import { describe, expect, it } from 'vitest';
import type { GraphFehler } from '../graph/fehler';
import { backoffMs, MAX_BACKOFF_MS, MAX_RETRY_AFTER_MS } from './backoff';

const transient: GraphFehler = { klasse: 'transient', code: '500', text: 'kaputt' };
/** Kein Jitter, damit die Kurve selbst geprüft wird. */
const ohneStreuung = () => 0.5;

describe('Backoff (SPEC §3)', () => {
	it('verdoppelt ausgehend vom Poll-Intervall', () => {
		const kurve = [1, 2, 3, 4].map((fehlerInFolge) =>
			backoffMs({ fehler: transient, fehlerInFolge, intervallSekunden: 60, zufall: ohneStreuung })
		);

		expect(kurve).toEqual([60_000, 120_000, 240_000, 480_000]);
	});

	it('deckelt bei 15 Minuten, damit eine behobene Ursache schnell wieder greift', () => {
		const spaet = backoffMs({
			fehler: transient,
			fehlerInFolge: 30,
			intervallSekunden: 300,
			zufall: ohneStreuung
		});

		expect(spaet).toBe(MAX_BACKOFF_MS);
	});

	it('bleibt mit Jitter innerhalb von ±20 %', () => {
		const werte = [0, 0.25, 0.5, 0.75, 0.999].map((r) =>
			backoffMs({ fehler: transient, fehlerInFolge: 2, intervallSekunden: 60, zufall: () => r })
		);

		for (const wert of werte) {
			expect(wert).toBeGreaterThanOrEqual(120_000 * 0.8);
			expect(wert).toBeLessThanOrEqual(120_000 * 1.2);
		}
		// Der Jitter wirkt auch wirklich, statt immer denselben Wert zu liefern.
		expect(new Set(werte).size).toBeGreaterThan(1);
	});

	it('lässt Retry-After gewinnen und streut es nicht', () => {
		const wert = backoffMs({
			fehler: { klasse: 'throttling', code: '429', text: 'zu viel', retryAfterMs: 45_000 },
			fehlerInFolge: 7,
			intervallSekunden: 60,
			zufall: () => 0
		});

		expect(wert).toBe(45_000);
	});

	it('deckelt auch ein absurdes Retry-After', () => {
		const wert = backoffMs({
			fehler: { klasse: 'throttling', code: '503', text: 'Wartung', retryAfterMs: 86_400_000 },
			fehlerInFolge: 1,
			intervallSekunden: 60
		});

		expect(wert).toBe(MAX_RETRY_AFTER_MS);
	});

	it('akzeptiert Retry-After: 0 als „sofort", statt es für fehlend zu halten', () => {
		const wert = backoffMs({
			fehler: { klasse: 'throttling', code: '429', text: 'jetzt', retryAfterMs: 0 },
			fehlerInFolge: 5,
			intervallSekunden: 60
		});

		expect(wert).toBe(0);
	});
});
