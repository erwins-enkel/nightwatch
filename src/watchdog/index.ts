/**
 * Watchdog entrypoint — deliberately tiny (SPEC §2).
 *
 * It aggregates the Postgres heartbeats, evaluates the self-monitors and sends self-alarms on its
 * own path, without worker or pg-boss (SPEC §8). That independence is the point: a self-monitor that
 * needed a healthy queue in order to report a broken queue would report nothing, and one that needed
 * a reachable database in order to report an unreachable database would be worse than nothing.
 */
import { env } from '../lib/server/env';
import { createLogger, describeError } from '../lib/server/logger';
import { startHeartbeat } from '../lib/server/heartbeat';
import { startWatchdogTimer } from '../lib/server/watchdog-timer';
import { writeHeartbeat } from '../lib/server/db/heartbeat';
import { closePool } from '../lib/server/db/client';
import { startSelbstScheduler } from '../lib/server/selbst/scheduler';

const log = createLogger('watchdog');

const watchdog = startWatchdogTimer({
	name: 'watchdog',
	timeoutMs: env.watchdogTimeoutMs,
	livenessFile: env.livenessFile
});

/**
 * The watchdog's own heartbeat, on its own timer.
 *
 * Kept apart from the self-monitoring loop on purpose: petting the in-process watchdog timer must
 * not depend on how long an evaluation takes, and a failed write says nothing about whether *this*
 * process is alive. The self-monitoring loop draws its own conclusion about the database.
 */
const heartbeat = startHeartbeat({
	intervalMs: env.heartbeatIntervalMs,
	write: () => writeHeartbeat('watchdog'),
	onTick: () => watchdog.pet(),
	onError: (err) => log.warn('heartbeat write failed', { error: describeError(err) })
});

const selbst = startSelbstScheduler({ tickMs: env.selbstTickMs });

log.info('watchdog ready', {
	version: env.appVersion,
	tickMs: env.selbstTickMs,
	cache: env.watchdogCacheFile
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	log.info('shutting down', { signal });
	selbst.stop();
	heartbeat.stop();
	watchdog.stop();
	await closePool().catch(() => {});
	process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
