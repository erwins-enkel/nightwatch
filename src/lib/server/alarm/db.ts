import { and, asc, eq, inArray, isNull, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { getDb } from '../db/client';
import { kunde, monitor, uebergang, zustellung } from '../db/schema';
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

/** The flat row both queries below share: one episode plus who it belongs to. */
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
	monitorId: string;
	monitorBezeichnung: string;
	monitorArt: MonitorArt;
	kundeId: string;
	kundeName: string;
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
	monitorId: monitor.id,
	monitorBezeichnung: monitor.bezeichnung,
	monitorArt: monitor.art,
	kundeId: kunde.id,
	kundeName: kunde.name
};

/** The episode as the payload builder wants it (`ereignis.ts`). */
export function alsSicht(zeile: EpisodenZeile): EpisodenSicht {
	return {
		alertId: zeile.alertId,
		vorgaengerAlertId: zeile.vorgaengerAlertId,
		alarmgrund: zeile.alarmgrund,
		begonnenAm: zeile.begonnenAm,
		letztesVorkommenAm: zeile.letztesVorkommenAm,
		vorkommen: zeile.vorkommen,
		verschaerftAm: zeile.verschaerftAm,
		beendetAm: zeile.beendetAm,
		erholungsArt: zeile.erholungsArt,
		monitor: {
			art: zeile.monitorArt,
			id: zeile.monitorId,
			bezeichnung: zeile.monitorBezeichnung
		},
		kunde: { id: zeile.kundeId, name: zeile.kundeName }
	};
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
 * Only customer monitors. Self-monitor episodes are sent by the watchdog on its own path (SPEC
 * §8); publishing them here as well would send everything twice.
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
				partition by ${uebergang.monitorId}, ${zustellung.kanal}, ${zustellung.webhookZielId}
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
								eq(aeltere.monitorId, uebergang.monitorId),
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
		.innerJoin(monitor, eq(monitor.id, uebergang.monitorId))
		.innerJoin(kunde, eq(kunde.id, monitor.kundeId))
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
