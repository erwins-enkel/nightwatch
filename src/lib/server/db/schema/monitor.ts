import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	date,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uuid
} from 'drizzle-orm/pg-core';
import { kunde } from './kunde';
import { postfach } from './postfach';
import {
	alarmgrund,
	erwartungModus,
	monitorArt,
	monitorZustand,
	regelQuelle,
	vorlagenHerkunft
} from './enums';

/**
 * Absolute due times for a heartbeat expectation (CONTEXT „Kalenderplan", e.g. "Mo–Fr bis 06:00").
 * Covers the three calendar-ish Takt classes — täglich, werktäglich, wöchentlich — which is
 * exactly what the derivation can produce; monthly is deliberately out (CONTEXT „Takt").
 *
 * `wochentage` is ISO-8601 (1 = Monday … 7 = Sunday), `uhrzeit` is `HH:MM` in the instance time
 * zone (`einstellungen.zeitzone`), so a plan does not silently shift when the server moves.
 */
export interface Kalenderplan {
	wochentage: number[];
	uhrzeit: string;
}

/**
 * The per-kind parameters of a monitor, as a plain object. The `monitor` table stores these as
 * typed columns (see below); this shape exists so a `regel_vorlage` can carry defaults for them
 * without duplicating the column list in an untyped blob.
 */
export interface MonitorParameter {
	erwartungModus?: 'intervall' | 'kalenderplan';
	erwartungIntervallSekunden?: number;
	erwartungPlan?: Kalenderplan;
	karenzSekunden?: number;
	autoZurueckSekunden?: number;
	maxOffenzeitSekunden?: number;
	zaehlerFensterSekunden?: number;
	zaehlerObergrenze?: number;
	zaehlerUntergrenze?: number;
}

/**
 * The atomic unit of monitoring (CONTEXT „Monitor"): one per watched thing, exactly one kind,
 * exactly one rule, belonging to exactly one customer.
 *
 * Parameters are typed columns rather than one JSON blob: there are only about ten of them, and
 * the scheduler (#26) has to filter on them ("which monitors are due?"). The CHECK constraints at
 * the bottom encode the Dreiklang-Vertrag's parametrisation — each kind carries its own time
 * parameters and none of the others'.
 *
 * There is no materialised `anlauf` column. CONTEXT defines Anlauf as "a full window T since
 * activation or since an Ausnahmetag ended", which is computable from `aktiviert_am`,
 * `zaehler_fenster_sekunden` and the `ausnahmetag` rows — storing it would be redundant state
 * that can drift.
 */
export const monitor = pgTable(
	'monitor',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		kundeId: uuid('kunde_id')
			.notNull()
			.references(() => kunde.id, { onDelete: 'cascade' }),
		bezeichnung: text('bezeichnung').notNull(),
		art: monitorArt('art').notNull(),
		/**
		 * The mailbox this monitor's mails last arrived through. Cached from the assignment so the
		 * Ingestion-Gate (SPEC §8) can suspend overdue decisions per mailbox without joining
		 * through the mail table on every tick.
		 */
		postfachId: uuid('postfach_id').references(() => postfach.id, { onDelete: 'set null' }),

		// --- Parameter je Art (CONTEXT „Erwartung", „Anlauf", SPEC §5) ---
		erwartungModus: erwartungModus('erwartung_modus'),
		erwartungIntervallSekunden: integer('erwartung_intervall_sekunden'),
		erwartungPlan: jsonb('erwartung_plan').$type<Kalenderplan>(),
		karenzSekunden: integer('karenz_sekunden'),
		autoZurueckSekunden: integer('auto_zurueck_sekunden'),
		maxOffenzeitSekunden: integer('max_offenzeit_sekunden'),
		zaehlerFensterSekunden: integer('zaehler_fenster_sekunden'),
		zaehlerObergrenze: integer('zaehler_obergrenze'),
		zaehlerUntergrenze: integer('zaehler_untergrenze'),
		/** Per-monitor override of the instance-wide Entwarnungs-Stabilität (CONTEXT). */
		entwarnungsStabilitaetSekunden: integer('entwarnungs_stabilitaet_sekunden'),

		// --- Zustand (CONTEXT „Zustandsmaschine") ---
		zustand: monitorZustand('zustand').notNull().default('gesund'),
		/** Always the *current* reason while gestört, so the dashboard is live (CONTEXT). */
		alarmgrund: alarmgrund('alarmgrund'),
		zustandSeit: timestamp('zustand_seit', { withTimezone: true }).notNull().defaultNow(),
		/** Orthogonal overlay, not a third state (CONTEXT „Pausiert"). */
		pausiert: boolean('pausiert').notNull().default(false),
		/** Optional auto-end of a pause; null means "until someone un-pauses it". */
		pausiertBis: timestamp('pausiert_bis', { withTimezone: true }),
		/**
		 * Null until a human confirms the rule (SPEC §5). Doubles as the "evaluate forward only"
		 * boundary — CONTEXT „Lernfenster": history is learning material, never monitoring
		 * material, so nothing before this timestamp may ever raise an alarm.
		 */
		aktiviertAm: timestamp('aktiviert_am', { withTimezone: true }),
		/** Last matching mail of any classification — this is what proves the channel is alive. */
		zuletztGesehenAm: timestamp('zuletzt_gesehen_am', { withTimezone: true }),
		/**
		 * Paar only: when the currently open state was opened. A monitor carries exactly one open
		 * state, and the max open time runs from the *first* Auf (CONTEXT „Paar-Monitor").
		 */
		paarOffenSeit: timestamp('paar_offen_seit', { withTimezone: true }),
		/**
		 * How far the time-based evaluation has judged this monitor's Soll-Zeitpunkte (#26).
		 *
		 * Read by the Kalenderplan, the one Erwartung with discrete due times. Unlike `anlauf` this
		 * is *not* a materialised derivation: `zuletzt_gesehen_am` knows only the last mail, so
		 * after a standstill nothing else in the row can still say whether the Soll of two days ago
		 * was covered. A missed Soll would be silently forgiven — the exact blind spot Nightwatch
		 * exists to close.
		 *
		 * It is also what makes „ausgesetzt, nicht verworfen" literal: while the evaluation is
		 * suspended (Bewertungs-Schranke, Ingestion-Gate) this cursor stays put, so the same Soll is
		 * offered again once ingestion and assignment have caught up. Set to *now* on activation and
		 * on a rule change, and never moved backwards — a Soll is judged exactly once.
		 */
		sollGeprueftBisAm: timestamp('soll_geprueft_bis_am', { withTimezone: true }),

		erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		index('monitor_kunde_idx').on(t.kundeId),
		index('monitor_postfach_idx').on(t.postfachId),
		/**
		 * The Dreiklang-Vertrag in SQL: every kind requires its own time parameters and must leave
		 * the other kinds' parameters empty, so a monitor can never carry a stale window from a
		 * kind it used to be.
		 *
		 * The `else false` matters: adding a Monitor-Art to the enum without extending this CASE
		 * would otherwise yield NULL, and a NULL CHECK passes — the guard would quietly stop
		 * guarding. Failing loudly instead costs the author of the new kind one follow-up
		 * migration (Postgres will not accept a new enum value in a constraint in the same
		 * transaction that adds it).
		 */
		check(
			'monitor_parameter_je_art',
			sql`case art
				when 'heartbeat' then
					erwartung_modus is not null and karenz_sekunden is not null
					and auto_zurueck_sekunden is null and max_offenzeit_sekunden is null
					and zaehler_fenster_sekunden is null
					and zaehler_obergrenze is null and zaehler_untergrenze is null
					and paar_offen_seit is null
				when 'ereignis' then
					auto_zurueck_sekunden is not null
					and erwartung_modus is null and karenz_sekunden is null
					and max_offenzeit_sekunden is null and zaehler_fenster_sekunden is null
					and zaehler_obergrenze is null and zaehler_untergrenze is null
					and paar_offen_seit is null
				when 'paar' then
					max_offenzeit_sekunden is not null
					and erwartung_modus is null and karenz_sekunden is null
					and auto_zurueck_sekunden is null and zaehler_fenster_sekunden is null
					and zaehler_obergrenze is null and zaehler_untergrenze is null
				when 'zaehler' then
					zaehler_fenster_sekunden is not null
					and (zaehler_obergrenze is not null or zaehler_untergrenze is not null)
					and erwartung_modus is null and karenz_sekunden is null
					and auto_zurueck_sekunden is null and max_offenzeit_sekunden is null
					and paar_offen_seit is null
				else false
			end`
		),
		/**
		 * CONTEXT „Gestört": the disturbed state always carries a reason, and a healthy monitor
		 * carries none — so a stale Alarmgrund cannot survive a recovery and colour the dashboard.
		 */
		check('monitor_alarmgrund_zum_zustand', sql`(zustand = 'gestoert') = (alarmgrund is not null)`),
		/** An Erwartung carries exactly the payload its mode names — never both, never neither. */
		check(
			'monitor_erwartung_vollstaendig',
			sql`case
				when erwartung_modus is null then
					erwartung_intervall_sekunden is null and erwartung_plan is null
				when erwartung_modus = 'intervall' then
					erwartung_intervall_sekunden is not null and erwartung_plan is null
				when erwartung_modus = 'kalenderplan' then
					erwartung_plan is not null and erwartung_intervall_sekunden is null
				else false
			end`
		),
		/**
		 * Durations are non-negative and the counter band is not inverted.
		 * `max_offenzeit_sekunden` may be 0 — that is its documented default, "alarm immediately"
		 * (CONTEXT „Paar-Monitor"). The bounds may be equal (a band of exactly one value is odd
		 * but meaningful); only an upper bound *below* the lower one is impossible, because it
		 * would leave the monitor permanently disturbed with no reachable healthy state.
		 */
		check(
			'monitor_parameter_plausibel',
			sql`karenz_sekunden >= 0
				and erwartung_intervall_sekunden > 0
				and auto_zurueck_sekunden > 0
				and max_offenzeit_sekunden >= 0
				and zaehler_fenster_sekunden > 0
				and zaehler_obergrenze >= 0
				and zaehler_untergrenze >= 0
				and entwarnungs_stabilitaet_sekunden >= 0
				and (
					zaehler_obergrenze is null or zaehler_untergrenze is null
					or zaehler_obergrenze >= zaehler_untergrenze
				)`
		)
	]
);

/**
 * A rule ships with its own curated template (CONTEXT „Regel-Vorlage"): curated ones arrive as
 * versioned data in the container image and are upserted on release (#32), the operator's own
 * ones come from export/import.
 */
export const regelVorlage = pgTable('regel_vorlage', {
	id: uuid('id').primaryKey().defaultRandom(),
	/** Stable identifier used to upsert curated templates across releases, e.g. `veeam-report`. */
	schluessel: text('schluessel').notNull().unique(),
	name: text('name').notNull(),
	hersteller: text('hersteller'),
	beschreibung: text('beschreibung'),
	herkunft: vorlagenHerkunft('herkunft').notNull(),
	/** Version of the template's content, so a release can tell whether to overwrite. */
	version: integer('version').notNull().default(1),
	vorgeschlageneArt: monitorArt('vorgeschlagene_art'),

	absender: text('absender')
		.array()
		.notNull()
		.default(sql`'{}'::text[]`),
	betreffMuster: text('betreff_muster')
		.array()
		.notNull()
		.default(sql`'{}'::text[]`),
	schluesselwoerter: text('schluesselwoerter')
		.array()
		.notNull()
		.default(sql`'{}'::text[]`),
	musterSchlecht: text('muster_schlecht')
		.array()
		.notNull()
		.default(sql`'{}'::text[]`),
	musterGut: text('muster_gut')
		.array()
		.notNull()
		.default(sql`'{}'::text[]`),

	/** Prefill for the monitor's per-kind parameters (CONTEXT „Vorbefüllungs-Grad"). */
	parameterDefaults: jsonb('parameter_defaults').$type<MonitorParameter>(),
	erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull().defaultNow()
});

/**
 * The detection logic inside a monitor (CONTEXT „Regel") — exactly one per monitor.
 *
 * The two pattern slots are named generically on purpose: one bad signal, one good signal, which
 * each Monitor-Art reads its own way (Heartbeat Fehler/OK · Ereignis —/Harmlos-Filter · Paar
 * Auf/Zu · Zähler unused). One structure, four readings, one place for the classifier seam.
 *
 * All pattern fields are arrays because rules are language independent (CONTEXT „Regel"): the
 * same software reports "Backup completed" or "Sicherung erfolgreich" depending on its config.
 */
export const regel = pgTable('regel', {
	id: uuid('id').primaryKey().defaultRandom(),
	/** Unique: CONTEXT is explicit that there is exactly one rule per monitor. */
	monitorId: uuid('monitor_id')
		.notNull()
		.unique()
		.references(() => monitor.id, { onDelete: 'cascade' }),

	// --- Match-Kriterien: which mails are "mine", within the recognised customer ---
	absender: text('absender')
		.array()
		.notNull()
		.default(sql`'{}'::text[]`),
	betreffMuster: text('betreff_muster')
		.array()
		.notNull()
		.default(sql`'{}'::text[]`),
	schluesselwoerter: text('schluesselwoerter')
		.array()
		.notNull()
		.default(sql`'{}'::text[]`),

	// --- Muster-Slots: interpreted by the Monitor-Art ---
	musterSchlecht: text('muster_schlecht')
		.array()
		.notNull()
		.default(sql`'{}'::text[]`),
	musterGut: text('muster_gut')
		.array()
		.notNull()
		.default(sql`'{}'::text[]`),

	quelle: regelQuelle('quelle').notNull(),
	/** Provenance only — a template may be deleted without taking the rules it seeded with it. */
	vorlageId: uuid('vorlage_id').references(() => regelVorlage.id, { onDelete: 'set null' }),
	erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull().defaultNow(),
	geaendertAm: timestamp('geaendert_am', { withTimezone: true }).notNull().defaultNow()
});

/** A named, reusable bundle of exception days (CONTEXT „Ausnahmetag"). */
export const ausnahmekalender = pgTable('ausnahmekalender', {
	id: uuid('id').primaryKey().defaultRandom(),
	name: text('name').notNull().unique(),
	beschreibung: text('beschreibung'),
	erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull().defaultNow()
});

/**
 * A single date on which the *time* targets are suspended — calendar plan due times and the
 * counter's lower bound. The upper bound stays sharp: a message storm on a holiday is all the
 * more a finding (CONTEXT „Ausnahmetag").
 */
export const ausnahmetag = pgTable(
	'ausnahmetag',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		kalenderId: uuid('kalender_id')
			.notNull()
			.references(() => ausnahmekalender.id, { onDelete: 'cascade' }),
		datum: date('datum').notNull(),
		bezeichnung: text('bezeichnung')
	},
	(t) => [unique('ausnahmetag_kalender_datum_key').on(t.kalenderId, t.datum)]
);

/** Which calendars apply to which monitor. */
export const monitorAusnahmekalender = pgTable(
	'monitor_ausnahmekalender',
	{
		monitorId: uuid('monitor_id')
			.notNull()
			.references(() => monitor.id, { onDelete: 'cascade' }),
		kalenderId: uuid('kalender_id')
			.notNull()
			.references(() => ausnahmekalender.id, { onDelete: 'cascade' })
	},
	(t) => [primaryKey({ columns: [t.monitorId, t.kalenderId] })]
);
