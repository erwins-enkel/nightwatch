import type { PgBoss } from 'pg-boss';
import { markiereFehlgeschlagen } from '../alarm/db';
import { createLogger, describeError } from '../logger';
import { fuehreAus } from './ablauf';
import { entschluesseleZugang, erzeugeAutotaskPort } from './client';
import { holeKonfig, istEinsatzbereit } from './db';
import { AUTOTASK_DEAD_LETTER, AUTOTASK_QUEUE, type TicketAuftrag } from './weg';

/**
 * The durable retry queue behind the Autotask channel (SPEC §7).
 *
 * Three properties are queue configuration rather than code, which is why they survive a restart,
 * a crash and a second worker container:
 *
 *  - **Serialisiert.** `policy: 'singleton'` allows exactly one *active* job on this queue,
 *    enforced by a partial unique index in pg-boss' own schema. Autotask asks integrations to
 *    serialise their requests (Research-Doc §2), and doing it in the database means scaling the
 *    worker service cannot quietly undo it.
 *  - **Exponentieller Backoff mit Jitter.** `retryBackoff` spreads retries as
 *    `retryDelay * (2^n/2 + 2^n/2 · random())`, capped by `retryDelayMax`.
 *  - **Dead-Letter nach N Versuchen.** `retryLimit` is that N, and it applies to every failure
 *    without exception — a rejected field and a dead socket both get the full budget.
 */

const log = createLogger('autotask');

/** Attempts per delivery before it counts as undeliverable — the N of "Dead-Letter nach N". */
export const VERSUCHE = 8;

const QUEUE_KONFIG = {
	retryLimit: VERSUCHE,
	retryDelay: 30,
	retryBackoff: true,
	/** ~8 attempts spread over roughly an hour; long enough for a maintenance window. */
	retryDelayMax: 900,
	/** A job whose worker died has to come back well before its Alarm is stale. */
	expireInSeconds: 120
} as const;

export interface AutotaskWorker {
	stop(): Promise<void>;
}

/**
 * Creates the queues and starts both workers.
 *
 * The dead letter queue is created first: `createQueue` verifies that the queue it is told to
 * forward to exists. `updateQueue` follows `createQueue` because the latter is
 * `ON CONFLICT DO NOTHING` — without it, an instance created before a settings change would keep
 * the old retry budget forever, and the code would stop being the truth.
 */
export async function starteAutotaskWorker(boss: PgBoss): Promise<AutotaskWorker> {
	await boss.createQueue(AUTOTASK_DEAD_LETTER, { policy: 'standard', retryLimit: 0 });

	await boss.createQueue(AUTOTASK_QUEUE, {
		policy: 'singleton',
		deadLetter: AUTOTASK_DEAD_LETTER,
		...QUEUE_KONFIG
	});
	await boss.updateQueue(AUTOTASK_QUEUE, { deadLetter: AUTOTASK_DEAD_LETTER, ...QUEUE_KONFIG });

	await boss.work<TicketAuftrag>(AUTOTASK_QUEUE, { batchSize: 1 }, async (jobs) => {
		for (const job of jobs) {
			const konfig = await holeKonfig();
			const zugang = entschluesseleZugang(konfig);

			// Throwing rather than skipping: the instruction is still owed. If the operator only
			// paused Autotask briefly, a later attempt delivers it; if the configuration is gone for
			// good, the delivery dead-letters like any other and the self-monitor notices.
			if (!zugang || !istEinsatzbereit(konfig)) {
				throw new Error('Autotask ist nicht (mehr) vollständig konfiguriert');
			}

			await fuehreAus({
				zustellungId: job.data.zustellungId,
				port: erzeugeAutotaskPort(zugang),
				konfig: konfig.defaults
			});
		}
	});

	await boss.work<TicketAuftrag>(AUTOTASK_DEAD_LETTER, { batchSize: 1 }, async (jobs) => {
		for (const job of jobs) {
			// The only place that gives up on a delivery — and the signal SPEC §8 calls
			// „Alarm-Zustellung gestört", which the global self-monitor (#30) reads off these rows.
			await markiereFehlgeschlagen(job.data.zustellungId, new Date());
			log.error('Alarm-Zustellung gestört', {
				zustellungId: job.data.zustellungId,
				versuche: VERSUCHE
			});
		}
	});

	log.info('Autotask-Worker gestartet', { queue: AUTOTASK_QUEUE, versuche: VERSUCHE });

	return {
		async stop(): Promise<void> {
			await Promise.all(
				[AUTOTASK_QUEUE, AUTOTASK_DEAD_LETTER].map((queue) =>
					boss.offWork(queue).catch((err: unknown) => {
						log.warn('Worker-Stopp fehlgeschlagen', { queue, error: describeError(err) });
					})
				)
			);
		}
	};
}
