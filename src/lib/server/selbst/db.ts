import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { getDb } from '../db/client';
import {
	einstellungen,
	heartbeat,
	postfach,
	selbstMonitor,
	uebergang,
	webhookZiel,
	zustellung
} from '../db/schema';
import type {
	Alarmgrund,
	ErholungsArt,
	MonitorZustand,
	SelbstMonitorArt
} from '../db/schema/enums';
import { erholungHielt } from '../alarm/lebenszyklus';
import { wirksameSelbstStabilitaet } from '../alarm/db';
import type { FehlerKlasse } from '../graph/fehler';
import type { ServiceName } from '../health';
import type { Zustandsaenderung } from '../monitor/zustand';
import type { Tx } from '../zuordnung/db';
import type { DienstBeobachtung, PostfachBeobachtung } from './beobachtung';

/**
 * Every database statement the self-monitoring needs, so the modules above it stay comparisons.
 *
 * The writing half mirrors `monitor/db.ts` → `schreibeWirkung()` rather than reusing it: that
 * function is bound to columns `selbst_monitor` does not have (`zuletzt_gesehen_am`,
 * `paar_offen_seit`, the per-Art parameters). The *rules* are not mirrored — the state machine and
 * `erholungHielt()` are the same functions the customer path runs (SPEC §8: „keine zweite Logik").
 */

type Db = ReturnType<typeof getDb>;
type Ausfuehrer = Db | Tx;

function alsDatum(wert: string | Date | null): Date | null {
	if (wert === null) return null;
	return wert instanceof Date ? wert : new Date(wert);
}

// ---------------------------------------------------------------------------------------------
// Laufzeit
// ---------------------------------------------------------------------------------------------

/** A self-monitor's state and parameters, as the evaluation reads and writes them. */
export interface SelbstLaufzeit {
	id: string;
	schluessel: string;
	art: SelbstMonitorArt;
	bezeichnung: string;
	postfachId: string | null;
	zustand: MonitorZustand;
	alarmgrund: Alarmgrund | null;
	zustandSeit: Date;
	stalenessSekunden: number;
	/** Already resolved against the instance default, like `MonitorLaufzeit`'s. */
	entwarnungsStabilitaetSekunden: number;
	offenerUebergangId: string | null;
	verschaerftAm: Date | null;
}

/**
 * Locks every self-monitor and reads its state.
 *
 * There are only ever a handful of rows — one per mailbox plus the core — so this takes them all
 * rather than paging. Ascending `id` is the lock order (the same discipline as `sperreMonitore()`);
 * it says nothing about the order they are *evaluated* in, which is the caller's business and
 * is core-first for a reason — see `scheduler.ts`.
 */
export async function sperreSelbstMonitore(tx: Tx): Promise<SelbstLaufzeit[]> {
	const zeilen = await tx
		.select({
			id: selbstMonitor.id,
			schluessel: selbstMonitor.schluessel,
			art: selbstMonitor.art,
			bezeichnung: selbstMonitor.bezeichnung,
			postfachId: selbstMonitor.postfachId,
			zustand: selbstMonitor.zustand,
			alarmgrund: selbstMonitor.alarmgrund,
			zustandSeit: selbstMonitor.zustandSeit,
			stalenessSekunden: selbstMonitor.stalenessSekunden,
			entwarnungsStabilitaetSekunden: wirksameSelbstStabilitaet
		})
		.from(selbstMonitor)
		.orderBy(asc(selbstMonitor.id))
		.for('update');

	// Read after the lock, so a concurrent writer's episode is visible rather than raced.
	const offene = await tx
		.select({
			id: uebergang.id,
			selbstMonitorId: uebergang.selbstMonitorId,
			verschaerftAm: uebergang.verschaerftAm
		})
		.from(uebergang)
		.where(and(isNull(uebergang.beendetAm), sql`${uebergang.selbstMonitorId} is not null`));

	const nachMonitor = new Map(
		offene
			.filter((zeile) => zeile.selbstMonitorId !== null)
			.map((zeile) => [zeile.selbstMonitorId as string, zeile])
	);

	return zeilen.map((zeile) => {
		const offen = nachMonitor.get(zeile.id);
		return {
			...zeile,
			offenerUebergangId: offen?.id ?? null,
			verschaerftAm: offen?.verschaerftAm ?? null
		};
	});
}

// ---------------------------------------------------------------------------------------------
// Beobachtungen
// ---------------------------------------------------------------------------------------------

/**
 * Every mailbox's ingestion facts, keyed by mailbox.
 *
 * `letzter_erfolgreicher_poll` falls back to `erstellt_am`: a mailbox that has never polled is
 * judged from the moment it was connected, which gives the onboarding its staleness window before
 * the self-monitor has an opinion.
 */
export async function ladePostfachBeobachtungen(
	db: Ausfuehrer = getDb()
): Promise<Map<string, PostfachBeobachtung>> {
	const zeilen = await db
		.select({
			postfachId: postfach.id,
			aktiv: postfach.aktiv,
			letzterErfolgAm: sql<Date>`coalesce(${postfach.letzterErfolgreicherPoll}, ${postfach.erstelltAm})`,
			letzterFehlerKlasse: postfach.letzterFehlerKlasse,
			letzterFehlerAm: postfach.letzterFehlerAm
		})
		.from(postfach);

	return new Map(
		zeilen.map((zeile) => [
			zeile.postfachId,
			{
				postfachId: zeile.postfachId,
				aktiv: zeile.aktiv,
				letzterErfolgAm: alsDatum(zeile.letzterErfolgAm) as Date,
				letzterFehlerKlasse: zeile.letzterFehlerKlasse as FehlerKlasse | null,
				letzterFehlerAm: zeile.letzterFehlerAm
			}
		])
	);
}

export async function ladeDienste(db: Ausfuehrer = getDb()): Promise<DienstBeobachtung[]> {
	const zeilen = await db
		.select({ dienst: heartbeat.dienst, zuletztGesehen: heartbeat.zuletztGesehen })
		.from(heartbeat);

	return zeilen.map((zeile) => ({
		dienst: zeile.dienst as ServiceName,
		zuletztGesehen: zeile.zuletztGesehen
	}));
}

/**
 * Since when alarm delivery has been demonstrably broken — or null when it has not (SPEC §8).
 *
 * Evaluated **per target** (`kanal` × `webhook_ziel_id`), because the targets are independent: a
 * webhook that has been dead for a day must not be papered over by a successful delivery to another
 * receiver. The two timestamps come from deliberately different sets:
 *
 * - The **fault** is a dead letter of a *customer* delivery. Self-monitor deliveries are excluded
 *   here and only here: a channel that cannot carry the self-alarm would otherwise report its own
 *   failure as a fresh core disruption and feed the alarm back into itself.
 * - The **recovery** is any delivery that reached this target, self-monitor deliveries **included**.
 *   A self-alarm that gets through *is* the proof the receiver is reachable — and it is the only
 *   proof available for a target that no customer event happens to be going to, which is why
 *   `versand.ts` keeps that delivery pending instead of dead-lettering it.
 *
 * A target with no dead letter at all is healthy, however little it has ever delivered: „never used"
 * is the normal state of a receiver the operator has just saved, not a disruption. Retired receivers
 * (`aktiv = false`) drop out entirely — they can never produce the success that would clear them.
 *
 * The oldest surviving fault wins, so the episode is dated on the beginning of the disruption rather
 * than on its latest symptom.
 */
export async function zustellStoerungSeit(db: Ausfuehrer = getDb()): Promise<Date | null> {
	const ergebnis = await db.execute<{ seit: string | Date | null }>(sql`
		with je_ziel as (
			select
				max(${zustellung.aufgegebenAm}) filter (
					where ${zustellung.zustand} = 'fehlgeschlagen'
						and ${uebergang.selbstMonitorId} is null
				) as stoerung,
				max(${zustellung.zugestelltAm}) filter (
					where ${zustellung.zustand} = 'zugestellt'
				) as erfolg
			from ${zustellung}
			join ${uebergang} on ${uebergang.id} = ${zustellung.uebergangId}
			left join ${webhookZiel} on ${webhookZiel.id} = ${zustellung.webhookZielId}
			where ${zustellung.webhookZielId} is null or ${webhookZiel.aktiv}
			group by ${zustellung.kanal}, ${zustellung.webhookZielId}
		)
		select min(stoerung) as seit from je_ziel
		where stoerung is not null and (erfolg is null or erfolg < stoerung)
	`);

	return alsDatum(ergebnis.rows[0]?.seit ?? null);
}

// ---------------------------------------------------------------------------------------------
// Schreiben
// ---------------------------------------------------------------------------------------------

interface VorgaengerZeile {
	id: string;
	beendetAm: Date | null;
	entwarntAm: Date | null;
	entwarnungEntfaelltAm: Date | null;
}

/** The self-monitor's most recent episode — read under the lock the caller already holds. */
async function juengsteEpisode(
	selbstMonitorId: string,
	tx: Tx
): Promise<VorgaengerZeile | undefined> {
	const [zeile] = await tx
		.select({
			id: uebergang.id,
			beendetAm: uebergang.beendetAm,
			entwarntAm: uebergang.entwarntAm,
			entwarnungEntfaelltAm: uebergang.entwarnungEntfaelltAm
		})
		.from(uebergang)
		.where(eq(uebergang.selbstMonitorId, selbstMonitorId))
		.orderBy(desc(uebergang.begonnenAm), desc(uebergang.id))
		.limit(1);

	return zeile;
}

/**
 * Voids the predecessor's pending Entwarnung when this disruption proves the recovery did not hold.
 *
 * Identical in shape and in reasoning to `monitor/db.ts`; the rule itself is the shared
 * `erholungHielt()`, so a self-monitor's flutter is damped by exactly the same arithmetic as a
 * customer monitor's.
 */
async function entwerteEntwarnung(
	vorgaenger: VorgaengerZeile | undefined,
	stabilitaetSekunden: number,
	zeitpunkt: Date,
	tx: Tx
): Promise<void> {
	if (!vorgaenger?.beendetAm) return;
	if (vorgaenger.entwarntAm !== null || vorgaenger.entwarnungEntfaelltAm !== null) return;
	if (erholungHielt(vorgaenger.beendetAm, stabilitaetSekunden, zeitpunkt)) return;

	await tx
		.update(uebergang)
		.set({ entwarnungEntfaelltAm: zeitpunkt })
		.where(and(eq(uebergang.id, vorgaenger.id), isNull(uebergang.entwarntAm)));
}

/**
 * Writes one observation's outcome: the state and the episode.
 *
 * Returns the new in-memory state, so the caller can fold the next observation onto it without
 * re-reading — and, crucially, so `scheduler.ts` can take „is the core disturbed?" from this return
 * value rather than from the row it read at the start of the tick.
 */
export async function schreibeSelbstWirkung(
	laufzeit: SelbstLaufzeit,
	aenderung: Zustandsaenderung,
	zeitpunkt: Date,
	tx: Tx
): Promise<SelbstLaufzeit> {
	const neu: SelbstLaufzeit = { ...laufzeit };
	const felder: PgUpdateSetSource<typeof selbstMonitor> = {};

	switch (aenderung.art) {
		case 'keine':
			return neu;

		case 'eroeffnen': {
			felder.zustand = 'gestoert';
			felder.alarmgrund = aenderung.grund;
			felder.zustandSeit = zeitpunkt;
			neu.zustand = 'gestoert';
			neu.alarmgrund = aenderung.grund;
			neu.zustandSeit = zeitpunkt;

			const vorgaenger = await juengsteEpisode(laufzeit.id, tx);

			const [zeile] = await tx
				.insert(uebergang)
				.values({
					selbstMonitorId: laufzeit.id,
					alarmgrund: aenderung.grund,
					begonnenAm: zeitpunkt,
					letztesVorkommenAm: zeitpunkt,
					vorgaengerId: vorgaenger?.id ?? null
				})
				.returning({ id: uebergang.id });

			neu.offenerUebergangId = zeile.id;
			neu.verschaerftAm = null;

			await entwerteEntwarnung(vorgaenger, laufzeit.entwarnungsStabilitaetSekunden, zeitpunkt, tx);
			break;
		}

		case 'vorkommen':
			if (laufzeit.offenerUebergangId) {
				await tx
					.update(uebergang)
					.set({ vorkommen: sql`${uebergang.vorkommen} + 1`, letztesVorkommenAm: zeitpunkt })
					.where(eq(uebergang.id, laufzeit.offenerUebergangId));
			}
			break;

		case 'grundwechsel': {
			// Only the live reason moves; `uebergang.alarmgrund` stays the reason the alarm went out
			// with, exactly as on the customer path.
			felder.alarmgrund = aenderung.grund;
			neu.alarmgrund = aenderung.grund;

			if (laufzeit.offenerUebergangId) {
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
			neu.zustandSeit = zeitpunkt;

			if (laufzeit.offenerUebergangId) {
				// Only the internal end; `entwarnt_am` is set once the stability window held.
				await tx
					.update(uebergang)
					.set({ beendetAm: zeitpunkt, erholungsArt: aenderung.erholungsArt })
					.where(eq(uebergang.id, laufzeit.offenerUebergangId));
			}
			neu.offenerUebergangId = null;
			neu.verschaerftAm = null;
			break;
		}
	}

	if (Object.keys(felder).length > 0) {
		await tx.update(selbstMonitor).set(felder).where(eq(selbstMonitor.id, laufzeit.id));
	}

	return neu;
}

/**
 * Ends a running disruption without an all-clear — the silent end an inactive mailbox deserves.
 *
 * „Ein Monitor, der abgeschaltet wurde, schuldet niemandem eine Entwarnung" (CONTEXT
 * „Archiviert"): `erholungs_art = 'archiviert'` is the enum value the publisher skips.
 */
export async function beendeSelbstStill(
	laufzeit: SelbstLaufzeit,
	jetzt: Date,
	tx: Tx
): Promise<SelbstLaufzeit> {
	return schreibeSelbstWirkung(
		laufzeit,
		{ art: 'beenden', erholungsArt: 'archiviert' satisfies ErholungsArt },
		jetzt,
		tx
	);
}

// ---------------------------------------------------------------------------------------------
// Parameter und Status
// ---------------------------------------------------------------------------------------------

/**
 * The only mutation the settings page gets. „Nicht anlegbar, nicht löschbar, nicht pausierbar
 * (Parameter ja, Existenz nein)" (CONTEXT „Selbst-Monitor") — so there is no insert, no delete and
 * no pause here, and `selbst_monitor` has no `pausiert` column to offer one.
 */
export async function setzeSelbstParameter(
	id: string,
	stalenessSekunden: number,
	entwarnungsStabilitaetSekunden: number | null,
	db: Ausfuehrer = getDb()
): Promise<void> {
	await db
		.update(selbstMonitor)
		.set({ stalenessSekunden, entwarnungsStabilitaetSekunden })
		.where(eq(selbstMonitor.id, id));
}

/**
 * The active webhook receivers with their stored secret — the only read in this codebase that pulls
 * ciphertext out for a reason other than sending right now.
 *
 * It exists for the emergency cache (SPEC §8): the receiver a database outage has to be reported to
 * cannot be looked up while the database is down. The plaintext never leaves the watchdog process;
 * it goes straight into the AES-256-GCM-encrypted cache file (SPEC §12).
 */
export async function ladeCacheZiele(
	db: Ausfuehrer = getDb()
): Promise<{ id: string; url: string; secretChiffre: string | null }[]> {
	return db
		.select({
			id: webhookZiel.id,
			url: webhookZiel.url,
			secretChiffre: webhookZiel.secretChiffre
		})
		.from(webhookZiel)
		.where(eq(webhookZiel.aktiv, true))
		.orderBy(asc(webhookZiel.erstelltAm), asc(webhookZiel.id));
}

export interface PingKonfig {
	/** Encrypted at rest (SPEC §12); null means the ping is switched off. */
	urlChiffre: string | null;
	intervallSekunden: number;
	zuletztAm: Date | null;
}

export async function holePingKonfig(db: Ausfuehrer = getDb()): Promise<PingKonfig> {
	const [zeile] = await db
		.select({
			urlChiffre: einstellungen.heartbeatPingUrlChiffre,
			intervallSekunden: einstellungen.heartbeatPingIntervallSekunden,
			zuletztAm: einstellungen.heartbeatPingZuletztAm
		})
		.from(einstellungen)
		.limit(1);

	return {
		urlChiffre: zeile?.urlChiffre ?? null,
		intervallSekunden: zeile?.intervallSekunden ?? 300,
		zuletztAm: zeile?.zuletztAm ?? null
	};
}

/** Only a ping that actually arrived is recorded — it doubles as the schedule. */
export async function vermerkePing(jetzt: Date, db: Ausfuehrer = getDb()): Promise<void> {
	await db
		.update(einstellungen)
		.set({ heartbeatPingZuletztAm: jetzt })
		.where(eq(einstellungen.id, 1));
}

/**
 * Saves the Heartbeat-Ping settings. A null URL switches it off; an unchanged URL is signalled by
 * `undefined`, because a secret is never round-tripped through the browser (SPEC §12).
 */
export async function speicherePingKonfig(
	urlChiffre: string | null | undefined,
	intervallSekunden: number,
	db: Ausfuehrer = getDb()
): Promise<void> {
	await db
		.update(einstellungen)
		.set({
			heartbeatPingIntervallSekunden: intervallSekunden,
			...(urlChiffre === undefined ? {} : { heartbeatPingUrlChiffre: urlChiffre }),
			// Switching the ping off drops the record of the last one with it: „last seen an hour ago"
			// next to „switched off" would read as a ping that is merely late.
			...(urlChiffre === null ? { heartbeatPingZuletztAm: null } : {}),
			geaendertAm: new Date()
		})
		.where(eq(einstellungen.id, 1));
}

export interface SelbstMonitorAnsicht {
	id: string;
	schluessel: string;
	art: SelbstMonitorArt;
	bezeichnung: string;
	zustand: MonitorZustand;
	alarmgrund: Alarmgrund | null;
	zustandSeit: Date;
	stalenessSekunden: number;
	entwarnungsStabilitaetSekunden: number | null;
	/** Null for the core, and for a mailbox monitor whose mailbox was deleted. */
	postfachBezeichnung: string | null;
}

export interface SystemStatus {
	monitore: SelbstMonitorAnsicht[];
	dienste: DienstBeobachtung[];
	/** CONTEXT „Heartbeat-Ping": opt-in, and „configured" is not the same as „arriving". */
	heartbeatPingKonfiguriert: boolean;
	heartbeatPingIntervallSekunden: number;
	heartbeatPingZuletztAm: Date | null;
	/**
	 * Whether any active webhook receiver exists. Together with the ping this answers the one
	 * question SPEC §8 wants the dashboard to answer out loud: with neither of them, a database
	 * outage — the one failure the instance cannot report through its own database — is unobserved.
	 */
	webhookZielVorhanden: boolean;
}

/** Everything the system banner (#31) and the settings page show. One read, no decisions. */
export async function systemStatus(db: Ausfuehrer = getDb()): Promise<SystemStatus> {
	const monitore = await db
		.select({
			id: selbstMonitor.id,
			schluessel: selbstMonitor.schluessel,
			art: selbstMonitor.art,
			bezeichnung: selbstMonitor.bezeichnung,
			zustand: selbstMonitor.zustand,
			alarmgrund: selbstMonitor.alarmgrund,
			zustandSeit: selbstMonitor.zustandSeit,
			stalenessSekunden: selbstMonitor.stalenessSekunden,
			entwarnungsStabilitaetSekunden: selbstMonitor.entwarnungsStabilitaetSekunden,
			postfachBezeichnung: postfach.bezeichnung
		})
		.from(selbstMonitor)
		.leftJoin(postfach, eq(postfach.id, selbstMonitor.postfachId))
		// The core first, then the mailboxes by name — the order the banner reads in.
		.orderBy(asc(selbstMonitor.art), asc(selbstMonitor.bezeichnung));

	const [konfig] = await db
		.select({
			pingUrlChiffre: einstellungen.heartbeatPingUrlChiffre,
			pingIntervallSekunden: einstellungen.heartbeatPingIntervallSekunden,
			pingZuletztAm: einstellungen.heartbeatPingZuletztAm
		})
		.from(einstellungen)
		.limit(1);

	const [ziel] = await db
		.select({ id: webhookZiel.id })
		.from(webhookZiel)
		.where(eq(webhookZiel.aktiv, true))
		.limit(1);

	return {
		monitore,
		dienste: await ladeDienste(db),
		heartbeatPingKonfiguriert: konfig?.pingUrlChiffre != null,
		heartbeatPingIntervallSekunden: konfig?.pingIntervallSekunden ?? 300,
		heartbeatPingZuletztAm: konfig?.pingZuletztAm ?? null,
		webhookZielVorhanden: ziel !== undefined
	};
}
