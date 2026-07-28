import { and, asc, eq, gt, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { getDb } from '../db/client';
import { kunde, mail, monitor, regel, uebergang } from '../db/schema';
import type {
	Alarmgrund,
	ErholungsArt,
	MonitorArt,
	MonitorZustand,
	RegelQuelle
} from '../db/schema/enums';
import type { MonitorParameter } from '../db/schema/monitor';
import { createLogger } from '../logger';
import type { Tx } from '../zuordnung/db';
import { kompiliereRegel, type KompilierteRegel, type RegelZeile } from './regel';
import {
	normalisiereParameter,
	normalisiereRegel,
	pruefeMonitor,
	type MonitorFehler
} from './parameter';
import type { Zustandsaenderung } from './zustand';

/**
 * Every database statement the monitor core needs, so the modules above it stay pure comparisons.
 */

const log = createLogger('monitor');

type Db = ReturnType<typeof getDb>;
/** Pool handle or transaction — every read here works with either. */
type Ausfuehrer = Db | Tx;

// ---------------------------------------------------------------------------------------------
// Laden für die Zuordnung
// ---------------------------------------------------------------------------------------------

/** One monitor as the matching needs it: which mails are its, and how does its kind read them. */
export interface MonitorEintrag {
	id: string;
	art: MonitorArt;
	regel: KompilierteRegel;
}

/** Monitors by customer, in the order that decides an overlap. */
export type MonitorIndex = Map<string, MonitorEintrag[]>;

/**
 * Loads the activated monitors with their compiled rules, grouped by customer.
 *
 * Read once per batch, like `ladeMerkmalIndex`: the number of monitors follows the configuration,
 * the number of mails does not.
 *
 * Only **activated** monitors take part. „Keine Regel wird ohne menschliche Bestätigung aktiv"
 * (SPEC §5) — a draft must not quietly start swallowing its customer's mail, which would also
 * remove it from the unmonitored Sorten the operator is working through.
 *
 * The order is `erstellt_am`, then `id`: if two monitors of one customer claim the same mail, the
 * older one wins. Deterministic and explainable, without introducing a score.
 */
export async function ladeMonitorIndex(db: Ausfuehrer = getDb()): Promise<MonitorIndex> {
	const zeilen = await db
		.select({
			id: monitor.id,
			kundeId: monitor.kundeId,
			art: monitor.art,
			absender: regel.absender,
			betreffMuster: regel.betreffMuster,
			schluesselwoerter: regel.schluesselwoerter,
			musterSchlecht: regel.musterSchlecht,
			musterGut: regel.musterGut
		})
		.from(monitor)
		.innerJoin(regel, eq(regel.monitorId, monitor.id))
		.where(sql`${monitor.aktiviertAm} is not null`)
		.orderBy(asc(monitor.erstelltAm), asc(monitor.id));

	const index: MonitorIndex = new Map();

	for (const zeile of zeilen) {
		const { regel: kompiliert, ungueltig } = kompiliereRegel(zeile);
		if (ungueltig.length > 0) {
			// A pattern that does not compile never matches. Failing the whole batch instead would let
			// one broken rule stop the assignment for every customer.
			log.warn('Regel enthält ungültige Muster', { monitorId: zeile.id, muster: ungueltig });
		}

		const eintrag: MonitorEintrag = { id: zeile.id, art: zeile.art, regel: kompiliert };
		const vorhanden = index.get(zeile.kundeId);
		if (vorhanden) vorhanden.push(eintrag);
		else index.set(zeile.kundeId, [eintrag]);
	}

	return index;
}

// ---------------------------------------------------------------------------------------------
// Auswertung
// ---------------------------------------------------------------------------------------------

/** A monitor's state and parameters, as the evaluation reads and writes them. */
export interface MonitorLaufzeit {
	id: string;
	art: MonitorArt;
	zustand: MonitorZustand;
	alarmgrund: Alarmgrund | null;
	pausiert: boolean;
	pausiertBis: Date | null;
	aktiviertAm: Date | null;
	zuletztGesehenAm: Date | null;
	paarOffenSeit: Date | null;
	postfachId: string | null;
	maxOffenzeitSekunden: number | null;
	zaehlerFensterSekunden: number | null;
	zaehlerObergrenze: number | null;
	/** The episode that is currently open, if any. */
	offenerUebergangId: string | null;
	verschaerftAm: Date | null;
}

/** The locked row, before the open episode is attached to it. */
type MonitorZeile = Omit<MonitorLaufzeit, 'offenerUebergangId' | 'verschaerftAm'>;

/**
 * Locks the given monitors and reads their state.
 *
 * The lock is what makes concurrent batches safe. `claimUnverarbeitete` leases mails with
 * `SKIP LOCKED`, so two workers can hold mails of the *same* monitor at the same time; without this
 * lock both would read the same state, both would decide "open an episode", and one would hit
 * `uebergang_offen_je_monitor_key`. Locking in ascending id order means two batches that touch the
 * same monitors take their locks in the same order rather than deadlocking each other.
 */
export async function sperreMonitore(ids: string[], tx: Tx): Promise<Map<string, MonitorLaufzeit>> {
	if (ids.length === 0) return new Map();

	const sortiert = [...new Set(ids)].sort();
	const zeilen: MonitorZeile[] = await tx
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
			maxOffenzeitSekunden: monitor.maxOffenzeitSekunden,
			zaehlerFensterSekunden: monitor.zaehlerFensterSekunden,
			zaehlerObergrenze: monitor.zaehlerObergrenze
		})
		.from(monitor)
		.where(inArray(monitor.id, sortiert))
		.orderBy(asc(monitor.id))
		.for('update');

	// Read after the lock, so a concurrent batch's episode is visible rather than raced.
	const offene = await tx
		.select({
			id: uebergang.id,
			monitorId: uebergang.monitorId,
			verschaerftAm: uebergang.verschaerftAm
		})
		.from(uebergang)
		.where(and(inArray(uebergang.monitorId, sortiert), isNull(uebergang.beendetAm)));

	// `monitor_id` is nullable on `uebergang` (a self-monitor's episodes carry the other column), but
	// the filter above cannot return one of those.
	const nachMonitor = new Map(
		offene.filter((zeile) => zeile.monitorId !== null).map((zeile) => [zeile.monitorId!, zeile])
	);

	return new Map(
		zeilen.map((zeile) => {
			const offen = nachMonitor.get(zeile.id);
			return [
				zeile.id,
				{
					...zeile,
					offenerUebergangId: offen?.id ?? null,
					verschaerftAm: offen?.verschaerftAm ?? null
				}
			];
		})
	);
}

/**
 * The arrival times of a monitor's countable mails, ascending.
 *
 * **Only evaluable mails count.** A mail from the learning window or from before the activation is
 * assigned and classified like any other and therefore carries `monitor_id` — but „Historie ist
 * Lernmaterial, nicht Überwachungsmaterial" (CONTEXT). Without this filter the first regular mail
 * after activation would burst the upper bound out of thirty days of backfill.
 */
export async function zaehlerFenster(
	monitorId: string,
	aktiviertAm: Date,
	von: Date,
	bis: Date,
	tx: Tx
): Promise<Date[]> {
	const zeilen = await tx
		.select({ ankunftszeit: mail.ankunftszeit })
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
		.orderBy(asc(mail.ankunftszeit));

	return zeilen.map((zeile) => zeile.ankunftszeit);
}

/** What one evaluated mail changes on the monitor, beyond the state transition itself. */
export interface Beobachtung {
	/** Set for a mail that passed the evaluation gate; it is also the ordering mark. */
	zuletztGesehenAm?: Date;
	postfachId?: string;
	paarOffenSeit?: Date | null;
}

/**
 * Writes one mail's outcome: the observation, the state, and the episode.
 *
 * Returns the monitor's new in-memory state, so the caller can fold the next mail of the same batch
 * onto it without reading the row again.
 */
export async function schreibeWirkung(
	laufzeit: MonitorLaufzeit,
	beobachtung: Beobachtung,
	aenderung: Zustandsaenderung,
	zeitpunkt: Date,
	tx: Tx
): Promise<MonitorLaufzeit> {
	const neu: MonitorLaufzeit = { ...laufzeit };
	const felder: PgUpdateSetSource<typeof monitor> = {};

	if (beobachtung.zuletztGesehenAm) {
		// `greatest`, so an out-of-order mail can never move the mark backwards.
		felder.zuletztGesehenAm = sql`greatest(${monitor.zuletztGesehenAm}, ${beobachtung.zuletztGesehenAm})`;
		neu.zuletztGesehenAm =
			laufzeit.zuletztGesehenAm && laufzeit.zuletztGesehenAm > beobachtung.zuletztGesehenAm
				? laufzeit.zuletztGesehenAm
				: beobachtung.zuletztGesehenAm;
	}

	if (beobachtung.postfachId && beobachtung.postfachId !== laufzeit.postfachId) {
		felder.postfachId = beobachtung.postfachId;
		neu.postfachId = beobachtung.postfachId;
	}

	if (beobachtung.paarOffenSeit !== undefined) {
		felder.paarOffenSeit = beobachtung.paarOffenSeit;
		neu.paarOffenSeit = beobachtung.paarOffenSeit;
	}

	switch (aenderung.art) {
		case 'keine':
			break;

		case 'eroeffnen': {
			felder.zustand = 'gestoert';
			felder.alarmgrund = aenderung.grund;
			felder.zustandSeit = zeitpunkt;
			neu.zustand = 'gestoert';
			neu.alarmgrund = aenderung.grund;

			const [zeile] = await tx
				.insert(uebergang)
				.values({
					monitorId: laufzeit.id,
					alarmgrund: aenderung.grund,
					begonnenAm: zeitpunkt,
					letztesVorkommenAm: zeitpunkt
				})
				.returning({ id: uebergang.id });
			neu.offenerUebergangId = zeile.id;
			neu.verschaerftAm = null;
			break;
		}

		case 'vorkommen':
			await zaehleVorkommen(laufzeit.offenerUebergangId, zeitpunkt, tx);
			break;

		case 'grundwechsel': {
			// Only the *live* reason moves. `uebergang.alarmgrund` is the reason at alarm time and
			// stays what it was: it is what the alarm went out with (SPEC §7's correlation key and
			// #27's ticket text hang off it), and overwriting it would make the episode claim it had
			// always been about something else. The change of reason is visible as `verschaerft_am`
			// where it matters, and on the monitor where the dashboard reads it.
			felder.alarmgrund = aenderung.grund;
			neu.alarmgrund = aenderung.grund;

			if (laufzeit.offenerUebergangId) {
				// „Der einzige Anlass, zu dem ein offenes Ticket zwischendurch automatisch kommentiert
				// wird" — and only the first time, so #27 comments once per episode.
				const verschaerftJetzt = aenderung.verschaerfung && laufzeit.verschaerftAm === null;

				await tx
					.update(uebergang)
					.set({
						letztesVorkommenAm: zeitpunkt,
						vorkommen: sql`${uebergang.vorkommen} + 1`,
						...(verschaerftJetzt ? { verschaerftAm: zeitpunkt } : {})
					})
					.where(eq(uebergang.id, laufzeit.offenerUebergangId));

				if (verschaerftJetzt) neu.verschaerftAm = zeitpunkt;
			}
			break;
		}

		case 'beenden': {
			felder.zustand = 'gesund';
			felder.alarmgrund = null;
			felder.zustandSeit = zeitpunkt;
			neu.zustand = 'gesund';
			neu.alarmgrund = null;

			if (laufzeit.offenerUebergangId) {
				// Only the internal end. `entwarnt_am` is set once the stability window held (#27).
				await tx
					.update(uebergang)
					.set({ beendetAm: zeitpunkt, erholungsArt: 'beweis' })
					.where(eq(uebergang.id, laufzeit.offenerUebergangId));
			}
			neu.offenerUebergangId = null;
			neu.verschaerftAm = null;
			break;
		}
	}

	if (Object.keys(felder).length > 0) {
		await tx.update(monitor).set(felder).where(eq(monitor.id, laufzeit.id));
	}

	return neu;
}

async function zaehleVorkommen(uebergangId: string | null, zeitpunkt: Date, tx: Tx): Promise<void> {
	if (!uebergangId) return;
	await tx
		.update(uebergang)
		.set({ vorkommen: sql`${uebergang.vorkommen} + 1`, letztesVorkommenAm: zeitpunkt })
		.where(eq(uebergang.id, uebergangId));
}

// ---------------------------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------------------------

export interface MonitorEingabe {
	kundeId: string;
	bezeichnung: string;
	art: MonitorArt;
	parameter: MonitorParameter;
	entwarnungsStabilitaetSekunden?: number | null;
	regel: RegelZeile;
	quelle: RegelQuelle;
	vorlageId?: string | null;
}

export type MonitorSchreibErgebnis =
	{ art: 'ok'; id: string } | { art: 'ungueltig'; fehler: MonitorFehler[] } | { art: 'unbekannt' };

/**
 * Normalises first, then checks — in that order.
 *
 * The other way round would reject an Ereignis monitor for a missing Auto-Zurück-Zeit that
 * `normalisiereParameter` is about to fill in with its documented default, and would let a stale
 * parameter of a previous kind pass the check only to be dropped on the way to the table.
 */
function pruefeEingabe(eingabe: MonitorEingabe) {
	const parameter = normalisiereParameter(eingabe.art, eingabe.parameter);
	const regel = normalisiereRegel(eingabe.regel);
	return { parameter, regel, fehler: pruefeMonitor({ ...eingabe, parameter, regel }) };
}

/** Every parameter column, so a kind change cannot leave a stale window behind. */
function parameterSpalten(p: MonitorParameter) {
	return {
		erwartungModus: p.erwartungModus ?? null,
		erwartungIntervallSekunden: p.erwartungIntervallSekunden ?? null,
		erwartungPlan: p.erwartungPlan ?? null,
		karenzSekunden: p.karenzSekunden ?? null,
		autoZurueckSekunden: p.autoZurueckSekunden ?? null,
		maxOffenzeitSekunden: p.maxOffenzeitSekunden ?? null,
		zaehlerFensterSekunden: p.zaehlerFensterSekunden ?? null,
		zaehlerObergrenze: p.zaehlerObergrenze ?? null,
		zaehlerUntergrenze: p.zaehlerUntergrenze ?? null
	};
}

/**
 * Creates a monitor with its rule, in one transaction — a monitor without a rule would match
 * nothing and is not a thing CONTEXT knows.
 *
 * `aktiviert_am` stays null: a new monitor is a draft until someone confirms it (SPEC §5). Until
 * then it evaluates nothing and its customer's mails keep flowing into the unmonitored Sorten.
 */
export async function legeMonitorAn(
	eingabe: MonitorEingabe,
	db: Db = getDb()
): Promise<MonitorSchreibErgebnis> {
	const { parameter, regel: regelWerte, fehler } = pruefeEingabe(eingabe);
	if (fehler.length > 0) return { art: 'ungueltig', fehler };

	return db.transaction(async (tx) => {
		const [zeile] = await tx
			.insert(monitor)
			.values({
				kundeId: eingabe.kundeId,
				bezeichnung: eingabe.bezeichnung.trim(),
				art: eingabe.art,
				entwarnungsStabilitaetSekunden: eingabe.entwarnungsStabilitaetSekunden ?? null,
				...parameterSpalten(parameter)
			})
			.returning({ id: monitor.id });

		await tx.insert(regel).values({
			monitorId: zeile.id,
			...regelWerte,
			quelle: eingabe.quelle,
			vorlageId: eingabe.vorlageId ?? null
		});

		return { art: 'ok', id: zeile.id };
	});
}

/**
 * Rewrites a monitor and its rule — „Regel überarbeiten" (CONTEXT), and the only way to change a
 * monitor's kind.
 *
 * A kind change ends an open disruption silently and clears the pair's open state. Not a nicety:
 * the reason of the old kind („Ereignis eingetroffen") is meaningless for the new one, and
 * `paar_offen_seit` on a non-Paar monitor violates the table's own contract.
 */
export async function aktualisiereMonitor(
	id: string,
	eingabe: MonitorEingabe,
	db: Db = getDb()
): Promise<MonitorSchreibErgebnis> {
	const { parameter, regel: regelWerte, fehler } = pruefeEingabe(eingabe);
	if (fehler.length > 0) return { art: 'ungueltig', fehler };

	return db.transaction(async (tx) => {
		const [vorher] = await tx
			.select({ art: monitor.art })
			.from(monitor)
			.where(eq(monitor.id, id))
			.for('update');
		if (!vorher) return { art: 'unbekannt' };

		const artWechsel = vorher.art !== eingabe.art;
		if (artWechsel) await beendeStill(id, new Date(), tx);

		await tx
			.update(monitor)
			.set({
				bezeichnung: eingabe.bezeichnung.trim(),
				art: eingabe.art,
				entwarnungsStabilitaetSekunden: eingabe.entwarnungsStabilitaetSekunden ?? null,
				...parameterSpalten(parameter)
			})
			.where(eq(monitor.id, id));

		// The rule is rewritten whole, provenance included: „Regel überarbeiten" hands back the
		// complete rule, so a template link that is no longer part of it is gone on purpose.
		await tx
			.update(regel)
			.set({
				...regelWerte,
				quelle: eingabe.quelle,
				vorlageId: eingabe.vorlageId ?? null,
				geaendertAm: new Date()
			})
			.where(eq(regel.monitorId, id));

		return { art: 'ok', id };
	});
}

/**
 * Ends a running disruption without an all-clear and resets the pair's open state.
 *
 * `erholungs_art = 'archiviert'` is the enum's "silent end" (CONTEXT „Archiviert (Kunde)"): the
 * episode is closed for the record, but nothing goes out — a monitor that was switched off or
 * rebuilt owes nobody an Entwarnung.
 */
async function beendeStill(monitorId: string, jetzt: Date, tx: Tx): Promise<void> {
	await tx
		.update(uebergang)
		.set({ beendetAm: jetzt, erholungsArt: 'archiviert' satisfies ErholungsArt })
		.where(and(eq(uebergang.monitorId, monitorId), isNull(uebergang.beendetAm)));

	await tx
		.update(monitor)
		.set({ zustand: 'gesund', alarmgrund: null, zustandSeit: jetzt, paarOffenSeit: null })
		.where(eq(monitor.id, monitorId));
}

/**
 * The confirmation gate (SPEC §5) and its counterpart.
 *
 * Activating always stamps *now*, also when re-activating: „Ein Monitor wertet ausschließlich ab
 * seiner Aktivierung vorwärts" (CONTEXT „Lernfenster") — the gap while it was off is not his.
 */
export async function setzeAktivierung(
	id: string,
	aktiv: boolean,
	jetzt: Date,
	db: Db = getDb()
): Promise<void> {
	await db.transaction(async (tx) => {
		if (!aktiv) await beendeStill(id, jetzt, tx);
		await tx
			.update(monitor)
			.set({ aktiviertAm: aktiv ? jetzt : null })
			.where(eq(monitor.id, id));
	});
}

/** CONTEXT „Pausiert": an overlay for planned maintenance, optionally with an auto-end. */
export async function setzePause(
	id: string,
	pausiert: boolean,
	bis: Date | null,
	db: Ausfuehrer = getDb()
): Promise<void> {
	await db
		.update(monitor)
		.set({ pausiert, pausiertBis: pausiert ? bis : null })
		.where(eq(monitor.id, id));
}

export type LoeschErgebnis = 'geloescht' | 'historie' | 'unbekannt';

/**
 * Deletes a monitor — but only a mistaken entry without history.
 *
 * `uebergang.monitor_id` cascades and `mail.monitor_id` is nulled, so an unguarded delete would
 * destroy the alarm history and silently detach the mails that evidence it. SPEC §11 lists that
 * history as permanent, so the way to retire a monitor that has run is `setzeAktivierung(false)`.
 *
 * The guard sits in the `DELETE` itself instead of a check followed by a delete: a mail arriving in
 * between would otherwise be taken by the very cascade the guard exists to prevent. Only when
 * nothing was deleted is the reason looked up, and only to phrase the message.
 */
export async function loescheMonitor(id: string, db: Db = getDb()): Promise<LoeschErgebnis> {
	return db.transaction(async (tx) => {
		const geloescht = await tx.execute<{ id: string }>(sql`
			delete from ${monitor}
			where ${monitor.id} = ${id}
				and not exists (select 1 from ${mail} where ${mail.monitorId} = ${monitor.id})
				and not exists (select 1 from ${uebergang} where ${uebergang.monitorId} = ${monitor.id})
			returning ${monitor.id}
		`);

		if (geloescht.rows.length > 0) return 'geloescht';

		const [vorhanden] = await tx
			.select({ id: monitor.id })
			.from(monitor)
			.where(eq(monitor.id, id))
			.limit(1);
		return vorhanden ? 'historie' : 'unbekannt';
	});
}

const monitorFelder = {
	id: monitor.id,
	kundeId: monitor.kundeId,
	bezeichnung: monitor.bezeichnung,
	art: monitor.art,
	zustand: monitor.zustand,
	alarmgrund: monitor.alarmgrund,
	zustandSeit: monitor.zustandSeit,
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
	entwarnungsStabilitaetSekunden: monitor.entwarnungsStabilitaetSekunden,
	erstelltAm: monitor.erstelltAm
};

const regelFelder = {
	regelAbsender: regel.absender,
	regelBetreffMuster: regel.betreffMuster,
	regelSchluesselwoerter: regel.schluesselwoerter,
	regelMusterSchlecht: regel.musterSchlecht,
	regelMusterGut: regel.musterGut,
	regelQuelle: regel.quelle
};

export function listeMonitore(kundeId?: string, db: Ausfuehrer = getDb()) {
	const abfrage = db
		.select({ ...monitorFelder, ...regelFelder, kundeName: kunde.name })
		.from(monitor)
		.innerJoin(regel, eq(regel.monitorId, monitor.id))
		.innerJoin(kunde, eq(kunde.id, monitor.kundeId))
		.orderBy(asc(kunde.name), asc(monitor.bezeichnung));

	return kundeId ? abfrage.where(eq(monitor.kundeId, kundeId)) : abfrage;
}

export async function holeMonitor(id: string, db: Ausfuehrer = getDb()) {
	const [zeile] = await db
		.select({ ...monitorFelder, ...regelFelder, kundeName: kunde.name })
		.from(monitor)
		.innerJoin(regel, eq(regel.monitorId, monitor.id))
		.innerJoin(kunde, eq(kunde.id, monitor.kundeId))
		.where(eq(monitor.id, id))
		.limit(1);

	return zeile;
}
