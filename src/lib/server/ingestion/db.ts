import { eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { mail, postfach, selbstMonitor } from '../db/schema';
import type { MailZeile } from '../graph/nachricht';
import type { GraphFehler } from '../graph/fehler';
import type { PollPostfach } from './poller';

/** Every database statement the ingestion needs, in one place, so the poller stays port-shaped. */

type Db = ReturnType<typeof getDb>;

/**
 * How far `ingestion_stand_am` is pulled back behind the round's start (#26).
 *
 * Graph's delta index is eventually consistent: a message can surface a few seconds after its
 * `receivedDateTime`, so a round that began at T has *not* strictly delivered everything up to T.
 * This margin is the one remaining piece of slack in the completeness promise — named here rather
 * than assumed silently, and small enough to disappear inside any sensible Karenz.
 */
export const INGESTION_SICHERHEITSSPANNE_SEKUNDEN = 60;

/** What `claimFaellige` returns: the poller's view plus the credentials the Graph port needs. */
export type GeclaimtesPostfach = PollPostfach & {
	tenantId: string;
	clientId: string;
	clientSecretChiffre: string | null;
};

/**
 * The raw shape `claimFaellige` gets back from Postgres.
 *
 * Column names stay snake_case and every timestamp arrives as a string: `db.execute` returns the
 * driver's rows untouched, without the field mapping and type parsing the query builder applies.
 * Hence `alsDatum` below — the poller does date arithmetic on these, and a string would only fail
 * at runtime.
 */
interface ClaimZeile extends Record<string, unknown> {
	id: string;
	adresse: string;
	tenant_id: string;
	client_id: string;
	client_secret_chiffre: string | null;
	delta_token: string | null;
	delta_folge_link: string | null;
	letzter_erfolgreicher_poll: string | null;
	poll_intervall_sekunden: number;
	lernfenster_tage: number;
	lernfenster_abgeschlossen_am: string | null;
	fehler_in_folge: number;
	erstellt_am: string;
}

function alsDatum(wert: string | Date | null): Date | null {
	if (wert === null) return null;
	return wert instanceof Date ? wert : new Date(wert);
}

/**
 * Claims the mailboxes that are due, and leases them in the same statement.
 *
 * `FOR UPDATE SKIP LOCKED` plus pushing `naechster_poll_fruehestens_am` forward is the whole
 * concurrency design: two workers cannot pick up the same mailbox, and nothing needs an advisory
 * lock or a separate lease table. A worker that dies mid-poll costs one interval of waiting, after
 * which the row is due again by itself.
 *
 * **The locking CTE is load-bearing, not style.** Written as
 * `UPDATE … WHERE id IN (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)`, PostgreSQL flattens the
 * subquery into a semi-join and is free to re-execute it per outer row when the plan does not
 * materialise it — which makes every due mailbox match its own re-execution, so `LIMIT n` and the
 * lease both silently stop working. Whether that plan is chosen depends on table statistics, so it
 * surfaces as an occasional "claimed more than asked for" and not as an obvious failure. A CTE
 * containing `FOR UPDATE` is never inlined, so it is evaluated exactly once. This is why the query
 * is hand-written instead of composed with the query builder.
 *
 * The `::timestamptz` cast is load-bearing as well: without it Postgres infers the bound
 * parameter's type from the `+ interval` operand and rejects it as an interval.
 *
 * The claim is also where a delta round gets its start time (#26). A run that resumes a paging
 * round (`delta_folge_link` set) continues the round it is in and keeps `runde_begonnen_am`; only a
 * run that starts a fresh one stamps it. That timestamp — not the moment the round finishes — is
 * what a settled round proves completeness up to, which is why it has to be captured here rather
 * than derived in `vermerkeErfolg`.
 */
export async function claimFaellige(
	anzahl: number,
	jetzt: Date,
	db: Db = getDb()
): Promise<GeclaimtesPostfach[]> {
	const ergebnis = await db.execute<ClaimZeile>(sql`
		with faellig as (
			select ${postfach.id} as id from ${postfach}
			where ${postfach.aktiv}
			  and (${postfach.naechsterPollFruehestensAm} is null
			       or ${postfach.naechsterPollFruehestensAm} <= ${jetzt})
			order by ${postfach.naechsterPollFruehestensAm} asc nulls first
			limit ${anzahl}
			for update skip locked
		)
		update ${postfach}
		set naechster_poll_fruehestens_am =
			${jetzt}::timestamptz + make_interval(secs => ${postfach.pollIntervallSekunden}),
			runde_begonnen_am = case
				when ${postfach.deltaFolgeLink} is null then ${jetzt}::timestamptz
				else ${postfach.rundeBegonnenAm}
			end
		from faellig
		where ${postfach.id} = faellig.id
		returning
			${postfach.id}, ${postfach.adresse}, ${postfach.tenantId}, ${postfach.clientId},
			${postfach.clientSecretChiffre}, ${postfach.deltaToken}, ${postfach.deltaFolgeLink},
			${postfach.letzterErfolgreicherPoll}, ${postfach.pollIntervallSekunden},
			${postfach.lernfensterTage}, ${postfach.lernfensterAbgeschlossenAm},
			${postfach.fehlerInFolge}, ${postfach.erstelltAm}
	`);

	return ergebnis.rows.map((zeile) => ({
		id: zeile.id,
		adresse: zeile.adresse,
		tenantId: zeile.tenant_id,
		clientId: zeile.client_id,
		clientSecretChiffre: zeile.client_secret_chiffre,
		deltaToken: zeile.delta_token,
		deltaFolgeLink: zeile.delta_folge_link,
		letzterErfolgreicherPoll: alsDatum(zeile.letzter_erfolgreicher_poll),
		pollIntervallSekunden: Number(zeile.poll_intervall_sekunden),
		lernfensterTage: Number(zeile.lernfenster_tage),
		lernfensterAbgeschlossenAm: alsDatum(zeile.lernfenster_abgeschlossen_am),
		fehlerInFolge: Number(zeile.fehler_in_folge),
		erstelltAm: alsDatum(zeile.erstellt_am) as Date
	}));
}

/**
 * Writes one page of mails.
 *
 * `onConflictDoNothing` rather than an upsert: a delta round re-reports the same message whenever
 * its read state or folder changes, and a resync re-reads a whole overlap window. Overwriting
 * would churn rows that #24 will have annotated with a customer, a monitor and a classification —
 * the ingestion has no business touching those. Returns how many rows were genuinely new.
 */
export async function speichereMails(
	postfachId: string,
	/** Onboarding time — mails older than this are learning material (CONTEXT „Lernfenster"). */
	erstelltAm: Date,
	zeilen: MailZeile[],
	db: Db = getDb()
): Promise<number> {
	if (zeilen.length === 0) return 0;

	const eingefuegt = await db
		.insert(mail)
		.values(
			zeilen.map((zeile) => ({
				postfachId,
				graphMessageId: zeile.graphMessageId,
				ankunftszeit: zeile.ankunftszeit,
				ausLernfenster: zeile.ankunftszeit < erstelltAm,
				absender: zeile.absender,
				empfaenger: zeile.empfaenger,
				betreff: zeile.betreff,
				bodyText: zeile.bodyText
			}))
		)
		.onConflictDoNothing()
		.returning({ id: mail.id });

	return eingefuegt.length;
}

export interface ErfolgEingabe {
	postfachId: string;
	jetzt: Date;
	deltaToken: string | null;
	deltaFolgeLink: string | null;
	/** Graph closed the round with an `@odata.deltaLink` — the completeness proof. */
	rundeAbgeschlossen: boolean;
	lernfensterAbgeschlossen: boolean;
	intervallSekunden: number;
}

/**
 * Records a successful round step and clears the error state.
 *
 * A round that is still paging becomes due immediately rather than after the poll interval —
 * otherwise a 200-page backfill would take 200 intervals to drain.
 *
 * A round that **settled** additionally renews the completeness promise the time scheduler judges
 * against (#26). Three properties make that promise worth something:
 *
 * - It moves only on `rundeAbgeschlossen`. A paging round has delivered a prefix, not everything.
 * - It moves to the round's *start* minus the safety margin, never to `jetzt` — a round that paged
 *   for ten minutes says nothing about the mail that arrived during those ten minutes.
 * - `greatest` keeps it monotone, so the hour of overlap a `410 Gone` resync re-reads cannot
 *   withdraw a promise that was already made.
 *
 * The mails themselves are committed page by page *before* this runs (`poller.ts`), which is the
 * ordering the scheduler relies on: whoever sees the new promise also sees its mails.
 */
export async function vermerkeErfolg(eingabe: ErfolgEingabe, db: Db = getDb()): Promise<void> {
	const { jetzt, deltaFolgeLink } = eingabe;
	const naechster = deltaFolgeLink
		? jetzt
		: new Date(jetzt.getTime() + eingabe.intervallSekunden * 1000);

	await db
		.update(postfach)
		.set({
			deltaToken: eingabe.deltaToken,
			deltaFolgeLink,
			letzterErfolgreicherPoll: jetzt,
			letzterFehlerCode: null,
			letzterFehlerText: null,
			letzterFehlerAm: null,
			fehlerInFolge: 0,
			naechsterPollFruehestensAm: naechster,
			...(eingabe.rundeAbgeschlossen
				? {
						ingestionStandAm: sql`greatest(${postfach.ingestionStandAm}, ${postfach.rundeBegonnenAm} - make_interval(secs => ${INGESTION_SICHERHEITSSPANNE_SEKUNDEN}))`
					}
				: {}),
			...(eingabe.lernfensterAbgeschlossen ? { lernfensterAbgeschlossenAm: jetzt } : {})
		})
		.where(eq(postfach.id, eingabe.postfachId));
}

export interface FehlerEingabe {
	postfachId: string;
	jetzt: Date;
	fehler: GraphFehler;
	wartenMs: number;
	deltaZuruecksetzen: boolean;
}

/**
 * Records a failed poll and schedules the retry.
 *
 * `letzter_erfolgreicher_poll` is deliberately left alone — it is the staleness signal the mailbox
 * self-monitor reads (#30), and a failure must not look like activity.
 */
export async function vermerkeFehler(eingabe: FehlerEingabe, db: Db = getDb()): Promise<void> {
	await db
		.update(postfach)
		.set({
			letzterFehlerCode: eingabe.fehler.code,
			letzterFehlerText: eingabe.fehler.text,
			letzterFehlerAm: eingabe.jetzt,
			fehlerInFolge: sql`${postfach.fehlerInFolge} + 1`,
			naechsterPollFruehestensAm: new Date(eingabe.jetzt.getTime() + eingabe.wartenMs),
			// A resync throws the round away; the next poll starts a fresh one.
			...(eingabe.deltaZuruecksetzen ? { deltaToken: null, deltaFolgeLink: null } : {})
		})
		.where(eq(postfach.id, eingabe.postfachId));
}

export interface NeuesPostfach {
	bezeichnung: string;
	adresse: string;
	tenantId: string;
	clientId: string;
	clientSecretChiffre: string;
	secretAblaufAm: Date | null;
	pollIntervallSekunden: number;
	lernfensterTage: number;
}

/**
 * Creates a mailbox together with its self-monitor (CONTEXT „Selbst-Monitor": one per mailbox).
 *
 * In one transaction on purpose. The self-monitor is not creatable by hand and #30 assumes it
 * exists for every mailbox; a mailbox that came into existence without one would be a mailbox
 * whose ingestion nobody watches — the exact blind spot Nightwatch is built to remove.
 */
export async function legePostfachAn(neu: NeuesPostfach, db: Db = getDb()): Promise<string> {
	return db.transaction(async (tx) => {
		const [zeile] = await tx.insert(postfach).values(neu).returning({ id: postfach.id });

		await tx.insert(selbstMonitor).values({
			schluessel: `postfach:${zeile.id}`,
			art: 'postfach',
			postfachId: zeile.id,
			bezeichnung: `Ingestion ${neu.bezeichnung}`
		});

		return zeile.id;
	});
}

/** The settings list: mailboxes with their ingestion status, in the order they were connected. */
export function listePostfaecher(db: Db = getDb()) {
	return db
		.select({
			id: postfach.id,
			bezeichnung: postfach.bezeichnung,
			adresse: postfach.adresse,
			tenantId: postfach.tenantId,
			clientId: postfach.clientId,
			secretAblaufAm: postfach.secretAblaufAm,
			pollIntervallSekunden: postfach.pollIntervallSekunden,
			lernfensterTage: postfach.lernfensterTage,
			lernfensterAbgeschlossenAm: postfach.lernfensterAbgeschlossenAm,
			letzterErfolgreicherPoll: postfach.letzterErfolgreicherPoll,
			letzterFehlerCode: postfach.letzterFehlerCode,
			letzterFehlerText: postfach.letzterFehlerText,
			letzterFehlerAm: postfach.letzterFehlerAm,
			aktiv: postfach.aktiv,
			erstelltAm: postfach.erstelltAm
		})
		.from(postfach)
		.orderBy(postfach.erstelltAm);
}

/** SPEC §11: deleting a mailbox removes its mails and its delta state (cascade does the rest). */
export async function entfernePostfach(id: string, db: Db = getDb()): Promise<void> {
	await db.delete(postfach).where(eq(postfach.id, id));
}

/** Pausing ingestion without losing the delta state or the history. */
export async function setzeAktiv(id: string, aktiv: boolean, db: Db = getDb()): Promise<void> {
	await db.update(postfach).set({ aktiv }).where(eq(postfach.id, id));
}
