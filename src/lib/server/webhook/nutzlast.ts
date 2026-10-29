import type { AlarmEreignisDaten, EreignisMonitor } from '../alarm/ereignis';
import type { TicketWeisung } from '../alarm/lebenszyklus';
import type { AlarmEreignis, Alarmgrund, ErholungsArt, MonitorArt } from '../db/schema/enums';

/**
 * The wire format of the generic webhook (SPEC §7) — and the only place that decides it.
 *
 * „Payload selbsttragend": a receiver must be able to act on one call without asking Nightwatch
 * anything back. Every field is therefore spelled out here rather than referenced by id, and the
 * mapping is written by hand: `AlarmEreignisDaten` is an internal type that will keep growing, and
 * spreading it would publish each new field to every receiver by accident.
 *
 * Keys are German `snake_case` — the same terms CONTEXT.md uses, so the payload reads like the
 * domain it describes.
 */

/** SPEC §7: self-monitor events carry `art: "selbst"` and their `schluessel`. */
export type NutzlastMonitor =
	| { art: MonitorArt; id: string; bezeichnung: string }
	| { art: 'selbst'; id: string; bezeichnung: string; schluessel: string };

export interface NutzlastVorkommen {
	anzahl: number;
	erste_am: string;
	letzte_am: string;
	verschaerft_am: string | null;
	/** Null while the disruption is still running. */
	stoerungsdauer_sekunden: number | null;
}

export interface WebhookNutzlast {
	ereignis: AlarmEreignis;
	/** The episode's stable identity. Internal ids never leave the instance. */
	alert_id: string;
	vorgaenger_alert_id: string | null;
	/**
	 * Stamped per **attempt**, not when the delivery was planned.
	 *
	 * It is what lets a receiver reject a replayed body without also rejecting a legitimate retry,
	 * which may well arrive an hour after the event (`docs/webhook.md`). Because the signature
	 * covers the body, this timestamp is signed — an unsigned header could not carry the same
	 * promise.
	 */
	gesendet_am: string;
	/**
	 * What the lifecycle asks a ticket system to do (CONTEXT „Alarmweg"). The generic webhook is
	 * how PSAs other than Autotask are reached (README), and they need the semantics rather than
	 * having to re-derive them from the event.
	 */
	weisung: TicketWeisung;
	monitor: NutzlastMonitor;
	/** Null for a self-monitor — „Gehört keinem Kunden" (CONTEXT „Selbst-Monitor"). */
	kunde: { id: string; name: string } | null;
	alarmgrund: Alarmgrund;
	erholungs_art: ErholungsArt | null;
	vorkommen: NutzlastVorkommen;
	/** CONTEXT „Rückverweis" — the deep link back to what triggered this. */
	rueckverweis: string;
}

function alsMonitor(monitor: EreignisMonitor): NutzlastMonitor {
	return monitor.art === 'selbst'
		? {
				art: 'selbst',
				id: monitor.id,
				bezeichnung: monitor.bezeichnung,
				schluessel: monitor.schluessel
			}
		: { art: monitor.art, id: monitor.id, bezeichnung: monitor.bezeichnung };
}

export function nutzlast(daten: AlarmEreignisDaten, gesendetAm: Date): WebhookNutzlast {
	return {
		ereignis: daten.ereignis,
		alert_id: daten.alertId,
		vorgaenger_alert_id: daten.vorgaengerAlertId,
		gesendet_am: gesendetAm.toISOString(),
		weisung: daten.weisung,
		monitor: alsMonitor(daten.monitor),
		kunde: daten.kunde ? { id: daten.kunde.id, name: daten.kunde.name } : null,
		alarmgrund: daten.alarmgrund,
		erholungs_art: daten.erholungsArt,
		vorkommen: {
			anzahl: daten.zusammenfassung.vorkommen,
			erste_am: daten.zusammenfassung.ersteAm.toISOString(),
			letzte_am: daten.zusammenfassung.letzteAm.toISOString(),
			verschaerft_am: daten.zusammenfassung.verschaerftAm?.toISOString() ?? null,
			stoerungsdauer_sekunden: daten.zusammenfassung.stoerungsdauerSekunden
		},
		rueckverweis: daten.rueckverweis
	};
}

/**
 * The exact bytes that are sent — and therefore the exact bytes that are signed.
 *
 * Serialising **once** is the whole point of this function existing. Signing one `JSON.stringify`
 * and sending another would produce a signature that no receiver can verify, and nothing in the
 * delivery path would notice; the caller must pass this string to both.
 */
export function koerper(daten: AlarmEreignisDaten, gesendetAm: Date): string {
	return JSON.stringify(nutzlast(daten, gesendetAm));
}
