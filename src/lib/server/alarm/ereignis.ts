import type { AlarmEreignis, Alarmgrund, ErholungsArt, MonitorArt } from '../db/schema/enums';
import {
	weisungFuer,
	zusammenfassung,
	type TicketWeisung,
	type VorkommensZusammenfassung
} from './lebenszyklus';

/**
 * The self-carrying payload every Alarmweg receives (SPEC §7).
 *
 * Self-carrying is the point: a receiver must be able to act on one event without querying
 * Nightwatch back. The channels turn this into their own shape — Autotask into a ticket body
 * (#28), the webhook into JSON (#29) — so nothing here commits to a wire format yet.
 */

/** SPEC §7: self-monitor events carry `monitor.art = "selbst"` and no customer. */
export type EreignisMonitor =
	| { art: MonitorArt; id: string; bezeichnung: string }
	/** `schluessel` is `selbst_monitor.schluessel` (`kern`, `postfach:{uuid}`). */
	| { art: 'selbst'; id: string; bezeichnung: string; schluessel: string };

export interface EreignisKunde {
	id: string;
	name: string;
}

/** One episode, as the payload builder reads it. */
export interface EpisodenSicht {
	alertId: string;
	/** The published id of the preceding episode of the same monitor, if there was one. */
	vorgaengerAlertId: string | null;
	alarmgrund: Alarmgrund;
	begonnenAm: Date;
	letztesVorkommenAm: Date;
	vorkommen: number;
	verschaerftAm: Date | null;
	beendetAm: Date | null;
	erholungsArt: ErholungsArt | null;
	monitor: EreignisMonitor;
	/** Null for a self-monitor — „Gehört keinem Kunden" (CONTEXT „Selbst-Monitor"). */
	kunde: EreignisKunde | null;
}

export interface AlarmEreignisDaten {
	ereignis: AlarmEreignis;
	/** The stable identity of the episode, outside. Internal ids never leave the instance. */
	alertId: string;
	vorgaengerAlertId: string | null;
	korrelationsKey: string;
	weisung: TicketWeisung;
	monitor: EreignisMonitor;
	kunde: EreignisKunde | null;
	/** The reason the episode opened with; a Verschärfung is visible in the summary. */
	alarmgrund: Alarmgrund;
	erholungsArt: ErholungsArt | null;
	zusammenfassung: VorkommensZusammenfassung;
	/** CONTEXT „Rückverweis" — the deep link back to the monitor that triggered this. */
	rueckverweis: string;
}

/**
 * The de-dupe key that travels in Autotask's `externalID` (SPEC §7): `nw:{monitorId}:{alertId}`,
 * `self:{schluessel}:{alertId}` for a self-monitor.
 *
 * SPEC writes `{übergangsId}` — the `alert_id` **is** that episode's id, only the published one,
 * which keeps internal ids inside the instance while the key stays stable and makes retries
 * idempotent.
 */
export function korrelationsKey(monitor: EreignisMonitor, alertId: string): string {
	return monitor.art === 'selbst'
		? `self:${monitor.schluessel}:${alertId}`
		: `nw:${monitor.id}:${alertId}`;
}

/**
 * CONTEXT „Rückverweis": every alarm and every ticket carries a deep link back into the UI.
 *
 * Both paths live here alone, so #31 has exactly one place to honour — or to correct — when it
 * builds the board. Self-monitors have no page of their own; they appear as the system banner.
 */
export function rueckverweis(basisUrl: string, monitor: EreignisMonitor): string {
	const basis = basisUrl.replace(/\/+$/, '');
	return monitor.art === 'selbst' ? `${basis}/system` : `${basis}/monitore/${monitor.id}`;
}

export function baueEreignis(
	sicht: EpisodenSicht,
	ereignis: AlarmEreignis,
	basisUrl: string
): AlarmEreignisDaten {
	return {
		ereignis,
		alertId: sicht.alertId,
		vorgaengerAlertId: sicht.vorgaengerAlertId,
		korrelationsKey: korrelationsKey(sicht.monitor, sicht.alertId),
		weisung: weisungFuer(ereignis, sicht.erholungsArt),
		monitor: sicht.monitor,
		kunde: sicht.kunde,
		alarmgrund: sicht.alarmgrund,
		erholungsArt: sicht.erholungsArt,
		zusammenfassung: zusammenfassung(sicht),
		rueckverweis: rueckverweis(basisUrl, sicht.monitor)
	};
}
