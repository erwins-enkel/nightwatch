import { error, fail } from '@sveltejs/kit';
import { monitorArt, type MonitorArt } from '$lib/server/db/schema/enums';
import type { Kalenderplan } from '$lib/server/db/schema/monitor';
import { aktualisiereMonitor, holeMonitor, setzeAktivierung } from '$lib/server/monitor/db';
import { text } from '$lib/server/zuordnung/formular';
import type { Actions, PageServerLoad } from './$types';

/**
 * „Regel überarbeiten" (CONTEXT) — der Rückverweis aus dem Monitor-Drawer.
 *
 * Bewusst ein Formular und kein Assistent: das Anlegen einer Regel ist ein eigener Weg mit
 * Vorlagen, Ableitung aus einer Mail und vier Schritten (#32). Wer hier landet, hat einen laufenden
 * Monitor, dessen Erkennung nicht stimmt — meistens, weil er „unklar" meldet und die
 * Zustandsmaschine genau hierher zeigt (`empfohleneAktion`).
 *
 * Der Kunde steht nicht zur Wahl: ein Monitor gehört genau einem, und ihn umzuhängen ließe seine
 * bisherigen Mails und seine Alarm-Historie bei jemand anderem zurück.
 */

export const load: PageServerLoad = async ({ params }) => {
	const monitor = await holeMonitor(params.id);
	if (monitor === undefined) error(404, 'Monitor nicht gefunden');

	return { monitor, arten: monitorArt.enumValues };
};

function istArt(wert: string): wert is MonitorArt {
	return (monitorArt.enumValues as readonly string[]).includes(wert);
}

/** Ein Muster je Zeile: Kommas kommen in Betreffs vor, Zeilenumbrüche nicht. */
function zeilen(daten: FormData, feld: string): string[] {
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
function zahl(roh: string): number | undefined {
	return roh === '' ? undefined : Number(roh);
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

/** Jedes Feld des Formulars — die Liste, aus der auch die Rückgabe im Fehlerfall entsteht. */
const FELDER = [
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

type Eingaben = Record<(typeof FELDER)[number], string> & { wochentage: string[] };

/**
 * Was eingetippt wurde, zurück ans Formular.
 *
 * Ohne das verlöre ein abgelehnter Speichern-Versuch ohne JavaScript die ganze Eingabe — und
 * ausgerechnet bei einer Regel, an der jemand gerade fünf Muster von Hand zusammengesucht hat.
 */
function eingabenAus(daten: FormData): Eingaben {
	return {
		...(Object.fromEntries(FELDER.map((feld) => [feld, text(daten, feld)])) as Record<
			(typeof FELDER)[number],
			string
		>),
		wochentage: daten.getAll('wochentage').map(String)
	};
}

export const actions: Actions = {
	speichern: async ({ request, params }) => {
		const daten = await request.formData();
		const eingaben = eingabenAus(daten);

		const art = text(daten, 'art');
		if (!istArt(art)) return fail(400, { fehler: ['art_unbekannt'], eingaben });

		const modus = text(daten, 'erwartungModus');

		const ergebnis = await aktualisiereMonitor(params.id, {
			// Wird von `aktualisiereMonitor` nicht geschrieben; die Eingabe verlangt das Feld.
			kundeId: '',
			bezeichnung: text(daten, 'bezeichnung'),
			art,
			parameter: {
				erwartungModus: modus === 'intervall' || modus === 'kalenderplan' ? modus : undefined,
				erwartungIntervallSekunden: zahl(text(daten, 'erwartungIntervallSekunden')),
				erwartungPlan: planAus(daten),
				karenzSekunden: zahl(text(daten, 'karenzSekunden')),
				autoZurueckSekunden: zahl(text(daten, 'autoZurueckSekunden')),
				maxOffenzeitSekunden: zahl(text(daten, 'maxOffenzeitSekunden')),
				zaehlerFensterSekunden: zahl(text(daten, 'zaehlerFensterSekunden')),
				zaehlerObergrenze: zahl(text(daten, 'zaehlerObergrenze')),
				zaehlerUntergrenze: zahl(text(daten, 'zaehlerUntergrenze'))
			},
			entwarnungsStabilitaetSekunden: zahl(text(daten, 'entwarnungsStabilitaetSekunden')) ?? null,
			regel: {
				absender: zeilen(daten, 'absender'),
				betreffMuster: zeilen(daten, 'betreffMuster'),
				schluesselwoerter: zeilen(daten, 'schluesselwoerter'),
				musterSchlecht: zeilen(daten, 'musterSchlecht'),
				musterGut: zeilen(daten, 'musterGut')
			},
			// Eine von Hand überarbeitete Regel ist von Hand gemacht, was immer sie vorher war
			// (CONTEXT „Regel-Quelle": die drei Werte sind Vorbefüllungs-Grade, keine Herkunftsurkunde).
			quelle: 'manuell'
		});

		if (ergebnis.art === 'ungueltig') {
			return fail(400, { fehler: ergebnis.fehler as string[], eingaben });
		}
		if (ergebnis.art === 'unbekannt') return fail(404, { fehler: ['unbekannt'], eingaben });

		return { erfolg: 'gespeichert' as const };
	},

	/**
	 * Das Bestätigungs-Gate (SPEC §5). Es steht hier, weil eine überarbeitete Regel genau der
	 * Moment ist, in dem jemand sie bestätigt — und weil ein Entwurf sonst nirgends scharf würde.
	 */
	aktivierung: async ({ request, params }) => {
		const aktiv = text(await request.formData(), 'aktiv') === 'true';
		await setzeAktivierung(params.id, aktiv, new Date());

		return { erfolg: aktiv ? ('aktiviert' as const) : ('deaktiviert' as const) };
	}
};
