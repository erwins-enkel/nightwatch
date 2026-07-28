import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startZuordnungScheduler, STAPEL_PRO_TICK } from './scheduler';

describe('Zuordnungs-Scheduler', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('verarbeitet sofort und danach im Takt', async () => {
		const verarbeite = vi.fn(() => Promise.resolve(0));
		const scheduler = startZuordnungScheduler({ tickMs: 10_000, verarbeite });

		// Ein frisch gestarteter Worker soll nicht erst ein Intervall lang nichts tun.
		expect(verarbeite).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(20_000);
		expect(verarbeite).toHaveBeenCalledTimes(3);

		scheduler.stop();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(verarbeite).toHaveBeenCalledTimes(3);
	});

	/**
	 * Der Scheduler startet sofort einen Tick. Die Fälle unten messen einen *einzelnen* Tick, also
	 * muss der Start-Tick erst durchgelaufen sein — sonst greifen beide Schleifen ineinander und
	 * das Ergebnis hinge an der Reihenfolge der Microtasks.
	 */
	async function nachStart(verarbeite: () => Promise<number>, stapelGroesse: number) {
		const abgeschlossen = vi.fn(() => Promise.resolve(0));
		const scheduler = startZuordnungScheduler({
			tickMs: 10_000,
			stapelGroesse,
			verarbeite: abgeschlossen
		});
		await vi.advanceTimersByTimeAsync(0);
		abgeschlossen.mockImplementation(verarbeite);
		abgeschlossen.mockClear();
		return { scheduler, verarbeite: abgeschlossen };
	}

	it('hört auf, sobald ein Stapel nicht mehr voll wird', async () => {
		const { scheduler, verarbeite } = await nachStart(() => Promise.resolve(0), 100);

		await scheduler.tick();
		scheduler.stop();

		// Ein leerer Rückstand kostet genau einen Aufruf.
		expect(verarbeite).toHaveBeenCalledTimes(1);
		expect(verarbeite).toHaveBeenCalledWith(100);
	});

	it('zieht einen Rückstand in mehreren Stapeln nach', async () => {
		// Zwei volle Stapel, dann ein angebrochener: der Rückstand ist abgearbeitet.
		const laeufe = [10, 10, 3];
		const { scheduler, verarbeite } = await nachStart(
			() => Promise.resolve(laeufe.shift() ?? 0),
			10
		);

		await scheduler.tick();
		scheduler.stop();

		expect(verarbeite).toHaveBeenCalledTimes(3);
	});

	/**
	 * Ein frisch verbundenes Postfach übergibt der Pipeline ein ganzes Lernfenster auf einmal. Ohne
	 * Deckel säße ein Tick minutenlang darauf und die Schleife wäre für neu eintreffende Mails tot.
	 */
	it('deckelt die Stapel je Tick', async () => {
		const { scheduler, verarbeite } = await nachStart(() => Promise.resolve(10), 10);

		await scheduler.tick();
		scheduler.stop();

		expect(verarbeite).toHaveBeenCalledTimes(STAPEL_PRO_TICK);
	});

	it('überspringt einen Tick, solange der vorige noch läuft', async () => {
		let freigabe = () => {};
		const verarbeite = vi.fn(
			() =>
				new Promise<number>((resolve) => {
					freigabe = () => resolve(0);
				})
		);
		const scheduler = startZuordnungScheduler({ tickMs: 10_000, verarbeite });

		await vi.advanceTimersByTimeAsync(30_000);
		expect(verarbeite).toHaveBeenCalledTimes(1);

		freigabe();
		scheduler.stop();
	});

	it('lässt einen gescheiterten Stapel den Timer nicht abräumen', async () => {
		const verarbeite = vi
			.fn(() => Promise.resolve(0))
			.mockRejectedValueOnce(new Error('Datenbank weg'));
		const scheduler = startZuordnungScheduler({ tickMs: 10_000, verarbeite });

		await vi.advanceTimersByTimeAsync(10_000);
		expect(verarbeite).toHaveBeenCalledTimes(2);

		scheduler.stop();
	});
});
