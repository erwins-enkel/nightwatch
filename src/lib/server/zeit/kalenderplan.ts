import type { Kalenderplan } from '../db/schema/monitor';
import { TAG_MS, alsInstant, isoDatum, isoWochentag, zonenTeile } from './zeitzone';

/**
 * Turning a Kalenderplan into the Soll-Zeitpunkte it means, and answering the one question the
 * Abdeckungs-Regel asks: which Soll came before this one (CONTEXT „Erwartung").
 *
 * Pure — every rule CONTEXT states about exception days and coverage windows is assertable here
 * without a database and without a clock.
 */

/**
 * How far back the search for the previous effective Soll runs.
 *
 * Five weeks: enough for a weekly plan whose weekday fell on an exception day several times in a
 * row. Beyond that no verdict is passed at all — a coverage window that cannot be established is
 * not a window, and guessing one would invent an alarm out of missing information.
 *
 * The same bound caps how far a catch-up after a standstill reaches back. Older Solls are not
 * replayed one by one; a monitor that has been silent for five weeks is overdue on the most recent
 * Soll anyway, and that is what alarms.
 */
export const RUECKBLICK_TAGE = 35;

export interface PlanKontext {
	plan: Kalenderplan;
	/** IANA zone from `einstellungen.zeitzone` — the plan's `HH:MM` is wall clock in it. */
	zone: string;
	/** `YYYY-MM-DD` dates on which the time targets are suspended (CONTEXT „Ausnahmetag"). */
	ausnahmetage: ReadonlySet<string>;
}

/** One Soll that is due for a verdict, with the window its coverage is judged over. */
export interface SollBewertung {
	soll: Date;
	/** „seit dem vorherigen wirksamen Soll" — where the coverage window starts. */
	fensterVon: Date;
	/** `soll + karenz`: when the verdict falls due, and where the window ends. */
	fensterBis: Date;
}

interface Kalendertag {
	jahr: number;
	monat: number;
	tag: number;
	wochentag: number;
	datum: string;
}

function zerlegeUhrzeit(uhrzeit: string): { stunde: number; minute: number } | null {
	const treffer = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(uhrzeit ?? '');
	return treffer ? { stunde: Number(treffer[1]), minute: Number(treffer[2]) } : null;
}

/**
 * The local calendar days a range touches, walked on the proleptic calendar rather than by adding
 * 24 hours to an instant — a DST day is 23 or 25 hours long, and stepping by instants would drift.
 */
function kalendertage(von: Date, bis: Date, zone: string): Kalendertag[] {
	const start = zonenTeile(von, zone);
	const ende = zonenTeile(bis, zone);
	const letzter = Date.UTC(ende.jahr, ende.monat - 1, ende.tag);
	const tage: Kalendertag[] = [];

	for (
		let cursor = Date.UTC(start.jahr, start.monat - 1, start.tag);
		cursor <= letzter;
		cursor += TAG_MS
	) {
		const datum = new Date(cursor);
		const jahr = datum.getUTCFullYear();
		const monat = datum.getUTCMonth() + 1;
		const tag = datum.getUTCDate();
		tage.push({
			jahr,
			monat,
			tag,
			wochentag: isoWochentag(jahr, monat, tag),
			datum: isoDatum({ jahr, monat, tag })
		});
	}

	return tage;
}

/**
 * The effective Soll instants in `(von, bis]`, ascending.
 *
 * „Wirksam" excludes the exception days: their Soll simply does not exist, which is what lets the
 * next Soll's window reach further back (CONTEXT „Ausnahmetag").
 *
 * The caller bounds the range; nothing here caps it.
 */
export function sollZeitpunkte(kontext: PlanKontext, von: Date, bis: Date): Date[] {
	if (bis <= von) return [];

	const uhrzeit = zerlegeUhrzeit(kontext.plan.uhrzeit);
	if (!uhrzeit || kontext.plan.wochentage.length === 0) return [];
	const wochentage = new Set(kontext.plan.wochentage);

	const solls: Date[] = [];

	for (const tag of kalendertage(von, bis, kontext.zone)) {
		if (!wochentage.has(tag.wochentag)) continue;
		if (kontext.ausnahmetage.has(tag.datum)) continue;

		const soll = alsInstant(
			{
				jahr: tag.jahr,
				monat: tag.monat,
				tag: tag.tag,
				stunde: uhrzeit.stunde,
				minute: uhrzeit.minute
			},
			kontext.zone
		);

		if (soll > von && soll <= bis) solls.push(soll);
	}

	return solls;
}

/** The effective Soll immediately before this one, or `null` beyond `RUECKBLICK_TAGE`. */
export function vorherigesSoll(kontext: PlanKontext, soll: Date): Date | null {
	const frueher = sollZeitpunkte(
		kontext,
		new Date(soll.getTime() - RUECKBLICK_TAGE * TAG_MS),
		new Date(soll.getTime() - 1)
	);

	return frueher.length > 0 ? frueher[frueher.length - 1] : null;
}

/**
 * The Solls whose verdict falls due in `(von, bis]` — `von` being the monitor's cursor and `bis`
 * the Bewertungs-Schranke.
 *
 * A Soll is judged `karenz` after it passed, so the enumeration is shifted by the Karenz rather
 * than the comparison.
 *
 * The Anlauf of the Kalenderplan is the `fensterVon < aktiviertAm` test: a window that starts
 * before the activation contains time in which the monitor did not run, and no mail from it counts
 * (CONTEXT „Lernfenster"). Judging it anyway would make a monitor activated at 05:59 alarm at 06:00
 * for a report that arrived — and was ignored — at 23:40 the night before.
 */
export function zuBewertendeSolls(
	kontext: PlanKontext,
	karenzSekunden: number,
	aktiviertAm: Date,
	von: Date,
	bis: Date
): SollBewertung[] {
	const karenzMs = karenzSekunden * 1000;
	const untergrenze = Math.max(von.getTime(), bis.getTime() - RUECKBLICK_TAGE * TAG_MS);

	const solls = sollZeitpunkte(
		kontext,
		new Date(untergrenze - karenzMs),
		new Date(bis.getTime() - karenzMs)
	);

	const bewertungen: SollBewertung[] = [];

	for (const soll of solls) {
		const fensterVon = vorherigesSoll(kontext, soll);
		if (fensterVon === null || fensterVon < aktiviertAm) continue;

		bewertungen.push({ soll, fensterVon, fensterBis: new Date(soll.getTime() + karenzMs) });
	}

	return bewertungen;
}
