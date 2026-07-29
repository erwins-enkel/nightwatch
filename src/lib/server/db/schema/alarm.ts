import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	foreignKey,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { monitor } from './monitor';
import { selbstMonitor } from './system';
import {
	alarmEreignis,
	alarmgrund,
	erholungsArt,
	ticketZustand,
	zustellKanal,
	zustellZustand
} from './enums';

/**
 * One disruption episode, from the Alarm that opened it to the Entwarnung that closed it
 * (SPEC §10 `uebergang / alarm`).
 *
 * A row is an episode, not a single transition: SPEC hangs the occurrence counter and the
 * acknowledge marker on the same entity as `alert_id` and Alarmgrund, and both describe the span
 * rather than a moment. That shape buys the model's strongest invariant — the partial unique
 * indexes below make "ein Alarm pro Übergang" (SPEC §6) a database guarantee instead of
 * application discipline. Its sibling rule, "ein offenes Ticket pro Monitor", is a separate
 * guarantee and lives on `ticket_korrelation`: a ticket outlives its episode.
 *
 * Every other Grund-Wechsel and every repeat occurrence is only counted internally; the summary
 * goes out with the Entwarnung (CONTEXT „Verschärfung").
 */
export const uebergang = pgTable(
	'uebergang',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		/**
		 * The identifier published to the outside — webhook payloads (SPEC §7) and ticket bodies.
		 * Deliberately separate from the primary key so internal ids never leave the instance.
		 */
		alertId: uuid('alert_id').notNull().unique().defaultRandom(),

		/** Exactly one of the two is set; see the CHECK below. */
		monitorId: uuid('monitor_id').references(() => monitor.id, { onDelete: 'cascade' }),
		selbstMonitorId: uuid('selbst_monitor_id').references(() => selbstMonitor.id, {
			onDelete: 'cascade'
		}),

		/** The reason at alarm time. The live reason is on the monitor itself. */
		alarmgrund: alarmgrund('alarmgrund').notNull(),
		/**
		 * CONTEXT „Verschärfung" is by definition *the* switch to „Fehler gemeldet" while gestört —
		 * the only mid-episode automatic ticket comment. One timestamp captures it entirely.
		 */
		verschaerftAm: timestamp('verschaerft_am', { withTimezone: true }),

		begonnenAm: timestamp('begonnen_am', { withTimezone: true }).notNull().defaultNow(),
		/**
		 * When the `alarm` event was handed to the Alarmwege (#27) — the outbox marker beside
		 * `verschaerfung_gemeldet_am` and `entwarnt_am`.
		 *
		 * A transition is written inside the transaction that decided it; sending from there would
		 * either publish what a rollback takes back or lose the event on a crash. So the publisher
		 * derives its work from these three columns instead, exactly like every other loop in this
		 * service derives its work from rows.
		 */
		alarmiertAm: timestamp('alarmiert_am', { withTimezone: true }),
		verschaerfungGemeldetAm: timestamp('verschaerfung_gemeldet_am', { withTimezone: true }),
		/** Feeds Auto-Zurück: "no new occurrence for the configured time" (CONTEXT). */
		letztesVorkommenAm: timestamp('letztes_vorkommen_am', { withTimezone: true })
			.notNull()
			.defaultNow(),
		vorkommen: integer('vorkommen').notNull().default(1),

		/** Internal recovery — the dashboard flips immediately (CONTEXT „Entwarnungs-Stabilität"). */
		beendetAm: timestamp('beendet_am', { withTimezone: true }),
		/** When the Entwarnung actually went out, i.e. after the stability window held. */
		entwarntAm: timestamp('entwarnt_am', { withTimezone: true }),
		/**
		 * When it became certain that this all-clear will never go out: the monitor broke again
		 * *within* the stability window, so the recovery did not hold (CONTEXT
		 * „Entwarnungs-Stabilität"). Written by the successor episode as it opens.
		 *
		 * Recorded at that moment rather than re-derived on every tick — otherwise every suppressed
		 * episode would be scanned forever, and the rule would live in two places.
		 */
		entwarnungEntfaelltAm: timestamp('entwarnung_entfaellt_am', { withTimezone: true }),
		erholungsArt: erholungsArt('erholungs_art'),

		/** Pure dashboard marker without outside effect; expires with the recovery (CONTEXT). */
		quittiertAm: timestamp('quittiert_am', { withTimezone: true }),
		/** Re-alarm after a closed ticket links back to its predecessor (SPEC §6). */
		vorgaengerId: uuid('vorgaenger_id'),

		erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		/** Self-reference, so it has to be declared at table level rather than inline. */
		foreignKey({
			name: 'uebergang_vorgaenger_fk',
			columns: [t.vorgaengerId],
			foreignColumns: [t.id]
		}).onDelete('set null'),
		index('uebergang_monitor_begonnen_idx').on(t.monitorId, t.begonnenAm.desc()),
		index('uebergang_selbst_monitor_begonnen_idx').on(t.selbstMonitorId, t.begonnenAm.desc()),
		/** Reads the predecessor when an episode opens, and the chain in the alarm history. */
		index('uebergang_vorgaenger_idx').on(t.vorgaengerId),
		/**
		 * The publisher's claim (#27), in the order it publishes: episode by episode, oldest first.
		 *
		 * The predicate is the claim's `WHERE` verbatim, so the planner can prove the implication.
		 * It keeps the index to the handful of episodes that still owe an event — the table itself
		 * is permanent history (SPEC §11) and grows without bound.
		 */
		index('uebergang_veroeffentlichung_offen_idx').on(t.begonnenAm, t.id)
			.where(sql`alarmiert_am is null
				or (verschaerft_am is not null and verschaerfung_gemeldet_am is null)
				or (
					beendet_am is not null and entwarnt_am is null
					and entwarnung_entfaellt_am is null and erholungs_art <> 'archiviert'
				)`),
		/** At most one open episode per monitor — "ein Alarm pro Übergang" (SPEC §6). */
		uniqueIndex('uebergang_offen_je_monitor_key')
			.on(t.monitorId)
			.where(sql`beendet_am is null`),
		uniqueIndex('uebergang_offen_je_selbst_monitor_key')
			.on(t.selbstMonitorId)
			.where(sql`beendet_am is null`),
		/** An episode belongs to a customer monitor or to a self-monitor, never to both. */
		check(
			'uebergang_genau_ein_monitor',
			sql`(monitor_id is not null) <> (selbst_monitor_id is not null)`
		),
		/** A recovered episode names how it recovered — only `beweis` may close a ticket. */
		check('uebergang_erholung_vollstaendig', sql`(beendet_am is null) = (erholungs_art is null)`),
		/**
		 * The Entwarnung goes out *after* the internal recovery held for the stability window, so
		 * it can lag `beendet_am` — but it can never precede it. Otherwise a row would claim the
		 * all-clear was sent for a disruption that is still running.
		 */
		check(
			'uebergang_entwarnung_nach_erholung',
			sql`entwarnt_am is null or (beendet_am is not null and entwarnt_am >= beendet_am)`
		),
		/** A Verschärfung can only be reported once it happened. */
		check(
			'uebergang_verschaerfung_gemeldet_nach_verschaerfung',
			sql`verschaerfung_gemeldet_am is null or verschaerft_am is not null`
		),
		/**
		 * An episode's all-clear either went out or was cancelled — never both, and neither before
		 * the recovery it would report.
		 */
		check(
			'uebergang_entwarnung_ausgang_eindeutig',
			sql`(entwarnt_am is null or entwarnung_entfaellt_am is null)
				and (entwarnung_entfaellt_am is null or beendet_am is not null)`
		)
	]
);

/**
 * Autotask ticket ↔ correlation key (SPEC §10).
 *
 * Anchored on the **monitor**, not on the episode, because SPEC §6 wants "ein offenes Ticket pro
 * Monitor" across episodes: Erledigen and Auto-Zurück only comment, so a ticket stays open past
 * the end of its episode and a re-alarm must attach to it. Only "Re-Alarm nach Schließung" opens
 * a new one. A 1:1 to `uebergang` would make that unrepresentable — hence the partial unique
 * indexes below, which are what actually enforce the rule.
 *
 * `uebergang_id` is the episode that opened the ticket, kept as provenance and nulled rather than
 * cascaded: SPEC §11 lists ticket correlations as permanent, and losing one would orphan a live
 * PSA ticket that Nightwatch could then never comment on or close.
 *
 * The unique `korrelations_key` is what makes retries idempotent: before creating a ticket the
 * worker queries Autotask for an open ticket carrying this key in `externalID` (SPEC §7).
 */
export const ticketKorrelation = pgTable(
	'ticket_korrelation',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		/** Exactly one of the two is set, mirroring `uebergang`. */
		monitorId: uuid('monitor_id').references(() => monitor.id, { onDelete: 'cascade' }),
		selbstMonitorId: uuid('selbst_monitor_id').references(() => selbstMonitor.id, {
			onDelete: 'cascade'
		}),
		uebergangId: uuid('uebergang_id').references(() => uebergang.id, { onDelete: 'set null' }),
		/** `nw:{monitorId}:{uebergangId}`, or `self:…` for a self-monitor (SPEC §7). */
		korrelationsKey: text('korrelations_key').notNull().unique(),
		/** Autotask's internal ticket id; null while the creation is still queued. */
		ticketId: text('ticket_id'),
		/** The human-facing ticket number, for display and deep links. */
		ticketNummer: text('ticket_nummer'),
		zustand: ticketZustand('zustand').notNull().default('offen'),
		angelegtAm: timestamp('angelegt_am', { withTimezone: true }),
		letzterKommentarAm: timestamp('letzter_kommentar_am', { withTimezone: true }),
		geschlossenAm: timestamp('geschlossen_am', { withTimezone: true })
	},
	(t) => [
		/** SPEC §6, "Ein offenes Ticket pro Monitor" — as a guarantee, not as a convention. */
		uniqueIndex('ticket_offen_je_monitor_key')
			.on(t.monitorId)
			.where(sql`zustand = 'offen'`),
		uniqueIndex('ticket_offen_je_selbst_monitor_key')
			.on(t.selbstMonitorId)
			.where(sql`zustand = 'offen'`),
		index('ticket_korrelation_uebergang_idx').on(t.uebergangId),
		check(
			'ticket_korrelation_genau_ein_monitor',
			sql`(monitor_id is not null) <> (selbst_monitor_id is not null)`
		),
		check(
			'ticket_korrelation_geschlossen_am_zum_zustand',
			sql`(zustand = 'geschlossen') = (geschlossen_am is not null)`
		)
	]
);

/**
 * A webhook receiver (SPEC §7). Its own table rather than a list inside `einstellungen`, because
 * each target carries its own HMAC secret, and SPEC §12 requires every secret to be encrypted at
 * rest as a value of its own.
 */
export const webhookZiel = pgTable(
	'webhook_ziel',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		bezeichnung: text('bezeichnung').notNull(),
		/** HTTPS only, except for internal targets the operator opts in explicitly (SPEC §12). */
		url: text('url').notNull(),
		/** Secret for the `X-Nightwatch-Signature` HMAC-SHA256 over the body. */
		secretChiffre: text('secret_chiffre'),
		/** The opt-in from SPEC §12 — for an internal receiver that has no certificate. */
		httpErlaubt: boolean('http_erlaubt').notNull().default(false),
		aktiv: boolean('aktiv').notNull().default(true),
		erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		/**
		 * „Webhooks nur HTTPS-Ziele, HTTP nur mit explizitem Opt-in für interne Ziele" (SPEC §12) —
		 * as a database guarantee, because the form is not the only way a row can appear.
		 *
		 * The opt-in grants **HTTP**, not "any scheme": without the second half a target could carry
		 * `ftp://` or `file://` the moment the checkbox is set, and the delivery would fail in the
		 * fetch layer instead of at the one place that is supposed to decide this.
		 */
		check(
			'webhook_ziel_transport',
			sql`${t.url} like 'https://%' or (${t.httpErlaubt} and ${t.url} like 'http://%')`
		)
	]
);

/**
 * Nightwatch's own ledger of an outbound alarm delivery (SPEC §10 `zustellung`).
 *
 * pg-boss owns the retry mechanics in its own schema; this table records what was meant to go
 * where, so the dashboard can show a dead letter and the global self-monitor can notice that
 * alarm delivery itself is broken (SPEC §8).
 */
export const zustellung = pgTable(
	'zustellung',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		uebergangId: uuid('uebergang_id')
			.notNull()
			.references(() => uebergang.id, { onDelete: 'cascade' }),
		ereignis: alarmEreignis('ereignis').notNull(),
		kanal: zustellKanal('kanal').notNull(),
		/**
		 * Set for webhook deliveries, null for Autotask. `restrict`, not `cascade`: this table is
		 * the evidence a dead letter happened, and deleting a misbehaving receiver must not erase
		 * the record of the alarms that failed to reach it — which is exactly what the global
		 * self-monitor reacts to (SPEC §8). Retiring a receiver is `aktiv = false`.
		 */
		webhookZielId: uuid('webhook_ziel_id').references(() => webhookZiel.id, {
			onDelete: 'restrict'
		}),
		/** The pg-boss job backing this delivery, for tracing a retry back to its queue entry. */
		jobId: text('job_id'),
		zustand: zustellZustand('zustand').notNull().default('offen'),
		versuche: integer('versuche').notNull().default(0),
		letzterFehler: text('letzter_fehler'),
		erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull().defaultNow(),
		zugestelltAm: timestamp('zugestellt_am', { withTimezone: true })
	},
	(t) => [
		index('zustellung_uebergang_idx').on(t.uebergangId),
		/** The queue view and the "is delivery healthy?" check both look at the open slice only. */
		index('zustellung_offen_idx')
			.on(t.zustand)
			.where(sql`zustand = 'offen'`),
		/** A webhook delivery names its target; an Autotask delivery must not. */
		check(
			'zustellung_ziel_je_kanal',
			sql`(kanal = 'webhook' and webhook_ziel_id is not null)
				or (kanal = 'autotask' and webhook_ziel_id is null)`
		)
	]
);
