import type { GraphPort } from '../graph/client';
import { klassifiziereAusnahme, klassifiziereFehler, type GraphFehler } from '../graph/fehler';
import { zuMailZeile, type MailZeile } from '../graph/nachricht';
import { backoffMs } from './backoff';

/**
 * One delta round for one mailbox (SPEC §3).
 *
 * Written against ports — a `GraphPort` and a save callback — so every branch below (initial round,
 * continuation, completion, resync, throttling) is asserted without a network or a database.
 */

/**
 * How many pages one run may fetch before it yields.
 *
 * A ~30-day backfill of a busy NOC mailbox is thousands of mails; draining it in one go would let
 * one mailbox monopolise a poll slot for minutes. The `nextLink` is persisted instead, so the round
 * simply continues on the next tick and the other mailboxes get their turn.
 */
export const SEITEN_PRO_LAUF = 25;

/**
 * Overlap re-applied when a `410 Gone` forces a resync.
 *
 * The delta state is gone, so the only honest starting point is "everything since we last
 * definitely had it". The overlap covers the gap between a mail arriving and the poll that saw it;
 * re-ingesting a few mails is free because the insert is idempotent, losing one is not.
 */
export const RESYNC_UEBERLAPPUNG_MS = 3_600_000;

export interface PollPostfach {
	id: string;
	adresse: string;
	deltaToken: string | null;
	deltaFolgeLink: string | null;
	letzterErfolgreicherPoll: Date | null;
	pollIntervallSekunden: number;
	lernfensterTage: number;
	lernfensterAbgeschlossenAm: Date | null;
	fehlerInFolge: number;
	/** Onboarding time; the boundary between learning material and monitoring material. */
	erstelltAm: Date;
}

export type PollErgebnis =
	| {
			art: 'erfolg';
			mails: number;
			/** Set while the round is still paging; the mailbox becomes due again immediately. */
			deltaFolgeLink: string | null;
			/** Set once the round settled. */
			deltaToken: string | null;
			/**
			 * True only when Graph closed the round with an `@odata.deltaLink`.
			 *
			 * This is the completeness proof `postfach.ingestion_stand_am` rests on (#26), so it is
			 * reported explicitly rather than inferred from the two link fields: when the page budget
			 * runs out without either link, the run also ends with `deltaFolgeLink: null` while
			 * carrying the *previous* round's token — indistinguishable from a settled round, and
			 * claiming completeness there would be claiming it without evidence.
			 */
			rundeAbgeschlossen: boolean;
			/** True when this run finished the initial (learning-window) round. */
			lernfensterAbgeschlossen: boolean;
	  }
	| { art: 'fehler'; fehler: GraphFehler; wartenMs: number; deltaZuruecksetzen: boolean };

/** Graph's delta envelope, as far as the poller relies on it. */
interface DeltaSeite {
	value?: unknown[];
	'@odata.nextLink'?: string;
	'@odata.deltaLink'?: string;
}

export interface PollOptionen {
	postfach: PollPostfach;
	graph: GraphPort;
	/** Receives one page worth of mails; returns how many were actually new. */
	speichere(mails: MailZeile[]): Promise<number>;
	jetzt: Date;
	zufall?: () => number;
}

/** ISO-8601 without milliseconds — what Graph's `$filter` on `receivedDateTime` expects. */
function alsFilterZeit(zeitpunkt: Date): string {
	return zeitpunkt.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Builds the query string with the `$` of the OData options left intact.
 *
 * `URLSearchParams` would percent-encode it to `%24filter`, which stops being a recognised system
 * query option — the Graph SDK's own parser matches the literal `$filter`, and re-emits anything
 * else as a plain custom parameter. Only the values are encoded.
 */
function odataQuery(optionen: Record<string, string>): string {
	return Object.entries(optionen)
		.map(([name, wert]) => `${name}=${encodeURIComponent(wert)}`)
		.join('&');
}

/**
 * The URL that starts a fresh round.
 *
 * The learning window *is* this filter: `message: delta` supports exactly one filter expression,
 * `receivedDateTime ge {value}`, and Graph encodes it into every `@odata.deltaLink` it hands back
 * afterwards. So one mechanism covers both the ~30-day backfill and all forward polling — there is
 * no second retrieval path and no second piece of state to keep consistent.
 *
 * After a resync the cutoff moves up to the last successful poll instead: re-reading 30 days would
 * be pointless work, and everything older is already stored.
 */
export function initialeDeltaUrl(postfach: PollPostfach): string {
	const lernfensterStart = new Date(
		postfach.erstelltAm.getTime() - postfach.lernfensterTage * 86_400_000
	);
	const nachResync =
		postfach.lernfensterAbgeschlossenAm && postfach.letzterErfolgreicherPoll
			? new Date(postfach.letzterErfolgreicherPoll.getTime() - RESYNC_UEBERLAPPUNG_MS)
			: undefined;

	const ab = nachResync ?? lernfensterStart;
	const query = odataQuery({
		$filter: `receivedDateTime ge ${alsFilterZeit(ab)}`,
		// Deliberately no attachment fields (SPEC §11) — what is not requested cannot be stored.
		$select: 'id,receivedDateTime,from,sender,toRecipients,ccRecipients,subject,body,bodyPreview'
	});

	// `inbox` is the well-known folder name; delta is per folder, and v1 watches the inbox only.
	return `/users/${encodeURIComponent(postfach.adresse)}/mailFolders/inbox/messages/delta?${query}`;
}

function seiteAus(body: unknown): DeltaSeite {
	return (body ?? {}) as DeltaSeite;
}

/**
 * Runs one delta round step: resume where the mailbox left off, page until the round settles or
 * the page budget runs out, and report what the caller has to persist.
 *
 * Never throws — a poll failure is a value, because the caller has to record it either way.
 */
export async function pollePostfach(optionen: PollOptionen): Promise<PollErgebnis> {
	const { postfach, graph, speichere, jetzt } = optionen;

	// A round in progress wins over a settled one; only a mailbox with neither starts fresh.
	const fortsetzung = postfach.deltaFolgeLink ?? postfach.deltaToken;
	/**
	 * The backfill is done when the *first* round settles — however many ticks it took to page
	 * through. Deciding this from "this run started the round" instead would leave every backfill
	 * longer than one page budget marked as running forever, and a later resync would then go back
	 * a full learning window again rather than resuming from the last successful poll.
	 */
	const imLernfenster = postfach.lernfensterAbgeschlossenAm === null;
	let url: string | undefined = fortsetzung ?? initialeDeltaUrl(postfach);

	let mails = 0;

	for (let seite = 0; seite < SEITEN_PRO_LAUF && url; seite++) {
		let antwort;
		try {
			antwort = await graph.holeSeite(url);
		} catch (err) {
			// A token that cannot be acquired and a dead socket both land here.
			return fehlerErgebnis(klassifiziereAusnahme(err), optionen);
		}

		if (antwort.status < 200 || antwort.status >= 300) {
			const fehler = klassifiziereFehler({
				status: antwort.status,
				body: antwort.body,
				retryAfter: antwort.retryAfter,
				jetzt
			});
			return fehlerErgebnis(fehler, optionen);
		}

		const inhalt = seiteAus(antwort.body);
		const zeilen = (inhalt.value ?? [])
			.map((eintrag) => zuMailZeile(eintrag as Parameters<typeof zuMailZeile>[0]))
			.filter((zeile): zeile is MailZeile => zeile !== null);

		// Written page by page rather than at the end: a backfill that dies halfway keeps what it
		// already read, and the persisted link means it resumes exactly there.
		if (zeilen.length > 0) mails += await speichere(zeilen);

		if (inhalt['@odata.deltaLink']) {
			return {
				art: 'erfolg',
				mails,
				deltaFolgeLink: null,
				deltaToken: inhalt['@odata.deltaLink'],
				rundeAbgeschlossen: true,
				lernfensterAbgeschlossen: imLernfenster
			};
		}

		url = inhalt['@odata.nextLink'];
	}

	// Budget exhausted (or Graph returned neither link, which we treat the same way): keep the
	// resume point if there is one, otherwise the round is simply over.
	return {
		art: 'erfolg',
		mails,
		deltaFolgeLink: url ?? null,
		deltaToken: url ? null : (postfach.deltaToken ?? null),
		rundeAbgeschlossen: false,
		lernfensterAbgeschlossen: false
	};
}

function fehlerErgebnis(fehler: GraphFehler, optionen: PollOptionen): PollErgebnis {
	const { postfach } = optionen;
	return {
		art: 'fehler',
		fehler,
		wartenMs: backoffMs({
			fehler,
			fehlerInFolge: postfach.fehlerInFolge + 1,
			intervallSekunden: postfach.pollIntervallSekunden,
			zufall: optionen.zufall
		}),
		// `410 Gone` is the one failure that invalidates the stored state rather than the access.
		deltaZuruecksetzen: fehler.klasse === 'resync'
	};
}
