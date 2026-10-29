import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeclaimtesPostfach } from './db';
import { MAX_PARALLEL, startIngestionScheduler } from './scheduler';

const geclaimt = (id: string): GeclaimtesPostfach => ({
	id,
	adresse: `${id}@example.test`,
	tenantId: 'tenant',
	clientId: 'client',
	clientSecretChiffre: 'v1.a.b.c',
	deltaToken: null,
	deltaFolgeLink: null,
	letzterErfolgreicherPoll: null,
	pollIntervallSekunden: 120,
	lernfensterTage: 30,
	lernfensterAbgeschlossenAm: null,
	fehlerInFolge: 0,
	erstelltAm: new Date('2026-07-27T10:00:00Z')
});

describe('Ingestion-Scheduler', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('pollt sofort und danach im Takt', async () => {
		const claim = vi.fn(async () => []);
		const scheduler = startIngestionScheduler({ tickMs: 15_000, claim });

		// Ein frisch gestarteter Worker soll nicht erst ein Intervall lang nichts tun.
		expect(claim).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(30_000);
		expect(claim).toHaveBeenCalledTimes(3);

		scheduler.stop();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(claim).toHaveBeenCalledTimes(3);
	});

	it('fordert höchstens so viele Postfächer an, wie es parallel verarbeiten kann', async () => {
		const claim = vi.fn(async () => []);
		startIngestionScheduler({ tickMs: 15_000, claim }).stop();

		expect(claim).toHaveBeenCalledWith(MAX_PARALLEL, expect.any(Date));
	});

	it('verarbeitet den geclaimten Stapel nebenläufig', async () => {
		const laufend: string[] = [];
		const scheduler = startIngestionScheduler({
			tickMs: 15_000,
			claim: async () => [geclaimt('a'), geclaimt('b')],
			verarbeite: async (postfach) => {
				laufend.push(postfach.id);
			}
		});

		await scheduler.tick();
		expect(laufend).toContain('a');
		expect(laufend).toContain('b');
		scheduler.stop();
	});

	it('überspringt einen Tick, solange der vorige noch läuft', async () => {
		// Sonst stapelten sich bei einem langen Backfill die Ticks und würden dieselbe Arbeit
		// mehrfach anstoßen.
		let offen: (() => void) | undefined;
		const claim = vi.fn(
			() => new Promise<GeclaimtesPostfach[]>((resolve) => (offen = () => resolve([])))
		);
		const scheduler = startIngestionScheduler({ tickMs: 15_000, claim });

		await vi.advanceTimersByTimeAsync(60_000);
		expect(claim).toHaveBeenCalledTimes(1);

		offen?.();
		await vi.advanceTimersByTimeAsync(15_000);
		expect(claim).toHaveBeenCalledTimes(2);

		scheduler.stop();
	});

	it('überlebt einen fehlgeschlagenen Tick und läuft weiter', async () => {
		const claim = vi
			.fn<() => Promise<GeclaimtesPostfach[]>>()
			.mockRejectedValueOnce(new Error('Postgres weg'))
			.mockResolvedValue([]);
		const scheduler = startIngestionScheduler({ tickMs: 15_000, claim });

		await vi.advanceTimersByTimeAsync(15_000);

		expect(claim).toHaveBeenCalledTimes(2);
		scheduler.stop();
	});
});
