import { ladeZustellung, vermerkeZustellung } from '../alarm/db';
import { baueEreignis } from '../alarm/ereignis';
import { entschluessele } from '../crypto';
import { getDb } from '../db/client';
import { env } from '../env';
import { createLogger, describeError } from '../logger';
import { beschreibeAntwort, type WebhookPort } from './client';
import { ladeZiel } from './db';
import { koerper } from './nutzlast';
import { signiere, SIGNATUR_KOPF } from './signatur';

/**
 * Executing one delivery against a webhook receiver (SPEC §7).
 *
 * **Failure policy:** every failure is retried until the queue's budget is spent, exactly like the
 * Autotask channel. A `404` may be a receiver mid-redeploy and a `401` a secret the operator is
 * about to fix; giving up early would turn a temporary misconfiguration into a lost alarm. The
 * classification below decides the log level and the persisted diagnosis, nothing else.
 */

const log = createLogger('webhook');

type Db = ReturnType<typeof getDb>;

export interface AblaufOptionen {
	zustellungId: string;
	port: WebhookPort;
	jetzt?: Date;
	basisUrl?: string;
	db?: Db;
}

/**
 * `429` is a receiver asking for air, `408`/`425` and every `5xx` are the ordinary transport
 * failures. The rest of the 4xx range is a statement about the request and will read the same on
 * the next attempt — worth an `error` on the first try rather than the eighth, because the
 * operator has to act either way.
 *
 * A `3xx` lands here too: redirects are not followed (`client.ts`), so it is a receiver that moved
 * without the operator's configuration following it.
 */
const TRANSIENTE_CODES = new Set([408, 425, 429]);

function istDauerhaft(status: number): boolean {
	return status >= 300 && status < 500 && !TRANSIENTE_CODES.has(status);
}

/** The error a failed delivery throws, so the pg-boss handler stays a one-liner. */
export class WebhookZustellFehler extends Error {
	readonly dauerhaft: boolean;

	constructor(nachricht: string, dauerhaft: boolean) {
		super(nachricht);
		this.name = 'WebhookZustellFehler';
		this.dauerhaft = dauerhaft;
	}
}

/**
 * Runs one delivery. Resolves when the call went through (or provably no longer applies), throws
 * when it has to be retried.
 */
export async function fuehreAus(optionen: AblaufOptionen): Promise<void> {
	const db = optionen.db ?? getDb();
	const jetzt = optionen.jetzt ?? new Date();
	const { zustellungId } = optionen;

	const auftrag = await ladeZustellung(zustellungId, db);
	if (!auftrag) {
		// The episode went with its monitor. Nothing is owed any more, and the job may finish.
		log.info('Zustellung nicht mehr vorhanden', { zustellungId });
		return;
	}

	const ziel = await ladeZiel(zustellungId, db);
	if (!ziel || !ziel.aktiv) {
		// The operator retired this receiver after the event was planned. Nothing is owed; marking it
		// delivered is what releases the target's chain (`ladeOffeneZustellungen`).
		log.info('Zustellung übersprungen', { zustellungId, ziel: ziel?.id ?? null });
		await vermerkeZustellung(zustellungId, 'zugestellt', jetzt, null, db);
		return;
	}

	const daten = baueEreignis(auftrag.episode, auftrag.ereignis, optionen.basisUrl ?? env.basisUrl);

	// The attempt and the bookkeeping are kept apart on purpose: only what happens between here and
	// the receiver is a *delivery* failure. A database error while recording the outcome is not, and
	// classifying it as one would put a Postgres message in front of the operator as if the webhook
	// had answered it.
	let fehler: { text: string; dauerhaft: boolean } | null = null;

	try {
		// An unsigned webhook is not a supported mode (SPEC §7). Failing rather than skipping: the
		// event is still owed, a later attempt delivers it once the secret is back, and if it never
		// comes back the delivery dead-letters like any other and the self-monitor notices.
		if (!ziel.secretChiffre) {
			throw new WebhookZustellFehler(`Webhook-Ziel ${ziel.id} hat kein Secret`, true);
		}

		// Serialised once and used twice: these are the bytes that are signed **and** the bytes that
		// go out. Building the body a second time for the request would produce a signature no
		// receiver can verify, and nothing here would notice.
		const rumpf = koerper(daten, jetzt);
		const signatur = signiere(entschluessele(ziel.secretChiffre), rumpf);

		const antwort = await optionen.port.sende(ziel.url, rumpf, {
			'Content-Type': 'application/json',
			[SIGNATUR_KOPF]: signatur,
			// Routing convenience only. It is *not* signed, and `docs/webhook.md` says so — the same
			// value stands in the body, which is.
			'X-Nightwatch-Event': daten.ereignis,
			'User-Agent': `Nightwatch/${env.appVersion}`
		});

		if (antwort.status < 200 || antwort.status >= 300) {
			fehler = {
				text: `HTTP ${antwort.status}${antwort.text === '' ? '' : `: ${antwort.text}`}`,
				dauerhaft: istDauerhaft(antwort.status)
			};
		}
	} catch (err: unknown) {
		// A dead socket, a DNS failure, the request timeout, an undecryptable secret — none of those
		// say anything about the request itself, so they are transient unless they said otherwise.
		fehler =
			err instanceof WebhookZustellFehler
				? { text: err.message, dauerhaft: err.dauerhaft }
				: { text: beschreibeAntwort(describeError(err)), dauerhaft: false };
	}

	if (fehler === null) {
		await vermerkeZustellung(zustellungId, 'zugestellt', jetzt, null, db);
		log.info('Webhook zugestellt', {
			zustellungId,
			alertId: daten.alertId,
			ereignis: daten.ereignis,
			ziel: ziel.id
		});
		return;
	}

	// Recorded on *every* attempt, so the operator sees the cause from the first failure on rather
	// than only once the dead letter arrives.
	await vermerkeZustellung(zustellungId, 'offen', jetzt, fehler.text, db);

	const melde = fehler.dauerhaft ? log.error : log.warn;
	melde('Webhook-Zustellung fehlgeschlagen', {
		zustellungId,
		alertId: daten.alertId,
		ziel: ziel.id,
		fehler: fehler.text
	});

	throw new WebhookZustellFehler(fehler.text, fehler.dauerhaft);
}
