import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { kundeZustand, zuordnungsStufe } from './enums';

/**
 * The company whose systems are monitored (CONTEXT „Kunde"). The MSP itself is kept as an
 * ordinary customer for its own infrastructure — there is no separate "internal" concept.
 */
export const kunde = pgTable(
	'kunde',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		name: text('name').notNull(),
		/** The customer number as the MSP knows it; also usable as a Stufe ② matching value. */
		kundennummer: text('kundennummer'),
		notiz: text('notiz'),
		zustand: kundeZustand('zustand').notNull().default('aktiv'),
		archiviertAm: timestamp('archiviert_am', { withTimezone: true }),
		/**
		 * CONTEXT „Autotask-Verknüpfung" — the stable company ID, set once via the picker. No
		 * continuous sync, so this is a plain number rather than a mirrored record.
		 */
		autotaskCompanyId: bigint('autotask_company_id', { mode: 'number' }),
		erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull().defaultNow()
	},
	() => [
		/**
		 * Archiving is a dated event, not just a flag: the silent-archive rotation (SPEC §11) and
		 * "offene Gestört-Zustände enden still ohne Entwarnung" both need to know when it happened.
		 */
		check(
			'kunde_archiviert_am_zum_zustand',
			sql`(zustand = 'archiviert') = (archiviert_am is not null)`
		)
	]
);

/**
 * A trait that routes incoming mail to a customer (CONTEXT „Zuordnungs-Merkmal").
 *
 * Values are stored normalised (trimmed, lower-cased) by the assignment pipeline (#24) so that
 * the `(stufe, wert)` index below can serve an exact-match lookup.
 */
export const zuordnungsMerkmal = pgTable(
	'zuordnungs_merkmal',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		kundeId: uuid('kunde_id')
			.notNull()
			.references(() => kunde.id, { onDelete: 'cascade' }),
		stufe: zuordnungsStufe('stufe').notNull(),
		wert: text('wert').notNull(),
		erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		/**
		 * The lookup path of the assignment pipeline: given a stage and a value, which customers
		 * match? Deliberately NOT unique — CONTEXT „Kollisionswarnung" says an identical trait on
		 * another customer must remain saveable (transition phases); the duplicate then surfaces
		 * as "mehrdeutig" at match time and as a warning at configuration time.
		 */
		index('zuordnungs_merkmal_stufe_wert_idx').on(t.stufe, t.wert),
		/** The same trait twice on the *same* customer is a data error, not a transition phase. */
		unique('zuordnungs_merkmal_kunde_stufe_wert_key').on(t.kundeId, t.stufe, t.wert)
	]
);
