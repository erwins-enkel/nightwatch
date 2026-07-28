import { and, asc, eq, gt, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import {
	ausnahmekalender,
	ausnahmetag,
	einstellungen,
	kunde,
	mail,
	monitor,
	monitorAusnahmekalender,
	postfach,
	uebergang
} from '../db/schema';
import type { ErwartungModus } from '../db/schema/enums';
import type { Kalenderplan } from '../db/schema/monitor';
import type { MonitorLaufzeit } from '../monitor/db';
import type { Tx } from '../zuordnung/db';

/** Every database statement the time scheduler needs, so the modules above it stay comparisons. */

type Db = ReturnType<typeof getDb>;
type Ausfuehrer = Db | Tx;

/** Monitors claimed per page. Their number follows the configuration, not the mail volume. */
export const KANDIDATEN_PRO_SEITE = 200;

/** Keyset start — every uuid sorts above it. */
export const ERSTE_SEITE = '00000000-0000-0000-0000-000000000000';

function alsDatum(wert: string | Date | null | undefined): Date | null {
	if (wert === null || wert === undefined) return null;
	return wert instanceof Date ? wert : new Date(wert);
}

// ---------------------------------------------------------------------------------------------
// Bewertungs-Schranke
// ---------------------------------------------------------------------------------------------

/** Which part of the pipeline is holding the bound back. */
export type SchrankenGrund = 'jetzt' | 'ingestion' | 'zuordnung' | 'keine_zusage';

export interface Schranke {
	/** Nothing past this point may be judged. */
	bewertbarBis: Date;
	haltendVon: SchrankenGrund;
}

/**
 * The bound when an active mailbox has promised nothing at all.
 *
 * The epoch rather than a null `bewertbarBis`: every comparison downstream then yields „not due"
 * by itself, so forgetting the short circuit in `werteZeitAus` costs a pointless query rather than
 * a wrong verdict.
 */
const NICHTS_BEWERTBAR = new Date(0);

/**
 * How far the time evaluation may judge (#26).
 *
 * Every time decision reads `mail.monitor_id`, which only the assignment pipeline sets. A mail that
 * is not fetched yet, or fetched but not yet assigned, looks to the scheduler exactly like a mail
 * that never came — so judging against the wall clock would alarm on mail that is merely in flight.
 * The bound closes both gaps:
 *
 * - `min(ingestion_stand_am)`: what every active mailbox has provably fetched.
 * - `min(ankunftszeit) where verarbeitet_am is null`: where the assignment backlog begins.
 *
 * **One statement, deliberately.** Under READ COMMITTED a statement sees a single snapshot, so the
 * two bounds cannot be read from different points in time. Split into two selects, a mailbox could
 * publish a new promise plus its mails in between, and the scheduler would combine a fresh
 * ingestion bound with a backlog reading that predates the mails it covers — the precise race the
 * bound exists to prevent.
 *
 * `ohne_zusage` is counted rather than inferred from `min()`, because aggregate functions skip
 * nulls: a mailbox that has never completed a round would otherwise drop silently out of the
 * minimum — the one mailbox that knows nothing would be the one not holding the bound.
 *
 * Global rather than per mailbox: `monitor.postfach_id` only caches where a monitor's mail last
 * came from, and the next one may arrive through a different mailbox.
 */
export async function bewertungsSchranke(jetzt: Date, db: Ausfuehrer = getDb()): Promise<Schranke> {
	const ergebnis = await db.execute<{
		ingestion: string | Date | null;
		ohne_zusage: number | string;
		zuordnung: string | Date | null;
	}>(sql`
		select
			(select min(${postfach.ingestionStandAm}) from ${postfach} where ${postfach.aktiv})
				as ingestion,
			(select count(*) from ${postfach}
				where ${postfach.aktiv} and ${postfach.ingestionStandAm} is null)::int
				as ohne_zusage,
			(select min(${mail.ankunftszeit}) from ${mail} where ${mail.verarbeitetAm} is null)
				as zuordnung
	`);

	const zeile = ergebnis.rows[0];

	/**
	 * An active mailbox that has not settled a single round has read nothing, and nothing it has not
	 * read can be told apart from mail that never arrived. Until it reports in, no absence anywhere
	 * is evidence — the alternative is a Dead-Man's-Switch that judges a mailbox it knows is behind.
	 *
	 * Costs one poll interval after an upgrade and the length of a backfill when a mailbox is added.
	 * `werteZeitAus` logs it, so the standstill is visible rather than mysterious.
	 */
	if (Number(zeile?.ohne_zusage ?? 0) > 0) {
		return { bewertbarBis: NICHTS_BEWERTBAR, haltendVon: 'keine_zusage' };
	}

	const ingestion = alsDatum(zeile?.ingestion);
	const zuordnung = alsDatum(zeile?.zuordnung);

	let bewertbarBis = jetzt;
	let haltendVon: SchrankenGrund = 'jetzt';

	// The ingestion promise is inclusive: everything *up to and including* it is a row.
	// No active mailbox means no mail can arrive, so there is nothing to wait for.
	if (ingestion !== null && ingestion < bewertbarBis) {
		bewertbarBis = ingestion;
		haltendVon = 'ingestion';
	}

	/**
	 * The backlog bound is **exclusive**: `min(ankunftszeit)` is the first mail that is *not* yet
	 * assigned, so only everything strictly before it is complete.
	 *
	 * Off by this one millisecond, a counter window would end exactly on the mail still sitting in
	 * the queue — the window would look one mail short and the lower bound would break for a mail
	 * that is demonstrably there.
	 */
	const rueckstand = zuordnung === null ? null : new Date(zuordnung.getTime() - 1);
	if (rueckstand !== null && rueckstand < bewertbarBis) {
		bewertbarBis = rueckstand;
		haltendVon = 'zuordnung';
	}

	return { bewertbarBis, haltendVon };
}

/** The instance time zone every `HH:MM` in a Kalenderplan is read in. */
export async function ladeZeitzone(db: Ausfuehrer = getDb()): Promise<string> {
	const [zeile] = await db
		.select({ zeitzone: einstellungen.zeitzone })
		.from(einstellungen)
		.limit(1);
	return zeile?.zeitzone ?? 'Europe/Berlin';
}

// ---------------------------------------------------------------------------------------------
// Kandidaten
// ---------------------------------------------------------------------------------------------

/** A monitor as the time evaluation reads it — `MonitorLaufzeit` plus its time parameters. */
export interface ZeitLaufzeit extends MonitorLaufzeit {
	/** Narrowed: the claim only returns activated monitors. */
	aktiviertAm: Date;
	erwartungModus: ErwartungModus | null;
	erwartungIntervallSekunden: number | null;
	erwartungPlan: Kalenderplan | null;
	karenzSekunden: number | null;
	autoZurueckSekunden: number | null;
	zaehlerUntergrenze: number | null;
	sollGeprueftBisAm: Date | null;
	/** From the open episode — what Auto-Zurück counts from. */
	letztesVorkommenAm: Date | null;
}

/**
 * Claims the monitors that can possibly be due, and leases them.
 *
 * The predicates are prefilters, not the decision: they only have to be *generous* enough never to
 * drop a monitor that could move, so the real reading stays in `faelligkeit.ts` where it is
 * testable. They compare against the Schranke rather than `jetzt`, because a deadline beyond it is
 * not going to be judged anyway.
 *
 * An archived customer is excluded outright: „Monitore werden mitarchiviert — keine Auswertung,
 * keine Alarme" (CONTEXT „Archiviert").
 *
 * `FOR UPDATE SKIP LOCKED` is what makes two workers safe. Both would otherwise read the same state
 * and both decide „open an episode", and one of them would hit
 * `uebergang_offen_je_monitor_key`. A monitor another worker holds is simply skipped and picked up
 * on the next tick — the evaluation derives from state, so nothing is lost by deferring it.
 *
 * The locking CTE returns ids only; the row itself is read by the query builder afterwards, inside
 * the same transaction and therefore behind the same lock. That keeps the twenty-odd columns typed
 * and their timestamps as `Date` instead of hand-mapping raw driver output.
 */
export async function claimZeitKandidaten(
	bewertbarBis: Date,
	nachId: string,
	limit: number,
	tx: Tx
): Promise<ZeitLaufzeit[]> {
	const gesperrt = await tx.execute<{ id: string }>(sql`
		with kandidat as (
			select ${monitor.id} as id
			from ${monitor}
			where ${monitor.aktiviertAm} is not null
				and ${monitor.id} > ${nachId}::uuid
				and exists (
					select 1 from ${kunde}
					where ${kunde.id} = ${monitor.kundeId} and ${kunde.zustand} = 'aktiv'
				)
				and (
					(${monitor.art} = 'heartbeat' and ${monitor.erwartungModus} = 'intervall'
						and greatest(${monitor.zuletztGesehenAm}, ${monitor.aktiviertAm})
							+ make_interval(secs =>
								${monitor.erwartungIntervallSekunden} + ${monitor.karenzSekunden})
							<= ${bewertbarBis}::timestamptz)
					or (${monitor.art} = 'heartbeat' and ${monitor.erwartungModus} = 'kalenderplan'
						and coalesce(${monitor.sollGeprueftBisAm}, ${monitor.aktiviertAm})
							< ${bewertbarBis}::timestamptz)
					or (${monitor.art} = 'paar' and ${monitor.paarOffenSeit} is not null
						and ${monitor.paarOffenSeit}
							+ make_interval(secs => ${monitor.maxOffenzeitSekunden})
							<= ${bewertbarBis}::timestamptz)
					or (${monitor.art} = 'ereignis' and ${monitor.zustand} = 'gestoert')
					or (${monitor.art} = 'zaehler'
						and (${monitor.zustand} = 'gestoert' or ${monitor.zaehlerUntergrenze} is not null))
				)
			order by ${monitor.id}
			limit ${limit}
			for update skip locked
		)
		select id from kandidat
	`);

	const ids = gesperrt.rows.map((zeile) => zeile.id);
	if (ids.length === 0) return [];

	const zeilen = await tx
		.select({
			id: monitor.id,
			art: monitor.art,
			zustand: monitor.zustand,
			alarmgrund: monitor.alarmgrund,
			pausiert: monitor.pausiert,
			pausiertBis: monitor.pausiertBis,
			aktiviertAm: monitor.aktiviertAm,
			zuletztGesehenAm: monitor.zuletztGesehenAm,
			paarOffenSeit: monitor.paarOffenSeit,
			postfachId: monitor.postfachId,
			erwartungModus: monitor.erwartungModus,
			erwartungIntervallSekunden: monitor.erwartungIntervallSekunden,
			erwartungPlan: monitor.erwartungPlan,
			karenzSekunden: monitor.karenzSekunden,
			autoZurueckSekunden: monitor.autoZurueckSekunden,
			maxOffenzeitSekunden: monitor.maxOffenzeitSekunden,
			zaehlerFensterSekunden: monitor.zaehlerFensterSekunden,
			zaehlerObergrenze: monitor.zaehlerObergrenze,
			zaehlerUntergrenze: monitor.zaehlerUntergrenze,
			sollGeprueftBisAm: monitor.sollGeprueftBisAm,
			offenerUebergangId: uebergang.id,
			verschaerftAm: uebergang.verschaerftAm,
			letztesVorkommenAm: uebergang.letztesVorkommenAm
		})
		.from(monitor)
		.leftJoin(uebergang, and(eq(uebergang.monitorId, monitor.id), isNull(uebergang.beendetAm)))
		.where(inArray(monitor.id, ids))
		.orderBy(asc(monitor.id));

	return zeilen.flatMap((zeile) =>
		zeile.aktiviertAm === null ? [] : [{ ...zeile, aktiviertAm: zeile.aktiviertAm }]
	);
}

/**
 * The exception dates of the given monitors within a date range, ascending per monitor.
 *
 * `ausnahmetag.datum` is a `date`, i.e. a `YYYY-MM-DD` string in the instance time zone — which is
 * how it is compared, so no zone arithmetic sneaks into SQL.
 */
export async function ladeAusnahmetage(
	monitorIds: string[],
	vonDatum: string,
	bisDatum: string,
	tx: Tx
): Promise<Map<string, string[]>> {
	if (monitorIds.length === 0) return new Map();

	const zeilen = await tx
		.select({ monitorId: monitorAusnahmekalender.monitorId, datum: ausnahmetag.datum })
		.from(monitorAusnahmekalender)
		.innerJoin(ausnahmetag, eq(ausnahmetag.kalenderId, monitorAusnahmekalender.kalenderId))
		.where(
			and(
				inArray(monitorAusnahmekalender.monitorId, monitorIds),
				gte(ausnahmetag.datum, vonDatum),
				lte(ausnahmetag.datum, bisDatum)
			)
		)
		.orderBy(asc(ausnahmetag.datum));

	const nachMonitor = new Map<string, string[]>();
	for (const zeile of zeilen) {
		const vorhanden = nachMonitor.get(zeile.monitorId);
		// Two calendars may name the same day; the set semantics matter, not the multiplicity.
		if (vorhanden) {
			if (vorhanden[vorhanden.length - 1] !== zeile.datum) vorhanden.push(zeile.datum);
		} else {
			nachMonitor.set(zeile.monitorId, [zeile.datum]);
		}
	}

	return nachMonitor;
}

export interface FensterAnfrage {
	monitorId: string;
	aktiviertAm: Date;
	/** Exclusive lower bound — `bewertbarBis − T`. */
	von: Date;
	/** Inclusive upper bound — the Schranke, not `jetzt`. */
	bis: Date;
}

/**
 * The counter readings for a whole page, in one query.
 *
 * One statement rather than one per monitor: the windows differ per monitor, so they travel with
 * their monitor instead of as a loop.
 *
 * They travel as **one JSON parameter** rather than as parallel `unnest` arrays: a JS array in a
 * template hole is bound as a single scalar, which Postgres then rejects as a malformed array
 * literal. `jsonb_to_recordset` names and types every column right here, so nothing depends on how
 * a driver happens to serialise an array.
 *
 * **Only evaluable mails count** — the same filter the mail path applies (`monitor/db.ts`).
 * „Historie ist Lernmaterial, nicht Überwachungsmaterial" (CONTEXT „Lernfenster"): without it a
 * thirty-day backfill would sit in every window forever and no counter could ever fall below its
 * lower bound.
 */
export async function zaehlerStaende(
	anfragen: FensterAnfrage[],
	tx: Tx
): Promise<Map<string, number>> {
	if (anfragen.length === 0) return new Map();

	const fenster = JSON.stringify(
		anfragen.map((anfrage) => ({
			monitor_id: anfrage.monitorId,
			aktiviert_am: anfrage.aktiviertAm.toISOString(),
			von: anfrage.von.toISOString(),
			bis: anfrage.bis.toISOString()
		}))
	);

	const ergebnis = await tx.execute<{ monitor_id: string; anzahl: number | string }>(sql`
		select f.monitor_id, count(${mail.id})::int as anzahl
		from jsonb_to_recordset(${fenster}::jsonb)
			as f(monitor_id uuid, aktiviert_am timestamptz, von timestamptz, bis timestamptz)
		left join ${mail}
			on ${mail.monitorId} = f.monitor_id
			and ${mail.ausLernfenster} = false
			and ${mail.ankunftszeit} >= f.aktiviert_am
			and ${mail.ankunftszeit} > f.von
			and ${mail.ankunftszeit} <= f.bis
		group by f.monitor_id
	`);

	return new Map(ergebnis.rows.map((zeile) => [zeile.monitor_id, Number(zeile.anzahl)]));
}

/**
 * Whether a countable mail of this monitor arrived inside a Kalenderplan coverage window.
 *
 * Deliberately a query rather than a look at `zuletzt_gesehen_am`: that column knows only the most
 * recent mail, which is enough to judge the newest Soll and useless for judging a Soll that was
 * missed while the worker was down. The window always ends at or before the Bewertungs-Schranke,
 * so every mail inside it is already assigned and carries its `monitor_id`.
 */
export async function istAbgedeckt(
	monitorId: string,
	aktiviertAm: Date,
	von: Date,
	bis: Date,
	tx: Tx
): Promise<boolean> {
	const [zeile] = await tx
		.select({ id: mail.id })
		.from(mail)
		.where(
			and(
				eq(mail.monitorId, monitorId),
				eq(mail.ausLernfenster, false),
				gte(mail.ankunftszeit, aktiviertAm),
				gt(mail.ankunftszeit, von),
				lte(mail.ankunftszeit, bis)
			)
		)
		.limit(1);

	return zeile !== undefined;
}

/**
 * Advances the „judged up to here" cursor.
 *
 * `greatest` keeps it monotone. The Schranke can move *backwards* — a mail ingested with an older
 * arrival time lowers the backlog bound — and a Soll that was already judged must not be judged a
 * second time and counted twice.
 */
export async function setzeSollGeprueftBis(
	monitorId: string,
	bis: Date,
	tx: Ausfuehrer
): Promise<void> {
	await tx
		.update(monitor)
		.set({ sollGeprueftBisAm: sql`greatest(${monitor.sollGeprueftBisAm}, ${bis}::timestamptz)` })
		.where(eq(monitor.id, monitorId));
}

// ---------------------------------------------------------------------------------------------
// Ausnahmekalender
// ---------------------------------------------------------------------------------------------

/** Named, reusable bundles of exception days (CONTEXT „Ausnahmetag"); the UI is #31. */
export async function legeAusnahmekalenderAn(
	name: string,
	beschreibung: string | null,
	db: Ausfuehrer = getDb()
): Promise<string> {
	const [zeile] = await db
		.insert(ausnahmekalender)
		.values({ name: name.trim(), beschreibung })
		.returning({ id: ausnahmekalender.id });

	return zeile.id;
}

export function listeAusnahmekalender(db: Ausfuehrer = getDb()) {
	return db
		.select({
			id: ausnahmekalender.id,
			name: ausnahmekalender.name,
			beschreibung: ausnahmekalender.beschreibung,
			tage: sql<number>`count(${ausnahmetag.id})::int`
		})
		.from(ausnahmekalender)
		.leftJoin(ausnahmetag, eq(ausnahmetag.kalenderId, ausnahmekalender.id))
		.groupBy(ausnahmekalender.id)
		.orderBy(asc(ausnahmekalender.name));
}

/**
 * Replaces a calendar's days wholesale — the maintenance screen hands back the complete list, and a
 * day removed there has to disappear here.
 */
export async function setzeAusnahmetage(
	kalenderId: string,
	tage: { datum: string; bezeichnung?: string | null }[],
	db: Db = getDb()
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.delete(ausnahmetag).where(eq(ausnahmetag.kalenderId, kalenderId));
		if (tage.length === 0) return;

		await tx
			.insert(ausnahmetag)
			.values(
				tage.map((tag) => ({
					kalenderId,
					datum: tag.datum,
					bezeichnung: tag.bezeichnung ?? null
				}))
			)
			.onConflictDoNothing();
	});
}

/** Which calendars apply to a monitor. Replaced wholesale, for the same reason. */
export async function verknuepfeKalender(
	monitorId: string,
	kalenderIds: string[],
	db: Db = getDb()
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx
			.delete(monitorAusnahmekalender)
			.where(eq(monitorAusnahmekalender.monitorId, monitorId));
		if (kalenderIds.length === 0) return;

		await tx
			.insert(monitorAusnahmekalender)
			.values(kalenderIds.map((kalenderId) => ({ monitorId, kalenderId })))
			.onConflictDoNothing();
	});
}

export async function loescheAusnahmekalender(id: string, db: Ausfuehrer = getDb()): Promise<void> {
	await db.delete(ausnahmekalender).where(eq(ausnahmekalender.id, id));
}
