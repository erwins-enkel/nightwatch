import { getDb } from '../db/client';
import { env } from '../env';
import { createLogger, describeError } from '../logger';
import { bewertungsSchranke } from '../zeit/db';
import type { Tx } from '../zuordnung/db';
import {
	alsSicht,
	claimOffeneEpisoden,
	EPISODEN_PRO_SEITE,
	ERSTE_SEITE,
	ladeOffeneZustellungen,
	markiereVeroeffentlicht,
	oeffneZustellungen,
	setzeJobId,
	type OffeneEpisode,
	type Seitenmarke,
	type ZustellEintrag
} from './db';
import { baueEreignis } from './ereignis';
import { entwarnungFaellig } from './lebenszyklus';
import { alarmwege } from './wege';
import type { AlarmEreignis } from '../db/schema/enums';

/**
 * The publisher: the one place where a state transition becomes an outside effect (SPEC §6–7).
 *
 * A transition is written inside the transaction that decided it — the mail pipeline's or the time
 * scheduler's. Sending from there would either publish what a rollback takes back, or lose the
 * event when the process dies after the commit. So this loop derives its work from the episode
 * rows instead, like every other loop in this service, and the three markers on `uebergang` make
 * each event go out exactly once.
 */

const log = createLogger('alarm');

/** Deliveries examined per tick. Bounded by what has not reached its receiver yet. */
const ZUSTELLUNGEN_PRO_TICK = 500;

export interface AlarmBericht {
	/** Events published in this pass. */
	veroeffentlicht: number;
	/** Deliveries handed to a way's queue in this pass. */
	uebergeben: number;
}

export interface AuswertungsOptionen {
	jetzt?: Date;
	seitenGroesse?: number;
	basisUrl?: string;
	db?: ReturnType<typeof getDb>;
}

interface SeitenErgebnis {
	anzahl: number;
	ereignisse: number;
	marke: Seitenmarke;
}

/**
 * Publishes one event: marker and ledger rows in the caller's transaction, so they exist together
 * or not at all.
 */
async function veroeffentliche(
	episode: OffeneEpisode,
	ereignis: AlarmEreignis,
	jetzt: Date,
	basisUrl: string,
	tx: Tx
): Promise<void> {
	const daten = baueEreignis(alsSicht(episode), ereignis, basisUrl);

	await markiereVeroeffentlicht(episode.id, ereignis, jetzt, tx);

	const eintraege: ZustellEintrag[] = [];
	for (const weg of alarmwege()) {
		for (const plan of await weg.plane(daten, tx)) {
			eintraege.push({ kanal: weg.kanal, webhookZielId: plan.webhookZielId });
		}
	}
	await oeffneZustellungen(episode.id, ereignis, eintraege, tx);

	log.info('Ereignis veröffentlicht', {
		ereignis,
		alertId: daten.alertId,
		monitorId: daten.monitor.id,
		zustellungen: eintraege.length
	});
}

/**
 * One page of episodes, each one drained in lifecycle order.
 *
 * Alarm first, then Verschärfung, then Entwarnung — and only ever behind the alarm of the same
 * episode: a receiver must not learn that something recovered before it learned that it broke.
 * That an episode can publish its alarm and its Entwarnung in the same pass is deliberate; a short
 * disruption is exactly that.
 */
async function veroeffentlicheSeite(
	nach: Seitenmarke,
	limit: number,
	bewertbarBis: Date,
	basisUrl: string,
	jetzt: Date,
	tx: Tx
): Promise<SeitenErgebnis> {
	const episoden = await claimOffeneEpisoden(nach, limit, tx);
	if (episoden.length === 0) return { anzahl: 0, ereignisse: 0, marke: nach };

	let ereignisse = 0;

	for (const episode of episoden) {
		let alarmRaus = episode.alarmiertAm !== null;
		if (!alarmRaus) {
			// Published even when the episode is already over: „Der Alarm wirkt sofort" (SPEC §6).
			// The Entwarnung below closes the ticket again once the stability window held.
			await veroeffentliche(episode, 'alarm', jetzt, basisUrl, tx);
			alarmRaus = true;
			ereignisse++;
		}

		if (alarmRaus && episode.verschaerftAm !== null && episode.verschaerfungGemeldetAm === null) {
			await veroeffentliche(episode, 'verschaerfung', jetzt, basisUrl, tx);
			ereignisse++;
		}

		// The claim is a disjunction, so an episode can be here for its alarm while its all-clear is
		// void or silent — both are re-checked rather than assumed.
		const beendetAm = episode.beendetAm;
		if (
			alarmRaus &&
			beendetAm !== null &&
			episode.entwarntAm === null &&
			episode.entwarnungEntfaelltAm === null &&
			episode.erholungsArt !== 'archiviert' &&
			entwarnungFaellig(beendetAm, episode.stabilitaetSekunden, bewertbarBis)
		) {
			await veroeffentliche(episode, 'entwarnung', jetzt, basisUrl, tx);
			ereignisse++;
		}
	}

	const letzte = episoden[episoden.length - 1];
	return {
		anzahl: episoden.length,
		ereignisse,
		marke: { begonnenAm: letzte.begonnenAm, id: letzte.id }
	};
}

/**
 * Hands the head of every delivery chain to its way.
 *
 * **One in flight per target.** pg-boss promises nothing about the order of concurrent jobs, so
 * two pending instructions for the same monitor could execute the wrong way round: the alarm of
 * the next episode would find the previous ticket still open and comment it, instead of opening a
 * new one after the close — breaking „ein offenes Ticket pro Monitor" and „Re-Alarm nach
 * Schließung = neues Ticket" at once. A delivery therefore blocks the younger ones of its target
 * while it is `offen`, retries included, and releases them when it is `zugestellt` or (dead letter)
 * `fehlgeschlagen`.
 *
 * A row that already carries a `job_id` is in the queue's hands; one without is either fresh or
 * was interrupted before its id could be written — the same handover covers both, because the
 * delivery id is the job's identity.
 */
async function uebergebeOffene(basisUrl: string, db: ReturnType<typeof getDb>): Promise<number> {
	const offene = await ladeOffeneZustellungen(ZUSTELLUNGEN_PRO_TICK, db);

	if (offene.length === ZUSTELLUNGEN_PRO_TICK) {
		// The oldest come first, so the head of every long-running chain still moves — but a backlog
		// this size means alarms are piling up unsent, and that must not look like a quiet minute.
		log.warn('Zustellungs-Rückstand', { betrachtet: ZUSTELLUNGEN_PRO_TICK });
	}

	const koepfe = new Map<string, (typeof offene)[number]>();
	for (const eintrag of offene) {
		if (!koepfe.has(eintrag.kette)) koepfe.set(eintrag.kette, eintrag);
	}

	let uebergeben = 0;

	for (const kopf of koepfe.values()) {
		if (kopf.jobId !== null) continue;

		const weg = alarmwege().find((eintrag) => eintrag.kanal === kopf.kanal);
		if (!weg) {
			// The record of an alarm that reached nobody — what the global self-monitor reads (#30).
			log.warn('Kein Alarmweg für offene Zustellung', { kanal: kopf.kanal, zustellung: kopf.id });
			continue;
		}

		const daten = baueEreignis(kopf.episode, kopf.ereignis, basisUrl);
		try {
			const jobId = await weg.uebergib(daten, kopf.id);
			await setzeJobId(kopf.id, jobId, db);
			uebergeben++;
		} catch (err: unknown) {
			// Left as it is, on purpose: `job_id` stays null, the next tick repeats the handover, and
			// the way's idempotency in the delivery id keeps that from duplicating anything.
			log.warn('Übergabe fehlgeschlagen', {
				kanal: kopf.kanal,
				zustellung: kopf.id,
				error: describeError(err)
			});
		}
	}

	return uebergeben;
}

/**
 * Runs one full pass: publish what is due, then hand over what is waiting.
 *
 * The Bewertungs-Schranke is read once and used for every Entwarnung of the pass — „no re-alarm
 * came" is a judgement about an absence, and it may only be made up to the point where ingestion
 * and assignment have provably caught up (#26).
 */
export async function werteAlarmeAus(optionen: AuswertungsOptionen = {}): Promise<AlarmBericht> {
	const db = optionen.db ?? getDb();
	const jetzt = optionen.jetzt ?? new Date();
	const seitenGroesse = optionen.seitenGroesse ?? EPISODEN_PRO_SEITE;
	const basisUrl = optionen.basisUrl ?? env.basisUrl;

	const schranke = await bewertungsSchranke(jetzt, db);

	let veroeffentlicht = 0;
	let marke = ERSTE_SEITE;

	for (;;) {
		const seite = await db.transaction((tx) =>
			veroeffentlicheSeite(marke, seitenGroesse, schranke.bewertbarBis, basisUrl, jetzt, tx)
		);

		veroeffentlicht += seite.ereignisse;
		marke = seite.marke;

		// A short page means the end of the list — or that another worker holds the rest, which the
		// next tick picks up either way.
		if (seite.anzahl < seitenGroesse) break;
	}

	const uebergeben = await uebergebeOffene(basisUrl, db);

	if (veroeffentlicht > 0 || uebergeben > 0) {
		log.info('Alarm-Auswertung', { veroeffentlicht, uebergeben });
	}

	return { veroeffentlicht, uebergeben };
}

export interface AlarmScheduler {
	/** Runs one tick. Exposed so a caller can drive it deterministically instead of waiting. */
	tick(): Promise<void>;
	stop(): void;
}

export interface SchedulerOptionen {
	tickMs: number;
	seitenGroesse?: number;
	jetzt?: () => Date;
	/** Injected in tests so the loop's own behaviour is checkable without a database. */
	verarbeite?: (jetzt: Date) => Promise<void>;
}

/**
 * Starts the loop. Overlapping ticks are skipped rather than queued, exactly like the ingestion,
 * assignment and time schedulers: if a tick outruns its interval, stacking more of them helps
 * nobody.
 */
export function startAlarmScheduler(optionen: SchedulerOptionen): AlarmScheduler {
	const jetztAus = optionen.jetzt ?? (() => new Date());
	const verarbeite =
		optionen.verarbeite ??
		(async (jetzt: Date) => {
			await werteAlarmeAus({ jetzt, seitenGroesse: optionen.seitenGroesse });
		});
	let laeuft = false;

	async function tick(): Promise<void> {
		await verarbeite(jetztAus());
	}

	function geschuetzterTick(): void {
		if (laeuft) return;
		laeuft = true;
		tick()
			.catch((err: unknown) => log.warn('Tick fehlgeschlagen', { error: describeError(err) }))
			.finally(() => {
				laeuft = false;
			});
	}

	const timer = setInterval(geschuetzterTick, optionen.tickMs);
	geschuetzterTick();

	return {
		tick,
		stop(): void {
			clearInterval(timer);
		}
	};
}
