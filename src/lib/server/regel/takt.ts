import type { TaktKlasse } from '../db/schema/enums';
import { TAG_MS, isoWochentag, zonenDatum, zonenTeile } from '../zeit/zeitzone';

/**
 * Takt-Erkennung (CONTEXT „Takt") — der erkannte Eingangs-Rhythmus einer Mail-Sorte.
 *
 * Rein, ohne Datenbank: hinein gehen Ankunftszeiten und die Instanz-Zeitzone, heraus kommt ein
 * Vorschlag mit seinem Beleg oder `null`. Alles, was CONTEXT über den Takt sagt, ist damit ohne
 * Postgres prüfbar — dieselbe Schnittführung wie bei `zuordnung/engine.ts` und `monitor/regel.ts`.
 *
 * Drei Dinge, die nicht offensichtlich sind:
 *
 * **1. Die Kalender-Klassen kommen vor dem Intervall.** Ein Strom alle 24 h ± 5 min erfüllt beide.
 * Den Vorzug hat die Kalender-Klasse, weil sie zu einem `Kalenderplan` führt, der Wochenenden und
 * Sommerzeit von sich aus richtig behandelt; `intervall` ist der Rückfall für alles, was sich
 * keinem Kalender fügt.
 *
 * **2. Die Tagesgrenze wird auf die beobachtete Uhrzeit gedreht.** Der kanonische Fall ist der
 * nächtliche Report um ~00:00 ± 20 min. An echter Mitternacht gemessen fielen zwei aufeinander
 * folgende Läufe auf Tag N und Tag N+2 — „täglich" wäre nie erkennbar. Deshalb wird zuerst die
 * *zirkuläre* Mitte der Uhrzeiten bestimmt und der Tages-Eimer aus `t + (12 h − Mitte)` gebildet:
 * die Vorkommen liegen dann in der Mitte ihres Eimers, weit weg von jeder Kante.
 *
 * **3. Fehlende Vorkommen sind erlaubt, aber gedeckelt.** CONTEXT nennt eine Schwelle, ~25 %. Sie
 * gilt hier zweimal: für die *Streuung* (wie weit darf ein Vorkommen von seinem Soll abweichen)
 * und für die *Lücken* (wie viele Soll-Zeitpunkte dürfen im Lernfenster ganz fehlen). Ohne das
 * Zweite wäre die Erkennung praktisch nutzlos: ein einziger ausgefallener Report in dreißig Tagen
 * ließe einen kerngesunden werktäglichen Rhythmus durchfallen — und ausgerechnet der ausgefallene
 * Report ist der Grund, warum jemand den Monitor anlegen will.
 */

/** CONTEXT „Takt": „Gilt als erkannt ab 3 Vorkommen". */
export const TAKT_MIN_VORKOMMEN = 3;

/**
 * Die eine Schwelle, „~25 %" (CONTEXT). Gilt für die Streuung *und* für fehlende Vorkommen.
 */
export const TAKT_TOLERANZ_ANTEIL = 0.25;

/** „Absoluter Boden 15 Minuten, damit ‚alle 5 min ± 2 min' nicht durchfällt" (CONTEXT). */
export const TAKT_STREUUNG_BODEN_SEKUNDEN = 900;

/**
 * Wie viele Vorkommen höchstens ausgewertet werden — die jüngsten.
 *
 * Eine Sorte, die alle fünf Minuten meldet, bringt im Lernfenster über achttausend Vorkommen mit;
 * der Rhythmus ist nach zweihundert genauso klar. Der Beleg nennt immer die tatsächlich
 * ausgewertete Zahl, nie eine größere.
 */
export const TAKT_MAX_VORKOMMEN = 200;

const TAG_SEKUNDEN = 86_400;

/**
 * Die längste Periode, die als **Intervall** vorgeschlagen wird — eine Woche.
 *
 * CONTEXT nennt vier Klassen, und die längste davon ist `woechentlich`. Alles darüber ist die
 * Gegend, die dort ausdrücklich ausgeschlossen ist: *„Monatlich bewusst nicht — das Lernfenster
 * gibt keine 3 Vorkommen her; Monats-Reports legt der Mensch als Kalenderplan an."*
 *
 * Ohne diese Grenze käme ein Monats-Report trotzdem durch, nur unter falschem Namen: seine Abstände
 * sind 28–31 Tage, der Median ~30, und 25 % davon sind siebeneinhalb Tage Toleranz — die
 * Monatslängen schwanken bequem darin. Das Ergebnis wäre eine Intervall-Erwartung „alle ~30 Tage",
 * die genau das ist, was CONTEXT nicht will: ein gleitendes „spätestens alle X", das mit jedem
 * verspäteten Lauf mitwandert, statt eines Kalenderplans mit festem Soll-Zeitpunkt.
 *
 * Das Lernfenster (~30 Tage) kann eine solche Periode ohnehin nicht mit drei Vorkommen belegen; die
 * Grenze wird erst wirksam, wenn sich über Wochen genug Historie angesammelt hat — und dann ist sie
 * genau richtig.
 */
export const TAKT_MAX_INTERVALL_SEKUNDEN = 7 * TAG_SEKUNDEN;

export interface Takt {
	klasse: TaktKlasse;
	/** Nur bei `intervall`. */
	intervallSekunden?: number;
	/** `HH:MM` in der Instanz-Zeitzone; bei den drei Kalender-Klassen. */
	uhrzeit?: string;
	/** ISO-8601 1 = Montag … 7 = Sonntag; nur bei `woechentlich`. */
	wochentag?: number;
	/** Die ausgewerteten Vorkommen — der Beleg („aus 12 Vorkommen"). */
	vorkommen: number;
	/**
	 * Die größte beobachtete Abweichung vom Soll: bei den Kalender-Klassen von der Uhrzeit, beim
	 * Intervall vom Median-Abstand. Grundlage des Karenz-Vorschlags (`ableitung.ts`) — die
	 * Unregelmäßigkeit, die die Erkennung geduldet hat, geht dort nicht verloren, sondern wird
	 * sichtbar.
	 */
	streuungSekunden: number;
}

/**
 * Der Takt einer Folge von Ankunftszeiten, oder `null`, wenn keiner erkennbar ist.
 *
 * Die Eingabe darf unsortiert sein und mehr als `TAKT_MAX_VORKOMMEN` Einträge haben.
 */
export function erkenneTakt(ankunftszeiten: Date[], zone: string): Takt | null {
	const zeiten = juengste(ankunftszeiten);
	if (zeiten.length < TAKT_MIN_VORKOMMEN) return null;

	return kalenderTakt(zeiten, zone) ?? intervallTakt(zeiten);
}

/** Aufsteigend sortiert, auf die jüngsten `TAKT_MAX_VORKOMMEN` gekürzt. */
function juengste(ankunftszeiten: Date[]): Date[] {
	const sortiert = [...ankunftszeiten].sort((a, b) => a.getTime() - b.getTime());
	return sortiert.length > TAKT_MAX_VORKOMMEN ? sortiert.slice(-TAKT_MAX_VORKOMMEN) : sortiert;
}

// ---------------------------------------------------------------------------------------------
// Kalender-Klassen: täglich · werktäglich · wöchentlich
// ---------------------------------------------------------------------------------------------

function kalenderTakt(zeiten: Date[], zone: string): Takt | null {
	const uhrzeiten = zeiten.map((zeitpunkt) => sekundeDesTages(zeitpunkt, zone));
	const { mitte, streuung } = zirkulaereMitte(uhrzeiten);

	// Bezogen auf den Tagesrhythmus, also 6 h. Die eigentliche Erkennung trägt hier die Struktur
	// (höchstens ein Vorkommen je Tages-Eimer, Tage aus dem Fahrplan der Klasse); diese Toleranz
	// fängt nur den Fall ab, dass die Läufe über den Tag wandern und „~05:40" nichts mehr aussagt.
	if (streuung > Math.max(TAKT_STREUUNG_BODEN_SEKUNDEN, TAKT_TOLERANZ_ANTEIL * TAG_SEKUNDEN)) {
		return null;
	}

	const tage = zeiten.map((zeitpunkt) => eimerTag(zeitpunkt, mitte, zone));
	// Zwei Vorkommen an einem Tag sind kein Tagesrhythmus — das ist ein Intervall (etwa 12 h).
	if (new Set(tage).size !== tage.length) return null;

	const basis = {
		vorkommen: zeiten.length,
		streuungSekunden: Math.round(streuung),
		uhrzeit: alsUhrzeit(mitte)
	};

	// Reihenfolge ist tragend: eine werktägliche Folge deckt über zwei Wochen 10 von 12 Kalendertagen
	// ab und käme mit der Lücken-Toleranz auch als „täglich" durch — sie würde dann am Samstag
	// alarmieren. Erst wöchentlich, dann werktäglich, dann täglich.
	if (istWoechentlich(tage)) {
		return { klasse: 'woechentlich', wochentag: wochentagVon(tage[0]), ...basis };
	}
	if (istWerktaeglich(tage)) return { klasse: 'werktaeglich', ...basis };
	if (istTaeglich(tage)) return { klasse: 'taeglich', ...basis };

	return null;
}

/** Sekunden seit Mitternacht in der Instanz-Zeitzone. */
function sekundeDesTages(zeitpunkt: Date, zone: string): number {
	const teile = zonenTeile(zeitpunkt, zone);
	return teile.stunde * 3600 + teile.minute * 60 + teile.sekunde;
}

/**
 * Mitte und Halbweite des kürzesten Bogens, der alle Uhrzeiten umschließt.
 *
 * Zirkulär, weil 23:50 und 00:10 zwanzig Minuten auseinander liegen und nicht dreiundzwanzig
 * Stunden. Gesucht wird die *größte Lücke* zwischen benachbarten Werten — ihr Komplement ist der
 * kürzeste umschließende Bogen, seine Mitte die gesuchte Uhrzeit und seine halbe Länge die größte
 * Abweichung, die irgendein Vorkommen von ihr hat.
 */
function zirkulaereMitte(uhrzeiten: number[]): { mitte: number; streuung: number } {
	const sortiert = [...uhrzeiten].sort((a, b) => a - b);
	const anzahl = sortiert.length;

	let groessteLuecke = -1;
	let nachLuecke = 0;

	for (let i = 0; i < anzahl; i++) {
		// Der letzte Schritt geht über Mitternacht zurück zum ersten Wert. Bei lauter gleichen Werten
		// ist genau das die Lücke von einem vollen Tag — und der Bogen damit ein Punkt.
		const luecke =
			i === anzahl - 1 ? sortiert[0] + TAG_SEKUNDEN - sortiert[i] : sortiert[i + 1] - sortiert[i];

		if (luecke > groessteLuecke) {
			groessteLuecke = luecke;
			nachLuecke = (i + 1) % anzahl;
		}
	}

	const bogen = TAG_SEKUNDEN - groessteLuecke;
	return { mitte: (sortiert[nachLuecke] + bogen / 2) % TAG_SEKUNDEN, streuung: bogen / 2 };
}

/**
 * Der Tag, in dem ein Vorkommen liegt, wenn die Tagesgrenze auf die beobachtete Uhrzeit gedreht
 * wird — `YYYY-MM-DD` in der Instanz-Zeitzone.
 *
 * Die Verschiebung ist eine feste Dauer, kein Wandzeit-Sprung, also kann eine Sommerzeit-Umstellung
 * das Ergebnis um bis zu eine Stunde verrücken. Harmlos: die Toleranz oben hält jedes Vorkommen im
 * Bereich 06:00–18:00 des gedrehten Tages, und eine Stunde reicht von dort an keine Tageskante.
 */
function eimerTag(zeitpunkt: Date, mitte: number, zone: string): string {
	const versatzMs = (TAG_SEKUNDEN / 2 - mitte) * 1000;
	return zonenDatum(new Date(zeitpunkt.getTime() + versatzMs), zone);
}

function alsUhrzeit(sekunden: number): string {
	// Auf die Minute gerundet: „~05:40" ist die Aussage, nicht „05:39:47".
	const minuten = Math.round(sekunden / 60) % 1440;
	const stunde = Math.floor(minuten / 60);
	const minute = minuten % 60;
	return `${String(stunde).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function wochentagVon(datum: string): number {
	const [jahr, monat, tag] = datum.split('-').map(Number);
	return isoWochentag(jahr, monat, tag);
}

function alsTagesZahl(datum: string): number {
	const [jahr, monat, tag] = datum.split('-').map(Number);
	return Date.UTC(jahr, monat - 1, tag) / TAG_MS;
}

/**
 * Ob die beobachteten Tage den Fahrplan einer Klasse hinreichend abdecken.
 *
 * `erwartet` ist die Zahl der Soll-Tage zwischen dem ersten und dem letzten Vorkommen. Fehlen
 * mehr als `TAKT_TOLERANZ_ANTEIL` davon, ist es kein Rhythmus, sondern Zufall.
 */
function deckungReicht(beobachtet: number, erwartet: number): boolean {
	return beobachtet >= TAKT_MIN_VORKOMMEN && beobachtet >= (1 - TAKT_TOLERANZ_ANTEIL) * erwartet;
}

function istTaeglich(tage: string[]): boolean {
	const spanne = alsTagesZahl(tage[tage.length - 1]) - alsTagesZahl(tage[0]);
	return deckungReicht(tage.length, spanne + 1);
}

function istWerktaeglich(tage: string[]): boolean {
	if (!tage.every((tag) => wochentagVon(tag) <= 5)) return false;

	const erste = alsTagesZahl(tage[0]);
	const letzte = alsTagesZahl(tage[tage.length - 1]);
	let erwartet = 0;
	for (let tag = erste; tag <= letzte; tag++) {
		if (wochentagVonZahl(tag) <= 5) erwartet++;
	}

	// Die Wochenend-Lücke muss beobachtet sein. Lagen alle Vorkommen innerhalb einer Arbeitswoche,
	// ist „werktäglich" von „täglich" nicht unterscheidbar — und die Vermutung wäre teuer: sie
	// setzte die Wochenend-Solls stillschweigend aus, und ein ausbleibender Samstags-Report fiele
	// nie auf. Genau das ist der blinde Fleck, gegen den es Nightwatch gibt; im Zweifel also
	// `taeglich`, mit allen sieben Wochentagen im vorbefüllten Kalenderplan sichtbar.
	const wochenendtage = letzte - erste + 1 - erwartet;
	if (wochenendtage === 0) return false;

	return deckungReicht(tage.length, erwartet);
}

function istWoechentlich(tage: string[]): boolean {
	const wochentag = wochentagVon(tage[0]);
	if (!tage.every((tag) => wochentagVon(tag) === wochentag)) return false;

	const spanne = alsTagesZahl(tage[tage.length - 1]) - alsTagesZahl(tage[0]);
	return deckungReicht(tage.length, spanne / 7 + 1);
}

/** ISO-Wochentag einer Tageszahl (Tage seit 1970-01-01, das war ein Donnerstag). */
function wochentagVonZahl(tageszahl: number): number {
	return ((tageszahl + 3) % 7) + 1;
}

// ---------------------------------------------------------------------------------------------
// Intervall
// ---------------------------------------------------------------------------------------------

/**
 * „Alle ~X" — der Rückfall für alles, was in keinen Kalender passt.
 *
 * Ein ausgefallenes Vorkommen erscheint hier als doppelter Abstand. Statt daran zu scheitern, wird
 * jeder Abstand auf das nächstliegende Vielfache des Median-Abstands bezogen: `k` Soll-Zeitpunkte
 * statt einer, davon `k − 1` ausgefallen. Gemessen wird dann die Abweichung *je Soll-Zeitpunkt*,
 * und die Ausfälle unterliegen derselben ~25-%-Schwelle wie die Lücken der Kalender-Klassen.
 */
function intervallTakt(zeiten: Date[]): Takt | null {
	const abstaende: number[] = [];
	for (let i = 1; i < zeiten.length; i++) {
		abstaende.push((zeiten[i].getTime() - zeiten[i - 1].getTime()) / 1000);
	}

	const median = medianVon(abstaende);
	// Mehrheitlich gleichzeitige Mails sind kein Rhythmus; ohne diese Sperre teilte die Rechnung
	// unten durch null.
	if (median <= 0) return null;
	if (median > TAKT_MAX_INTERVALL_SEKUNDEN) return null;

	let streuung = 0;
	let sollZeitpunkte = 0;
	let ausgefallen = 0;

	for (const abstand of abstaende) {
		const schritte = Math.max(1, Math.round(abstand / median));
		streuung = Math.max(streuung, Math.abs(abstand - schritte * median) / schritte);
		sollZeitpunkte += schritte;
		ausgefallen += schritte - 1;
	}

	if (ausgefallen > TAKT_TOLERANZ_ANTEIL * sollZeitpunkte) return null;
	if (streuung > Math.max(TAKT_STREUUNG_BODEN_SEKUNDEN, TAKT_TOLERANZ_ANTEIL * median)) return null;

	return {
		klasse: 'intervall',
		intervallSekunden: Math.round(median),
		vorkommen: zeiten.length,
		streuungSekunden: Math.round(streuung)
	};
}

function medianVon(werte: number[]): number {
	const sortiert = [...werte].sort((a, b) => a - b);
	const mitte = Math.floor(sortiert.length / 2);
	return sortiert.length % 2 === 1 ? sortiert[mitte] : (sortiert[mitte - 1] + sortiert[mitte]) / 2;
}
