/**
 * Der Heartbeat-Ping — Nightwatchs Dead-Man's-Switch, auf sich selbst angewendet.
 *
 * Die interessante Zusage ist die negative: eine degradierte Instanz **verstummt**. Ein Ping, der
 * auch bei gestörtem Selbst-Monitor rausginge, würde die Stille-Erkennung des Empfängers aktiv in
 * die Irre führen — schlimmer, als gar keinen Ping zu haben.
 */
import { describe, expect, it } from 'vitest';
import { innereGesundheit, istAngekommen, pingFaellig } from './ping';

const T = (hhmm: string) => new Date(`2026-07-29T${hhmm}:00Z`);

describe('Heartbeat-Ping', () => {
	describe('Innere Gesundheit', () => {
		it('gilt, wenn die Datenbank antwortet und kein Selbst-Monitor gestört ist', () => {
			expect(innereGesundheit(true, [{ zustand: 'gesund' }, { zustand: 'gesund' }])).toBe(true);
		});

		it('gilt nicht, sobald ein einziger Selbst-Monitor gestört ist', () => {
			expect(innereGesundheit(true, [{ zustand: 'gesund' }, { zustand: 'gestoert' }])).toBe(false);
		});

		it('gilt nicht ohne Datenbank', () => {
			expect(innereGesundheit(false, [{ zustand: 'gesund' }])).toBe(false);
		});

		/** Eine Instanz ohne Postfächer ist nicht krank, sie hat nur nichts zu überwachen. */
		it('gilt auch ganz ohne Selbst-Monitore', () => {
			expect(innereGesundheit(true, [])).toBe(true);
		});
	});

	describe('Fälligkeit', () => {
		it('ist sofort fällig, solange noch keiner ankam', () => {
			expect(pingFaellig(null, 300, T('06:00'))).toBe(true);
		});

		it('wartet das Intervall ab', () => {
			expect(pingFaellig(T('06:00'), 300, T('06:04'))).toBe(false);
			expect(pingFaellig(T('06:00'), 300, T('06:05'))).toBe(true);
		});
	});

	describe('Antwort', () => {
		it('nimmt nur 2xx als angekommen', () => {
			expect(istAngekommen(200)).toBe(true);
			expect(istAngekommen(204)).toBe(true);
			expect(istAngekommen(301)).toBe(false);
			expect(istAngekommen(404)).toBe(false);
			expect(istAngekommen(500)).toBe(false);
		});
	});
});
