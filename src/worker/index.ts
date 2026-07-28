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
import { startIngestionScheduler } from '../lib/server/ingestion/scheduler';
import { startZuordnungScheduler } from '../lib/server/zuordnung/scheduler';
import { startZeitScheduler } from '../lib/server/zeit/scheduler';
import { monitorStufe } from '../lib/server/monitor/pipeline';

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

// The Graph delta poller (SPEC §3). Deliberately not a pg-boss job: pg-boss carries the durable
// retry queues for Autotask and webhooks, while a mailbox's next poll time lives in its own row.
const ingestion = startIngestionScheduler({ tickMs: env.ingestionTickMs });
log.info('ingestion scheduler started', { tickMs: env.ingestionTickMs });

// The assignment pipeline (SPEC §4). Separate from the ingestion loop on purpose: the queue is
// `mail.verarbeitet_am is null`, so a backfill drains by itself and a new Zuordnungs-Merkmal can
// send unassigned mails back through with a single UPDATE. Stage 2 — Kunde → Monitor and the
// mail-triggered state machine (SPEC §5–6) — is handed in here.
const zuordnung = startZuordnungScheduler({ tickMs: env.zuordnungTickMs, monitorStufe });
log.info('zuordnung scheduler started', { tickMs: env.zuordnungTickMs });

// The time-triggered half of the Dreiklang-Vertrag (SPEC §5–6) — the Dead-Man's-Switch itself.
// Until this loop runs, only an arriving mail can move a monitor, so the one thing Nightwatch
// exists for (nothing arrived) could never be noticed.
const zeit = startZeitScheduler({ tickMs: env.zeitTickMs });
log.info('zeit scheduler started', { tickMs: env.zeitTickMs });

log.info('worker ready', { version: env.appVersion });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	log.info('shutting down', { signal });
	ingestion.stop();
	zuordnung.stop();
	zeit.stop();
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
