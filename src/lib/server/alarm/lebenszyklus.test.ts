/**
 * Die Lebenszyklus-Regeln ohne Datenbank: das Stabilitätsfenster an beiden Rändern, die
 * Ticket-Weisung je Ereignis und Erholungs-Art, die Vorkommens-Zusammenfassung.
 */
import { describe, expect, it } from 'vitest';
import {
	entwarnungFaellig,
	erholungHielt,
	stabilitaetEndeAm,
	weisungFuer,
	zusammenfassung,
	type EpisodenTally
} from './lebenszyklus';

const BEENDET = new Date('2026-07-28T06:00:00Z');
const FENSTER = 900;
const FENSTER_ENDE = new Date('2026-07-28T06:15:00Z');

describe('Entwarnungs-Stabilität', () => {
	it('spannt das Fenster ab der internen Erholung', () => {
		expect(stabilitaetEndeAm(BEENDET, FENSTER)).toEqual(FENSTER_ENDE);
		// Ohne Fenster wirkt die Entwarnung sofort — ein zulässiger Parameter, kein Sonderfall.
		expect(stabilitaetEndeAm(BEENDET, 0)).toEqual(BEENDET);
	});

	/**
	 * Der Kern der Flatter-Dämpfung: **nur** ein Re-Alarm im Fenster entwertet die Entwarnung.
	 * Danach ist sie geschuldet — die Erholung hat gehalten, egal wie lange der Publisher stand.
	 */
	it('hält nur, wenn der Re-Alarm nach dem Fensterende kommt', () => {
		const eineSekundeVorher = new Date(FENSTER_ENDE.getTime() - 1000);
		expect(erholungHielt(BEENDET, FENSTER, eineSekundeVorher)).toBe(false);

		expect(erholungHielt(BEENDET, FENSTER, FENSTER_ENDE)).toBe(true);

		const zwanzigMinuten = new Date('2026-07-28T06:20:00Z');
		expect(erholungHielt(BEENDET, FENSTER, zwanzigMinuten)).toBe(true);
	});

	/**
	 * Gemessen wird gegen die Bewertungs-Schranke, nicht gegen die Wanduhr: „es kam kein Re-Alarm"
	 * ist ein Urteil über eine Abwesenheit, und ein noch nicht abgearbeiteter Rückstand hält es auf.
	 */
	it('wird fällig, sobald das Fensterende bewertbar ist', () => {
		const knappVorher = new Date(FENSTER_ENDE.getTime() - 1);
		expect(entwarnungFaellig(BEENDET, FENSTER, knappVorher)).toBe(false);

		expect(entwarnungFaellig(BEENDET, FENSTER, FENSTER_ENDE)).toBe(true);

		// Rückstand: die Wanduhr ist längst weiter, bewertbar ist trotzdem nur bis 06:10.
		const schrankeImRueckstand = new Date('2026-07-28T06:10:00Z');
		expect(entwarnungFaellig(BEENDET, FENSTER, schrankeImRueckstand)).toBe(false);
	});

	/** Fenster-Ende ist zugleich „hielt" und „fällig" — dazwischen darf keine Lücke klaffen. */
	it('lässt am Fensterende keine Lücke zwischen Halten und Fälligkeit', () => {
		expect(erholungHielt(BEENDET, FENSTER, FENSTER_ENDE)).toBe(true);
		expect(entwarnungFaellig(BEENDET, FENSTER, FENSTER_ENDE)).toBe(true);
	});
});

describe('Ticket-Weisung', () => {
	it('lässt den Alarm ein Ticket eröffnen und die Verschärfung nur kommentieren', () => {
		expect(weisungFuer('alarm', null)).toBe('eroeffnen');
		expect(weisungFuer('verschaerfung', null)).toBe('kommentieren');
	});

	/**
	 * CONTEXT „Beweisbasierte Erholung": nur ein Beweis darf schließen. „Ein nach Zeitablauf
	 * stillgelegtes Ereignis-Ticket darf nicht ungelesen zugehen."
	 */
	it('erlaubt das Schließen nur bei beweisbasierter Erholung', () => {
		expect(weisungFuer('entwarnung', 'beweis')).toBe('schliessen');
		expect(weisungFuer('entwarnung', 'erledigt')).toBe('kommentieren');
		expect(weisungFuer('entwarnung', 'auto_zurueck')).toBe('kommentieren');
		expect(weisungFuer('entwarnung', null)).toBe('kommentieren');
	});
});

describe('Vorkommens-Zusammenfassung', () => {
	const episode: EpisodenTally = {
		begonnenAm: new Date('2026-07-28T04:00:00Z'),
		letztesVorkommenAm: new Date('2026-07-28T05:30:00Z'),
		vorkommen: 7,
		verschaerftAm: new Date('2026-07-28T04:30:00Z'),
		beendetAm: BEENDET
	};

	it('nennt Anzahl, Ränder und Störungsdauer', () => {
		expect(zusammenfassung(episode)).toEqual({
			vorkommen: 7,
			ersteAm: episode.begonnenAm,
			letzteAm: episode.letztesVorkommenAm,
			verschaerftAm: episode.verschaerftAm,
			stoerungsdauerSekunden: 7200
		});
	});

	/** Eine laufende Störung hat noch keine Dauer — der Alarm geht trotzdem mit Zählerstand raus. */
	it('lässt die Dauer offen, solange die Störung läuft', () => {
		expect(zusammenfassung({ ...episode, beendetAm: null }).stoerungsdauerSekunden).toBeNull();
	});
});
