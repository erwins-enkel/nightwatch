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
import { selbstGate } from '../lib/server/selbst/gate';
import { startAlarmScheduler } from '../lib/server/alarm/scheduler';
import { registriereAlarmweg } from '../lib/server/alarm/wege';
import { autotaskWeg } from '../lib/server/autotask/weg';
import { starteAutotaskWorker } from '../lib/server/autotask/worker';
import { webhookWeg } from '../lib/server/webhook/weg';
import { starteWebhookWorker } from '../lib/server/webhook/worker';
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
// The Ingestion-Gate (SPEC §8) rides along: while a mailbox's ingestion is demonstrably broken, its
// monitors' overdue decisions are suspended rather than taken and later regretted. Without it a
// two-hour Graph outage would end in one false ticket per monitor.
const zeit = startZeitScheduler({ tickMs: env.zeitTickMs, gate: selbstGate });
log.info('zeit scheduler started', { tickMs: env.zeitTickMs });

// The Autotask channel (SPEC §7). Registered *before* the publisher starts, so the very first tick
// already sees the way — a transition published without it would carry no ticket delivery, and the
// publisher's markers make sure it is never published a second time.
const autotask = await starteAutotaskWorker(boss);
registriereAlarmweg(autotaskWeg(boss));

// The generic webhook channel (SPEC §7), registered before the publisher for the same reason.
// It is the channel that also carries self-monitor events, and it is what an operator without
// Autotask alerts through.
const webhook = await starteWebhookWorker(boss);
registriereAlarmweg(webhookWeg(boss));

// The alarm lifecycle's outbox (SPEC §6–7): transitions are written by the two loops above, inside
// their transactions; this one turns them into outside effects. Without it the dashboard would be
// live and every ticket and webhook silent.
const alarm = startAlarmScheduler({ tickMs: env.alarmTickMs });
log.info('alarm scheduler started', { tickMs: env.alarmTickMs });

log.info('worker ready', { version: env.appVersion });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	log.info('shutting down', { signal });
	ingestion.stop();
	zuordnung.stop();
	zeit.stop();
	alarm.stop();
	heartbeat.stop();
	watchdog.stop();
	// Stops fetching before pg-boss shuts down, so a delivery in flight finishes instead of being
	// cut off halfway between the ticket (or the webhook call) and the row that records it.
	await Promise.all([autotask.stop(), webhook.stop()]);
	await boss.stop({ graceful: true }).catch((err: unknown) => {
		log.warn('pg-boss shutdown failed', { error: describeError(err) });
	});
	await closePool().catch(() => {});
	process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
