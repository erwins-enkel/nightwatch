import { createLogger, describeError } from '../logger';
import { STAPEL_GROESSE, verarbeiteStapel, type MonitorStufeFabrik } from './verarbeitung';

/**
 * The assignment pipeline's main loop, owned by the `worker` service (SPEC §2).
 *
 * A timer rather than a pg-boss job, for the same reason the ingestion poller is one: the
 * durability that matters lives in the row — a mail with `verarbeitet_am is null` *is* the queue —
 * and a queue on top of it would only be a second piece of state that can disagree with the first.
 * It also makes "evaluate these mails again" a single `UPDATE`, which is exactly what happens when
 * a new Zuordnungs-Merkmal is created.
 */

const log = createLogger('zuordnung');

/**
 * Batches one tick may drain before it yields.
 *
 * A freshly connected mailbox hands the pipeline a whole learning window at once. Without a ceiling
 * one tick would sit on that backlog for minutes; with it the backlog drains over a few ticks while
 * the loop stays responsive to mail arriving in the meantime.
 */
export const STAPEL_PRO_TICK = 20;

export interface ZuordnungsScheduler {
	/** Runs one tick. Exposed so a caller can drive it deterministically instead of waiting. */
	tick(): Promise<void>;
	stop(): void;
}

export interface SchedulerOptionen {
	tickMs: number;
	stapelGroesse?: number;
	stapelProTick?: number;
	/**
	 * Stage 2 of the pipeline (#25). Handed down rather than imported by `verarbeiteStapel` itself:
	 * this loop is the only caller in production, and keeping the wiring here is what lets the
	 * customer stage be tested — and run — without the monitor core.
	 */
	monitorStufe?: MonitorStufeFabrik;
	/** Injected in tests so the loop's own behaviour is checkable without a database. */
	verarbeite?: (groesse: number) => Promise<number>;
}

/**
 * Starts the loop. Overlapping ticks are skipped rather than queued, exactly like the ingestion
 * scheduler and the heartbeat: if a tick outruns its interval, stacking more of them helps nobody.
 */
export function startZuordnungScheduler(optionen: SchedulerOptionen): ZuordnungsScheduler {
	const groesse = optionen.stapelGroesse ?? STAPEL_GROESSE;
	const proTick = optionen.stapelProTick ?? STAPEL_PRO_TICK;
	const verarbeite =
		optionen.verarbeite ??
		((stapelGroesse: number) =>
			verarbeiteStapel({ groesse: stapelGroesse, monitorStufe: optionen.monitorStufe }));
	let laeuft = false;

	async function tick(): Promise<void> {
		let gesamt = 0;

		for (let stapel = 0; stapel < proTick; stapel++) {
			const verarbeitet = await verarbeite(groesse);
			gesamt += verarbeitet;
			// A short batch means the backlog is drained — as far as this worker can see, since
			// SKIP LOCKED hides what another worker holds. Either way the next tick picks it up.
			if (verarbeitet < groesse) break;
		}

		if (gesamt > 0) log.info('Mails zugeordnet', { mails: gesamt });
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
