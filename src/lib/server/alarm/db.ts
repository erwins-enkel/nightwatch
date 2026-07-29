import { and, asc, eq, inArray, isNull, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { getDb } from '../db/client';
import { kunde, monitor, selbstMonitor, uebergang, zustellung } from '../db/schema';
import type {
	AlarmEreignis,
	Alarmgrund,
	ErholungsArt,
	MonitorArt,
	ZustellKanal,
	ZustellZustand
} from '../db/schema/enums';
import { schreibeWirkung, sperreMonitore, wirksameStabilitaet } from '../monitor/db';
import { wendeAn } from '../monitor/zustand';
import type { Tx } from '../zuordnung/db';
import type { EpisodenSicht } from './ereignis';

/**
 * Every database statement the alarm lifecycle needs, so the modules above it stay comparisons.
 */

type Db = ReturnType<typeof getDb>;
type Ausfuehrer = Db | Tx;

/** The predecessor episode, joined in only for its published id. */
const vorgaenger = alias(uebergang, 'vorgaenger');
/** Any *older* episode of the same monitor — the one that may not be overtaken. */
const aeltere = alias(uebergang, 'aeltere');

// ---------------------------------------------------------------------------------------------
// Veröffentlichen
// ---------------------------------------------------------------------------------------------

/** Episodes claimed per page. Bounded by open work, not by the size of the history. */
export const EPISODEN_PRO_SEITE = 200;

/** Keyset start — every episode sorts above it. */
export const ERSTE_SEITE: Seitenmarke = {
	begonnenAm: new Date(0),
	id: '00000000-0000-0000-0000-000000000000'
};

export interface Seitenmarke {
	begonnenAm: Date;
	id: string;
}

/**
 * An episode that still owes at least one event.
 *
 * The predicate is the outbox: three markers, one per event of `alarm_ereignis`. It is repeated
 * verbatim as the partial index `uebergang_veroeffentlichung_offen_idx`, so the planner can prove
 * the implication and the index stays as small as the open work.
 *
 * `erholungs_art <> 'archiviert'` keeps the silent end silent — „ein Monitor, der abgeschaltet
 * oder umgebaut wurde, schuldet niemandem eine Entwarnung" — and `entwarnung_entfaellt_am`
 * excludes the recoveries that did not hold, permanently and without re-deriving why.
 */
function offenePflichten(t: typeof uebergang | typeof aeltere) {
	return sql`(
		${t.alarmiertAm} is null
		or (${t.verschaerftAm} is not null and ${t.verschaerfungGemeldetAm} is null)
		or (
			${t.beendetAm} is not null and ${t.entwarntAm} is null
			and ${t.entwarnungEntfaelltAm} is null and ${t.erholungsArt} <> 'archiviert'
		)
	)`;
}

const OFFEN = offenePflichten(uebergang);

/**
 * One episode plus whom it belongs to — the row every query below shares.
 *
 * Both sides are nullable because `uebergang` hangs on exactly one of them (CHECK
 * `uebergang_genau_ein_monitor`): a customer monitor with its customer, or a self-monitor with
 * neither. The nested shapes are what make that readable — Drizzle nulls a whole nested object
 * when its left join found nothing, so „welche Seite ist es?" stays one question instead of six.
 */
export interface EpisodenZeile {
	alertId: string;
	vorgaengerAlertId: string | null;
	alarmgrund: Alarmgrund;
	begonnenAm: Date;
	letztesVorkommenAm: Date;
	vorkommen: number;
	verschaerftAm: Date | null;
	beendetAm: Date | null;
	erholungsArt: ErholungsArt | null;
	monitor: { id: string; bezeichnung: string; art: MonitorArt } | null;
	kunde: { id: string; name: string } | null;
	selbst: { id: string; bezeichnung: string; schluessel: string } | null;
}

const episodenFelder = {
	alertId: uebergang.alertId,
	vorgaengerAlertId: vorgaenger.alertId,
	alarmgrund: uebergang.alarmgrund,
	begonnenAm: uebergang.begonnenAm,
	letztesVorkommenAm: uebergang.letztesVorkommenAm,
	vorkommen: uebergang.vorkommen,
	verschaerftAm: uebergang.verschaerftAm,
	beendetAm: uebergang.beendetAm,
	erholungsArt: uebergang.erholungsArt,
	monitor: { id: monitor.id, bezeichnung: monitor.bezeichnung, art: monitor.art },
	kunde: { id: kunde.id, name: kunde.name },
	selbst: {
		id: selbstMonitor.id,
		bezeichnung: selbstMonitor.bezeichnung,
		schluessel: selbstMonitor.schluessel
	}
};

/**
 * The episode as the payload builder wants it (`ereignis.ts`).
 *
 * The self-monitor branch is what SPEC §7 asks the webhook to carry: `monitor.art = "selbst"` with
 * the `schluessel`, and no customer at all — „Gehört keinem Kunden" (CONTEXT „Selbst-Monitor").
 */
export function alsSicht(zeile: EpisodenZeile): EpisodenSicht {
	const gemeinsam = {
		alertId: zeile.alertId,
		vorgaengerAlertId: zeile.vorgaengerAlertId,
		alarmgrund: zeile.alarmgrund,
		begonnenAm: zeile.begonnenAm,
		letztesVorkommenAm: zeile.letztesVorkommenAm,
		vorkommen: zeile.vorkommen,
		verschaerftAm: zeile.verschaerftAm,
		beendetAm: zeile.beendetAm,
		erholungsArt: zeile.erholungsArt
	};

	if (zeile.selbst) {
		return {
			...gemeinsam,
			monitor: { art: 'selbst', ...zeile.selbst },
			kunde: null
		};
	}

	if (!zeile.monitor || !zeile.kunde) {
		// Unreachable through the CHECK, which lets an episode hang on exactly one of the two — but
		// the CHECK lives in the database and TypeScript cannot read it. Loud rather than a payload
		// that names no monitor.
		throw new Error(`Übergang ${zeile.alertId} hängt an keinem Monitor`);
	}

	return { ...gemeinsam, monitor: { ...zeile.monitor }, kunde: { ...zeile.kunde } };
}

export interface OffeneEpisode extends EpisodenZeile {
	id: string;
	alarmiertAm: Date | null;
	verschaerfungGemeldetAm: Date | null;
	entwarntAm: Date | null;
	entwarnungEntfaelltAm: Date | null;
	/** Already resolved against the instance default (CONTEXT „Entwarnungs-Stabilität"). */
	stabilitaetSekunden: number;
}

/**
 * Claims a page of episodes that owe an event, oldest first.
 *
 * The order keeps a single pass tidy — the Entwarnung of the older episode is published before the
 * alarm of the younger one — but it is **not** where the guarantee lives. `skip locked` lets a
 * second worker take a younger episode while an older one is being written, and a lagging
 * Bewertungs-Schranke can hold back an Entwarnung while the next alarm is already publishable.
 * What must never be overtaken is the *delivery*, and that is enforced in
 * `ladeOffeneZustellungen`, against committed rows rather than against who claimed what first.
 *
 * Keyset paging rather than „claim until the page is short": an episode whose only pending event
 * is an Entwarnung that is not due yet matches the predicate but produces no work, and an offset
 * that never moves would spin on it forever.
 *
 * Only customer monitors — the inner join is the filter. Self-monitor episodes are sent by the
 * watchdog on its own path (SPEC §8); publishing them here as well would send everything twice.
 * `selbst_monitor` is joined all the same so the row keeps the shape `alsSicht` reads; the CHECK
 * makes it null in every row this query can return.
 */
export async function claimOffeneEpisoden(
	nach: Seitenmarke,
	limit: number,
	tx: Tx
): Promise<OffeneEpisode[]> {
	return (
		tx
			.select({
				...episodenFelder,
				id: uebergang.id,
				alarmiertAm: uebergang.alarmiertAm,
				verschaerfungGemeldetAm: uebergang.verschaerfungGemeldetAm,
				entwarntAm: uebergang.entwarntAm,
				entwarnungEntfaelltAm: uebergang.entwarnungEntfaelltAm,
				stabilitaetSekunden: wirksameStabilitaet
			})
			.from(uebergang)
			.innerJoin(monitor, eq(monitor.id, uebergang.monitorId))
			.innerJoin(kunde, eq(kunde.id, monitor.kundeId))
			.leftJoin(selbstMonitor, eq(selbstMonitor.id, uebergang.selbstMonitorId))
			.leftJoin(vorgaenger, eq(vorgaenger.id, uebergang.vorgaengerId))
			.where(
				and(
					sql`(${uebergang.begonnenAm}, ${uebergang.id}) > (${nach.begonnenAm}, ${nach.id}::uuid)`,
					OFFEN
				)
			)
			.orderBy(asc(uebergang.begonnenAm), asc(uebergang.id))
			.limit(limit)
			// Only the episode is locked; the joined rows are read-only here. `skip locked` lets a
			// second worker take the next page instead of waiting for this one.
			.for('update', { of: uebergang, skipLocked: true })
	);
}

/** Records that an event went out. The marker is what keeps it going out exactly once. */
export async function markiereVeroeffentlicht(
	uebergangId: string,
	ereignis: AlarmEreignis,
	zeitpunkt: Date,
	tx: Tx
): Promise<void> {
	const felder =
		ereignis === 'alarm'
			? { alarmiertAm: zeitpunkt }
			: ereignis === 'verschaerfung'
				? { verschaerfungGemeldetAm: zeitpunkt }
				: { entwarntAm: zeitpunkt };

	await tx.update(uebergang).set(felder).where(eq(uebergang.id, uebergangId));
}

export interface ZustellEintrag {
	kanal: ZustellKanal;
	webhookZielId: string | null;
}

/** Opens the ledger rows for one event, in the same transaction as its marker. */
export async function oeffneZustellungen(
	uebergangId: string,
	ereignis: AlarmEreignis,
	eintraege: ZustellEintrag[],
	tx: Tx
): Promise<void> {
	if (eintraege.length === 0) return;

	await tx
		.insert(zustellung)
		.values(eintraege.map((eintrag) => ({ uebergangId, ereignis, ...eintrag })));
}

// ---------------------------------------------------------------------------------------------
// Übergeben
// ---------------------------------------------------------------------------------------------

export interface OffeneZustellung {
	id: string;
	ereignis: AlarmEreignis;
	kanal: ZustellKanal;
	webhookZielId: string | null;
	jobId: string | null;
	episode: EpisodenSicht;
}

/**
 * The rank of an event within its episode — the order the lifecycle produces them in.
 *
 * Not `erstellt_am`: a pass publishes an episode's events in one transaction, where `now()` is the
 * transaction's start time, so all of them would carry the *same* timestamp and their order would
 * fall to a random uuid. The rank is derived from the event itself and cannot tie.
 */
const EREIGNIS_RANG = sql`case ${zustellung.ereignis}
	when 'alarm' then 0 when 'verschaerfung' then 1 else 2 end`;

/**
 * Which monitor an episode belongs to, whichever of the two columns carries it.
 *
 * Without the `coalesce` every self-monitor would share the single NULL partition below, and their
 * chains would collapse into one: the alarm of the core monitor would block a mailbox monitor's
 * all-clear for no reason at all.
 */
const MONITOR_IDENTITAET = sql`coalesce(${uebergang.monitorId}, ${uebergang.selbstMonitorId})`;

/**
 * The head of every delivery chain: per target (`monitor` × `kanal` × `webhook_ziel`) the oldest
 * delivery that has not reached its receiver yet, oldest chain first.
 *
 * **One row per chain, not the oldest N rows overall.** A limit over the flat list would let a
 * single flapping monitor fill the whole window with its own backlog and starve every other
 * target indefinitely — the deliveries of a stalled chain accumulate, and they are the oldest.
 * Bounding by *chains* makes each target contribute exactly one candidate, so the limit can only
 * postpone whole chains, never hide one behind another.
 *
 * Episodes whose **predecessor still owes an event** are excluded outright. Publishing is not
 * globally ordered — `skip locked` lets a second worker take a younger episode while an older one
 * is being written, and a lagging Bewertungs-Schranke can hold back an Entwarnung while the alarm
 * of the next episode is already publishable. Handing over the younger alarm first would make the
 * adapter comment the old ticket instead of opening a new one after the close, and the late
 * Entwarnung would then close the ticket the alarm just opened. The filter drops whole episodes,
 * so it can never promote a younger delivery of the same episode to head.
 */
export async function ladeOffeneZustellungen(
	limit: number,
	db: Ausfuehrer = getDb()
): Promise<OffeneZustellung[]> {
	const koepfe = db
		.select({
			// Aliased one by one: `zustellung.id` and `uebergang.id` would collide into two columns
			// of the same name, and the outer query could not tell them apart.
			id: sql<string>`${zustellung.id}`.as('zustellung_id'),
			begonnenAm: sql<Date>`${uebergang.begonnenAm}`.as('begonnen_am'),
			uebergangId: sql<string>`${uebergang.id}`.as('uebergang_id'),
			rang: EREIGNIS_RANG.as('rang'),
			platz: sql<number>`row_number() over (
				partition by ${MONITOR_IDENTITAET}, ${zustellung.kanal}, ${zustellung.webhookZielId}
				order by ${uebergang.begonnenAm}, ${uebergang.id}, ${EREIGNIS_RANG}, ${zustellung.id}
			)`.as('platz')
		})
		.from(zustellung)
		.innerJoin(uebergang, eq(uebergang.id, zustellung.uebergangId))
		.where(
			and(
				eq(zustellung.zustand, 'offen'),
				notExists(
					db
						.select({ eins: sql`1` })
						.from(aeltere)
						.where(
							and(
								// "Same monitor", written as two equalities rather than over
								// `MONITOR_IDENTITAET`: each side is indexed
								// (`uebergang_monitor_begonnen_idx`, `uebergang_selbst_monitor_begonnen_idx`),
								// a `coalesce` on both columns would be neither. Exactly one column is set
								// per row (CHECK `uebergang_genau_ein_monitor`), so the other comparison is
								// null and can never make this true by accident.
								sql`(${aeltere.monitorId} = ${uebergang.monitorId}
									or ${aeltere.selbstMonitorId} = ${uebergang.selbstMonitorId})`,
								sql`(${aeltere.begonnenAm}, ${aeltere.id}) < (${uebergang.begonnenAm}, ${uebergang.id})`,
								offenePflichten(aeltere)
							)
						)
				)
			)
		)
		.as('koepfe');

	const ausgewaehlt = await db
		.select({ id: koepfe.id })
		.from(koepfe)
		.where(eq(koepfe.platz, 1))
		.orderBy(asc(koepfe.begonnenAm), asc(koepfe.uebergangId), asc(koepfe.rang))
		.limit(limit);

	if (ausgewaehlt.length === 0) return [];

	const ids = ausgewaehlt.map((zeile) => zeile.id);
	const zeilen = await db
		.select({
			...episodenFelder,
			id: zustellung.id,
			ereignis: zustellung.ereignis,
			kanal: zustellung.kanal,
			webhookZielId: zustellung.webhookZielId,
			jobId: zustellung.jobId
		})
		.from(zustellung)
		.innerJoin(uebergang, eq(uebergang.id, zustellung.uebergangId))
		// Left, not inner: a self-monitor episode has no monitor row and no customer, and dropping
		// it here would make its deliveries invisible to the handover forever (SPEC §7–8).
		.leftJoin(monitor, eq(monitor.id, uebergang.monitorId))
		.leftJoin(kunde, eq(kunde.id, monitor.kundeId))
		.leftJoin(selbstMonitor, eq(selbstMonitor.id, uebergang.selbstMonitorId))
		.leftJoin(vorgaenger, eq(vorgaenger.id, uebergang.vorgaengerId))
		.where(inArray(zustellung.id, ids))
		.orderBy(asc(uebergang.begonnenAm), asc(uebergang.id), EREIGNIS_RANG, asc(zustellung.id));

	return zeilen.map((zeile) => ({
		id: zeile.id,
		ereignis: zeile.ereignis,
		kanal: zeile.kanal,
		webhookZielId: zeile.webhookZielId,
		jobId: zeile.jobId,
		episode: alsSicht(zeile)
	}));
}

/** One delivery, as the channel worker executing it needs it (#28, #29). */
export interface ZustellAuftrag {
	ereignis: AlarmEreignis;
	/** The episode that owes this event — provenance for the ticket correlation. */
	uebergangId: string;
	episode: EpisodenSicht;
}

/**
 * Reads a single delivery by id — the single-row sibling of `ladeOffeneZustellungen`.
 *
 * The queue job carries nothing but the delivery id, and everything else is derived here. That is
 * deliberate: a channel worker needs the database anyway to record the outcome, so re-reading costs
 * nothing extra and removes the second place a date could be serialised wrong. `zustellung.ereignis`
 * pins which of the episode's events this is, so the reconstruction is exact rather than guessed.
 *
 * Null when the row is gone — its episode was deleted with its monitor, and the job has nothing
 * left to deliver.
 */
export async function ladeZustellung(
	zustellungId: string,
	db: Ausfuehrer = getDb()
): Promise<ZustellAuftrag | null> {
	const [zeile] = await db
		.select({
			...episodenFelder,
			ereignis: zustellung.ereignis,
			uebergangId: uebergang.id
		})
		.from(zustellung)
		.innerJoin(uebergang, eq(uebergang.id, zustellung.uebergangId))
		// Left, like above: a self-monitor delivery has to load, or the webhook channel could never
		// send the „monitor.art = selbst, kunde = null" event SPEC §7 requires of it.
		.leftJoin(monitor, eq(monitor.id, uebergang.monitorId))
		.leftJoin(kunde, eq(kunde.id, monitor.kundeId))
		.leftJoin(selbstMonitor, eq(selbstMonitor.id, uebergang.selbstMonitorId))
		.leftJoin(vorgaenger, eq(vorgaenger.id, uebergang.vorgaengerId))
		.where(eq(zustellung.id, zustellungId))
		.limit(1);

	if (!zeile) return null;

	return {
		ereignis: zeile.ereignis,
		uebergangId: zeile.uebergangId,
		episode: alsSicht(zeile)
	};
}

/**
 * Notes the queue job behind a delivery.
 *
 * Written *after* the way accepted it, so a crash in between leaves the row looking un-handed-over
 * and the next tick repeats the handover — which is harmless exactly because the delivery id is
 * the job's identity (`Alarmweg.uebergib`).
 */
export async function setzeJobId(
	zustellungId: string,
	jobId: string | null,
	db: Ausfuehrer = getDb()
): Promise<void> {
	await db.update(zustellung).set({ jobId }).where(eq(zustellung.id, zustellungId));
}

/**
 * The outcome of one delivery attempt, written by the channel that made it (#28, #29).
 *
 * Both end states matter to the chain: a delivery blocks the younger ones of its target while it
 * is `offen` — including across retries, which is what keeps a close from being overtaken by the
 * next alarm — and releases them once it is `zugestellt` **or** `fehlgeschlagen`. The dead letter
 * is therefore not only the signal the global self-monitor reads (SPEC §8), it is also the valve
 * that keeps a dead channel from stalling a monitor's chain forever.
 */
export async function vermerkeZustellung(
	zustellungId: string,
	zustand: ZustellZustand,
	jetzt: Date,
	fehler: string | null = null,
	db: Ausfuehrer = getDb()
): Promise<void> {
	await db
		.update(zustellung)
		.set({
			zustand,
			letzterFehler: fehler,
			zugestelltAm: zustand === 'zugestellt' ? jetzt : null,
			versuche: sql`${zustellung.versuche} + 1`
		})
		.where(eq(zustellung.id, zustellungId));
}

/**
 * The dead letter: this delivery will not be attempted again (SPEC §7, "nach N erschöpften
 * Versuchen gilt die Alarm-Zustellung als gestört").
 *
 * Separate from `vermerkeZustellung` because this is not an attempt — it neither made a request nor
 * learned anything new. It therefore leaves `versuche` alone and **keeps** the diagnosis the last
 * real attempt wrote; only a delivery that never got as far as recording one falls back to the
 * generic sentence.
 *
 * The resulting row is the hook the global self-monitor reads (SPEC §8, #30), and it is what
 * releases the target's blocked chain — see `ladeOffeneZustellungen`.
 */
export async function markiereFehlgeschlagen(
	zustellungId: string,
	db: Ausfuehrer = getDb()
): Promise<void> {
	await db
		.update(zustellung)
		.set({
			zustand: 'fehlgeschlagen',
			letzterFehler: sql`coalesce(${zustellung.letzterFehler}, 'Zustellung nach erschöpften Versuchen aufgegeben')`
		})
		.where(eq(zustellung.id, zustellungId));
}

// ---------------------------------------------------------------------------------------------
// Handgriffe am Alarm
// ---------------------------------------------------------------------------------------------

export type QuittierErgebnis = 'gesetzt' | 'kein_alarm';

/**
 * CONTEXT „Quittieren": a dashboard marker „seen / being worked on", without any outside effect.
 *
 * It expires with the recovery by construction — the marker sits on the episode, and a recovered
 * episode is closed, so a re-alarm starts unacknowledged rather than inheriting an old marker.
 */
export async function setzeQuittierung(
	monitorId: string,
	quittiert: boolean,
	jetzt: Date,
	db: Ausfuehrer = getDb()
): Promise<QuittierErgebnis> {
	const zeilen = await db
		.update(uebergang)
		.set({ quittiertAm: quittiert ? jetzt : null })
		.where(and(eq(uebergang.monitorId, monitorId), isNull(uebergang.beendetAm)))
		.returning({ id: uebergang.id });

	return zeilen.length > 0 ? 'gesetzt' : 'kein_alarm';
}

export type ErledigenErgebnis = 'erledigt' | 'nicht_gestoert' | 'falsche_art' | 'unbekannt';

/**
 * CONTEXT „Erledigen": the manual recovery of an Ereignis monitor — „der Mensch setzt gestört →
 * gesund zurück, weil das Ereignis behandelt ist".
 *
 * Restricted to that kind on purpose: every other kind recovers on evidence or on time, and a hand
 * that overrules evidence would make the state say something no mail supports. It runs through the
 * ordinary state machine under the monitor lock, so there is no second path into `uebergang` —
 * only the Erholungs-Art differs, and that is what forbids the ticket from being closed.
 */
export async function erledige(
	monitorId: string,
	jetzt: Date,
	db: Db = getDb()
): Promise<ErledigenErgebnis> {
	return db.transaction(async (tx) => {
		const laufzeit = (await sperreMonitore([monitorId], tx)).get(monitorId);
		if (!laufzeit) return 'unbekannt';
		if (laufzeit.art !== 'ereignis') return 'falsche_art';
		if (laufzeit.zustand !== 'gestoert') return 'nicht_gestoert';

		const aenderung = wendeAn(laufzeit, { art: 'erholung', erholungsArt: 'erledigt' }, jetzt);
		if (aenderung.art === 'keine') return 'nicht_gestoert';

		await schreibeWirkung(laufzeit, {}, aenderung, jetzt, tx);
		return 'erledigt';
	});
}
