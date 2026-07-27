import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWatchdogTimer } from './watchdog-timer';

describe('startWatchdogTimer', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('fires once the main loop stops petting it', () => {
		const onExpire = vi.fn();
		startWatchdogTimer({ name: 'worker', timeoutMs: 1000, onExpire });

		vi.advanceTimersByTime(999);
		expect(onExpire).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(onExpire).toHaveBeenCalledWith('worker', 1000);
	});

	it('stays quiet as long as the main loop keeps ticking', () => {
		const onExpire = vi.fn();
		const timer = startWatchdogTimer({ name: 'web', timeoutMs: 1000, onExpire });

		for (let i = 0; i < 10; i++) {
			vi.advanceTimersByTime(900);
			timer.pet();
		}

		expect(onExpire).not.toHaveBeenCalled();
	});

	it('does not fire after stop()', () => {
		const onExpire = vi.fn();
		const timer = startWatchdogTimer({ name: 'watchdog', timeoutMs: 1000, onExpire });

		timer.stop();
		vi.advanceTimersByTime(5000);

		expect(onExpire).not.toHaveBeenCalled();
	});

	it('ignores pet() after stop(), so a late tick cannot re-arm it', () => {
		const onExpire = vi.fn();
		const timer = startWatchdogTimer({ name: 'watchdog', timeoutMs: 1000, onExpire });

		timer.stop();
		timer.pet();
		vi.advanceTimersByTime(5000);

		expect(onExpire).not.toHaveBeenCalled();
	});

	describe('liveness file', () => {
		let dir: string;
		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), 'nightwatch-watchdog-'));
		});
		afterEach(() => rmSync(dir, { recursive: true, force: true }));

		it('creates the file on the first tick and bumps its mtime afterwards', () => {
			const livenessFile = join(dir, 'alive');
			const timer = startWatchdogTimer({
				name: 'worker',
				timeoutMs: 1000,
				livenessFile,
				onExpire: vi.fn()
			});

			const created = statSync(livenessFile).mtimeMs;

			vi.setSystemTime(new Date(Date.now() + 5000));
			timer.pet();

			expect(statSync(livenessFile).mtimeMs).toBeGreaterThan(created);
		});
	});
});
