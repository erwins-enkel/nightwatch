import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { kunde, zuordnungsMerkmal } from './kunde';
import { monitor } from './monitor';
import { postfach } from './postfach';
import { klassifikation, taktKlasse, triageGrund } from './enums';

/**
 * A recurring kind of mail from a known customer, grouped by its Sorten-Signatur (sender +
 * subject pattern) — CONTEXT „Unüberwachte Mail-Sorte".
 *
 * Rows survive retention: they carry statistics (count, last arrival, Takt), never bodies
 * (SPEC §11). "Ignoriert" is per customer *and* kind, never global — a sender dismissed at
 * customer A must not hide the same kind at customer B.
 */
export const mailSorte = pgTable(
	'mail_sorte',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		kundeId: uuid('kunde_id')
			.notNull()
			.references(() => kunde.id, { onDelete: 'cascade' }),
		/** The normalised Sorten-Signatur; the two columns below keep it human readable. */
		signatur: text('signatur').notNull(),
		absender: text('absender').notNull(),
		betreffMuster: text('betreff_muster').notNull(),

		anzahl: integer('anzahl').notNull().default(0),
		ersterEingang: timestamp('erster_eingang', { withTimezone: true }),
		letzterEingang: timestamp('letzter_eingang', { withTimezone: true }),

		// --- Takt (CONTEXT „Takt"): recognised from >= 3 occurrences at <= ~25 % spread ---
		taktKlasse: taktKlasse('takt_klasse'),
		taktIntervallSekunden: integer('takt_intervall_sekunden'),
		/** `HH:MM` in the instance time zone, for the täglich/werktäglich/wöchentlich classes. */
		taktUhrzeit: text('takt_uhrzeit'),
		/** ISO weekday 1–7, only meaningful for the wöchentlich class. */
		taktWochentag: integer('takt_wochentag'),
		/** The evidence a Takt proposal must carry: "werktäglich ~05:40, aus 12 Vorkommen". */
		taktVorkommen: integer('takt_vorkommen'),

		ignoriert: boolean('ignoriert').notNull().default(false),
		ignoriertAm: timestamp('ignoriert_am', { withTimezone: true })
	},
	(t) => [
		/** Issue requirement: the Sorten-Signatur index. One row per customer and signature. */
		unique('mail_sorte_kunde_signatur_key').on(t.kundeId, t.signatur),
		/** The Ablage needs to know *when* a Sorte was dismissed, so the two move together. */
		check('mail_sorte_ignoriert_am_zum_flag', sql`ignoriert = (ignoriert_am is not null)`)
	]
);

/**
 * An ingested mail (SPEC §3, §10, §11).
 *
 * Data minimisation is the rule: subject and body *as text*, never attachments, HTML reduced to
 * text. Rows are deleted hard by the retention job (#34), which is why every durable statistic
 * lives on `mail_sorte`, `monitor` or `uebergang` instead of being recomputed from mails.
 */
export const mail = pgTable(
	'mail',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		postfachId: uuid('postfach_id')
			.notNull()
			.references(() => postfach.id, { onDelete: 'cascade' }),
		/** Graph's immutable message id, used to make delta polling idempotent. */
		graphMessageId: text('graph_message_id').notNull(),

		/**
		 * Postfach-Ankunftszeit, never the processing time (SPEC §3). Every due-date decision is
		 * judged against this, which is what lets the Ingestion-Gate tell "really missing" from
		 * "merely processed late" after a backlog is caught up.
		 */
		ankunftszeit: timestamp('ankunftszeit', { withTimezone: true }).notNull(),
		verarbeitetAm: timestamp('verarbeitet_am', { withTimezone: true }),

		/**
		 * CONTEXT „Lernfenster": *Historie ist Lernmaterial, nicht Überwachungsmaterial.* A mail the
		 * backfill pulled in feeds mail search, Takt recognition and rule derivation — it may never
		 * make a monitor fire, or every freshly connected mailbox would be a ticket avalanche.
		 *
		 * Set at insert time from `ankunftszeit < postfach.erstellt_am`, which stays exact however
		 * long the backfill runs and is still right when a `410 Gone` forces a resync years later.
		 */
		ausLernfenster: boolean('aus_lernfenster').notNull().default(false),

		absender: text('absender').notNull(),
		empfaenger: text('empfaenger')
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		betreff: text('betreff').notNull(),
		bodyText: text('body_text'),

		// --- Zuordnungs-Ergebnis (CONTEXT „Kunden-Zuordnung") ---
		kundeId: uuid('kunde_id').references(() => kunde.id, { onDelete: 'cascade' }),
		monitorId: uuid('monitor_id').references(() => monitor.id, { onDelete: 'set null' }),
		/**
		 * Which trait matched. CONTEXT insists that "why did this mail land at customer B?" must be
		 * answerable at a glance — this column is that answer.
		 */
		zuordnungsMerkmalId: uuid('zuordnungs_merkmal_id').references(() => zuordnungsMerkmal.id, {
			onDelete: 'set null'
		}),
		sorteId: uuid('sorte_id').references(() => mailSorte.id, { onDelete: 'set null' }),
		triageGrund: triageGrund('triage_grund'),
		klassifikation: klassifikation('klassifikation')
	},
	(t) => [
		/** Issue requirement, and the workhorse: per-mailbox range scans and per-mailbox cleanup. */
		index('mail_postfach_ankunftszeit_idx').on(t.postfachId, t.ankunftszeit),
		/** Makes re-delivery of the same Graph message a no-op instead of a duplicate. */
		uniqueIndex('mail_postfach_graph_message_key').on(t.postfachId, t.graphMessageId),
		/** Heartbeat "zuletzt gesehen", counting a Zähler window, and the monitor drawer. */
		index('mail_monitor_ankunftszeit_idx').on(t.monitorId, t.ankunftszeit),
		/** The retention job sweeps globally by age (SPEC §11). */
		index('mail_ankunftszeit_idx').on(t.ankunftszeit),
		/**
		 * The three indexes below back this table's inbound foreign keys. Postgres does not index
		 * the referencing side by itself, and `mail` is by far the largest table — without them
		 * SPEC §11's "Löschen auf Zuruf" sequential-scans it once per deleted customer, and once
		 * more per assignment trait and per Sorte that goes with them. `kunde_id` doubles as the
		 * per-customer mail listing in the UI, hence the composite.
		 */
		index('mail_kunde_ankunftszeit_idx').on(t.kundeId, t.ankunftszeit),
		index('mail_sorte_idx').on(t.sorteId),
		index('mail_zuordnungs_merkmal_idx').on(t.zuordnungsMerkmalId),
		/** The triage list is a small slice of a large table. */
		index('mail_triage_grund_idx')
			.on(t.triageGrund)
			.where(sql`triage_grund is not null`),
		/**
		 * The assignment pipeline's claim (#24): "which mails are still unprocessed?", oldest first.
		 *
		 * Partial on purpose. `verarbeitet_am` is null only while a mail waits for the pipeline, so
		 * this index holds the *backlog* and is near-empty in steady state — while an unindexed claim
		 * would sequential-scan the largest table in the schema on every tick, forever, to find
		 * nothing. Oldest-first is the order the pipeline needs anyway: `mail_sorte.erster_eingang`
		 * and the Takt statistics (#32) are only meaningful if arrival order is preserved.
		 */
		index('mail_unverarbeitet_idx')
			.on(t.ankunftszeit)
			.where(sql`verarbeitet_am is null`)
	]
);
