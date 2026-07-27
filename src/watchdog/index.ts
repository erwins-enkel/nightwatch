/**
 * Watchdog entrypoint — deliberately tiny (SPEC §2).
 *
 * Its job in v1 is to aggregate the Postgres heartbeats, evaluate the self-monitors and send
 * self-alarms on its own path, without worker or pg-boss. The scaffold covers the aggregation
 * and reports what it sees; the evaluation and the sending path belong to the self-monitoring
 * milestone. It never depends on pg-boss, so a broken queue cannot silence the watchdog.
 */
import { env } from '../lib/server/env';
import { createLogger, describeError } from '../lib/server/logger';
import { startHeartbeat } from '../lib/server/heartbeat';
import { startWatchdogTimer } from '../lib/server/watchdog-timer';
import { readHeartbeats, writeHeartbeat } from '../lib/server/db/heartbeat';
import { closePool } from '../lib/server/db/client';
import { evaluateHealth } from '../lib/server/health';

const log = createLogger('watchdog');

const watchdog = startWatchdogTimer({
	name: 'watchdog',
	timeoutMs: env.watchdogTimeoutMs,
	livenessFile: env.livenessFile
});

async function tick(): Promise<void> {
	await writeHeartbeat('watchdog');
	const report = evaluateHealth({
		rows: await readHeartbeats(),
		now: new Date(),
		staleAfterMs: env.heartbeatStaleAfterMs,
		version: env.appVersion,
		databaseReachable: true
	});
	const stale = report.services.filter((service) => service.stale).map((service) => service.dienst);
	if (stale.length > 0) log.warn('services are not reporting in', { stale });
	else log.debug('all services reporting in');
}

const heartbeat = startHeartbeat({
	intervalMs: env.heartbeatIntervalMs,
	write: tick,
	onTick: () => watchdog.pet(),
	onError: (err) => log.warn('heartbeat tick failed', { error: describeError(err) })
});

log.info('watchdog ready', { version: env.appVersion });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	log.info('shutting down', { signal });
	heartbeat.stop();
	watchdog.stop();
	await closePool().catch(() => {});
	process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
