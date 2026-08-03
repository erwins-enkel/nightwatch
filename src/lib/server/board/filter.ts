import type { AnzeigeZustand } from '../../board/anzeige';
import type { MonitorArt } from '../db/schema/enums';
import { istPausiert, type ZustandsSicht } from '../monitor/zustand';

/**
 * What the Kundenboard shows, decided without a database (SPEC §9).
 *
 * The board itself decides nothing about monitoring — `monitor.zustand` is the truth and is written
 * elsewhere. What is left here is presentation: which single badge a monitor wears, how a customer
 * card summarises its monitors, and what the search and the two filters select. All of it is
 * comparison over rows, so every rule is a table row in the test rather than a fixture.
 */

/** Re-exported so a caller of `baueKarten` does not have to know where the badge type lives. */
export type { AnzeigeZustand };

/** The order the customer traffic light reads in: the worst thing about a customer wins. */
const AMPEL_RANG: AnzeigeZustand[] = ['gestoert', 'pausiert', 'gesund', 'entwurf'];

/** One monitor, as the board reads it. */
export interface BoardMonitorZeile extends ZustandsSicht {
	id: string;
	kundeId: string;
	bezeichnung: string;
	art: MonitorArt;
	zustandSeit: Date;
	/** Null while the monitor is a draft — SPEC §5, it evaluates nothing until confirmed. */
	aktiviertAm: Date | null;
	zuletztGesehenAm: Date | null;
}

export interface BoardMonitor extends BoardMonitorZeile {
	anzeige: AnzeigeZustand;
	/**
	 * Whether the pause is in effect right now, independently of the badge.
	 *
	 * A disturbed monitor under maintenance is both, and shows as disturbed — the episode is open
	 * and the alarm strip lists it, so a „pausiert" badge would hide a live disruption. The flag
	 * keeps the maintenance visible next to it.
	 */
	pauseWirksam: boolean;
}

export interface KundenZeile {
	id: string;
	name: string;
	kundennummer: string | null;
	autotaskCompanyId: number | null;
}

export interface KundenKarte {
	kunde: KundenZeile;
	/**
	 * Over **all** of the customer's monitors, never over the filtered ones: a card that reads
	 * „gesund" because the operator filtered for healthy monitors would be a lie about a customer
	 * who has a disruption. The filter selects which cards appear; it never edits their summary.
	 */
	ampel: AnzeigeZustand;
	zaehler: Record<AnzeigeZustand, number>;
	gesamt: number;
	/** The monitors this search and these filters selected — what the card lists when one is set. */
	treffer: BoardMonitor[];
}

export interface BoardFilter {
	/** Free text over customer name, customer number and monitor label. */
	suche: string;
	zustand: AnzeigeZustand | null;
	art: MonitorArt | null;
}

export const LEERER_FILTER: BoardFilter = { suche: '', zustand: null, art: null };

/**
 * „Entwurf" outranks everything: a monitor that was never confirmed evaluates nothing at all
 * (CONTEXT „Lernfenster"), so neither its state nor its pause says anything about the watched
 * system. Below that the disruption outranks the pause, for the reason on `pauseWirksam`.
 */
export function anzeigeZustand(zeile: BoardMonitorZeile, jetzt: Date): AnzeigeZustand {
	if (zeile.aktiviertAm === null) return 'entwurf';
	if (zeile.zustand === 'gestoert') return 'gestoert';
	if (istPausiert(zeile, jetzt)) return 'pausiert';
	return 'gesund';
}

export function alsBoardMonitor(zeile: BoardMonitorZeile, jetzt: Date): BoardMonitor {
	return {
		...zeile,
		anzeige: anzeigeZustand(zeile, jetzt),
		pauseWirksam: istPausiert(zeile, jetzt)
	};
}

function enthaelt(wert: string | null, begriff: string): boolean {
	return wert !== null && wert.toLowerCase().includes(begriff);
}

/**
 * The state filter, with the one deliberate asymmetry to the badge: asking for „pausiert" also
 * finds the disturbed monitors that are under maintenance. They wear the disruption's badge, but
 * they *are* what the question was about.
 */
function passtZustand(monitor: BoardMonitor, gesucht: AnzeigeZustand | null): boolean {
	if (gesucht === null) return true;
	if (gesucht === 'pausiert') return monitor.pauseWirksam || monitor.anzeige === 'pausiert';
	return monitor.anzeige === gesucht;
}

function leereZaehler(): Record<AnzeigeZustand, number> {
	return { gestoert: 0, pausiert: 0, entwurf: 0, gesund: 0 };
}

/** The worst badge among the customer's monitors; „entwurf" also covers having none at all. */
function ampel(monitore: BoardMonitor[]): AnzeigeZustand {
	for (const zustand of AMPEL_RANG) {
		if (monitore.some((monitor) => monitor.anzeige === zustand)) return zustand;
	}
	return 'entwurf';
}

/**
 * The board's card list.
 *
 * A customer survives when the search names them — then all their monitors are candidates — or when
 * one of their monitors does. The two structural filters are stricter than the search: once the
 * operator asks for „gestört" or for a Monitor-Art, a customer without such a monitor is not an
 * answer to the question, however well their name matches.
 */
export function baueKarten(
	kunden: KundenZeile[],
	zeilen: BoardMonitorZeile[],
	filter: BoardFilter,
	jetzt: Date
): KundenKarte[] {
	const begriff = filter.suche.trim().toLowerCase();
	const strukturFilter = filter.zustand !== null || filter.art !== null;

	const jeKunde = new Map<string, BoardMonitor[]>();
	for (const zeile of zeilen) {
		const monitor = alsBoardMonitor(zeile, jetzt);
		const vorhanden = jeKunde.get(monitor.kundeId);
		if (vorhanden) vorhanden.push(monitor);
		else jeKunde.set(monitor.kundeId, [monitor]);
	}

	const karten: KundenKarte[] = [];

	for (const kunde of kunden) {
		const monitore = jeKunde.get(kunde.id) ?? [];
		const kundeTrifft =
			begriff === '' || enthaelt(kunde.name, begriff) || enthaelt(kunde.kundennummer, begriff);

		const treffer = monitore.filter(
			(monitor) =>
				(kundeTrifft || enthaelt(monitor.bezeichnung, begriff)) &&
				passtZustand(monitor, filter.zustand) &&
				(filter.art === null || monitor.art === filter.art)
		);

		if (!kundeTrifft && treffer.length === 0) continue;
		if (strukturFilter && treffer.length === 0) continue;

		const zaehler = leereZaehler();
		for (const monitor of monitore) zaehler[monitor.anzeige] += 1;

		karten.push({
			kunde,
			ampel: ampel(monitore),
			zaehler,
			gesamt: monitore.length,
			treffer
		});
	}

	return karten;
}
