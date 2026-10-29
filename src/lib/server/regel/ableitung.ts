import type { MonitorArt } from '../db/schema/enums';
import type { Kalenderplan, MonitorParameter } from '../db/schema/monitor';
import { AUTO_ZURUECK_DEFAULT_SEKUNDEN } from '../monitor/parameter';
import { Heuhaufen, kompiliereRegel, slotTreffer, type RegelZeile } from '../monitor/regel';
import { zonenDatum } from '../zeit/zeitzone';
import { alsBetreffMuster } from '../../regel/muster';
import { betreffMuster } from '../zuordnung/sorte';
import { TAKT_STREUUNG_BODEN_SEKUNDEN, type Takt } from './takt';

/**
 * Schicht 1 der Ableitung aus einer Beispiel-Mail (CONTEXT „Vorbefüllungs-Grad").
 *
 * Der Leitsatz, an dem sich hier alles entscheidet:
 *
 * > **Schicht 1 befüllt Zeitliches und Strukturelles, nie Inhaltliches.**
 *
 * Match-Kriterien, Takt → Erwartung, Karenz aus der Streuung, Zähler-Fenster und -Grenzen aus der
 * Lernfenster-Statistik, Paar-Offenzeit nachgelagert. Die **Muster-Slots bleiben leer** — welcher
 * Satz in einem Report „alles gut" bedeutet, markiert der Mensch (Schicht 2). Der Klassifikator
 * wird hier bewusst *nicht* gefragt: er wirkt zur Laufzeit und senkt die Unklar-Quote eintreffender
 * Mails, er schlägt keine Muster vor (CONTEXT „Klassifikator").
 *
 * Als Art vermutet die Automatik nur **Heartbeat** (Takt erkannt) oder **Ereignis** (kein Takt);
 * Paar und Zähler wählt der Mensch bewusst. Und jeder Vorschlag trägt seinen **Beleg** — ein
 * vorbefülltes Feld ohne Begründung wäre eine Behauptung, die niemand prüfen kann.
 *
 * Rein und ohne Datenbank: `regel/db.ts` besorgt Beispiel-Mail und Ankunftszeiten, hier wird nur
 * gerechnet.
 */

/**
 * Die Begründung eines einzelnen Vorschlags.
 *
 * Strukturiert statt als fertiger Satz, weil die Oberfläche zweisprachig ist (SPEC §13): die
 * Ansicht setzt daraus „werktäglich ~05:40, aus 12 Vorkommen" oder ihr englisches Gegenstück.
 */
export type Beleg =
	| { grund: 'match'; absender: string; betreffMuster: string }
	| { grund: 'takt'; takt: Takt }
	| { grund: 'kein_takt'; vorkommen: number }
	| { grund: 'karenz'; streuungSekunden: number }
	| { grund: 'zaehler'; medianProTag: number; tage: number }
	| { grund: 'offenzeit'; maxSekunden: number; paare: number };

export interface Vorbefuellung {
	bezeichnung: string;
	art: MonitorArt;
	regel: RegelZeile;
	parameter: MonitorParameter;
	belege: Beleg[];
}

/** Die Teile der Beispiel-Mail, aus denen Schicht 1 schöpft. */
export interface BeispielMail {
	absender: string;
	betreff: string;
}

/**
 * Vorbefüllt eine Regel aus einer Beispiel-Mail und dem Takt ihrer Sorte.
 *
 * Der Takt kommt **fertig herein**, aus `mail_sorte`, statt hier neu gerechnet zu werden: die
 * Sorten-Ansicht zeigt denselben Wert, und zwei Rechnungen über dieselbe Sorte dürfen sich nicht
 * unterscheiden — „diese Sorte kommt werktäglich" in der Liste und eine andere Erwartung im Wizard
 * wäre ein Widerspruch, den niemand auflösen kann.
 *
 * `takt` darf `null` sein — dann ist die Art-Vermutung `ereignis`, und der Beleg sagt genau das.
 * Der Fall ist real: eine Mail aus der System-Triage hat noch keinen Kunden und damit keine Sorte,
 * aus der sich ein Rhythmus lesen ließe.
 */
export function leiteAb(
	beispiel: BeispielMail,
	takt: Takt | null,
	vorkommen: number
): Vorbefuellung {
	const belege: Beleg[] = [];

	const signatur = betreffMuster(beispiel.betreff);
	const absender = beispiel.absender.trim().toLowerCase();
	belege.push({ grund: 'match', absender, betreffMuster: signatur });

	const regel: RegelZeile = {
		absender: absender === '' ? [] : [absender],
		betreffMuster: [alsBetreffMuster(signatur)].filter((muster) => muster !== ''),
		schluesselwoerter: [],
		// Schicht 2, Menschensache.
		musterSchlecht: [],
		musterGut: []
	};

	if (!takt) {
		belege.push({ grund: 'kein_takt', vorkommen });
		return {
			bezeichnung: bezeichnungAus(signatur, absender),
			art: 'ereignis',
			regel,
			// Die Auto-Zurück-Zeit ist der dokumentierte Default, kein abgeleiteter Wert — deshalb
			// trägt sie keinen Beleg. „Auto-Zurück-Zeit … ist immer Menschensache" (CONTEXT).
			parameter: { autoZurueckSekunden: AUTO_ZURUECK_DEFAULT_SEKUNDEN },
			belege
		};
	}

	belege.push({ grund: 'takt', takt });
	belege.push({ grund: 'karenz', streuungSekunden: takt.streuungSekunden });

	return {
		bezeichnung: bezeichnungAus(signatur, absender),
		art: 'heartbeat',
		parameter: {
			...taktAlsErwartung(takt),
			karenzSekunden: karenzAusStreuung(takt.streuungSekunden)
		},
		regel,
		belege
	};
}

/** Ein Vorschlag für den Monitor-Namen; der Mensch überschreibt ihn im ersten Schritt. */
function bezeichnungAus(signatur: string, absender: string): string {
	const roh = signatur.trim() === '' ? absender : signatur;
	return roh.length > 80 ? `${roh.slice(0, 79)}…` : roh;
}

// ---------------------------------------------------------------------------------------------
// Takt → Erwartung und Karenz
// ---------------------------------------------------------------------------------------------

/** ISO-Wochentage Montag–Freitag bzw. Montag–Sonntag. */
const WERKTAGE = [1, 2, 3, 4, 5];
const ALLE_TAGE = [1, 2, 3, 4, 5, 6, 7];

/**
 * Der erkannte Takt als Erwartung (CONTEXT „Erwartung").
 *
 * Die drei Kalender-Klassen werden zum **Kalenderplan**, nicht zu einem 24-Stunden-Intervall: nur er
 * kennt Wochentage und Uhrzeiten, und nur mit ihm bleibt „bis 06:00" über die Sommerzeit hinweg
 * 06:00. Ein Intervall ließe den Soll-Zeitpunkt mit jedem verspäteten Lauf mitwandern.
 */
export function taktAlsErwartung(takt: Takt): MonitorParameter {
	if (takt.klasse === 'intervall') {
		return { erwartungModus: 'intervall', erwartungIntervallSekunden: takt.intervallSekunden };
	}

	const plan: Kalenderplan = {
		wochentage:
			takt.klasse === 'werktaeglich'
				? WERKTAGE
				: takt.klasse === 'woechentlich'
					? [takt.wochentag ?? 1]
					: ALLE_TAGE,
		uhrzeit: takt.uhrzeit ?? '00:00'
	};

	return { erwartungModus: 'kalenderplan', erwartungPlan: plan };
}

/**
 * Die Karenz aus der beobachteten Streuung: **so unpünktlich, wie es schon war, plus den Boden**.
 *
 * Die Streuung allein wäre zu knapp — sie ist per Definition genau die größte Verspätung, die schon
 * einmal vorkam, und der nächste Lauf, der sie um eine Sekunde überbietet, alarmierte. Der Boden von
 * 15 Minuten ist derselbe, mit dem die Takt-Erkennung „alle 5 min ± 2 min" durchgehen lässt; er
 * dient hier als Luft nach oben und als Untergrenze für den perfekt pünktlichen Fall.
 */
export function karenzAusStreuung(streuungSekunden: number): number {
	const roh = Math.max(0, streuungSekunden) + TAKT_STREUUNG_BODEN_SEKUNDEN;
	return aufVielfaches(roh, 300);
}

/** Auf volle Fünf-Minuten-Schritte aufgerundet — Karenzen sind keine Sekunden-Angaben. */
function aufVielfaches(sekunden: number, schritt: number): number {
	return Math.ceil(sekunden / schritt) * schritt;
}

// ---------------------------------------------------------------------------------------------
// Zähler
// ---------------------------------------------------------------------------------------------

const TAG_SEKUNDEN = 86_400;

export interface ZaehlerVorschlag {
	parameter: MonitorParameter;
	beleg: Beleg;
}

/**
 * Fenster und Grenzen eines Zähl-Monitors aus der Lernfenster-Statistik (CONTEXT „Zähl-Monitor":
 * „Der ‚erlernte Normalwert' ist **Vorbefüllung** der Grenzen, keine Laufzeit-Baseline").
 *
 * Fenster 24 h, Band vom halben bis zum doppelten Median der Tageszahlen. Der Faktor zwei ist
 * bewusst grob: der Zähler ist nie die Art-Vermutung, sondern eine bewusste Wahl des Menschen, und
 * ein zu enges Band, das er nicht bemerkt, wäre teurer als ein weites, das er nachschärft.
 *
 * Der erste und der letzte Tag fallen heraus — beide sind angeschnitten (das Lernfenster beginnt und
 * endet mitten am Tag) und zögen den Median nach unten. Tage ohne Vorkommen zählen dagegen mit: dass
 * am Wochenende nichts kommt, gehört zur Verteilung, und genau davor schützt der **Anlauf** und der
 * **Ausnahmetag**, nicht ein geschöntes Mittel.
 */
export function zaehlerVorschlag(ankunftszeiten: Date[], zone: string): ZaehlerVorschlag | null {
	const proTag = tageszahlen(ankunftszeiten, zone);
	if (proTag.length === 0) return null;

	const median = medianVon(proTag);
	if (median <= 0) return null;

	const untergrenze = Math.floor(median / 2);

	return {
		parameter: {
			zaehlerFensterSekunden: TAG_SEKUNDEN,
			zaehlerObergrenze: Math.ceil(median * 2),
			// Eine Untergrenze von 0 kann nie unterschritten werden; sie wäre ein Feld, das aussieht,
			// als überwache es etwas. Bei sehr seltenen Sorten bleibt es deshalb bei der Obergrenze.
			...(untergrenze >= 1 ? { zaehlerUntergrenze: untergrenze } : {})
		},
		beleg: { grund: 'zaehler', medianProTag: median, tage: proTag.length }
	};
}

/** Vorkommen je Kalendertag der Instanz-Zeitzone, angeschnittene Randtage ausgenommen. */
function tageszahlen(ankunftszeiten: Date[], zone: string): number[] {
	if (ankunftszeiten.length === 0) return [];

	const proTag = new Map<string, number>();
	for (const zeitpunkt of ankunftszeiten) {
		const tag = zonenDatum(zeitpunkt, zone);
		proTag.set(tag, (proTag.get(tag) ?? 0) + 1);
	}

	const tage = [...proTag.keys()].sort();
	const erste = Date.UTC(...alsTeile(tage[0]));
	const letzte = Date.UTC(...alsTeile(tage[tage.length - 1]));

	const zahlen: number[] = [];
	for (let tag = erste; tag <= letzte; tag += TAG_SEKUNDEN * 1000) {
		zahlen.push(proTag.get(new Date(tag).toISOString().slice(0, 10)) ?? 0);
	}

	// Ohne die Ränder bleiben mindestens drei volle Tage übrig, sonst ist die ganze Beobachtung zu
	// kurz, um sie zu beschneiden — dann ist ein etwas zu niedriger Median besser als kein Vorschlag.
	return zahlen.length >= 5 ? zahlen.slice(1, -1) : zahlen;
}

function alsTeile(datum: string): [number, number, number] {
	const [jahr, monat, tag] = datum.split('-').map(Number);
	return [jahr, monat - 1, tag];
}

function medianVon(werte: number[]): number {
	const sortiert = [...werte].sort((a, b) => a - b);
	const mitte = Math.floor(sortiert.length / 2);
	return sortiert.length % 2 === 1
		? sortiert[mitte]
		: Math.round((sortiert[mitte - 1] + sortiert[mitte]) / 2);
}

// ---------------------------------------------------------------------------------------------
// Paar-Offenzeit, nachgelagert
// ---------------------------------------------------------------------------------------------

/** Eine Mail der Sorte, wie die Offenzeit-Beobachtung sie liest. */
export interface VerlaufsMail {
	ankunftszeit: Date;
	absender: string;
	betreff: string;
	bodyText: string | null;
}

export interface OffenzeitVorschlag {
	maxOffenzeitSekunden: number;
	beleg: Beleg;
}

/**
 * Die maximale Offenzeit aus den beobachteten Auf→Zu-Dauern (CONTEXT „Vorbefüllungs-Grad":
 * „Paar-Offenzeit nachgelagert … sobald die Muster markiert sind").
 *
 * Nachgelagert, weil sie das Einzige ist, was Schicht 1 *nicht* aus Zeitlichem allein gewinnen kann:
 * ohne Auf- und Zu-Muster gibt es keine Paare, deren Dauer man messen könnte. Der Wizard rechnet sie
 * deshalb erst, wenn die Muster stehen.
 *
 * Die Ränder sind die von CONTEXT „Paar-Monitor": ein zweites Auf während offen zählt nicht neu (die
 * Offenzeit läuft ab dem **ersten** Auf), eine Zu-Mail ohne offenen Zustand ist neutral. Trifft eine
 * Mail beide Slots, gewinnt Auf — dieselbe Präzedenz, mit der der Klassifikator zur Laufzeit „Fehler
 * hat Vorrang" liest.
 */
export function beobachteteOffenzeit(
	mails: VerlaufsMail[],
	regelZeile: RegelZeile
): OffenzeitVorschlag | null {
	const { regel } = kompiliereRegel(regelZeile);
	const sortiert = [...mails].sort((a, b) => a.ankunftszeit.getTime() - b.ankunftszeit.getTime());

	let offenSeit: Date | null = null;
	let maxSekunden = 0;
	let paare = 0;

	for (const mail of sortiert) {
		const treffer = slotTreffer(mail, regel, new Heuhaufen(mail));

		if (treffer.schlecht) {
			offenSeit ??= mail.ankunftszeit;
			continue;
		}

		if (treffer.gut && offenSeit) {
			maxSekunden = Math.max(
				maxSekunden,
				(mail.ankunftszeit.getTime() - offenSeit.getTime()) / 1000
			);
			paare++;
			offenSeit = null;
		}
	}

	if (paare === 0) return null;

	return {
		// Dieselbe Rechnung wie bei der Karenz: die längste Dauer, die schon vorkam, plus Luft — eine
		// erlaubte Laufzeit exakt auf dem bisherigen Maximum alarmierte beim nächsten langsamen Lauf.
		maxOffenzeitSekunden: aufVielfaches(maxSekunden + TAKT_STREUUNG_BODEN_SEKUNDEN, 300),
		beleg: { grund: 'offenzeit', maxSekunden: Math.round(maxSekunden), paare }
	};
}
