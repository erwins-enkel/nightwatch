import type { PgBoss } from 'pg-boss';
import type { AlarmEreignisDaten } from '../alarm/ereignis';
import type { Alarmweg, ZustellPlan } from '../alarm/wege';
import type { Tx } from '../zuordnung/db';
import { aktiveZiele } from './db';

/**
 * The webhook Alarmweg (SPEC §7): the publisher's side of the channel.
 *
 * Everything expensive happens in the queue worker; this module only answers two questions —
 * "which receivers does this event go to?" and "how does each delivery get into the queue exactly
 * once?".
 */

export const WEBHOOK_QUEUE = 'webhook-zustellung';
/** Where a delivery lands once its retries are spent; drained by `worker.ts`. */
export const WEBHOOK_DEAD_LETTER = 'webhook-zustellung-tot';

/** The whole job payload. Everything else is re-read from the delivery row (`ladeZustellung`). */
export interface WebhookAuftrag {
	zustellungId: string;
}

export function webhookWeg(boss: PgBoss): Alarmweg {
	return {
		kanal: 'webhook',

		/**
		 * One delivery per active receiver — and none at all while there is no receiver, which is how
		 * the channel switches itself off without the publisher knowing anything about it.
		 *
		 * Deliberately **no** condition on the customer, unlike the Autotask way: the webhook is the
		 * channel that carries self-monitor events (`monitor.art = "selbst"`, `kunde = null`, SPEC §7),
		 * and asking for a customer here would be exactly the wrong question.
		 *
		 * Reads inside the publishing transaction, so a receiver switched off in the same moment
		 * either gets the event or does not — never a delivery row nobody wanted.
		 */
		async plane(_ereignis: AlarmEreignisDaten, tx: Tx): Promise<ZustellPlan[]> {
			const ziele = await aktiveZiele(tx);
			return ziele.map((ziel) => ({ webhookZielId: ziel.id }));
		},

		/**
		 * Hands the delivery to pg-boss, using the delivery id as the job id.
		 *
		 * That is what makes the handover idempotent, as the `Alarmweg` contract requires: pg-boss
		 * inserts jobs with `ON CONFLICT DO NOTHING`, so a repeat after a crash between enqueue and
		 * `job_id` produces no second job — and therefore no second call at the receiver.
		 *
		 * The delivery id is returned rather than `send()`'s result, which is `null` exactly in that
		 * repeat case; treating it as "not handed over" would make the publisher retry the handover
		 * on every tick for the lifetime of the job.
		 */
		async uebergib(_ereignis: AlarmEreignisDaten, zustellungId: string): Promise<string> {
			const auftrag: WebhookAuftrag = { zustellungId };
			await boss.send(WEBHOOK_QUEUE, auftrag, { id: zustellungId });
			return zustellungId;
		}
	};
}
