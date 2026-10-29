/**
 * Zone arithmetic, asserted on the two days a year it can go wrong.
 *
 * Europe/Berlin 2026: the clocks jump forward at 2026-03-29T01:00Z (02:00 → 03:00) and back at
 * 2026-10-25T01:00Z (03:00 → 02:00). Both dates are hard-coded rather than computed — a test that
 * derives the transition the same way the code does would agree with a wrong answer.
 */
import { describe, expect, it } from 'vitest';
import {
	alsInstant,
	isoWochentag,
	tagesBeginn,
	tagesEnde,
	zonenDatum,
	zonenTeile
} from './zeitzone';

const BERLIN = 'Europe/Berlin';

describe('zonenTeile', () => {
	it('liest die Wandzeit der Zone, nicht die des Servers', () => {
		expect(zonenTeile(new Date('2026-06-01T12:00:00Z'), BERLIN)).toMatchObject({
			jahr: 2026,
			monat: 6,
			tag: 1,
			stunde: 14,
			minute: 0,
			wochentag: 1,
			datum: '2026-06-01'
		});
	});

	it('zählt Sonntag als 7 (ISO), nicht als 0', () => {
		expect(isoWochentag(2026, 3, 29)).toBe(7);
		expect(zonenTeile(new Date('2026-03-29T12:00:00Z'), BERLIN).wochentag).toBe(7);
	});

	it('meldet Mitternacht als Stunde 0, nicht als 24', () => {
		expect(zonenTeile(new Date('2026-01-14T23:00:00Z'), BERLIN)).toMatchObject({
			tag: 15,
			stunde: 0
		});
	});

	it('trägt das Datum der Zone, das über UTC-Mitternacht hinweg abweicht', () => {
		expect(zonenDatum(new Date('2026-06-01T23:30:00Z'), BERLIN)).toBe('2026-06-02');
	});
});

describe('alsInstant', () => {
	it('rechnet Winter- und Sommerzeit auseinander', () => {
		expect(
			alsInstant({ jahr: 2026, monat: 1, tag: 15, stunde: 6, minute: 0 }, BERLIN).toISOString()
		).toBe('2026-01-15T05:00:00.000Z');
		expect(
			alsInstant({ jahr: 2026, monat: 6, tag: 1, stunde: 6, minute: 0 }, BERLIN).toISOString()
		).toBe('2026-06-01T04:00:00.000Z');
	});

	/** Das eigentliche Versprechen: 06:00 bleibt 06:00, auch über den Wechsel. */
	it('hält ein Soll über den Wechsel hinweg auf derselben Wandzeit', () => {
		const vorher = alsInstant({ jahr: 2026, monat: 3, tag: 28, stunde: 6, minute: 0 }, BERLIN);
		const nachher = alsInstant({ jahr: 2026, monat: 3, tag: 30, stunde: 6, minute: 0 }, BERLIN);

		expect(vorher.toISOString()).toBe('2026-03-28T05:00:00.000Z');
		expect(nachher.toISOString()).toBe('2026-03-30T04:00:00.000Z');
		expect(zonenTeile(nachher, BERLIN).stunde).toBe(6);
	});

	/** „Missing": 02:30 gibt es am 29.03. nicht — das Soll rutscht auf den Sprung, es entfällt nicht. */
	it('legt eine nicht existierende Wandzeit auf den Sprung-Zeitpunkt', () => {
		const sprung = alsInstant({ jahr: 2026, monat: 3, tag: 29, stunde: 2, minute: 30 }, BERLIN);

		expect(sprung.toISOString()).toBe('2026-03-29T01:00:00.000Z');
		expect(zonenTeile(sprung, BERLIN)).toMatchObject({ tag: 29, stunde: 3, minute: 0 });
	});

	/** „Doubled": 02:30 gibt es am 25.10. zweimal — die frühere gewinnt. */
	it('nimmt bei doppelter Wandzeit das frühere Vorkommen', () => {
		const frueh = alsInstant({ jahr: 2026, monat: 10, tag: 25, stunde: 2, minute: 30 }, BERLIN);

		expect(frueh.toISOString()).toBe('2026-10-25T00:30:00.000Z');
		// Die spätere Lesart wäre 01:30Z — beide zeigen 02:30 lokal.
		expect(zonenTeile(frueh, BERLIN).stunde).toBe(2);
		expect(zonenTeile(new Date('2026-10-25T01:30:00Z'), BERLIN).stunde).toBe(2);
	});

	it('ist außerhalb der Wechsel die Umkehrung von zonenTeile', () => {
		for (let tag = 0; tag < 365; tag += 7) {
			const zeitpunkt = new Date(Date.UTC(2026, 0, 1, 12, 0, 0) + tag * 86_400_000);
			const teile = zonenTeile(zeitpunkt, BERLIN);
			expect(alsInstant(teile, BERLIN).toISOString()).toBe(zeitpunkt.toISOString());
		}
	});

	it('lässt eine Zone ohne Versatz unverändert', () => {
		expect(
			alsInstant({ jahr: 2026, monat: 6, tag: 1, stunde: 6, minute: 0 }, 'UTC').toISOString()
		).toBe('2026-06-01T06:00:00.000Z');
	});
});

describe('Tagesgrenzen', () => {
	it('setzt den Tagesanfang auf die lokale Mitternacht', () => {
		expect(tagesBeginn('2026-06-01', BERLIN).toISOString()).toBe('2026-05-31T22:00:00.000Z');
		expect(tagesBeginn('2026-01-15', BERLIN).toISOString()).toBe('2026-01-14T23:00:00.000Z');
	});

	/** Der Umstelltag ist 23 Stunden lang — der Anlauf nach einem Ausnahmetag muss das treffen. */
	it('macht den Umstelltag kürzer, statt 24 Stunden zu unterstellen', () => {
		const beginn = tagesBeginn('2026-03-29', BERLIN);
		const ende = tagesEnde('2026-03-29', BERLIN);

		expect(beginn.toISOString()).toBe('2026-03-28T23:00:00.000Z');
		expect(ende.toISOString()).toBe('2026-03-29T22:00:00.000Z');
		expect(ende.getTime() - beginn.getTime()).toBe(23 * 3_600_000);
	});

	it('macht den Rückstelltag 25 Stunden lang', () => {
		const beginn = tagesBeginn('2026-10-25', BERLIN);
		const ende = tagesEnde('2026-10-25', BERLIN);

		expect(ende.getTime() - beginn.getTime()).toBe(25 * 3_600_000);
	});

	it('trägt über den Monatswechsel', () => {
		expect(tagesEnde('2026-01-31', BERLIN).toISOString()).toBe('2026-01-31T23:00:00.000Z');
		expect(tagesEnde('2026-12-31', BERLIN).toISOString()).toBe('2026-12-31T23:00:00.000Z');
	});
});
