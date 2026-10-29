import { describe, expect, it } from 'vitest';
import {
	beschreibeFehler,
	klassifiziereAusnahme,
	klassifiziereFehler,
	retryAfterMs
} from './fehler';

const jetzt = new Date('2026-07-27T12:00:00.000Z');
const graphFehler = (code: string, message = 'irgendwas') => ({ error: { code, message } });

describe('Retry-After', () => {
	it('liest die Sekunden-Form', () => {
		expect(retryAfterMs('120', jetzt)).toBe(120_000);
	});

	it('liest die HTTP-Date-Form', () => {
		expect(retryAfterMs('Mon, 27 Jul 2026 12:02:30 GMT', jetzt)).toBe(150_000);
	});

	it('klemmt ein Datum in der Vergangenheit auf null, statt negativ zu warten', () => {
		expect(retryAfterMs('Mon, 27 Jul 2026 11:59:00 GMT', jetzt)).toBe(0);
	});

	it.each([
		['fehlend', undefined],
		['leer', '   '],
		['unlesbar', 'demnächst']
	])('gibt bei %s nichts zurück, damit der eigene Backoff greift', (_name, roh) => {
		expect(retryAfterMs(roh, jetzt)).toBeUndefined();
	});
});

describe('Klassifikation der Graph-Antworten (SPEC §3)', () => {
	it('behandelt 429 als Throttling und übernimmt Retry-After', () => {
		const fehler = klassifiziereFehler({
			status: 429,
			body: graphFehler('activityLimitReached', 'Too many requests'),
			retryAfter: '30',
			jetzt
		});

		expect(fehler).toMatchObject({ klasse: 'throttling', code: '429', retryAfterMs: 30_000 });
	});

	it('behandelt 503 wie 429', () => {
		expect(klassifiziereFehler({ status: 503, jetzt }).klasse).toBe('throttling');
	});

	it('verlangt bei 410 einen Resync', () => {
		const fehler = klassifiziereFehler({
			status: 410,
			body: graphFehler('resyncRequired', 'Resync required'),
			jetzt
		});

		expect(fehler).toMatchObject({ klasse: 'resync', code: 'resyncRequired' });
	});

	it('erkennt den Resync auch als 400/SyncStateNotFound', () => {
		// Ohne diesen Zweig sähe ein verlorener Delta-Zustand wie ein dauerhafter Client-Fehler aus
		// und das Postfach würde nie wieder synchronisieren.
		const fehler = klassifiziereFehler({
			status: 400,
			body: graphFehler('SyncStateNotFound'),
			jetzt
		});

		expect(fehler.klasse).toBe('resync');
	});

	it.each([401, 403])('meldet %i als Zugriffsproblem', (status) => {
		const fehler = klassifiziereFehler({
			status,
			body: graphFehler('ErrorAccessDenied', 'Access is denied.'),
			jetzt
		});

		expect(fehler).toMatchObject({
			klasse: 'zugriff',
			code: 'ErrorAccessDenied',
			text: 'Access is denied.'
		});
	});

	it('meldet 404 als fehlendes Postfach', () => {
		const fehler = klassifiziereFehler({
			status: 404,
			body: graphFehler('ErrorInvalidUser', 'The requested user is invalid.'),
			jetzt
		});

		expect(fehler).toMatchObject({ klasse: 'nicht_gefunden', code: 'ErrorInvalidUser' });
	});

	it('nimmt einen unbekannten 5xx als vorübergehend', () => {
		expect(klassifiziereFehler({ status: 500, jetzt })).toMatchObject({
			klasse: 'transient',
			code: '500',
			text: 'Graph antwortete mit HTTP 500'
		});
	});

	it('fällt auf den Statuscode zurück, wenn kein Fehler-Body kommt', () => {
		expect(klassifiziereFehler({ status: 410, body: 'kein JSON', jetzt }).code).toBe('410');
	});
});

describe('Klassifikation geworfener Fehler', () => {
	it('erkennt einen AADSTS-Code als Zugriffsproblem', () => {
		const fehler = klassifiziereAusnahme(
			new Error(
				'AADSTS7000215: Invalid client secret provided.\r\nTrace ID: abc\r\nCorrelation ID: def'
			)
		);

		expect(fehler).toMatchObject({
			klasse: 'zugriff',
			code: 'AADSTS7000215',
			// Trace- und Correlation-IDs gehören nicht in eine Dashboard-Spalte.
			text: 'AADSTS7000215: Invalid client secret provided.'
		});
	});

	it('hält einen Netzfehler für vorübergehend, nicht für ein Rechteproblem', () => {
		const netz = new Error('fetch failed');
		netz.name = 'TypeError';

		expect(klassifiziereAusnahme(netz)).toMatchObject({ klasse: 'transient', code: 'TypeError' });
	});

	it('kommt auch mit einem geworfenen Nicht-Fehler zurecht', () => {
		expect(klassifiziereAusnahme('kaputt')).toMatchObject({ klasse: 'transient', text: 'kaputt' });
	});
});

describe('beschreibeFehler', () => {
	it('kürzt sehr lange Meldungen', () => {
		const lang = beschreibeFehler('x'.repeat(500));
		expect(lang).toHaveLength(300);
		expect(lang.endsWith('…')).toBe(true);
	});
});
