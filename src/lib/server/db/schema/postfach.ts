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
	/**
	 * The complete `@odata.deltaLink` of the last finished round, not a bare token.
	 *
	 * Graph encodes every query option that was set once — `$select`, `$filter`, `changeType` — into
	 * the link it hands back, and the documentation is explicit that the next round has to reuse
	 * that URL verbatim. Rebuilding a request around an extracted token would silently drop those
	 * options, so the whole link is what gets persisted. It is state, not a credential.
	 */
	deltaToken: text('delta_token'),
	/**
	 * The `@odata.nextLink` of a round that is still paging. Set means "resume here", null means the
	 * round is settled — which is what makes a ~30-day backfill survive a restart instead of
	 * starting over.
	 */
	deltaFolgeLink: text('delta_folge_link'),
	letzterErfolgreicherPoll: timestamp('letzter_erfolgreicher_poll', { withTimezone: true }),
	/**
	 * When the delta round that is currently running began. Set by the claim that starts a *fresh*
	 * round, kept while the round pages across several runs.
	 *
	 * Only interesting as the raw material of `ingestion_stand_am` below — a round that settles has
	 * delivered everything that existed at its **beginning**, not at its end.
	 */
	rundeBegonnenAm: timestamp('runde_begonnen_am', { withTimezone: true }),
	/**
	 * The completeness promise (#26): every mail of this mailbox with
	 * `ankunftszeit <= ingestion_stand_am` is present as a row.
	 *
	 * The time scheduler judges nothing beyond the earliest promise across all active mailboxes.
	 * Without it, a monitor could be declared overdue at 06:00 while the 05:58 report is still
	 * sitting in Graph, unfetched — a false alarm the mail could never take back, because it would
	 * arrive as an Entwarnung after the ticket was already created.
	 *
	 * It may therefore only advance where completeness is *provable*: when a delta round settles
	 * (Graph returns `@odata.deltaLink`), and then only to that round's start minus a safety margin
	 * for Graph's eventually consistent delta index. A failed round advances nothing, which
	 * suspends the time evaluation for as long as ingestion is demonstrably broken — CONTEXT
	 * „Ingestion-Gate", derived from data rather than from a state machine.
	 *
	 * Defaults to *now* rather than to the epoch: a fresh mailbox promises nothing about the past,
	 * and an epoch default would freeze every other mailbox's monitors until its first round
	 * settled.
	 */
	ingestionStandAm: timestamp('ingestion_stand_am', { withTimezone: true }).notNull().defaultNow(),
	letzterFehlerCode: text('letzter_fehler_code'),
	letzterFehlerText: text('letzter_fehler_text'),
	letzterFehlerAm: timestamp('letzter_fehler_am', { withTimezone: true }),
	pollIntervallSekunden: integer('poll_intervall_sekunden').notNull().default(120),

	// --- Poll scheduling (SPEC §3: 429/503 backoff honouring Retry-After) ---
	/**
	 * When this mailbox may be polled again. Doubles as the scheduler's lease: claiming a mailbox
	 * pushes this forward in the same statement, so two workers cannot pick up the same one.
	 *
	 * Persisted rather than kept in memory because a restarted worker must not hammer a Graph that
	 * is already throttling us — `restart: unless-stopped` would otherwise reset the backoff.
	 */
	naechsterPollFruehestensAm: timestamp('naechster_poll_fruehestens_am', { withTimezone: true }),
	/** Consecutive failures; the exponent of the backoff curve. Reset by every successful poll. */
	fehlerInFolge: integer('fehler_in_folge').notNull().default(0),

	// --- Lernfenster (CONTEXT „Lernfenster") ---
	lernfensterTage: integer('lernfenster_tage').notNull().default(30),
	/** Set once the one-off backfill has finished; null means it is still running or never ran. */
	lernfensterAbgeschlossenAm: timestamp('lernfenster_abgeschlossen_am', { withTimezone: true }),

	aktiv: boolean('aktiv').notNull().default(true),
	erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull().defaultNow()
});
