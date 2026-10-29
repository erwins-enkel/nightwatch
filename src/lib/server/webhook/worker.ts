import type { PgBoss } from 'pg-boss';
import { markiereFehlgeschlagen } from '../alarm/db';
import { createLogger, describeError } from '../logger';
import { fuehreAus } from './ablauf';
import { erzeugeWebhookPort } from './client';
import { WEBHOOK_DEAD_LETTER, WEBHOOK_QUEUE, type WebhookAuftrag } from './weg';

/**
 * The durable retry queue behind the webhook channel (SPEC §7: „Zustellung at-least-once mit
 * Backoff").
 *
 * The properties that matter are queue configuration rather than code, which is why they survive a
 * restart, a crash and a second worker container:
 *
 *  - **Exponentieller Backoff mit Jitter.** `retryBackoff` spreads retries as
 *    `retryDelay * (2^n/2 + 2^n/2 · random())`, capped by `retryDelayMax`.
 *  - **Dead-Letter nach N Versuchen.** `retryLimit` is that N, and it applies to every failure
 *    without exception — a refused body and a dead socket both get the full budget.
 *
 * Unlike Autotask this queue is **not** `singleton`: Autotask asks integrations to serialise their
 * requests, webhook receivers do not, and a slow one must not hold up the others. Order *within* a
 * target is not at stake either way — the publisher hands over one delivery per chain at a time
 * (`ladeOffeneZustellungen`), so there can be no second job for the same receiver and monitor.
 */

const log = createLogger('webhook');

/** Attempts per delivery before it counts as undeliverable — the N of "Dead-Letter nach N". */
export const VERSUCHE = 8;

/** Receivers served at once. Each worker takes one job, so a hanging endpoint blocks only itself. */
const GLEICHZEITIG = 4;

const QUEUE_KONFIG = {
	retryLimit: VERSUCHE,
	retryDelay: 30,
	retryBackoff: true,
	/** ~8 attempts spread over roughly an hour; long enough for a maintenance window. */
	retryDelayMax: 900,
	/** Comfortably above the client's 10 s request timeout, so only a dead worker expires a job. */
	expireInSeconds: 60
} as const;

export interface WebhookWorker {
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
export async function starteWebhookWorker(boss: PgBoss): Promise<WebhookWorker> {
	await boss.createQueue(WEBHOOK_DEAD_LETTER, { policy: 'standard', retryLimit: 0 });

	await boss.createQueue(WEBHOOK_QUEUE, {
		policy: 'standard',
		deadLetter: WEBHOOK_DEAD_LETTER,
		...QUEUE_KONFIG
	});
	await boss.updateQueue(WEBHOOK_QUEUE, { deadLetter: WEBHOOK_DEAD_LETTER, ...QUEUE_KONFIG });

	const port = erzeugeWebhookPort();

	await boss.work<WebhookAuftrag>(
		WEBHOOK_QUEUE,
		{ batchSize: 1, localConcurrency: GLEICHZEITIG },
		async (jobs) => {
			for (const job of jobs) {
				await fuehreAus({ zustellungId: job.data.zustellungId, port });
			}
		}
	);

	await boss.work<WebhookAuftrag>(WEBHOOK_DEAD_LETTER, { batchSize: 1 }, async (jobs) => {
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

	log.info('Webhook-Worker gestartet', { queue: WEBHOOK_QUEUE, versuche: VERSUCHE });

	return {
		async stop(): Promise<void> {
			await Promise.all(
				[WEBHOOK_QUEUE, WEBHOOK_DEAD_LETTER].map((queue) =>
					boss.offWork(queue).catch((err: unknown) => {
						log.warn('Worker-Stopp fehlgeschlagen', { queue, error: describeError(err) });
					})
				)
			);
		}
	};
}
