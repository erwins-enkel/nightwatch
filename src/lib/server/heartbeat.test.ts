import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startHeartbeat } from './heartbeat';

describe('startHeartbeat', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('writes immediately, so a fresh service shows up without waiting an interval', () => {
		const write = vi.fn().mockResolvedValue(undefined);
		startHeartbeat({ intervalMs: 1000, write });

		expect(write).toHaveBeenCalledTimes(1);
	});

	it('keeps writing once per interval', async () => {
		const write = vi.fn().mockResolvedValue(undefined);
		startHeartbeat({ intervalMs: 1000, write });

		await vi.advanceTimersByTimeAsync(3000);

		expect(write).toHaveBeenCalledTimes(4);
	});

	it('pets the watchdog even while the database is unreachable', async () => {
		const onTick = vi.fn();
		const onError = vi.fn();
		const write = vi.fn().mockRejectedValue(new Error('connection refused'));
		startHeartbeat({ intervalMs: 1000, write, onTick, onError });

		await vi.advanceTimersByTimeAsync(3000);

		// An unreachable database says nothing about whether this process is still alive.
		expect(onTick).toHaveBeenCalledTimes(4);
		expect(onError).toHaveBeenCalledTimes(4);
	});

	it('skips a tick instead of piling up overlapping writes', async () => {
		let release: (() => void) | undefined;
		const write = vi.fn().mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		);
		startHeartbeat({ intervalMs: 1000, write });

		await vi.advanceTimersByTimeAsync(5000);
		expect(write).toHaveBeenCalledTimes(1);

		release?.();
		await vi.advanceTimersByTimeAsync(1000);
		expect(write).toHaveBeenCalledTimes(2);
	});

	it('stops writing after stop()', async () => {
		const write = vi.fn().mockResolvedValue(undefined);
		const heartbeat = startHeartbeat({ intervalMs: 1000, write });

		heartbeat.stop();
		await vi.advanceTimersByTimeAsync(5000);

		expect(write).toHaveBeenCalledTimes(1);
	});
});
