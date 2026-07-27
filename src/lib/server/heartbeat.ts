export interface HeartbeatWriter {
	stop(): void;
}

export interface HeartbeatOptions {
	intervalMs: number;
	/** Persists the heartbeat. Injected so the scheduling can be tested without a database. */
	write: () => Promise<void>;
	/**
	 * Runs synchronously at the start of every tick, before the write — this is where a service
	 * pets its watchdog timer. Deliberately independent of whether the write succeeds: a
	 * unreachable database says nothing about whether *this* process is still alive.
	 */
	onTick?: () => void;
	/** A failed write must never take the service down; it is reported and the loop continues. */
	onError?: (err: unknown) => void;
}

/**
 * Periodic heartbeat writer (SPEC §2, §10) — the services' mutual visibility through Postgres.
 *
 * Writes once immediately, so a freshly started service shows up in `/health` without waiting a
 * full interval, then once per interval. Overlapping ticks are skipped rather than queued: if a
 * write takes longer than the interval, piling up more of them helps nobody.
 */
export function startHeartbeat(options: HeartbeatOptions): HeartbeatWriter {
	const { intervalMs, write, onTick, onError } = options;
	let inFlight = false;

	function tick(): void {
		onTick?.();
		if (inFlight) return;
		inFlight = true;
		write()
			.catch((err: unknown) => onError?.(err))
			.finally(() => {
				inFlight = false;
			});
	}

	const timer = setInterval(tick, intervalMs);
	tick();

	return {
		stop(): void {
			clearInterval(timer);
		}
	};
}
