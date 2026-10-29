import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { entschluessele, verschluessele } from '../crypto';
import { createLogger, describeError } from '../logger';

/**
 * The watchdog's local config and dedup cache (SPEC §8, §12).
 *
 * „Lokaler **verschlüsselter** Config- + Dedup-Cache (Datei im Volume) übersteht Postgres-Ausfall."
 * Everything the watchdog needs in order to alarm *about the database* has to live outside the
 * database — the receiver's URL, its HMAC secret, and the record of which self-alarm already went
 * out so a restart does not send it again.
 *
 * Encrypted with the same AES-256-GCM key as every other secret at rest and written `0600`: it
 * carries webhook secrets, and a file in a Docker volume is a great deal easier to read than a
 * Postgres row.
 */

const log = createLogger('selbst');

/** Bumped when the shape changes; an unreadable or older cache is discarded, never migrated. */
const CACHE_VERSION = 1;

/** A webhook receiver, as the emergency path needs it — secret in the clear inside the ciphertext. */
export interface CacheZiel {
	id: string;
	url: string;
	secret: string;
}

/** The core self-monitor's identity and windows, so the emergency alarm looks like any other. */
export interface CacheKern {
	id: string;
	schluessel: string;
	bezeichnung: string;
	stalenessSekunden: number;
	stabilitaetSekunden: number;
}

/**
 * The one disruption that cannot be recorded in `uebergang`, because the table is in the database
 * that is gone. It lives here for its whole life — alarm and all-clear both go out from the cache.
 *
 * Timestamps are ISO strings: this is a serialised file, and a `Date` that survives `JSON.parse` as
 * a string would be a bug waiting to be found at the worst possible moment.
 */
export interface NotfallEpisode {
	alertId: string;
	/** When the database first failed to answer. */
	seitAm: string;
	/** When the alarm went out; null while the outage is still inside its staleness window. */
	alarmiertAm: string | null;
	/** When the database answered again; cleared if it drops out before the all-clear is due. */
	beendetAm: string | null;
}

export interface WatchdogCache {
	version: number;
	geschriebenAm: string;
	basisUrl: string;
	kern: CacheKern | null;
	webhookZiele: CacheZiel[];
	notfall: NotfallEpisode | null;
}

export function leererCache(basisUrl: string): WatchdogCache {
	return {
		version: CACHE_VERSION,
		geschriebenAm: new Date(0).toISOString(),
		basisUrl,
		kern: null,
		webhookZiele: [],
		notfall: null
	};
}

function istCache(wert: unknown): wert is WatchdogCache {
	const cache = wert as Partial<WatchdogCache> | null;
	return (
		typeof cache === 'object' &&
		cache !== null &&
		cache.version === CACHE_VERSION &&
		typeof cache.basisUrl === 'string' &&
		Array.isArray(cache.webhookZiele)
	);
}

/**
 * Reads the cache, or null when there is nothing usable to read.
 *
 * Every failure mode collapses into null on purpose — no file yet, a truncated write, a rotated
 * encryption key, a shape from a future version. The watchdog's job in that moment is to keep
 * running, and a cache it cannot read is indistinguishable from one that was never written.
 */
export async function liesCache(datei: string): Promise<WatchdogCache | null> {
	let roh: string;
	try {
		roh = await readFile(datei, 'utf8');
	} catch {
		return null;
	}

	try {
		const inhalt: unknown = JSON.parse(entschluessele(roh.trim()));
		if (!istCache(inhalt)) {
			log.warn('Watchdog-Cache hat ein unbekanntes Format und wird verworfen', { datei });
			return null;
		}
		return inhalt;
	} catch (err: unknown) {
		log.warn('Watchdog-Cache ist nicht lesbar und wird verworfen', {
			datei,
			error: describeError(err)
		});
		return null;
	}
}

/**
 * Writes the cache atomically: a temporary file in the same directory, then a rename.
 *
 * The rename is what makes it atomic — a watchdog killed mid-write leaves the previous cache whole
 * rather than a half-written one, and half a cache is exactly as useless as none at the moment it
 * is needed. `chmod` follows the write because the `mode` on `writeFile` only applies when the file
 * is created, and the temporary file may well already exist from an interrupted run.
 */
export async function schreibeCache(datei: string, cache: WatchdogCache): Promise<void> {
	const inhalt = verschluessele(
		JSON.stringify({ ...cache, geschriebenAm: new Date().toISOString() })
	);
	const temp = `${datei}.tmp`;

	await mkdir(dirname(datei), { recursive: true });
	try {
		await writeFile(temp, inhalt, { encoding: 'utf8', mode: 0o600 });
		await chmod(temp, 0o600);
		await rename(temp, datei);
	} catch (err: unknown) {
		await unlink(temp).catch(() => {});
		throw err;
	}
}

/**
 * Whether the configuration half changed and is therefore worth a write.
 *
 * The watchdog ticks every few seconds and the configuration changes about never, so comparing
 * keeps the volume from taking a write per tick for the rest of its life. The Notfall half is
 * compared too: it changes rarely, but when it does the write must not be skipped.
 */
export function istUnveraendert(a: WatchdogCache | null, b: WatchdogCache): boolean {
	if (a === null) return false;
	// `geschriebenAm` is stamped at write time and would differ on every comparison, which would make
	// this always report a change and defeat the whole point.
	const ohneZeit = (cache: WatchdogCache) => ({ ...cache, geschriebenAm: '' });
	return JSON.stringify(ohneZeit(a)) === JSON.stringify(ohneZeit(b));
}
