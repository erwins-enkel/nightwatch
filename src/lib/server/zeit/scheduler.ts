import { getDb } from '../db/client';
import { createLogger, describeError } from '../logger';
import { schreibeWirkung, type MonitorLaufzeit } from '../monitor/db';
import { wendeAn } from '../monitor/zustand';
import type { Tx } from '../zuordnung/db';
import {
	ERSTE_SEITE,
	KANDIDATEN_PRO_SEITE,
	bewertungsSchranke,
	claimZeitKandidaten,
	istAbgedeckt,
	ladeAusnahmetage,
	ladeZeitzone,
	setzeSollGeprueftBis,
	zaehlerStaende,
	type Schranke,
	type ZeitLaufzeit
} from './db';
import { zeitWirkungen, type ZeitKontext } from './faelligkeit';
import { ohneGate, type Gate, type GateFabrik } from './gate';
import { RUECKBLICK_TAGE, zuBewertendeSolls } from './kalenderplan';
import { TAG_MS, tagesEnde, zonenDatum } from './zeitzone';

/**
 * The time-triggered evaluation's main loop, owned by the `worker` service (SPEC §2).
 *
 * A timer rather than a pg-boss job, like the two loops beside it: the evaluation derives from
 * persisted state, so there is no message that could be lost and nothing a queue would add. A tick
 * that never ran costs nothing — the next one reaches the same conclusion, because the conclusion
 * is a function of the rows, not of the ticks.
 */

const log = createLogger('zeit');

/** How far the Schranke may lag before the standstill is worth a line in the log. */
export const SCHRANKE_WARNUNG_MS = 15 * 60_000;

export interface ZeitBericht {
	schranke: Schranke;
	/** Monitors this pass looked at. */
	geprueft: number;
	/** State changes actually written. */
	wirkungen: number;
}

export interface AuswertungsOptionen {
	jetzt?: Date;
	seitenGroesse?: number;
	gate?: GateFabrik;
	db?: ReturnType<typeof getDb>;
}

interface SeitenErgebnis {
	anzahl: number;
	wirkungen: number;
	letzteId: string;
}

function braucthAusnahmetage(kandidat: ZeitLaufzeit): boolean {
	if (kandidat.art === 'zaehler') return true;
	return kandidat.art === 'heartbeat' && kandidat.erwartungModus === 'kalenderplan';
}

/**
 * The Zähler's Anlauf (CONTEXT): the lower bound goes live only once a full window has passed since
 * the activation — or since the end of an Ausnahmetag.
 *
 * Without it every freshly activated counter would be disturbed immediately, because the count
 * starts at zero and history is never counted retroactively.
 */
function anlaufVorbei(
	kandidat: ZeitLaufzeit,
	tage: string[],
	zone: string,
	bis: Date,
	bisDatum: string
): boolean {
	const fenster = kandidat.zaehlerFensterSekunden;
	if (fenster === null) return false;

	let start = kandidat.aktiviertAm;
	const letzterTag = tage.filter((datum) => datum <= bisDatum).pop();
	if (letzterTag) {
		const ende = tagesEnde(letzterTag, zone);
		if (ende > start) start = ende;
	}

	return bis.getTime() >= start.getTime() + fenster * 1000;
}

/**
 * The Kalenderplan's verdicts for one monitor, and whether the cursor may move.
 *
 * A closed gate returns `null`: the cursor stays where it is, so the same Solls are offered again
 * once the ingestion has recovered and caught up — „ausgesetzt, nicht verworfen" (CONTEXT
 * „Ingestion-Gate").
 */
async function kalenderplanSolls(
	kandidat: ZeitLaufzeit,
	tage: Set<string>,
	zone: string,
	bis: Date,
	gateOffen: boolean,
	tx: Tx
): Promise<Date[] | null> {
	const plan = kandidat.erwartungPlan;
	if (!plan || kandidat.erwartungModus !== 'kalenderplan') return [];
	if (!gateOffen) return null;

	const cursor = kandidat.sollGeprueftBisAm ?? kandidat.aktiviertAm;
	const bewertungen = zuBewertendeSolls(
		{ plan, zone, ausnahmetage: tage },
		kandidat.karenzSekunden ?? 0,
		kandidat.aktiviertAm,
		cursor,
		bis
	);

	const unabgedeckt: Date[] = [];
	for (const bewertung of bewertungen) {
		const abgedeckt = await istAbgedeckt(
			kandidat.id,
			kandidat.aktiviertAm,
			bewertung.fensterVon,
			bewertung.fensterBis,
			tx
		);
		if (!abgedeckt) unabgedeckt.push(bewertung.fensterBis);
	}

	return unabgedeckt;
}

async function verarbeiteSeite(
	schranke: Schranke,
	zone: string,
	gate: Gate,
	nachId: string,
	limit: number,
	tx: Tx
): Promise<SeitenErgebnis> {
	const bis = schranke.bewertbarBis;
	const kandidaten = await claimZeitKandidaten(bis, nachId, limit, tx);
	if (kandidaten.length === 0) return { anzahl: 0, wirkungen: 0, letzteId: nachId };

	const zaehlerKandidaten = kandidaten.filter(
		(kandidat) => kandidat.art === 'zaehler' && kandidat.zaehlerFensterSekunden !== null
	);

	// One date range for the whole page: far enough back for the widest counter window and for the
	// Kalenderplan's look-back, one day forward so „today" is never cut off by a zone offset.
	const weitestesFenster = Math.max(
		0,
		...zaehlerKandidaten.map((kandidat) => kandidat.zaehlerFensterSekunden ?? 0)
	);
	const rueckblickMs = Math.max(RUECKBLICK_TAGE * TAG_MS, weitestesFenster * 1000 + TAG_MS);
	const bisDatum = zonenDatum(bis, zone);

	const ausnahmetage = await ladeAusnahmetage(
		kandidaten.filter(braucthAusnahmetage).map((kandidat) => kandidat.id),
		zonenDatum(new Date(bis.getTime() - rueckblickMs), zone),
		zonenDatum(new Date(bis.getTime() + TAG_MS), zone),
		tx
	);

	const staende = await zaehlerStaende(
		zaehlerKandidaten.map((kandidat) => ({
			monitorId: kandidat.id,
			aktiviertAm: kandidat.aktiviertAm,
			von: new Date(bis.getTime() - (kandidat.zaehlerFensterSekunden ?? 0) * 1000),
			bis
		})),
		tx
	);

	let wirkungen = 0;

	for (const kandidat of kandidaten) {
		const gateOffen = gate.offen(kandidat.postfachId);
		const tage = ausnahmetage.get(kandidat.id) ?? [];
		const tageSatz = new Set(tage);

		const unabgedeckt = await kalenderplanSolls(kandidat, tageSatz, zone, bis, gateOffen, tx);

		const kontext: ZeitKontext = {
			unabgedeckt: unabgedeckt ?? [],
			zaehlerStand: staende.get(kandidat.id) ?? 0,
			anlaufVorbei: anlaufVorbei(kandidat, tage, zone, bis, bisDatum),
			ausnahmetag: tageSatz.has(bisDatum),
			gateOffen
		};

		let laufzeit: MonitorLaufzeit = kandidat;
		for (const { wirkung, zeitpunkt } of zeitWirkungen(kandidat, kontext, bis)) {
			// The pause is checked against the Schranke, not against the deadline: a monitor that is
			// under maintenance *now* must not alarm for a condition that arose before it began.
			// The episode is still dated on the deadline — „überfällig seit 06:30", not since the
			// tick that noticed.
			const aenderung = wendeAn(laufzeit, wirkung, bis);
			if (aenderung.art === 'keine') continue;

			laufzeit = await schreibeWirkung(laufzeit, {}, aenderung, zeitpunkt, tx);
			wirkungen++;
		}

		// Only after the verdicts were written, and only when they were actually taken.
		if (unabgedeckt !== null && kandidat.erwartungModus === 'kalenderplan') {
			await setzeSollGeprueftBis(kandidat.id, bis, tx);
		}
	}

	return {
		anzahl: kandidaten.length,
		wirkungen,
		letzteId: kandidaten[kandidaten.length - 1].id
	};
}

/**
 * Runs one full pass over the due monitors.
 *
 * The Schranke is read **once** and handed into every page: a value that moved on mid-pass would
 * make two monitors of the same tick judge against different clocks, and a slightly stale bound is
 * always safe — it only ever judges less.
 */
export async function werteZeitAus(optionen: AuswertungsOptionen = {}): Promise<ZeitBericht> {
	const db = optionen.db ?? getDb();
	const jetzt = optionen.jetzt ?? new Date();
	const seitenGroesse = optionen.seitenGroesse ?? KANDIDATEN_PRO_SEITE;
	const gate = await (optionen.gate ?? ohneGate)();

	const schranke = await bewertungsSchranke(jetzt, db);

	/**
	 * A mailbox that has never settled a round promises nothing, and nothing it has not read can be
	 * told apart from mail that never came. Nothing is judged at all until it reports in.
	 *
	 * Logged every tick rather than only past the lag threshold: this state is normal for the first
	 * minutes after an upgrade or a new mailbox, and mysterious for anyone who does not know that.
	 */
	if (schranke.haltendVon === 'keine_zusage') {
		log.warn('Zeit-Auswertung ausgesetzt: Postfach ohne Vollständigkeits-Zusage');
		return { schranke, geprueft: 0, wirkungen: 0 };
	}

	const zone = await ladeZeitzone(db);

	const rueckstandMs = jetzt.getTime() - schranke.bewertbarBis.getTime();
	if (rueckstandMs > SCHRANKE_WARNUNG_MS) {
		// A standstill, not a false alarm — the right direction, but it has to be visible. The alarm
		// on top of it is the global self-monitor (#30).
		log.warn('Zeit-Auswertung ausgesetzt', {
			haltendVon: schranke.haltendVon,
			rueckstandSekunden: Math.round(rueckstandMs / 1000)
		});
	}

	let geprueft = 0;
	let wirkungen = 0;
	let nachId = ERSTE_SEITE;

	for (;;) {
		const seite = await db.transaction((tx) =>
			verarbeiteSeite(schranke, zone, gate, nachId, seitenGroesse, tx)
		);

		geprueft += seite.anzahl;
		wirkungen += seite.wirkungen;
		nachId = seite.letzteId;

		// A short page means the end of the list — or that another worker holds the rest, which the
		// next tick picks up either way.
		if (seite.anzahl < seitenGroesse) break;
	}

	if (wirkungen > 0) log.info('Zeit-Auswertung', { geprueft, wirkungen });

	return { schranke, geprueft, wirkungen };
}

export interface ZeitScheduler {
	/** Runs one tick. Exposed so a caller can drive it deterministically instead of waiting. */
	tick(): Promise<void>;
	stop(): void;
}

export interface SchedulerOptionen {
	tickMs: number;
	seitenGroesse?: number;
	gate?: GateFabrik;
	jetzt?: () => Date;
	/** Injected in tests so the loop's own behaviour is checkable without a database. */
	verarbeite?: (jetzt: Date) => Promise<void>;
}

/**
 * Starts the loop. Overlapping ticks are skipped rather than queued, exactly like the ingestion and
 * assignment schedulers: if a tick outruns its interval, stacking more of them helps nobody.
 */
export function startZeitScheduler(optionen: SchedulerOptionen): ZeitScheduler {
	const jetztAus = optionen.jetzt ?? (() => new Date());
	const verarbeite =
		optionen.verarbeite ??
		(async (jetzt: Date) => {
			await werteZeitAus({
				jetzt,
				seitenGroesse: optionen.seitenGroesse,
				gate: optionen.gate
			});
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
