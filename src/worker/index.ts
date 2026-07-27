/**
 * Worker entrypoint — Bun runs this TypeScript file directly, no build step.
 *
 * In v1 this service will own the Graph delta poller, the due-date/window scheduler and the
 * pg-boss workers for Autotask tickets and webhooks (SPEC §2). The scaffold brings up the parts
 * every one of those needs: pg-boss, a heartbeat and the in-process watchdog.
 */
import { env } from '../lib/server/env';
import { createLogger, describeError } from '../lib/server/logger';
import { startHeartbeat } from '../lib/server/heartbeat';
import { startWatchdogTimer } from '../lib/server/watchdog-timer';
import { writeHeartbeat } from '../lib/server/db/heartbeat';
import { closePool } from '../lib/server/db/client';
import { createQueueClient, PGBOSS_SCHEMA } from '../lib/server/queue';

const log = createLogger('worker');

const boss = createQueueClient();
boss.on('error', (err: unknown) => log.error('pg-boss error', { error: describeError(err) }));

await boss.start();
log.info('pg-boss started', { schema: PGBOSS_SCHEMA });

const watchdog = startWatchdogTimer({
	name: 'worker',
	timeoutMs: env.watchdogTimeoutMs,
	livenessFile: env.livenessFile
});

const heartbeat = startHeartbeat({
	intervalMs: env.heartbeatIntervalMs,
	write: () => writeHeartbeat('worker'),
	onTick: () => watchdog.pet(),
	onError: (err) => log.warn('heartbeat write failed', { error: describeError(err) })
});

log.info('worker ready', { version: env.appVersion });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	log.info('shutting down', { signal });
	heartbeat.stop();
	watchdog.stop();
	await boss.stop({ graceful: true }).catch((err: unknown) => {
		log.warn('pg-boss shutdown failed', { error: describeError(err) });
	});
	await closePool().catch(() => {});
	process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
