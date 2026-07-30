import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { heartbeat, postfach, selbstMonitor } from '../db/schema';
import { wirksameSelbstStabilitaet } from '../alarm/db';
import { stabilitaetEndeAm } from '../alarm/lebenszyklus';
import { createLogger } from '../logger';
import type { Gate, GateFabrik } from '../zeit/gate';
import type { Tx } from '../zuordnung/db';

/**
 * The Ingestion-Gate (SPEC §8, CONTEXT „Ingestion-Gate"): while the ingestion is demonstrably
 * broken, decisions that rest on a mail's *absence* are **suspended, not discarded**.
 *
 * „Ausgesetzt, nicht verworfen" is already built into the time scheduler — a closed gate makes
 * `kalenderplanSolls()` leave its cursor where it is, so the same Solls are offered again once the
 * mailbox has caught up. What this module adds is the truth value, and the precision: instead of
 * stopping every evaluation whenever any mailbox lags, it narrows the suspension to the mailboxes
 * that are actually affected.
 */

const log = createLogger('selbst');

type Db = ReturnType<typeof getDb>;
type Ausfuehrer = Db | Tx;

/** The service that owns the Graph poller. A silent `web` breaks the dashboard, not the ingestion. */
const INGESTION_DIENST = 'worker';

export interface GateSchnappschuss {
	/** Every mailbox whose own self-monitor says its ingestion cannot be trusted right now. */
	gesperrtePostfaecher: Set<string>;
	/** The core is disturbed **and** its disruption is one of processing — see below. */
	kernSperrt: boolean;
}

/**
 * Reads the whole gate in one query.
 *
 * The global clause takes two facts, not one. That the core is `gestoert` is not enough: a core that
 * is disturbed purely because a webhook is dead says nothing about ingestion, and closing every gate
 * for it would stop the customer evaluation for a reason that has nothing to do with mail. The
 * second fact — the `worker` heartbeat being stale — is looked up here rather than read off
 * `selbst_monitor.alarmgrund`, because a Verschärfung overwrites the live reason with
 * `fehler_gemeldet` and „the services are silent" would vanish from that column while still being
 * true.
 *
 * Per mailbox, a gate is closed while any of three things holds:
 *
 * - its self-monitor is `gestoert`;
 * - the recovery has not held for the Entwarnungs-Stabilität yet — „öffnet erst nach stabiler
 *   Erholung";
 * - `ingestion_stand_am` has not passed `zustand_seit` — „und aufgeholtem Rückstand". That promise
 *   only advances when a delta round *settles*, so it is the existing proof that the mail which
 *   piled up during the disruption has actually arrived. Null (nothing ever promised) keeps the gate
 *   closed, the same caution `bewertungsSchranke()` applies.
 */
export async function ladeGateSchnappschuss(
	jetzt: Date,
	db: Ausfuehrer = getDb()
): Promise<GateSchnappschuss> {
	const zeilen = await db
		.select({
			art: selbstMonitor.art,
			postfachId: selbstMonitor.postfachId,
			zustand: selbstMonitor.zustand,
			zustandSeit: selbstMonitor.zustandSeit,
			stabilitaetSekunden: wirksameSelbstStabilitaet,
			stalenessSekunden: selbstMonitor.stalenessSekunden,
			ingestionStandAm: postfach.ingestionStandAm
		})
		.from(selbstMonitor)
		.leftJoin(postfach, eq(postfach.id, selbstMonitor.postfachId));

	const [dienst] = await db
		.select({ zuletztGesehen: heartbeat.zuletztGesehen })
		.from(heartbeat)
		.where(eq(heartbeat.dienst, INGESTION_DIENST))
		.limit(1);

	const gesperrtePostfaecher = new Set<string>();
	let kernSperrt = false;

	for (const zeile of zeilen) {
		if (zeile.art === 'kern') {
			if (zeile.zustand !== 'gestoert') continue;
			// A missing heartbeat row counts as stale: a worker that has never reported in has never
			// polled either.
			const gesehen = dienst?.zuletztGesehen ?? null;
			const stillSeit =
				gesehen === null ? Number.POSITIVE_INFINITY : jetzt.getTime() - gesehen.getTime();
			kernSperrt = stillSeit >= zeile.stalenessSekunden * 1000;
			continue;
		}

		// A retired mailbox monitor keeps existing without its mailbox; it gates nothing.
		if (zeile.postfachId === null) continue;

		if (zeile.zustand === 'gestoert') {
			gesperrtePostfaecher.add(zeile.postfachId);
			continue;
		}

		if (stabilitaetEndeAm(zeile.zustandSeit, zeile.stabilitaetSekunden) > jetzt) {
			gesperrtePostfaecher.add(zeile.postfachId);
			continue;
		}

		const stand = zeile.ingestionStandAm;
		if (stand === null || stand < zeile.zustandSeit) gesperrtePostfaecher.add(zeile.postfachId);
	}

	return { gesperrtePostfaecher, kernSperrt };
}

export function baueGate(schnappschuss: GateSchnappschuss): Gate {
	return {
		offen(postfachId: string | null): boolean {
			// The global clause covers a monitor that has not seen a mail yet as well: with the core
			// down, nothing is being fetched for it either.
			if (schnappschuss.kernSperrt) return false;
			if (postfachId === null) return true;
			return !schnappschuss.gesperrtePostfaecher.has(postfachId);
		}
	};
}

/**
 * Built once per tick by the time scheduler, so the whole page of monitors is judged against one
 * snapshot rather than one query per monitor.
 *
 * A closed gate is logged: „nothing was overdue" and „nothing was allowed to be overdue" look the
 * same from the outside, and only one of them is good news.
 */
export const selbstGate: GateFabrik = async () => {
	const jetzt = new Date();
	const schnappschuss = await ladeGateSchnappschuss(jetzt);

	if (schnappschuss.kernSperrt) {
		log.warn('Ingestion-Gate global geschlossen: Nightwatch-Kern gestört');
	} else if (schnappschuss.gesperrtePostfaecher.size > 0) {
		log.info('Ingestion-Gate geschlossen', {
			postfaecher: schnappschuss.gesperrtePostfaecher.size
		});
	}

	return baueGate(schnappschuss);
};
