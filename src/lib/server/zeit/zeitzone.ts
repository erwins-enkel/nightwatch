/**
 * Wall-clock arithmetic for one IANA time zone, built on `Intl` alone.
 *
 * A Kalenderplan says „Mo–Fr bis 06:00" in `einstellungen.zeitzone` (CONTEXT „Kalenderplan"), and
 * 06:00 stays 06:00 across a daylight-saving change — so the scheduler cannot do its arithmetic in
 * UTC and cannot use the server's local zone either. `Intl.DateTimeFormat` knows the tz database
 * that ships with the runtime, which is the whole reason no library is needed here.
 *
 * The two directions are not symmetric: an instant has exactly one wall clock, but a wall clock has
 * zero or two instants on the days a zone shifts. Both edges are decided explicitly below rather
 * than left to whichever answer the arithmetic happens to produce.
 */

/** A local calendar time, without a zone. `monat` is 1–12, unlike `Date`'s 0-based month. */
export interface WandZeit {
	jahr: number;
	monat: number;
	tag: number;
	stunde: number;
	minute: number;
	sekunde?: number;
}

export interface ZonenTeile extends Required<WandZeit> {
	/** ISO-8601: 1 = Monday … 7 = Sunday, the same counting as `Kalenderplan.wochentage`. */
	wochentag: number;
	/** `YYYY-MM-DD`, directly comparable with `ausnahmetag.datum`. */
	datum: string;
}

export const TAG_MS = 86_400_000;

/**
 * How far to either side a probe looks for the other side of a transition.
 *
 * Twelve hours: a shift is at most an hour or two and happens at one instant, so probing half a day
 * out from a guess inside the transition day reliably lands on both offsets.
 */
const SONDIER_MS = 12 * 3_600_000;

/**
 * Cached per zone — constructing an `Intl.DateTimeFormat` is expensive, and the instance formats one
 * zone for its whole lifetime.
 */
const formatierer = new Map<string, Intl.DateTimeFormat>();

function fuerZone(zone: string): Intl.DateTimeFormat {
	const vorhanden = formatierer.get(zone);
	if (vorhanden) return vorhanden;

	const neu = new Intl.DateTimeFormat('en-US', {
		timeZone: zone,
		// `hourCycle` rather than `hour12: false`, which reports midnight as hour 24 in some engines.
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	});
	formatierer.set(zone, neu);
	return neu;
}

function zweistellig(wert: number): string {
	return wert < 10 ? `0${wert}` : String(wert);
}

/** `YYYY-MM-DD` for a local calendar date. */
export function isoDatum(teile: Pick<WandZeit, 'jahr' | 'monat' | 'tag'>): string {
	return `${teile.jahr}-${zweistellig(teile.monat)}-${zweistellig(teile.tag)}`;
}

/** ISO-8601 weekday of a calendar date, computed on the proleptic calendar rather than a zone. */
export function isoWochentag(jahr: number, monat: number, tag: number): number {
	const wochentag = new Date(Date.UTC(jahr, monat - 1, tag)).getUTCDay();
	// `getUTCDay` counts Sunday as 0; ISO counts it as 7.
	return wochentag === 0 ? 7 : wochentag;
}

/** The wall clock a zone shows at this instant. */
export function zonenTeile(zeitpunkt: Date, zone: string): ZonenTeile {
	const roh: Record<string, number> = {};
	for (const { type, value } of fuerZone(zone).formatToParts(zeitpunkt)) {
		if (type !== 'literal') roh[type] = Number(value);
	}

	const jahr = roh.year;
	const monat = roh.month;
	const tag = roh.day;

	return {
		jahr,
		monat,
		tag,
		stunde: roh.hour,
		minute: roh.minute,
		sekunde: roh.second,
		wochentag: isoWochentag(jahr, monat, tag),
		datum: isoDatum({ jahr, monat, tag })
	};
}

/** `YYYY-MM-DD` of the day a zone is on at this instant. */
export function zonenDatum(zeitpunkt: Date, zone: string): string {
	return zonenTeile(zeitpunkt, zone).datum;
}

/**
 * The zone's offset at this instant, in milliseconds.
 *
 * Expressed as „wall clock read as if it were UTC, minus the instant" — which is exactly the amount
 * `alsInstant` has to subtract again to get back.
 */
function versatzMs(zeitpunkt: Date, zone: string): number {
	const teile = zonenTeile(zeitpunkt, zone);
	const alsUtc = Date.UTC(
		teile.jahr,
		teile.monat - 1,
		teile.tag,
		teile.stunde,
		teile.minute,
		teile.sekunde
	);
	// The formatter has no millisecond field, so compare against the truncated instant.
	return alsUtc - (zeitpunkt.getTime() - zeitpunkt.getUTCMilliseconds());
}

/** Whether a candidate instant really shows the requested wall clock. */
function trifft(kandidat: number, ziel: number, zone: string): boolean {
	return kandidat + versatzMs(new Date(kandidat), zone) === ziel;
}

/**
 * The first instant carrying the later offset, to the millisecond.
 *
 * Only reached for a wall clock inside a spring-forward gap, so the binary search runs at most a few
 * dozen times a year per plan.
 */
function sprungZeitpunkt(frueh: number, spaet: number, zone: string): number {
	const versatzFrueh = versatzMs(new Date(frueh), zone);
	let lo = frueh;
	let hi = spaet;

	while (hi - lo > 1) {
		const mitte = lo + Math.floor((hi - lo) / 2);
		if (versatzMs(new Date(mitte), zone) === versatzFrueh) lo = mitte;
		else hi = mitte;
	}

	return hi;
}

/**
 * The instant at which a zone shows this wall clock.
 *
 * The two days a year where that is not a function get a decided answer:
 *
 * - **Doubled** (autumn, the hour runs twice): the **earlier** occurrence wins. A Soll must not
 *   silently drift an hour later, and the Karenz absorbs the second pass anyway.
 * - **Missing** (spring, the hour is skipped): the Soll is pulled to the **transition instant**, so
 *   it still happens on that day. Dropping it would widen the next Soll's coverage window by a full
 *   period — an outage of exactly one night would go unnoticed once a year.
 */
export function alsInstant(wand: WandZeit, zone: string): Date {
	const ziel = Date.UTC(
		wand.jahr,
		wand.monat - 1,
		wand.tag,
		wand.stunde,
		wand.minute,
		wand.sekunde ?? 0
	);

	const kandidaten = [
		...new Set([
			ziel - versatzMs(new Date(ziel - SONDIER_MS), zone),
			ziel - versatzMs(new Date(ziel + SONDIER_MS), zone)
		])
	].sort((a, b) => a - b);

	const gueltig = kandidaten.filter((kandidat) => trifft(kandidat, ziel, zone));
	if (gueltig.length > 0) return new Date(gueltig[0]);

	return new Date(sprungZeitpunkt(kandidaten[0], kandidaten[kandidaten.length - 1], zone));
}

/**
 * Midnight of a `YYYY-MM-DD` date in this zone.
 *
 * A few zones have shifted at midnight, so this goes through `alsInstant` rather than assuming the
 * day starts at 00:00 — where it does not, the day starts at the transition.
 */
export function tagesBeginn(datum: string, zone: string): Date {
	const [jahr, monat, tag] = datum.split('-').map(Number);
	return alsInstant({ jahr, monat, tag, stunde: 0, minute: 0, sekunde: 0 }, zone);
}

/**
 * The end of a `YYYY-MM-DD` date in this zone, i.e. the start of the following day.
 *
 * CONTEXT „Anlauf" measures the counter's grace period „seit dem Ende eines Ausnahmetags"; this is
 * that end.
 */
export function tagesEnde(datum: string, zone: string): Date {
	const [jahr, monat, tag] = datum.split('-').map(Number);
	const naechster = new Date(Date.UTC(jahr, monat - 1, tag) + TAG_MS);
	return tagesBeginn(
		isoDatum({
			jahr: naechster.getUTCFullYear(),
			monat: naechster.getUTCMonth() + 1,
			tag: naechster.getUTCDate()
		}),
		zone
	);
}
