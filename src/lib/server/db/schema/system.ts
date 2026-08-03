import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	integer,
	jsonb,
	pgTable,
	smallint,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { postfach } from './postfach';
import { alarmgrund, monitorZustand, selbstMonitorArt } from './enums';

/** The stable key of the one global self-monitor; seeded by a migration, never created by hand. */
export const SELBST_MONITOR_KERN = 'kern';

/**
 * A built-in system monitor (CONTEXT „Selbst-Monitor"): one global core monitor plus one per
 * mailbox. It inherits the full state machine and alarm lifecycle, but it belongs to no customer,
 * has no rule and no Monitor-Art — which is exactly why it is its own table rather than a
 * `monitor` row with everything nullable.
 *
 * The watchdog evaluates and sends these outside the normal pipeline (SPEC §8), so nothing here
 * depends on the worker or pg-boss being alive.
 */
export const selbstMonitor = pgTable(
	'selbst_monitor',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		/** `kern` for the global one, `postfach:{uuid}` for a mailbox's. */
		schluessel: text('schluessel').notNull().unique(),
		art: selbstMonitorArt('art').notNull(),
		/**
		 * Nulled rather than cascaded when the mailbox is deleted. SPEC §11 says deleting a
		 * Postfach removes "dessen Mails und Delta-State" — not the alarm history, and explicitly
		 * not the ticket correlations, which it lists as permanent. Cascading here would have
		 * taken both with it through `uebergang`, orphaning any still-open PSA ticket: Nightwatch
		 * would no longer hold the correlation key needed to comment on or close it.
		 *
		 * A row with `art = 'postfach'` and no mailbox is therefore a retired ingestion monitor,
		 * kept so its episodes stay attributable.
		 */
		postfachId: uuid('postfach_id')
			.unique()
			.references(() => postfach.id, { onDelete: 'set null' }),
		bezeichnung: text('bezeichnung').notNull(),

		zustand: monitorZustand('zustand').notNull().default('gesund'),
		alarmgrund: alarmgrund('alarmgrund'),
		zustandSeit: timestamp('zustand_seit', { withTimezone: true }).notNull().defaultNow(),

		/**
		 * How long the observed signal (a successful poll, a fresh heartbeat) may be missing before
		 * the monitor is gestört. Self-monitors are not creatable or deletable, but their
		 * parameters are settable (CONTEXT).
		 */
		stalenessSekunden: integer('staleness_sekunden').notNull().default(900),
		entwarnungsStabilitaetSekunden: integer('entwarnungs_stabilitaet_sekunden'),
		erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		/** There is exactly one „Nightwatch-Kern" — Wurzel-Unterdrückung depends on it. */
		uniqueIndex('selbst_monitor_kern_key')
			.on(t.art)
			.where(sql`art = 'kern'`),
		/**
		 * The global monitor never has a mailbox. The reverse is only enforced one way: a retired
		 * mailbox monitor keeps existing without one (see `postfachId`), so "art = 'postfach'
		 * implies a mailbox" cannot be a table constraint — creating one with a mailbox is the
		 * application's job (#23/#30).
		 */
		check('selbst_monitor_kern_ohne_postfach', sql`art = 'postfach' or postfach_id is null`),
		/** Same coupling as on `monitor`: gestört always names a reason, gesund never does. */
		check(
			'selbst_monitor_alarmgrund_zum_zustand',
			sql`(zustand = 'gestoert') = (alarmgrund is not null)`
		),
		check(
			'selbst_monitor_parameter_plausibel',
			sql`staleness_sekunden > 0 and entwarnungs_stabilitaet_sekunden >= 0`
		)
	]
);

/**
 * SPEC §7 — the tenant-specific numeric IDs, resolved once at setup and never hardcoded.
 *
 * Every value here is a picklist entry of *one* Autotask tenant; there is deliberately no default
 * anywhere in the code. An instance that has not resolved them yet simply does not plan an Autotask
 * delivery (`autotask/weg.ts`), which is how the channel stays off until it is actually configured.
 */
export interface AutotaskTicketDefaults {
	/**
	 * The status a Nightwatch ticket is created with — and therefore also the reference for
	 * „unberührt" when an Entwarnung asks whether it may close the ticket (SPEC §6).
	 */
	statusId?: number;
	priorityId?: number;
	queueId?: number;
	/** The status a ticket is set to when a beweisbasierte Erholung closes it. */
	abschlussStatusId?: number;
	/** `billingCodeID`; only needed when the tenant requires a work type on tickets. */
	arbeitstypId?: number;
	/** `TicketNotes.noteType` / `TicketNotes.publish` — both required on a note. */
	notizTypId?: number;
	notizPublishId?: number;
	/**
	 * `dueDateTime = angelegt + N h`. Autotask requires a due date unless the ticket category
	 * supplies one, so this is set by default; clearing it omits the field entirely.
	 */
	faelligkeitStunden?: number;
	/**
	 * The company a **self-monitor** ticket is filed under (SPEC §8).
	 *
	 * A self-monitor „gehört keinem Kunden; wohin sein Ticket geht, ist reine Transport-Konfiguration"
	 * (CONTEXT) — but Autotask requires a `companyID` on every ticket, so the operator has to name
	 * one. Deliberately outside `istEinsatzbereit()`: without it Nightwatch simply does not plan an
	 * Autotask delivery for self-alarms, and they travel by webhook — exactly like a customer without
	 * an Autotask-Verknüpfung.
	 */
	selbstCompanyId?: number;
}

/**
 * Instance configuration (SPEC §10). A single row: `id` is pinned to 1 by a CHECK, so a second
 * configuration cannot come into existence and no query needs an "ORDER BY … LIMIT 1" ritual.
 *
 * Secrets live in `*_chiffre` columns; SPEC §12 requires AES-256-GCM at rest, which #35 adds.
 */
export const einstellungen = pgTable(
	'einstellungen',
	{
		id: smallint('id').primaryKey().default(1),

		/**
		 * SPEC §11: default 90 days. The real floor is the *Lernfenster*, which is per mailbox
		 * (`postfach.lernfenster_tage`) and settable — so it cannot be a table CHECK here. The 30
		 * below is only an absolute backstop; validating retention against the widest configured
		 * learning window is the settings form's job, not the database's.
		 */
		retentionTage: integer('retention_tage').notNull().default(90),
		/** Interprets every `HH:MM` in a Kalenderplan and in the Takt statistics. */
		zeitzone: text('zeitzone').notNull().default('Europe/Berlin'),
		/** Instance-wide default; a monitor may override it (CONTEXT „Entwarnungs-Stabilität"). */
		entwarnungsStabilitaetSekunden: integer('entwarnungs_stabilitaet_sekunden')
			.notNull()
			.default(900),

		/** CONTEXT „Heartbeat-Ping" — opt-in; null means the total outage is simply unobserved. */
		heartbeatPingUrlChiffre: text('heartbeat_ping_url_chiffre'),
		heartbeatPingIntervallSekunden: integer('heartbeat_ping_intervall_sekunden')
			.notNull()
			.default(300),
		/**
		 * When a ping last reached its receiver. Doubles as the schedule — the next one is due an
		 * interval after it — and as what the dashboard shows: „opted in" and „actually arriving" are
		 * different statements, and only the second one is worth anything.
		 */
		heartbeatPingZuletztAm: timestamp('heartbeat_ping_zuletzt_am', { withTimezone: true }),

		// --- Autotask (SPEC §7) ---
		autotaskAktiv: boolean('autotask_aktiv').notNull().default(false),
		/** Resolved once via `zoneInformation` and then persisted, rather than looked up per call. */
		autotaskZoneUrl: text('autotask_zone_url'),
		autotaskBenutzer: text('autotask_benutzer'),
		autotaskSecretChiffre: text('autotask_secret_chiffre'),
		autotaskIntegrationCodeChiffre: text('autotask_integration_code_chiffre'),
		autotaskTicketDefaults: jsonb('autotask_ticket_defaults').$type<AutotaskTicketDefaults>(),

		geaendertAm: timestamp('geaendert_am', { withTimezone: true }).notNull().defaultNow()
	},
	() => [
		check('einstellungen_singleton', sql`id = 1`),
		check(
			'einstellungen_plausibel',
			sql`retention_tage >= 30
				and entwarnungs_stabilitaet_sekunden >= 0
				and heartbeat_ping_intervall_sekunden > 0`
		)
	]
);

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
