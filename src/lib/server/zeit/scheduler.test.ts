/**
 * Die Schleife selbst — ohne Datenbank. Was sie *auswertet*, steht in `db.test.ts`; hier steht nur,
 * dass sie überhaupt und im Takt läuft und sich nicht selbst abräumt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startZeitScheduler } from './scheduler';

describe('Zeit-Scheduler-Schleife', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('läuft sofort und danach im Takt', async () => {
		const verarbeite = vi.fn(() => Promise.resolve());
		const scheduler = startZeitScheduler({ tickMs: 30_000, verarbeite });

		// Ein frisch gestarteter Worker soll nicht erst ein Intervall lang blind sein.
		expect(verarbeite).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(verarbeite).toHaveBeenCalledTimes(3);

		scheduler.stop();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(verarbeite).toHaveBeenCalledTimes(3);
	});

	it('reicht die eigene Uhr durch, statt sich eine zu nehmen', async () => {
		const jetzt = new Date('2026-06-03T05:00:00Z');
		const verarbeite = vi.fn(() => Promise.resolve());
		const scheduler = startZeitScheduler({ tickMs: 30_000, jetzt: () => jetzt, verarbeite });

		await vi.advanceTimersByTimeAsync(0);
		scheduler.stop();

		expect(verarbeite).toHaveBeenCalledWith(jetzt);
	});

	it('überspringt einen Tick, solange der vorige noch läuft', async () => {
		let freigabe = () => {};
		const verarbeite = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					freigabe = resolve;
				})
		);
		const scheduler = startZeitScheduler({ tickMs: 30_000, verarbeite });

		await vi.advanceTimersByTimeAsync(120_000);
		expect(verarbeite).toHaveBeenCalledTimes(1);

		freigabe();
		scheduler.stop();
	});

	/** Ein Ausfall der Datenbank darf den Dead-Man's-Switch nicht dauerhaft stilllegen. */
	it('lässt einen gescheiterten Durchlauf den Timer nicht abräumen', async () => {
		const verarbeite = vi
			.fn(() => Promise.resolve())
			.mockRejectedValueOnce(new Error('Datenbank weg'));
		const scheduler = startZeitScheduler({ tickMs: 30_000, verarbeite });

		await vi.advanceTimersByTimeAsync(30_000);
		expect(verarbeite).toHaveBeenCalledTimes(2);

		scheduler.stop();
	});
});
