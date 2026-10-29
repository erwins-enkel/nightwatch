import { monitorArt, type MonitorArt } from '../db/schema/enums';
import type { Kalenderplan, MonitorParameter } from '../db/schema/monitor';
import { text } from '../zuordnung/formular';
import type { RegelZeile } from './regel';

/**
 * Die Formularfelder einer Regel — gelesen für den Wizard (#32) und für „Regel überarbeiten".
 *
 * Beide Flächen tragen dieselben Felder, weil sie dieselbe Sache anlegen bzw. ändern: „Die drei
 * Regel-Quellen münden in dieselbe Anlage-Fläche" (CONTEXT „Regel-Quelle"). Läge das Lesen zweimal
 * herum, wäre der Tag absehbar, an dem der Wizard ein Feld kennt, das die Überarbeitung verliert.
 */

/** Ein Muster je Zeile: Kommas kommen in Betreffs vor, Zeilenumbrüche nicht. */
export function zeilen(daten: FormData, feld: string): string[] {
	return text(daten, feld)
		.split('\n')
		.map((wert) => wert.trim())
		.filter((wert) => wert !== '');
}

/**
 * Leer heißt „nicht gesetzt", alles andere geht als Zahl weiter — auch Unsinn.
 *
 * `pruefeMonitor` weist NaN und negative Werte ohnehin mit einer benennbaren Meldung ab; hier schon
 * zu urteilen hieße, dieselbe Regel an zwei Stellen zu pflegen. `ganzzahlOderNull` passt nicht: es
 * verlangt echte Positivität, und Karenz, Offenzeit und Zählergrenzen dürfen 0 sein.
 */
export function zahl(roh: string): number | undefined {
	return roh === '' ? undefined : Number(roh);
}

export function istArt(wert: string): wert is MonitorArt {
	return (monitorArt.enumValues as readonly string[]).includes(wert);
}

function planAus(daten: FormData): Kalenderplan {
	return {
		wochentage: daten
			.getAll('wochentage')
			.map((wert) => Number(wert))
			.filter((wert) => Number.isInteger(wert)),
		uhrzeit: text(daten, 'uhrzeit')
	};
}

/**
 * Alle Parameter, unabhängig von der Art.
 *
 * `normalisiereParameter` wirft gleich darauf weg, was die gewählte Art nicht liest — hier wird
 * nicht vorsortiert, damit ein Wechsel der Art im Formular nicht die eben eingetippten Werte der
 * anderen Art verschluckt, bevor jemand zurückwechseln kann.
 */
export function parameterAus(daten: FormData): MonitorParameter {
	const modus = text(daten, 'erwartungModus');

	return {
		erwartungModus: modus === 'intervall' || modus === 'kalenderplan' ? modus : undefined,
		erwartungIntervallSekunden: zahl(text(daten, 'erwartungIntervallSekunden')),
		erwartungPlan: planAus(daten),
		karenzSekunden: zahl(text(daten, 'karenzSekunden')),
		autoZurueckSekunden: zahl(text(daten, 'autoZurueckSekunden')),
		maxOffenzeitSekunden: zahl(text(daten, 'maxOffenzeitSekunden')),
		zaehlerFensterSekunden: zahl(text(daten, 'zaehlerFensterSekunden')),
		zaehlerObergrenze: zahl(text(daten, 'zaehlerObergrenze')),
		zaehlerUntergrenze: zahl(text(daten, 'zaehlerUntergrenze'))
	};
}

export function regelAus(daten: FormData): RegelZeile {
	return {
		absender: zeilen(daten, 'absender'),
		betreffMuster: zeilen(daten, 'betreffMuster'),
		schluesselwoerter: zeilen(daten, 'schluesselwoerter'),
		musterSchlecht: zeilen(daten, 'musterSchlecht'),
		musterGut: zeilen(daten, 'musterGut')
	};
}

/** Jedes Feld des Formulars — die Liste, aus der auch die Rückgabe im Fehlerfall entsteht. */
export const FELDER = [
	'bezeichnung',
	'art',
	'erwartungModus',
	'erwartungIntervallSekunden',
	'uhrzeit',
	'karenzSekunden',
	'autoZurueckSekunden',
	'maxOffenzeitSekunden',
	'zaehlerFensterSekunden',
	'zaehlerObergrenze',
	'zaehlerUntergrenze',
	'entwarnungsStabilitaetSekunden',
	'absender',
	'betreffMuster',
	'schluesselwoerter',
	'musterSchlecht',
	'musterGut'
] as const;

export type Eingaben = Record<(typeof FELDER)[number], string> & { wochentage: string[] };

/**
 * Was eingetippt wurde, zurück ans Formular.
 *
 * Ohne das verlöre ein abgelehnter Speichern-Versuch ohne JavaScript die ganze Eingabe — und
 * ausgerechnet bei einer Regel, an der jemand gerade fünf Muster von Hand zusammengesucht hat.
 */
export function eingabenAus(daten: FormData): Eingaben {
	return {
		...(Object.fromEntries(FELDER.map((feld) => [feld, text(daten, feld)])) as Record<
			(typeof FELDER)[number],
			string
		>),
		wochentage: daten.getAll('wochentage').map(String)
	};
}
