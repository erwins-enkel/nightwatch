/**
 * Der Kalenderplan als Tabelle: Datum rein, Soll-Zeitpunkt raus.
 *
 * Alle Fälle spielen in der Woche vom 2026-06-01 (einem Montag) oder um den Sommerzeit-Wechsel am
 * 2026-03-29. Sommerzeit in Berlin heißt +02:00, also liegt ein 06:00-Soll auf 04:00Z.
 */
import { describe, expect, it } from 'vitest';
import { RUECKBLICK_TAGE, sollZeitpunkte, vorherigesSoll, zuBewertendeSolls } from './kalenderplan';
import type { PlanKontext } from './kalenderplan';

const WERKTAGS_UM_6 = { wochentage: [1, 2, 3, 4, 5], uhrzeit: '06:00' };
const LANGE_AKTIV = new Date('2026-01-01T00:00:00Z');

function kontext(teile: Partial<PlanKontext> = {}): PlanKontext {
	return {
		plan: WERKTAGS_UM_6,
		zone: 'Europe/Berlin',
		ausnahmetage: new Set(),
		...teile
	};
}

function iso(zeitpunkte: Date[]): string[] {
	return zeitpunkte.map((zeitpunkt) => zeitpunkt.toISOString());
}

describe('sollZeitpunkte', () => {
	it('trifft die Wochentage des Plans und lässt das Wochenende aus', () => {
		expect(
			iso(
				sollZeitpunkte(
					kontext(),
					new Date('2026-05-31T00:00:00Z'),
					new Date('2026-06-07T23:59:00Z')
				)
			)
		).toEqual([
			'2026-06-01T04:00:00.000Z',
			'2026-06-02T04:00:00.000Z',
			'2026-06-03T04:00:00.000Z',
			'2026-06-04T04:00:00.000Z',
			'2026-06-05T04:00:00.000Z'
		]);
	});

	/** CONTEXT „Ausnahmetag": das Soll entfällt — es verschiebt sich nicht. */
	it('lässt das Soll eines Ausnahmetags weg', () => {
		expect(
			iso(
				sollZeitpunkte(
					kontext({ ausnahmetage: new Set(['2026-06-03']) }),
					new Date('2026-06-02T12:00:00Z'),
					new Date('2026-06-04T12:00:00Z')
				)
			)
		).toEqual(['2026-06-04T04:00:00.000Z']);
	});

	it('grenzt links offen und rechts geschlossen ab', () => {
		const soll = new Date('2026-06-01T04:00:00Z');

		expect(sollZeitpunkte(kontext(), soll, new Date('2026-06-01T12:00:00Z'))).toEqual([]);
		expect(iso(sollZeitpunkte(kontext(), new Date('2026-06-01T03:59:59Z'), soll))).toEqual([
			'2026-06-01T04:00:00.000Z'
		]);
	});

	/** Ein 06:00-Soll bleibt ein 06:00-Soll, auch wenn die Zone in der Nacht davor springt. */
	it('hält die Wandzeit über den Sommerzeit-Wechsel', () => {
		expect(
			iso(
				sollZeitpunkte(
					kontext({ plan: { wochentage: [1, 2, 3, 4, 5, 6, 7], uhrzeit: '06:00' } }),
					new Date('2026-03-27T12:00:00Z'),
					new Date('2026-03-30T12:00:00Z')
				)
			)
		).toEqual(['2026-03-28T05:00:00.000Z', '2026-03-29T04:00:00.000Z', '2026-03-30T04:00:00.000Z']);
	});

	it('liefert nichts für einen unbrauchbaren Plan', () => {
		const spanne = [new Date('2026-05-31T00:00:00Z'), new Date('2026-06-07T00:00:00Z')] as const;

		expect(
			sollZeitpunkte(kontext({ plan: { wochentage: [], uhrzeit: '06:00' } }), ...spanne)
		).toEqual([]);
		expect(
			sollZeitpunkte(kontext({ plan: { wochentage: [1], uhrzeit: '25:00' } }), ...spanne)
		).toEqual([]);
	});
});

describe('vorherigesSoll', () => {
	it('nennt das unmittelbar vorangehende Soll', () => {
		expect(vorherigesSoll(kontext(), new Date('2026-06-03T04:00:00Z'))?.toISOString()).toBe(
			'2026-06-02T04:00:00.000Z'
		);
	});

	/** „Das Abdeckungs-Fenster reicht bis zum letzten wirksamen Soll zurück" (CONTEXT). */
	it('reicht über einen Ausnahmetag hinweg zurück', () => {
		expect(
			vorherigesSoll(
				kontext({ ausnahmetage: new Set(['2026-06-03']) }),
				new Date('2026-06-04T04:00:00Z')
			)?.toISOString()
		).toBe('2026-06-02T04:00:00.000Z');
	});

	it('gibt über die Woche hinweg das Soll vom Freitag zurück', () => {
		expect(vorherigesSoll(kontext(), new Date('2026-06-01T04:00:00Z'))?.toISOString()).toBe(
			'2026-05-29T04:00:00.000Z'
		);
	});

	it('gibt null zurück, wenn im Rückblick kein wirksames Soll liegt', () => {
		const woechentlich = kontext({
			plan: { wochentage: [1], uhrzeit: '06:00' },
			ausnahmetage: new Set(['2026-05-25', '2026-05-18', '2026-05-11', '2026-05-04'])
		});

		expect(vorherigesSoll(woechentlich, new Date('2026-06-01T04:00:00Z'))).toBeNull();
	});
});

describe('zuBewertendeSolls', () => {
	it('bewertet ein Soll erst, wenn die Karenz abgelaufen ist', () => {
		const bisKurzVor = zuBewertendeSolls(
			kontext(),
			1800,
			LANGE_AKTIV,
			new Date('2026-06-02T00:00:00Z'),
			new Date('2026-06-02T04:29:00Z')
		);
		const bisDanach = zuBewertendeSolls(
			kontext(),
			1800,
			LANGE_AKTIV,
			new Date('2026-06-02T00:00:00Z'),
			new Date('2026-06-02T04:30:00Z')
		);

		expect(bisKurzVor).toEqual([]);
		expect(iso(bisDanach.map((eintrag) => eintrag.soll))).toEqual(['2026-06-02T04:00:00.000Z']);
	});

	it('spannt das Abdeckungs-Fenster vom vorherigen Soll bis Soll plus Karenz', () => {
		const [bewertung] = zuBewertendeSolls(
			kontext(),
			1800,
			LANGE_AKTIV,
			new Date('2026-06-02T00:00:00Z'),
			new Date('2026-06-02T05:00:00Z')
		);

		expect(bewertung.fensterVon.toISOString()).toBe('2026-06-01T04:00:00.000Z');
		expect(bewertung.fensterBis.toISOString()).toBe('2026-06-02T04:30:00.000Z');
	});

	/**
	 * Der Anlauf des Kalenderplans: erst das erste vollständig nach der Aktivierung liegende
	 * Abdeckungs-Fenster wird beurteilt.
	 */
	it('überspringt Solls, deren Fenster vor der Aktivierung beginnt', () => {
		const bewertungen = zuBewertendeSolls(
			kontext(),
			0,
			new Date('2026-06-01T12:00:00Z'),
			new Date('2026-06-01T00:00:00Z'),
			new Date('2026-06-04T05:00:00Z')
		);

		// Das Soll vom 02. fällt aus, weil sein Fenster am 01. um 04:00Z beginnt — vor der
		// Aktivierung um 12:00Z. Ab dem 03. ist das Fenster vollständig, und ab da wird bewertet.
		expect(iso(bewertungen.map((eintrag) => eintrag.soll))).toEqual([
			'2026-06-03T04:00:00.000Z',
			'2026-06-04T04:00:00.000Z'
		]);
	});

	/** Neustart: der Cursor steht sechs Tage zurück, jedes verpasste Soll wird einzeln angeboten. */
	it('holt jedes verpasste Soll einzeln nach, in Reihenfolge', () => {
		const bewertungen = zuBewertendeSolls(
			kontext(),
			0,
			LANGE_AKTIV,
			new Date('2026-06-01T00:00:00Z'),
			new Date('2026-06-08T05:00:00Z')
		);

		expect(iso(bewertungen.map((eintrag) => eintrag.soll))).toEqual([
			'2026-06-01T04:00:00.000Z',
			'2026-06-02T04:00:00.000Z',
			'2026-06-03T04:00:00.000Z',
			'2026-06-04T04:00:00.000Z',
			'2026-06-05T04:00:00.000Z',
			'2026-06-08T04:00:00.000Z'
		]);
	});

	it('reicht bei einem sehr alten Cursor höchstens den Rückblick zurück', () => {
		const bis = new Date('2026-06-08T05:00:00Z');
		const bewertungen = zuBewertendeSolls(
			kontext(),
			0,
			LANGE_AKTIV,
			new Date('2026-01-02T00:00:00Z'),
			bis
		);

		expect(bewertungen.length).toBeLessThanOrEqual(RUECKBLICK_TAGE);
		expect(bewertungen[0].soll.getTime()).toBeGreaterThan(
			bis.getTime() - RUECKBLICK_TAGE * 86_400_000
		);
	});

	it('bewertet nichts ohne wirksames vorheriges Soll', () => {
		const woechentlich = kontext({
			plan: { wochentage: [1], uhrzeit: '06:00' },
			ausnahmetage: new Set(['2026-05-25', '2026-05-18', '2026-05-11', '2026-05-04'])
		});

		expect(
			zuBewertendeSolls(
				woechentlich,
				0,
				LANGE_AKTIV,
				new Date('2026-06-01T00:00:00Z'),
				new Date('2026-06-01T12:00:00Z')
			)
		).toEqual([]);
	});
});
