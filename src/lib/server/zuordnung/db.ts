import { and, asc, desc, eq, exists, inArray, isNull, ne, sql, type SQLWrapper } from 'drizzle-orm';
import { alias, QueryBuilder } from 'drizzle-orm/pg-core';
import { getDb } from '../db/client';
import { kunde, mail, mailSorte, monitor, zuordnungsMerkmal } from '../db/schema';
import type {
	Klassifikation,
	KundeZustand,
	TriageGrund,
	ZuordnungsStufe
} from '../db/schema/enums';
import { TAKT_MAX_VORKOMMEN, erkenneTakt } from '../regel/takt';
import { baueMerkmalIndex, bestimmeKunde, type MerkmalIndex, type MerkmalZeile } from './engine';
import { normalisiereWert } from './merkmal';

/**
 * Every database statement the assignment pipeline and the customer administration need, in one
 * place, so the engine above stays a pure comparison of values.
 */

type Db = ReturnType<typeof getDb>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Pool handle or transaction — every read here works with either. */
type Ausfuehrer = Db | Tx;

// ---------------------------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------------------------

/** A mail waiting for assignment, with exactly the columns the engine looks at. */
export interface StapelMail {
	id: string;
	/** The monitor stage caches this on the monitor, so the Ingestion-Gate stays per mailbox. */
	postfachId: string;
	ankunftszeit: Date;
	ausLernfenster: boolean;
	absender: string;
	empfaenger: string[];
	betreff: string;
	bodyText: string | null;
}

/**
 * Claims unprocessed mails and leases them for the duration of the caller's transaction.
 *
 * `FOR UPDATE SKIP LOCKED` is the whole concurrency design, exactly as in `ingestion/db.ts`: two
 * workers cannot pick up the same mail, and a worker that dies mid-batch releases its rows by
 * rolling back — no lease column, no reaper. Which is why this **must** run inside a transaction:
 * the lock is what keeps the claim exclusive until the results are written.
 *
 * Oldest first, because `mail_sorte.erster_eingang` and the Takt statistics built on it (#32) are
 * only meaningful if the arrival order is preserved.
 */
export function claimUnverarbeitete(anzahl: number, tx: Tx): Promise<StapelMail[]> {
	return tx
		.select({
			id: mail.id,
			postfachId: mail.postfachId,
			ankunftszeit: mail.ankunftszeit,
			ausLernfenster: mail.ausLernfenster,
			absender: mail.absender,
			empfaenger: mail.empfaenger,
			betreff: mail.betreff,
			bodyText: mail.bodyText
		})
		.from(mail)
		.where(isNull(mail.verarbeitetAm))
		.orderBy(asc(mail.ankunftszeit))
		.limit(anzahl)
		.for('update', { skipLocked: true });
}

/**
 * Loads every assignment trait with the bits of its customer the outcome depends on.
 *
 * Read once per batch, not per mail: the number of traits follows the configuration (a handful per
 * customer), the number of mails does not.
 */
export async function ladeMerkmalIndex(db: Ausfuehrer = getDb()): Promise<MerkmalIndex> {
	const zeilen = await db
		.select({
			id: zuordnungsMerkmal.id,
			kundeId: zuordnungsMerkmal.kundeId,
			kundeName: kunde.name,
			zustand: kunde.zustand,
			stufe: zuordnungsMerkmal.stufe,
			wert: zuordnungsMerkmal.wert
		})
		.from(zuordnungsMerkmal)
		.innerJoin(kunde, eq(kunde.id, zuordnungsMerkmal.kundeId));

	return baueMerkmalIndex(
		zeilen.map(({ zustand, ...rest }): MerkmalZeile => ({
			...rest,
			kundeArchiviert: zustand === 'archiviert'
		}))
	);
}

/** One `mail_sorte` row's worth of new observations, aggregated over the batch. */
export interface SortenGruppe {
	kundeId: string;
	signatur: string;
	absender: string;
	betreffMuster: string;
	anzahl: number;
	ersterEingang: Date;
	letzterEingang: Date;
}

/**
 * Counts the batch's observations into `mail_sorte` and returns the row ids by signature.
 *
 * `anzahl` is incremented rather than set, and the two timestamps use `least`/`greatest`, so a
 * second worker and an out-of-order backfill both stay correct — a mail from last week must not
 * move `letzter_eingang` backwards. The caller aggregates per `(kunde_id, signatur)` beforehand;
 * that is not just for efficiency, a single statement may not touch the same conflicting row twice.
 */
export async function upsertSorten(gruppen: SortenGruppe[], tx: Tx): Promise<Map<string, string>> {
	if (gruppen.length === 0) return new Map();

	const zeilen = await tx
		.insert(mailSorte)
		.values(gruppen)
		.onConflictDoUpdate({
			target: [mailSorte.kundeId, mailSorte.signatur],
			set: {
				anzahl: sql`${mailSorte.anzahl} + excluded.anzahl`,
				ersterEingang: sql`least(${mailSorte.ersterEingang}, excluded.erster_eingang)`,
				letzterEingang: sql`greatest(${mailSorte.letzterEingang}, excluded.letzter_eingang)`
			}
		})
		.returning({ id: mailSorte.id, kundeId: mailSorte.kundeId, signatur: mailSorte.signatur });

	return new Map(
		zeilen.map((zeile) => [sortenSchluessel(zeile.kundeId, zeile.signatur), zeile.id])
	);
}

/** The key both the aggregation and the returned map are indexed by. */
export function sortenSchluessel(kundeId: string, signatur: string): string {
	return `${kundeId}\n${signatur}`;
}

/**
 * Recomputes the Takt of the given Sorten from their mails (CONTEXT „Takt", #32).
 *
 * Lives here, beside `upsertSorten`, because this is where `mail_sorte` is written; the recognition
 * itself is a pure function in `regel/takt.ts` and knows nothing about a database.
 *
 * **Why in the assignment batch and not in a loop of its own.** The Takt has to sit on the row
 * before anyone reads it — the unmonitored-Sorten view is one the operator *opens*, and it must not
 * have to wait for a scan (CONTEXT: „kein Hintergrund-Scan, der ihm Kandidaten aufdrängt"). It also
 * has to survive retention (#34), which deletes the mails underneath while the statistics stay.
 * Recomputing exactly the Sorten a batch touched gives both without a second scheduler: in steady
 * state that is a handful of rows, and during a backfill the repeated work is bounded by the cap of
 * `TAKT_MAX_VORKOMMEN` rows per Sorte and read straight off `mail_sorte_ankunftszeit_idx`.
 */
export async function aktualisiereSortenTakt(
	sorteIds: string[],
	zone: string,
	tx: Tx
): Promise<void> {
	if (sorteIds.length === 0) return;

	const eindeutig = [...new Set(sorteIds)];
	const zeilen = await tx.execute<{ sorte_id: string; ankunftszeit: Date }>(sql`
		select sorte_id, ankunftszeit from (
			select
				${mail.sorteId} as sorte_id,
				${mail.ankunftszeit} as ankunftszeit,
				row_number() over (
					partition by ${mail.sorteId} order by ${mail.ankunftszeit} desc
				) as rang
			from ${mail}
			where ${inArray(mail.sorteId, eindeutig)}
		) juengste
		where rang <= ${TAKT_MAX_VORKOMMEN}
	`);

	const jeSorte = new Map<string, Date[]>();
	for (const zeile of zeilen.rows) {
		const vorhanden = jeSorte.get(zeile.sorte_id);
		if (vorhanden) vorhanden.push(new Date(zeile.ankunftszeit));
		else jeSorte.set(zeile.sorte_id, [new Date(zeile.ankunftszeit)]);
	}

	for (const sorteId of eindeutig) {
		const takt = erkenneTakt(jeSorte.get(sorteId) ?? [], zone);

		// Also written when nothing was recognised: a Sorte that used to be regular and has become
		// erratic must lose its Takt, or the wizard would keep prefilling an expectation the mails
		// no longer support.
		await tx
			.update(mailSorte)
			.set({
				taktKlasse: takt?.klasse ?? null,
				taktIntervallSekunden: takt?.intervallSekunden ?? null,
				taktUhrzeit: takt?.uhrzeit ?? null,
				taktWochentag: takt?.wochentag ?? null,
				taktVorkommen: takt?.vorkommen ?? null,
				taktStreuungSekunden: takt?.streuungSekunden ?? null
			})
			.where(eq(mailSorte.id, sorteId));
	}
}

/** What the pipeline decided about one mail. */
export interface MailErgebnis {
	mailId: string;
	kundeId: string | null;
	merkmalId: string | null;
	monitorId: string | null;
	sorteId: string | null;
	triageGrund: TriageGrund | null;
	/**
	 * Only a mail that found a monitor can be classified — the rule's pattern slots belong to the
	 * monitor. Null for everything else, and for the Zähler, whose slots are unused (CONTEXT).
	 */
	klassifikation: Klassifikation | null;
}

/**
 * Writes the batch's outcomes and marks the mails processed.
 *
 * Grouped by identical outcome rather than one statement per mail: a backfill batch collapses to a
 * handful of `UPDATE … WHERE id IN (…)`, because the mails of one customer that match no monitor
 * all carry the same four values.
 */
export async function schreibeErgebnisse(
	ergebnisse: MailErgebnis[],
	jetzt: Date,
	tx: Tx
): Promise<void> {
	const gruppen = new Map<string, { werte: MailErgebnis; ids: string[] }>();

	for (const ergebnis of ergebnisse) {
		const schluessel = [
			ergebnis.kundeId,
			ergebnis.merkmalId,
			ergebnis.monitorId,
			ergebnis.sorteId,
			ergebnis.triageGrund,
			ergebnis.klassifikation
		].join('\n');
		const gruppe = gruppen.get(schluessel);
		if (gruppe) gruppe.ids.push(ergebnis.mailId);
		else gruppen.set(schluessel, { werte: ergebnis, ids: [ergebnis.mailId] });
	}

	for (const { werte, ids } of gruppen.values()) {
		await tx
			.update(mail)
			.set({
				kundeId: werte.kundeId,
				zuordnungsMerkmalId: werte.merkmalId,
				monitorId: werte.monitorId,
				sorteId: werte.sorteId,
				triageGrund: werte.triageGrund,
				klassifikation: werte.klassifikation,
				verarbeitetAm: jetzt
			})
			.where(inArray(mail.id, ids));
	}
}

/**
 * Sends every mail the assignment could not place back through the pipeline.
 *
 * Called whenever the configuration changed in a way that can produce a *new* match: a trait was
 * created (resolves „kein Kunde"), a trait or a customer was deleted (can resolve „mehrdeutig").
 *
 * Deliberately limited to unassigned mails. Re-assigning mail that already has a customer would
 * rewrite the evidence the monitor history rests on — the same reason the ingestion refuses to
 * overwrite an annotated row when Graph re-reports it.
 */
export async function stelleUnzugeordneteZurueck(db: Ausfuehrer = getDb()): Promise<number> {
	// Counted by the driver rather than with `returning`: after a mailbox was connected without any
	// customer configured yet, this can match a whole learning window, and shipping that many ids
	// back only to take their length would be the one expensive part of an otherwise cheap update.
	const ergebnis = await db
		.update(mail)
		.set({ verarbeitetAm: null, triageGrund: null })
		.where(inArray(mail.triageGrund, ['kein_kunde', 'mehrdeutig']));

	return ergebnis.rowCount ?? 0;
}

// ---------------------------------------------------------------------------------------------
// Kunden-Verwaltung
// ---------------------------------------------------------------------------------------------

/**
 * Correlated sub-selects for the customer list, built with the query builder rather than written
 * into a `sql` template.
 *
 * That is not a style preference. Inside a `select({…})` field list drizzle rewrites every *direct*
 * `Column` chunk of an `sql` fragment to a bare identifier — so a hand-written
 * `where ${mail.kundeId} = ${kunde.id}` renders as `where "kunde_id" = "id"`, which Postgres happily
 * resolves against the *inner* table and which is then silently false for every row. A nested query
 * builder is left alone by that rewrite and stays correlated.
 */
const unterabfrage = new QueryBuilder();

/**
 * Whether anything is attached to this customer that a hard delete would take with it.
 *
 * `mail.kunde_id` cascades, so "delete the customer" silently means "delete their mails" — which is
 * why CONTEXT allows hard deletion only „für Fehlanlagen ohne Historie". Traits are not history:
 * they are configuration and are meant to go.
 */
function hatHistorie() {
	const eins = { n: sql`1` };
	const mails = exists(unterabfrage.select(eins).from(mail).where(eq(mail.kundeId, kunde.id)));
	const monitore = exists(
		unterabfrage.select(eins).from(monitor).where(eq(monitor.kundeId, kunde.id))
	);
	const sorten = exists(
		unterabfrage.select(eins).from(mailSorte).where(eq(mailSorte.kundeId, kunde.id))
	);

	return sql<boolean>`${mails} or ${monitore} or ${sorten}`;
}

const kundeFelder = {
	id: kunde.id,
	name: kunde.name,
	kundennummer: kunde.kundennummer,
	notiz: kunde.notiz,
	zustand: kunde.zustand,
	archiviertAm: kunde.archiviertAm,
	autotaskCompanyId: kunde.autotaskCompanyId,
	erstelltAm: kunde.erstelltAm
};

/** A scalar sub-select, typed as the number it returns rather than as the query it is. */
function alsZahl(unterauswahl: SQLWrapper) {
	return sql<number>`${unterauswahl}`;
}

export function listeKunden(db: Ausfuehrer = getDb()) {
	return db
		.select({
			...kundeFelder,
			hatHistorie: hatHistorie(),
			merkmale: alsZahl(
				unterabfrage
					.select({ anzahl: sql`count(*)::int` })
					.from(zuordnungsMerkmal)
					.where(eq(zuordnungsMerkmal.kundeId, kunde.id))
			),
			monitore: alsZahl(
				unterabfrage
					.select({ anzahl: sql`count(*)::int` })
					.from(monitor)
					.where(eq(monitor.kundeId, kunde.id))
			)
		})
		.from(kunde)
		.orderBy(asc(kunde.name));
}

export async function holeKunde(id: string, db: Ausfuehrer = getDb()) {
	const [zeile] = await db
		.select({ ...kundeFelder, hatHistorie: hatHistorie() })
		.from(kunde)
		.where(eq(kunde.id, id))
		.limit(1);

	return zeile;
}

export interface KundenStammdaten {
	name: string;
	kundennummer: string | null;
	notiz: string | null;
	autotaskCompanyId: number | null;
}

export async function legeKundeAn(
	daten: KundenStammdaten,
	db: Ausfuehrer = getDb()
): Promise<string> {
	const [zeile] = await db.insert(kunde).values(daten).returning({ id: kunde.id });
	return zeile.id;
}

export async function aktualisiereKunde(
	id: string,
	daten: KundenStammdaten,
	db: Ausfuehrer = getDb()
): Promise<void> {
	await db.update(kunde).set(daten).where(eq(kunde.id, id));
}

/**
 * Archives or reactivates a customer (CONTEXT „Archiviert (Kunde)").
 *
 * Only the two coupled columns are written. The monitors are *not* touched: "Monitore werden
 * mitarchiviert" is a derived property — a monitor's customer state is a join away — and a
 * materialised copy of it could drift out of sync with the customer. Ending open disruptions
 * silently, without an all-clear, belongs to the alarm lifecycle (#27).
 */
export async function setzeKundeZustand(
	id: string,
	zustand: KundeZustand,
	jetzt: Date,
	db: Ausfuehrer = getDb()
): Promise<void> {
	await db
		.update(kunde)
		.set({ zustand, archiviertAm: zustand === 'archiviert' ? jetzt : null })
		.where(eq(kunde.id, id));
}

export type LoeschErgebnis = 'geloescht' | 'historie' | 'unbekannt';

/**
 * Hard-deletes a customer, but only a mistaken entry without history.
 *
 * The guard sits in the `DELETE` itself instead of a check followed by a delete: a mail arriving in
 * between would otherwise be destroyed by the very cascade the guard exists to prevent. Only when
 * nothing was deleted is the reason looked up, and only to phrase the message.
 */
export async function loescheKunde(id: string, db: Db = getDb()): Promise<LoeschErgebnis> {
	return db.transaction(async (tx) => {
		const geloescht = await tx.execute<{ id: string }>(sql`
			delete from ${kunde}
			where ${kunde.id} = ${id}
				and not exists (select 1 from ${mail} where ${mail.kundeId} = ${kunde.id})
				and not exists (select 1 from ${monitor} where ${monitor.kundeId} = ${kunde.id})
				and not exists (select 1 from ${mailSorte} where ${mailSorte.kundeId} = ${kunde.id})
			returning ${kunde.id}
		`);

		if (geloescht.rows.length > 0) {
			// Deleting a customer takes their traits with it, which can make an ambiguous mail
			// unambiguous — so the same re-queue as for a deleted trait applies, in the same
			// transaction so the two cannot come apart.
			await stelleUnzugeordneteZurueck(tx);
			return 'geloescht';
		}

		const [vorhanden] = await tx
			.select({ id: kunde.id })
			.from(kunde)
			.where(eq(kunde.id, id))
			.limit(1);
		return vorhanden ? 'historie' : 'unbekannt';
	});
}

// ---------------------------------------------------------------------------------------------
// Zuordnungs-Merkmale
// ---------------------------------------------------------------------------------------------

export function listeMerkmale(kundeId: string, db: Ausfuehrer = getDb()) {
	return db
		.select({
			id: zuordnungsMerkmal.id,
			stufe: zuordnungsMerkmal.stufe,
			wert: zuordnungsMerkmal.wert,
			erstelltAm: zuordnungsMerkmal.erstelltAm
		})
		.from(zuordnungsMerkmal)
		.where(eq(zuordnungsMerkmal.kundeId, kundeId))
		.orderBy(asc(zuordnungsMerkmal.stufe), asc(zuordnungsMerkmal.wert));
}

/**
 * The Kollisionswarnung's query (CONTEXT): who else already holds this exact trait?
 *
 * Archived customers are included on purpose — their traits keep matching, so a collision with one
 * of them produces exactly the same ambiguity as with an active customer.
 */
export function findeKollisionen(
	stufe: ZuordnungsStufe,
	wert: string,
	ausserKundeId: string,
	db: Ausfuehrer = getDb()
) {
	return db
		.select({ id: kunde.id, name: kunde.name, zustand: kunde.zustand })
		.from(zuordnungsMerkmal)
		.innerJoin(kunde, eq(kunde.id, zuordnungsMerkmal.kundeId))
		.where(
			and(
				eq(zuordnungsMerkmal.stufe, stufe),
				eq(zuordnungsMerkmal.wert, wert),
				ne(zuordnungsMerkmal.kundeId, ausserKundeId)
			)
		)
		.orderBy(asc(kunde.name));
}

/**
 * The same collision, for every trait of one customer at once — keyed by trait id.
 *
 * The warning is shown on saving *and* stays visible on the maintenance page afterwards. CONTEXT
 * asks for the ambiguity to be visible „bei der Konfiguration, nicht erst in der Mail", and a
 * warning that disappears with the next page load would be visible only to whoever happened to save.
 */
export async function findeKollisionenJeMerkmal(
	kundeId: string,
	db: Ausfuehrer = getDb()
): Promise<Record<string, { name: string; zustand: KundeZustand }[]>> {
	const andere = alias(zuordnungsMerkmal, 'andere');
	const zeilen = await db
		.select({ merkmalId: zuordnungsMerkmal.id, name: kunde.name, zustand: kunde.zustand })
		.from(zuordnungsMerkmal)
		.innerJoin(
			andere,
			and(
				eq(andere.stufe, zuordnungsMerkmal.stufe),
				eq(andere.wert, zuordnungsMerkmal.wert),
				ne(andere.kundeId, zuordnungsMerkmal.kundeId)
			)
		)
		.innerJoin(kunde, eq(kunde.id, andere.kundeId))
		.where(eq(zuordnungsMerkmal.kundeId, kundeId))
		.orderBy(asc(kunde.name));

	const nachMerkmal: Record<string, { name: string; zustand: KundeZustand }[]> = {};
	for (const { merkmalId, ...kollision } of zeilen) {
		(nachMerkmal[merkmalId] ??= []).push(kollision);
	}
	return nachMerkmal;
}

/**
 * Creates a trait and gives every unassigned mail another chance.
 *
 * This is also what resolving a System-Triage entry does (SPEC §4): „Das Auflösen eines
 * Triage-Eintrags legt dauerhaft ein Zuordnungs-Merkmal an … nie nur die eine Mail zuordnen" —
 * hence one function rather than a separate resolution path that could drift from this one.
 *
 * A collision with another customer does **not** block the insert (CONTEXT „Kollisionswarnung":
 * saving stays allowed for transition phases); the caller warns. The same trait twice on the *same*
 * customer is a data error and is reported as such.
 *
 * The value is normalised here rather than only in the form, because this is the single place traits
 * come into existence: an un-normalised value would not fail loudly, it would simply never match
 * anything, and the operator would be left looking at a trait that does nothing. Normalising twice
 * is a no-op, so the form may still do it to validate what it is about to send.
 */
export async function legeMerkmalAn(
	neu: { kundeId: string; stufe: ZuordnungsStufe; wert: string },
	db: Db = getDb()
): Promise<'angelegt' | 'doppelt'> {
	const wert = normalisiereWert(neu.stufe, neu.wert);

	// One transaction: a trait that exists while its re-queue never ran would leave the mails it was
	// created for sitting in the triage until some unrelated configuration change happens to free
	// them — the kind of silent staleness this project exists to remove.
	return db.transaction(async (tx) => {
		const [zeile] = await tx
			.insert(zuordnungsMerkmal)
			.values({ ...neu, wert })
			.onConflictDoNothing()
			.returning({ id: zuordnungsMerkmal.id });

		if (!zeile) return 'doppelt';

		await stelleUnzugeordneteZurueck(tx);
		return 'angelegt';
	});
}

/**
 * Removes a trait. Can make an ambiguous mail unambiguous, so the re-queue applies here too.
 *
 * Scoped by customer as well as by trait id: the id comes from a form field, and a stale page must
 * not be able to delete a trait that belongs to someone else's customer.
 */
export async function entferneMerkmal(
	id: string,
	kundeId: string,
	db: Db = getDb()
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx
			.delete(zuordnungsMerkmal)
			.where(and(eq(zuordnungsMerkmal.id, id), eq(zuordnungsMerkmal.kundeId, kundeId)));
		await stelleUnzugeordneteZurueck(tx);
	});
}

// ---------------------------------------------------------------------------------------------
// System-Triage (Backend; die Ansichten kommen mit #33)
// ---------------------------------------------------------------------------------------------

/**
 * The two reasons the System-Triage carries individually (CONTEXT „System-Triage").
 *
 * `kein_monitor` is deliberately absent: it is grouped into `mail_sorte`, „sonst schüttet ein frisch
 * verbundenes Postfach mit null Monitoren jede eingehende Mail in die Triage".
 */
const TRIAGE_GRUENDE = ['kein_kunde', 'mehrdeutig'] as const;

/**
 * Mails in the System-Triage, newest first.
 *
 * **The learning-window filter is the point of this function.** A freshly connected mailbox pulls
 * ~30 days of history before a single customer exists, and every one of those mails is honestly
 * „kein Kunde erkannt" — dumping them into the triage list would bury the handful of real
 * exceptions under the backfill, which is the very blind spot CONTEXT builds the triage to remove.
 * The mails keep their reason (mail search in #33 needs it); this list is what filters, and it is
 * the only way the triage is meant to be read.
 */
export async function listeTriage(grenze = 200, db: Ausfuehrer = getDb()) {
	const zeilen = await db
		.select({
			id: mail.id,
			ankunftszeit: mail.ankunftszeit,
			absender: mail.absender,
			empfaenger: mail.empfaenger,
			betreff: mail.betreff,
			bodyText: mail.bodyText,
			grund: mail.triageGrund
		})
		.from(mail)
		.where(and(inArray(mail.triageGrund, TRIAGE_GRUENDE), eq(mail.ausLernfenster, false)))
		.orderBy(desc(mail.ankunftszeit))
		.limit(grenze);

	// „mit sichtbaren Kandidaten" (CONTEXT „Mehrdeutig"): which customers claimed this mail? Only a
	// single trait id fits on the mail row, so the candidates are recomputed from the current
	// configuration rather than stored — the list is short, and a stale candidate would be worse
	// than none.
	const index = zeilen.some((zeile) => zeile.grund === 'mehrdeutig')
		? await ladeMerkmalIndex(db)
		: undefined;

	return zeilen.map(({ bodyText, ...zeile }) => ({
		...zeile,
		// The body is read for the recomputation above but never handed out: the triage list says
		// *why* a mail is stuck, and #33 opens the mail itself when the operator asks for it.
		kandidaten:
			index && zeile.grund === 'mehrdeutig' ? kandidaten({ ...zeile, bodyText }, index) : []
	}));
}

/** The customers that claimed a mail — empty unless the current configuration is still ambiguous. */
function kandidaten(
	zeile: { absender: string; empfaenger: string[]; betreff: string; bodyText: string | null },
	index: MerkmalIndex
) {
	const ergebnis = bestimmeKunde(zeile, index);
	if (ergebnis.art !== 'mehrdeutig') return [];

	return ergebnis.kandidaten.map((merkmal) => ({
		kundeId: merkmal.kundeId,
		kundeName: merkmal.kundeName,
		stufe: merkmal.stufe,
		wert: merkmal.wert
	}));
}

export async function zaehleTriage(db: Ausfuehrer = getDb()): Promise<number> {
	const [zeile] = await db
		.select({ anzahl: sql<number>`count(*)::int` })
		.from(mail)
		.where(and(inArray(mail.triageGrund, TRIAGE_GRUENDE), eq(mail.ausLernfenster, false)));

	return zeile?.anzahl ?? 0;
}

/**
 * The unmonitored mail kinds (CONTEXT „Unüberwachte Mail-Sorte") — triage reason ③, grouped.
 *
 * Learning-window mails *do* count here, unlike in the triage list: this is the onboarding entry
 * point, and the history is exactly the material it is built from — including the Takt evidence
 * derived from the counters.
 *
 * The Takt columns come along because they are what makes a Sorte „wiederkehrend": CONTEXT ties the
 * listing criterion and the Takt prefill to the same threshold, so the view (#33) filters on
 * `taktKlasse` rather than inventing a second rule.
 */
export function listeSorten(grenze = 200, db: Ausfuehrer = getDb()) {
	return db
		.select({
			id: mailSorte.id,
			kundeId: mailSorte.kundeId,
			kundeName: kunde.name,
			absender: mailSorte.absender,
			betreffMuster: mailSorte.betreffMuster,
			anzahl: mailSorte.anzahl,
			ersterEingang: mailSorte.ersterEingang,
			letzterEingang: mailSorte.letzterEingang,
			ignoriert: mailSorte.ignoriert,
			taktKlasse: mailSorte.taktKlasse,
			taktIntervallSekunden: mailSorte.taktIntervallSekunden,
			taktUhrzeit: mailSorte.taktUhrzeit,
			taktWochentag: mailSorte.taktWochentag,
			taktVorkommen: mailSorte.taktVorkommen
		})
		.from(mailSorte)
		.innerJoin(kunde, eq(kunde.id, mailSorte.kundeId))
		.orderBy(desc(mailSorte.letzterEingang))
		.limit(grenze);
}
