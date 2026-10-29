/**
 * Die Fehler-Deutung ohne Netz.
 *
 * Die Klasse steuert hier bewusst **keinen** Kontrollfluss — SPEC §7 verlangt „Dead-Letter nach N
 * Versuchen", also wird alles wiederholt. Was zählt, ist der Text, den der Betreiber später in
 * `zustellung.letzter_fehler` liest, und dass „dauerhaft" nur dort steht, wo Warten nichts hilft.
 */
import { describe, expect, it } from 'vitest';
import { beschreibeFehler, klassifiziereAntwort, klassifiziereAusnahme } from './fehler';

describe('Antwort-Klassifikation', () => {
	it('liest die Autotask-Fehlerliste als Diagnose', () => {
		const fehler = klassifiziereAntwort({
			status: 400,
			body: { errors: ['Ticket: Status is required.', 'Ticket: Priority is inactive.'] }
		});

		expect(fehler.klasse).toBe('dauerhaft');
		expect(fehler.code).toBe('400');
		expect(fehler.text).toBe('Ticket: Status is required.; Ticket: Priority is inactive.');
	});

	it('nennt fehlende Berechtigung und fehlende Company dauerhaft', () => {
		expect(klassifiziereAntwort({ status: 401 }).klasse).toBe('dauerhaft');
		expect(klassifiziereAntwort({ status: 403 }).klasse).toBe('dauerhaft');
		expect(klassifiziereAntwort({ status: 404 }).klasse).toBe('dauerhaft');
	});

	it('nennt Sperre und Serverfehler transient', () => {
		// Die Threshold-Sperre geht von allein vorbei (Research-Doc §2).
		expect(klassifiziereAntwort({ status: 429 }).klasse).toBe('transient');
		expect(klassifiziereAntwort({ status: 408 }).klasse).toBe('transient');
		expect(klassifiziereAntwort({ status: 500 }).klasse).toBe('transient');
		expect(klassifiziereAntwort({ status: 503 }).klasse).toBe('transient');
	});

	it('kommt ohne Fehler-Envelope aus', () => {
		// Eine Sperre antwortet gern als HTML aus einem Proxy — `body` ist dann `undefined`.
		expect(klassifiziereAntwort({ status: 502 }).text).toBe('Autotask antwortete mit HTTP 502');
		expect(klassifiziereAntwort({ status: 400, body: { message: 'Bad request' } }).text).toBe(
			'Bad request'
		);
	});
});

describe('Ausnahme-Klassifikation', () => {
	it('hält einen toten Socket für transient', () => {
		const fehler = klassifiziereAusnahme(new TypeError('fetch failed'));
		expect(fehler.klasse).toBe('transient');
		expect(fehler.code).toBe('TypeError');
	});

	it('verträgt einen geworfenen Nicht-Fehler', () => {
		expect(klassifiziereAusnahme('kaputt').text).toBe('kaputt');
	});
});

describe('Fehlertext', () => {
	it('kürzt auf die erste Zeile und eine sinnvolle Länge', () => {
		expect(beschreibeFehler('Diagnose\nStack\nmehr Stack')).toBe('Diagnose');
		expect(beschreibeFehler('x'.repeat(500))).toHaveLength(300);
	});
});
