import type { Kalenderplan, MonitorParameter } from '../db/schema/monitor';
import type { MonitorArt } from '../db/schema/enums';
import { kompiliereMuster, type RegelZeile } from './regel';

/**
 * Validation and normalisation of a monitor's per-kind parameters and its rule.
 *
 * The `monitor` table already carries the Dreiklang-Vertrag as CHECK constraints. This module says
 * the same thing one layer earlier and in a form a form can show: a constraint violation is a 500
 * with a constraint name in it, and „karenz_sekunden is not null" is not a sentence anyone wants to
 * read. Normalising *and* validating in one place is what keeps the two from disagreeing.
 */

/** CONTEXT „Ereignis-Monitor": „Auto-Zurück (Default 24 h)". */
export const AUTO_ZURUECK_DEFAULT_SEKUNDEN = 86_400;
/** CONTEXT „Paar-Monitor": „Default 0 = sofort alarmieren". */
export const MAX_OFFENZEIT_DEFAULT_SEKUNDEN = 0;

export type MonitorFehler =
	| 'bezeichnung_leer'
	| 'erwartung_fehlt'
	| 'erwartung_unvollstaendig'
	| 'karenz_fehlt'
	| 'auto_zurueck_ungueltig'
	| 'offenzeit_ungueltig'
	| 'fenster_fehlt'
	| 'grenze_fehlt'
	| 'grenzen_verdreht'
	| 'grenze_negativ'
	| 'stabilitaet_negativ'
	| 'kein_match_kriterium'
	| 'muster_ungueltig'
	| 'slot_ungenutzt';

/** Only the fields the kind owns, with the documented defaults filled in. */
export function normalisiereParameter(art: MonitorArt, roh: MonitorParameter): MonitorParameter {
	switch (art) {
		case 'heartbeat':
			return {
				erwartungModus: roh.erwartungModus,
				erwartungIntervallSekunden:
					roh.erwartungModus === 'intervall' ? roh.erwartungIntervallSekunden : undefined,
				erwartungPlan: roh.erwartungModus === 'kalenderplan' ? roh.erwartungPlan : undefined,
				karenzSekunden: roh.karenzSekunden
			};
		case 'ereignis':
			return { autoZurueckSekunden: roh.autoZurueckSekunden ?? AUTO_ZURUECK_DEFAULT_SEKUNDEN };
		case 'paar':
			return { maxOffenzeitSekunden: roh.maxOffenzeitSekunden ?? MAX_OFFENZEIT_DEFAULT_SEKUNDEN };
		case 'zaehler':
			return {
				zaehlerFensterSekunden: roh.zaehlerFensterSekunden,
				zaehlerObergrenze: roh.zaehlerObergrenze,
				zaehlerUntergrenze: roh.zaehlerUntergrenze
			};
	}
}

/**
 * Trimmed entries, empties dropped — an empty pattern would match everything or nothing.
 *
 * Slots the kind does not read are **not** silently dropped here; `pruefeMonitor` rejects them.
 * Someone who typed a failure pattern into an Ereignis rule has the wrong kind in mind, and
 * quietly discarding their input would hide that instead of correcting it.
 */
export function normalisiereRegel(roh: RegelZeile): RegelZeile {
	const putzen = (werte: string[]) =>
		werte.map((wert) => wert.trim()).filter((wert) => wert !== '');

	return {
		absender: putzen(roh.absender).map((wert) => wert.toLowerCase()),
		betreffMuster: putzen(roh.betreffMuster),
		schluesselwoerter: putzen(roh.schluesselwoerter),
		musterSchlecht: putzen(roh.musterSchlecht),
		musterGut: putzen(roh.musterGut)
	};
}

function istPositiv(wert: number | null | undefined): boolean {
	return typeof wert === 'number' && Number.isInteger(wert) && wert > 0;
}

function istNichtNegativ(wert: number | null | undefined): boolean {
	return typeof wert === 'number' && Number.isInteger(wert) && wert >= 0;
}

function planIstVollstaendig(plan: Kalenderplan | undefined): boolean {
	if (!plan) return false;
	if (!Array.isArray(plan.wochentage) || plan.wochentage.length === 0) return false;
	if (!plan.wochentage.every((tag) => Number.isInteger(tag) && tag >= 1 && tag <= 7)) return false;
	return /^([01]\d|2[0-3]):[0-5]\d$/.test(plan.uhrzeit ?? '');
}

export interface MonitorPruefung {
	bezeichnung: string;
	art: MonitorArt;
	parameter: MonitorParameter;
	entwarnungsStabilitaetSekunden?: number | null;
	regel: RegelZeile;
}

/**
 * Every problem at once, so a form can mark all its fields instead of one per round trip.
 *
 * Expects normalised input; `legeMonitorAn`/`aktualisiereMonitor` normalise before they check.
 */
export function pruefeMonitor(eingabe: MonitorPruefung): MonitorFehler[] {
	const fehler: MonitorFehler[] = [];
	const { parameter: p, regel } = eingabe;

	if (eingabe.bezeichnung.trim() === '') fehler.push('bezeichnung_leer');

	if (
		eingabe.entwarnungsStabilitaetSekunden !== null &&
		eingabe.entwarnungsStabilitaetSekunden !== undefined &&
		!istNichtNegativ(eingabe.entwarnungsStabilitaetSekunden)
	) {
		fehler.push('stabilitaet_negativ');
	}

	switch (eingabe.art) {
		case 'heartbeat':
			if (!p.erwartungModus) fehler.push('erwartung_fehlt');
			else if (
				p.erwartungModus === 'intervall'
					? !istPositiv(p.erwartungIntervallSekunden)
					: !planIstVollstaendig(p.erwartungPlan)
			) {
				fehler.push('erwartung_unvollstaendig');
			}
			// „Immer mit Karenz" (CONTEXT „Erwartung") — 0 is a valid choice, absent is not.
			if (!istNichtNegativ(p.karenzSekunden)) fehler.push('karenz_fehlt');
			break;

		case 'ereignis':
			if (!istPositiv(p.autoZurueckSekunden)) fehler.push('auto_zurueck_ungueltig');
			break;

		case 'paar':
			if (!istNichtNegativ(p.maxOffenzeitSekunden)) fehler.push('offenzeit_ungueltig');
			break;

		case 'zaehler': {
			if (!istPositiv(p.zaehlerFensterSekunden)) fehler.push('fenster_fehlt');

			const oben = p.zaehlerObergrenze ?? null;
			const unten = p.zaehlerUntergrenze ?? null;
			// „mindestens eine Grenze ist gesetzt" (CONTEXT „Zähl-Monitor").
			if (oben === null && unten === null) fehler.push('grenze_fehlt');
			if ([oben, unten].some((grenze) => grenze !== null && !istNichtNegativ(grenze))) {
				fehler.push('grenze_negativ');
			}
			// An upper bound below the lower one would leave the monitor permanently disturbed with no
			// reachable healthy state.
			if (oben !== null && unten !== null && oben < unten) fehler.push('grenzen_verdreht');
			break;
		}
	}

	// A rule without any criterion would swallow every mail of its customer and starve every other
	// monitor of that customer — the Match-Kriterien are what make a monitor "mine" (CONTEXT).
	if (
		regel.absender.length === 0 &&
		regel.betreffMuster.length === 0 &&
		regel.schluesselwoerter.length === 0
	) {
		fehler.push('kein_match_kriterium');
	}

	const alleMuster = [...regel.betreffMuster, ...regel.musterSchlecht, ...regel.musterGut];
	if (alleMuster.some((muster) => kompiliereMuster(muster) === null))
		fehler.push('muster_ungueltig');

	// „Ereignis: — / Harmlos-Filter" and „der Zähler nutzt sie nicht" (CONTEXT „Muster-Slots").
	const ungenutzt =
		eingabe.art === 'zaehler'
			? regel.musterSchlecht.length + regel.musterGut.length
			: eingabe.art === 'ereignis'
				? regel.musterSchlecht.length
				: 0;
	if (ungenutzt > 0) fehler.push('slot_ungenutzt');

	return fehler;
}
