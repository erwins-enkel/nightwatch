/**
 * Die Schleife selbst — ohne Datenbank. Was sie veröffentlicht und übergibt, steht in
 * `db.test.ts`; hier steht nur, dass sie läuft, im Takt bleibt und sich nicht selbst abräumt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAlarmScheduler } from './scheduler';

describe('Alarm-Scheduler-Schleife', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	/** Ein frisch gestarteter Worker soll nicht erst ein Intervall lang stumm alarmieren. */
	it('läuft sofort und danach im Takt', async () => {
		const verarbeite = vi.fn(() => Promise.resolve());
		const scheduler = startAlarmScheduler({ tickMs: 10_000, verarbeite });

		expect(verarbeite).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(20_000);
		expect(verarbeite).toHaveBeenCalledTimes(3);

		scheduler.stop();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(verarbeite).toHaveBeenCalledTimes(3);
	});

	it('überspringt einen Tick, solange der vorige noch läuft', async () => {
		let freigabe = () => {};
		const verarbeite = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					freigabe = resolve;
				})
		);
		const scheduler = startAlarmScheduler({ tickMs: 10_000, verarbeite });

		await vi.advanceTimersByTimeAsync(60_000);
		expect(verarbeite).toHaveBeenCalledTimes(1);

		freigabe();
		scheduler.stop();
	});

	/** Ein hängendes Alarmziel darf den Versand nicht dauerhaft stilllegen. */
	it('lässt einen gescheiterten Durchlauf den Timer nicht abräumen', async () => {
		const verarbeite = vi
			.fn(() => Promise.resolve())
			.mockRejectedValueOnce(new Error('Datenbank weg'));
		const scheduler = startAlarmScheduler({ tickMs: 10_000, verarbeite });

		await vi.advanceTimersByTimeAsync(10_000);
		expect(verarbeite).toHaveBeenCalledTimes(2);

		scheduler.stop();
	});
});
