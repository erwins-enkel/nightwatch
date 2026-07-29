import type { ZustellKanal } from '../db/schema/enums';
import type { Tx } from '../zuordnung/db';
import type { AlarmEreignisDaten } from './ereignis';

/**
 * The Alarmweg seam (SPEC §7): where Autotask (#28) and the generic webhook (#29) attach.
 *
 * **The dashboard needs no way.** It is always on and reads `uebergang` directly; its proof of
 * delivery is the publisher's marker on the episode. Only the channels that leave the instance
 * need a durable queue behind them, and those are exactly the two this interface serves.
 */

/** One delivery a way wants for one event. Mirrors `zustellung.webhook_ziel_id`. */
export interface ZustellPlan {
	/** The webhook receiver; null for Autotask, whose channel has exactly one target. */
	webhookZielId: string | null;
}

export interface Alarmweg {
	kanal: ZustellKanal;

	/**
	 * Which deliveries this way wants for one event — empty when the way is not configured, which
	 * is how a channel switches itself off without the publisher knowing anything about it.
	 *
	 * Runs **inside** the transaction that marks the episode as published, so the ledger rows and
	 * the marker come into existence together or not at all.
	 */
	plane(ereignis: AlarmEreignisDaten, tx: Tx): Promise<ZustellPlan[]>;

	/**
	 * Hands a committed delivery to the way's durable queue and returns the queue's job id (or
	 * null when it has none).
	 *
	 * **Must be idempotent in `zustellungId`: that id is the identity of the queue job** (pg-boss
	 * `insert()` with an explicit `id`, or a `singletonKey`). The publisher writes `job_id` only
	 * after this resolves, so a crash in between leaves the row looking un-handed-over — the next
	 * tick hands it over again, and only an idempotent way keeps that from becoming a second
	 * ticket or a second webhook call.
	 */
	uebergib(ereignis: AlarmEreignisDaten, zustellungId: string): Promise<string | null>;
}

const registriert: Alarmweg[] = [];

/** Called once per channel at worker startup (#28, #29). */
export function registriereAlarmweg(weg: Alarmweg): void {
	registriert.push(weg);
}

export function alarmwege(): readonly Alarmweg[] {
	return registriert;
}

/** Replaces the registry wholesale — for tests, which need a clean set per case. */
export function setzeAlarmwege(wege: readonly Alarmweg[]): void {
	registriert.length = 0;
	registriert.push(...wege);
}
