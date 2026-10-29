import type { Tagesspalte } from '../../board/anzeige';
import type { ErwartungModus, Klassifikation, MonitorArt } from '../db/schema/enums';
import type { Kalenderplan } from '../db/schema/monitor';
import { istPausiert, type ZustandsSicht } from '../monitor/zustand';
import {
	RUECKBLICK_TAGE,
	sollZeitpunkte,
	zuBewertendeSolls,
	type PlanKontext
} from '../zeit/kalenderplan';
import {
	TAG_MS,
	isoDatum,
	isoWochentag,
	tagesBeginn,
	tagesEnde,
	zonenDatum,
	zonenTeile
} from '../zeit/zeitzone';

/**
 * „Erwartet vs. eingetroffen" über sieben Tage — die Zeitachse im Monitor-Drawer (SPEC §9).
 *
 * Eine **Darstellung**, kein zweiter Entscheider. Der Zustand eines Monitors steht in
 * `monitor.zustand` und wird vom Scheduler (#26) geschrieben; diese Achse rechnet nur nach, welche
 * Soll-Zeitpunkte im Fenster lagen und welche Mail sie gedeckt hat. Damit beide dasselbe sagen,
 * benutzt sie dieselben Bausteine — `sollZeitpunkte`, `zuBewertendeSolls` und die Instanz-Zeitzone
 * — statt die Regeln ein zweites Mal zu formulieren.
 *
 * Pur, wie `zeit/faelligkeit.ts`: alle Fakten kommen fertig herein, damit jede Regel im Test eine
 * Tabellenzeile ist.
 */

export const ACHSE_TAGE = 7;

/**
 * Wie weit vor dem Fenster Ankünfte mitgeliefert werden müssen.
 *
 * Das Deckungsfenster eines Soll reicht bis zum vorherigen wirksamen Soll zurück — bei einem
 * Wochenplan mit Ausnahmetagen bis zu `RUECKBLICK_TAGE`. Ohne diese Ankünfte hielte die Achse den
 * ersten Soll des Fensters für ungedeckt, nur weil die deckende Mail knapp davor eintraf.
 */
export const VORLAUF_TAGE = RUECKBLICK_TAGE;

/** Der Monitor, wie die Achse ihn liest. */
export interface AchsenSicht extends ZustandsSicht {
	art: MonitorArt;
	/** Null beim Entwurf: dann wurde nie etwas beurteilt (CONTEXT „Lernfenster"). */
	aktiviertAm: Date | null;
	erwartungModus: ErwartungModus | null;
	erwartungIntervallSekunden: number | null;
	erwartungPlan: Kalenderplan | null;
	karenzSekunden: number | null;
}

export interface Ankunft {
	ankunftszeit: Date;
	klassifikation: Klassifikation | null;
}

export interface AchsenKontext {
	/** IANA-Zone aus `einstellungen.zeitzone` — dieselbe, gegen die der Scheduler rechnet. */
	zone: string;
	/** `YYYY-MM-DD`-Ausnahmetage dieses Monitors. */
	ausnahmetage: ReadonlySet<string>;
	/**
	 * Die Ankünfte ab `Fensterbeginn − VORLAUF_TAGE`, aufsteigend. Nur die im Fenster landen in
	 * einer Spalte; die älteren tragen die Deckungsprüfung und die Intervall-Kette.
	 */
	ankuenfte: Ankunft[];
}

/** „Fehler gewinnt vor ok" (CONTEXT „Klassifikation"); unklar liegt dazwischen. */
const KLASSIFIKATION_RANG: Record<Klassifikation, number> = { fehler: 3, unklar: 2, ok: 1 };

function schlechtere(a: Klassifikation | null, b: Klassifikation | null): Klassifikation | null {
	if (a === null) return b;
	if (b === null) return a;
	return KLASSIFIKATION_RANG[b] > KLASSIFIKATION_RANG[a] ? b : a;
}

/**
 * Die letzten `anzahl` Kalendertage der Zone, ältester zuerst.
 *
 * Auf dem proleptischen Kalender gelaufen statt in 24-Stunden-Schritten auf Instants: ein Tag mit
 * Zeitumstellung hat 23 oder 25 Stunden, und das Addieren von Instants würde wegdriften.
 */
function letzteTage(jetzt: Date, zone: string, anzahl: number) {
	const heute = zonenTeile(jetzt, zone);
	const anker = Date.UTC(heute.jahr, heute.monat - 1, heute.tag);
	const tage: { datum: string; wochentag: number }[] = [];

	for (let versatz = anzahl - 1; versatz >= 0; versatz -= 1) {
		const tag = new Date(anker - versatz * TAG_MS);
		const jahr = tag.getUTCFullYear();
		const monat = tag.getUTCMonth() + 1;
		const tagImMonat = tag.getUTCDate();
		tage.push({
			datum: isoDatum({ jahr, monat, tag: tagImMonat }),
			wochentag: isoWochentag(jahr, monat, tagImMonat)
		});
	}

	return tage;
}

function leereSpalte(datum: string, wochentag: number): Tagesspalte {
	return {
		datum,
		wochentag,
		eingetroffen: 0,
		klassifikation: null,
		erwartet: 0,
		verfehlt: 0,
		ausnahmetag: false,
		vorAktivierung: false,
		pausiert: false
	};
}

/**
 * Der Kalenderplan: diskrete Soll-Zeitpunkte, jeder mit seinem Deckungsfenster.
 *
 * `zuBewertendeSolls` liefert genau die Solls, über die der Scheduler ein Urteil fällt — inklusive
 * der Anlauf-Regel, dass ein Fenster nicht vor die Aktivierung reichen darf. Alles, was darin nicht
 * vorkommt, ist entweder noch nicht fällig (dann steht es als Erwartung) oder lag vor der
 * Aktivierung (dann gehört es diesem Monitor nicht).
 */
function kalenderplanErwartung(
	spalten: Map<string, Tagesspalte>,
	sicht: AchsenSicht,
	kontext: AchsenKontext,
	aktiviertAm: Date,
	fensterVon: Date,
	fensterBis: Date,
	jetzt: Date
): void {
	const plan = sicht.erwartungPlan;
	const karenzSekunden = sicht.karenzSekunden;
	if (plan === null || karenzSekunden === null) return;

	const planKontext: PlanKontext = { plan, zone: kontext.zone, ausnahmetage: kontext.ausnahmetage };
	const karenzMs = karenzSekunden * 1000;

	// `sollZeitpunkte` liefert `(von, bis]`; die Millisekunde davor holt den Fensterbeginn mit herein.
	const alle = sollZeitpunkte(planKontext, new Date(fensterVon.getTime() - 1), fensterBis);
	const beurteilt = new Map(
		zuBewertendeSolls(planKontext, karenzSekunden, aktiviertAm, fensterVon, jetzt).map(
			(bewertung) => [bewertung.soll.getTime(), bewertung]
		)
	);

	for (const soll of alle) {
		const spalte = spalten.get(zonenDatum(soll, kontext.zone));
		if (spalte === undefined) continue;

		const bewertung = beurteilt.get(soll.getTime());
		if (bewertung === undefined) {
			// Noch nicht fällig heißt „erwartet"; alles Ältere lag vor der Aktivierung.
			if (soll.getTime() + karenzMs > jetzt.getTime()) spalte.erwartet += 1;
			continue;
		}

		spalte.erwartet += 1;
		const abgedeckt = kontext.ankuenfte.some(
			(ankunft) =>
				ankunft.ankunftszeit > bewertung.fensterVon && ankunft.ankunftszeit <= bewertung.fensterBis
		);
		if (!abgedeckt) spalte.verfehlt += 1;
	}
}

/**
 * Die Intervall-Erwartung: „die Uhr startet bei jeder eingetroffenen Mail neu" (CONTEXT
 * „Intervall"). Verfehlt ist eine *Lücke*, nicht jedes verstrichene Intervall — genau wie der
 * Scheduler pro Lücke ein Vorkommen meldet und nicht pro Tick.
 */
function intervallErwartung(
	spalten: Map<string, Tagesspalte>,
	sicht: AchsenSicht,
	kontext: AchsenKontext,
	aktiviertAm: Date,
	jetzt: Date
): void {
	const intervall = sicht.erwartungIntervallSekunden;
	const karenz = sicht.karenzSekunden;
	if (intervall === null || karenz === null) return;

	const grenzeMs = (intervall + karenz) * 1000;

	const markiere = (frist: Date) => {
		const spalte = spalten.get(zonenDatum(frist, kontext.zone));
		if (spalte !== undefined) spalte.verfehlt += 1;
	};

	let vorher = aktiviertAm;
	for (const ankunft of kontext.ankuenfte) {
		if (ankunft.ankunftszeit <= vorher) continue;
		if (ankunft.ankunftszeit.getTime() - vorher.getTime() > grenzeMs) {
			markiere(new Date(vorher.getTime() + grenzeMs));
		}
		vorher = ankunft.ankunftszeit;
	}

	if (jetzt.getTime() - vorher.getTime() > grenzeMs) {
		markiere(new Date(vorher.getTime() + grenzeMs));
	}
}

export function baueZeitachse(
	sicht: AchsenSicht,
	kontext: AchsenKontext,
	jetzt: Date
): Tagesspalte[] {
	const tage = letzteTage(jetzt, kontext.zone, ACHSE_TAGE);
	const spalten = new Map(
		tage.map(({ datum, wochentag }) => [datum, leereSpalte(datum, wochentag)])
	);

	for (const spalte of spalten.values()) {
		spalte.ausnahmetag = kontext.ausnahmetage.has(spalte.datum);
		spalte.vorAktivierung =
			sicht.aktiviertAm === null || tagesEnde(spalte.datum, kontext.zone) <= sicht.aktiviertAm;
	}

	for (const ankunft of kontext.ankuenfte) {
		const spalte = spalten.get(zonenDatum(ankunft.ankunftszeit, kontext.zone));
		if (spalte === undefined) continue;
		spalte.eingetroffen += 1;
		spalte.klassifikation = schlechtere(spalte.klassifikation, ankunft.klassifikation);
	}

	const heute = spalten.get(tage[tage.length - 1].datum);
	if (heute !== undefined && istPausiert(sicht, jetzt)) heute.pausiert = true;

	const aktiviertAm = sicht.aktiviertAm;
	if (aktiviertAm !== null && sicht.art === 'heartbeat') {
		// Die Aktivierung braucht hier keine Untergrenze zu setzen — `zuBewertendeSolls` verwirft
		// jedes Deckungsfenster, das vor sie zurückreicht, und ist damit die einzige Stelle, die
		// die Anlauf-Regel kennt.
		const fensterVon = tagesBeginn(tage[0].datum, kontext.zone);
		const fensterBis = tagesEnde(tage[tage.length - 1].datum, kontext.zone);

		if (sicht.erwartungModus === 'kalenderplan') {
			kalenderplanErwartung(spalten, sicht, kontext, aktiviertAm, fensterVon, fensterBis, jetzt);
		} else if (sicht.erwartungModus === 'intervall') {
			intervallErwartung(spalten, sicht, kontext, aktiviertAm, jetzt);
		}
	}

	return [...spalten.values()];
}
