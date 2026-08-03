import { PgBoss } from 'pg-boss';
import { requireDatabaseUrl } from './env';

/** Keeps pg-boss' tables out of the way of the Drizzle-managed application schema. */
export const PGBOSS_SCHEMA = 'pgboss';

/**
 * pg-boss is the durable retry queue for Autotask tickets and webhooks (SPEC §7). This scaffold
 * only starts it — the queues themselves are created by the issues that own those jobs, since
 * pg-boss no longer auto-creates a queue on first `send()`.
 */
export function createQueueClient(): PgBoss {
	return new PgBoss({ connectionString: requireDatabaseUrl(), schema: PGBOSS_SCHEMA });
}
