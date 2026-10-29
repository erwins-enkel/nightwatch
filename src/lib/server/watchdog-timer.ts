import { closeSync, openSync, utimesSync } from 'node:fs';
import { createLogger } from './logger';

export interface WatchdogTimer {
	/** Called from the service's main loop: "I am still ticking." */
	pet(): void;
	/** Disarms the timer, e.g. during a graceful shutdown. */
	stop(): void;
}

export interface WatchdogTimerOptions {
	/** Service name, used for logging. */
	name: string;
	/** How long the main loop may go silent before the process is considered hung. */
	timeoutMs: number;
	/**
	 * Optional file whose mtime is bumped on every `pet()`. The container healthcheck reads it,
	 * which catches the case a blocked event loop cannot report itself: if the loop is wedged,
	 * neither the file nor this timer's callback move.
	 */
	livenessFile?: string;
	/** Overridable for tests. The default logs and exits so Docker restarts the container. */
	onExpire?: (name: string, timeoutMs: number) => void;
}

function exitSoDockerRestartsUs(name: string, timeoutMs: number): void {
	createLogger(name).error('watchdog timer expired, exiting so the container is restarted', {
		timeoutMs
	});
	process.exit(1);
}

function touch(file: string): void {
	const now = new Date();
	try {
		utimesSync(file, now, now);
	} catch {
		// Most likely the first tick and the file does not exist yet.
		closeSync(openSync(file, 'w'));
	}
}

/**
 * In-process watchdog against a *hung-but-alive* process (SPEC §2).
 *
 * `restart: unless-stopped` only helps once a process actually dies — a service whose main loop
 * silently stopped ticking looks perfectly healthy to Docker. So the process kills itself and
 * lets the Docker daemon, the supervisor, bring it back.
 */
export function startWatchdogTimer(options: WatchdogTimerOptions): WatchdogTimer {
	const { name, timeoutMs, livenessFile } = options;
	const onExpire = options.onExpire ?? exitSoDockerRestartsUs;

	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;

	function arm(): void {
		timer = setTimeout(() => onExpire(name, timeoutMs), timeoutMs);
	}

	function pet(): void {
		if (stopped) return;
		if (timer) clearTimeout(timer);
		if (livenessFile) touch(livenessFile);
		arm();
	}

	function stop(): void {
		stopped = true;
		if (timer) clearTimeout(timer);
		timer = undefined;
	}

	pet();
	return { pet, stop };
}
