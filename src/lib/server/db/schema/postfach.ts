import { boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * A monitored mailbox and its Graph connection (SPEC §3, §10).
 *
 * This table holds the *raw facts* of ingestion — when the last poll succeeded, which error came
 * back last. The ingestion *state* ("is this mailbox healthy?") deliberately lives on the
 * mailbox's self-monitor (SPEC §8), so there is exactly one place that decides it and one
 * state machine that drives the alarms.
 */
export const postfach = pgTable('postfach', {
	id: uuid('id').primaryKey().defaultRandom(),
	bezeichnung: text('bezeichnung').notNull(),
	/** The mailbox address polled via Graph; unique because it identifies the mailbox. */
	adresse: text('adresse').notNull().unique(),

	// --- Graph connection (SPEC §3: multi-tenant app registration, client credentials) ---
	tenantId: text('tenant_id').notNull(),
	clientId: text('client_id').notNull(),
	/** Encrypted at rest per SPEC §12 — the encryption itself lands with #35. */
	clientSecretChiffre: text('client_secret_chiffre'),
	/** Drives the proactive warning before the credential expires (SPEC §3). */
	secretAblaufAm: timestamp('secret_ablauf_am', { withTimezone: true }),

	// --- Delta state (SPEC §3) ---
	deltaToken: text('delta_token'),
	letzterErfolgreicherPoll: timestamp('letzter_erfolgreicher_poll', { withTimezone: true }),
	letzterFehlerCode: text('letzter_fehler_code'),
	letzterFehlerText: text('letzter_fehler_text'),
	letzterFehlerAm: timestamp('letzter_fehler_am', { withTimezone: true }),
	pollIntervallSekunden: integer('poll_intervall_sekunden').notNull().default(120),

	// --- Lernfenster (CONTEXT „Lernfenster") ---
	lernfensterTage: integer('lernfenster_tage').notNull().default(30),
	/** Set once the one-off backfill has finished; null means it is still running or never ran. */
	lernfensterAbgeschlossenAm: timestamp('lernfenster_abgeschlossen_am', { withTimezone: true }),

	aktiv: boolean('aktiv').notNull().default(true),
	erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull().defaultNow()
});
