import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Service heartbeats (SPEC §10 `heartbeat`) — one row per Node service, so web, worker and
 * watchdog can see each other through Postgres. Written via upsert, so the table never grows.
 *
 * Naming follows the rest of the data model: snake_case, German terms from CONTEXT.md.
 */
export const heartbeat = pgTable('heartbeat', {
	dienst: text('dienst').primaryKey(),
	zuletztGesehen: timestamp('zuletzt_gesehen', { withTimezone: true }).notNull(),
	gestartetAm: timestamp('gestartet_am', { withTimezone: true }).notNull(),
	version: text('version').notNull(),
	pid: integer('pid').notNull()
});
