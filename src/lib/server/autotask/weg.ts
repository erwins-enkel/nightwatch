import type { PgBoss } from 'pg-boss';
import type { Alarmweg, ZustellPlan } from '../alarm/wege';
import type { AlarmEreignisDaten } from '../alarm/ereignis';
import type { Tx } from '../zuordnung/db';
import { companyIdFuerKunde, holeKonfig, istEinsatzbereit } from './db';

/**
 * The Autotask Alarmweg (SPEC §7): the publisher's side of the channel.
 *
 * Everything expensive happens in the queue worker; this module only answers two questions —
 * "does this event go to Autotask at all?" and "how does it get into the queue exactly once?".
 */

export const AUTOTASK_QUEUE = 'autotask-tickets';
/** Where a delivery lands once its retries are spent; drained by `worker.ts`. */
export const AUTOTASK_DEAD_LETTER = 'autotask-tickets-tot';

/** The whole job payload. Everything else is re-read from the delivery row (`ladeZustellung`). */
export interface TicketAuftrag {
	zustellungId: string;
}

export function autotaskWeg(boss: PgBoss): Alarmweg {
	return {
		kanal: 'autotask',

		/**
		 * One delivery, or none at all.
		 *
		 * Three conditions have to hold together: Autotask is switched on and completely configured,
		 * the event belongs to a customer, and that customer carries an Autotask-Verknüpfung. Any of
		 * them missing is a legitimate state, not an error — "ohne Verknüpfung alarmiert der Kunde nur
		 * über Dashboard und Webhook" (CONTEXT) — so the channel switches itself off per customer
		 * without the publisher knowing anything about it.
		 *
		 * Self-monitor events never come through here; the watchdog sends them on its own path
		 * (SPEC §8, #30).
		 */
		async plane(ereignis: AlarmEreignisDaten, tx: Tx): Promise<ZustellPlan[]> {
			if (ereignis.monitor.art === 'selbst' || !ereignis.kunde) return [];

			const konfig = await holeKonfig(tx);
			if (!istEinsatzbereit(konfig)) return [];

			const companyId = await companyIdFuerKunde(ereignis.kunde.id, tx);
			return companyId === null ? [] : [{ webhookZielId: null }];
		},

		/**
		 * Hands the delivery to pg-boss, using the delivery id as the job id.
		 *
		 * That is what makes the handover idempotent, as the `Alarmweg` contract requires: pg-boss
		 * inserts jobs with `ON CONFLICT DO NOTHING`, so a repeat after a crash between enqueue and
		 * `job_id` produces no second job — and therefore no second ticket.
		 *
		 * The delivery id is returned rather than `send()`'s result, which is `null` exactly in that
		 * repeat case; treating it as "not handed over" would make the publisher retry the handover
		 * on every tick for the lifetime of the job.
		 */
		async uebergib(_ereignis: AlarmEreignisDaten, zustellungId: string): Promise<string> {
			const auftrag: TicketAuftrag = { zustellungId };
			await boss.send(AUTOTASK_QUEUE, auftrag, { id: zustellungId });
			return zustellungId;
		}
	};
}
