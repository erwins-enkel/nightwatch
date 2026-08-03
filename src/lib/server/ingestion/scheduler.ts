import { entschluessele } from '../crypto';
import { erzeugeGraphPort } from '../graph/client';
import { klassifiziereAusnahme } from '../graph/fehler';
import { createLogger, describeError } from '../logger';
import { claimFaellige, speichereMails, vermerkeErfolg, vermerkeFehler } from './db';
import { pollePostfach } from './poller';
import type { GeclaimtesPostfach } from './db';

/**
 * The Graph delta poller's main loop, owned by the `worker` service (SPEC §2).
 *
 * A timer rather than a pg-boss job: pg-boss carries the *durable retry queues* for Autotask and
 * webhooks, and its cron schedules only go down to a minute — which cannot express the 60–300 s
 * per-mailbox interval SPEC §3 asks for. The durability that matters here lives in the mailbox row
 * (`naechster_poll_fruehestens_am`), not in a queue.
 */

const log = createLogger('ingestion');

/**
 * Mailboxes polled at once. Graph's per-mailbox limits (10.000 requests / 10 min, 4 concurrent)
 * are nowhere near reachable at these intervals, so this bounds *our* resource use, not theirs.
 */
export const MAX_PARALLEL = 4;

export interface IngestionScheduler {
	/** Runs one tick. Exposed so a caller can drive it deterministically instead of waiting. */
	tick(): Promise<void>;
	stop(): void;
}

export interface SchedulerOptionen {
	tickMs: number;
	maxParallel?: number;
	jetzt?: () => Date;
	/** Injected in tests so the loop's own behaviour is checkable without a database. */
	claim?: (anzahl: number, jetzt: Date) => Promise<GeclaimtesPostfach[]>;
	verarbeite?: (geclaimt: GeclaimtesPostfach, jetzt: Date) => Promise<void>;
}

/**
 * Polls one mailbox and persists the outcome. Never throws — one broken mailbox must not take the
 * tick, and with it every other mailbox, down with it.
 */
export async function verarbeitePostfach(geclaimt: GeclaimtesPostfach, jetzt: Date): Promise<void> {
	const felder = { postfach: geclaimt.id, adresse: geclaimt.adresse };

	try {
		if (!geclaimt.clientSecretChiffre) {
			throw new Error('Für dieses Postfach ist kein Client-Secret hinterlegt');
		}

		const graph = erzeugeGraphPort({
			tenantId: geclaimt.tenantId,
			clientId: geclaimt.clientId,
			clientSecret: entschluessele(geclaimt.clientSecretChiffre)
		});

		const ergebnis = await pollePostfach({
			postfach: geclaimt,
			graph,
			speichere: (mails) => speichereMails(geclaimt.id, geclaimt.erstelltAm, mails),
			jetzt
		});

		if (ergebnis.art === 'fehler') {
			await vermerkeFehler({
				postfachId: geclaimt.id,
				jetzt,
				fehler: ergebnis.fehler,
				wartenMs: ergebnis.wartenMs,
				deltaZuruecksetzen: ergebnis.deltaZuruecksetzen
			});
			// Never at `error` level: a throttled or briefly unreachable mailbox is expected
			// operation, and the alarm for a *persistently* broken one is #30's job, not the log's.
			log.warn('Poll fehlgeschlagen', {
				...felder,
				code: ergebnis.fehler.code,
				klasse: ergebnis.fehler.klasse,
				wartenMs: ergebnis.wartenMs
			});
			return;
		}

		await vermerkeErfolg({
			postfachId: geclaimt.id,
			jetzt,
			deltaToken: ergebnis.deltaToken,
			deltaFolgeLink: ergebnis.deltaFolgeLink,
			rundeAbgeschlossen: ergebnis.rundeAbgeschlossen,
			lernfensterAbgeschlossen: ergebnis.lernfensterAbgeschlossen,
			intervallSekunden: geclaimt.pollIntervallSekunden
		});

		if (ergebnis.mails > 0 || ergebnis.lernfensterAbgeschlossen) {
			log.info('Poll erfolgreich', {
				...felder,
				mails: ergebnis.mails,
				laueft: ergebnis.deltaFolgeLink !== null,
				lernfensterAbgeschlossen: ergebnis.lernfensterAbgeschlossen
			});
		}
	} catch (err) {
		// Everything the poller could not turn into a value: a missing encryption key, a database
		// hiccup while persisting. Recorded like any other failure so the mailbox backs off instead
		// of spinning, and so the operator sees a reason in the dashboard.
		const fehler = klassifiziereAusnahme(err);
		log.error('Poll brach ab', { ...felder, error: describeError(err) });
		await vermerkeFehler({
			postfachId: geclaimt.id,
			jetzt,
			fehler,
			wartenMs: geclaimt.pollIntervallSekunden * 1000,
			deltaZuruecksetzen: false
		}).catch((weiterer: unknown) => {
			log.error('Fehlerstand nicht speicherbar', { ...felder, error: describeError(weiterer) });
		});
	}
}

/**
 * Starts the loop. Overlapping ticks are skipped rather than queued, exactly like the heartbeat:
 * if a tick outruns its interval, stacking more of them helps nobody.
 */
export function startIngestionScheduler(optionen: SchedulerOptionen): IngestionScheduler {
	const maxParallel = optionen.maxParallel ?? MAX_PARALLEL;
	const jetztAus = optionen.jetzt ?? (() => new Date());
	const claim = optionen.claim ?? claimFaellige;
	const verarbeite = optionen.verarbeite ?? verarbeitePostfach;
	let laeuft = false;

	async function tick(): Promise<void> {
		const jetzt = jetztAus();
		const faellige = await claim(maxParallel, jetzt);
		if (faellige.length === 0) return;

		// The claim already limits the batch to `maxParallel`, so the whole batch may run at once.
		await Promise.all(faellige.map((geclaimt) => verarbeite(geclaimt, jetzt)));
	}

	function geschuetzterTick(): void {
		if (laeuft) return;
		laeuft = true;
		tick()
			.catch((err: unknown) => log.warn('Tick fehlgeschlagen', { error: describeError(err) }))
			.finally(() => {
				laeuft = false;
			});
	}

	const timer = setInterval(geschuetzterTick, optionen.tickMs);
	geschuetzterTick();

	return {
		tick,
		stop(): void {
			clearInterval(timer);
		}
	};
}
