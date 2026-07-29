/**
 * The only place in the Autotask channel that touches the network (SPEC §7, Research-Doc §1).
 * Everything above it talks to `AutotaskPort`, which the tests implement with a fake.
 *
 * Autotask REST authenticates with three static headers — no OAuth, no token refresh, no SDK. The
 * whole client is therefore one `fetch` plus a base URL, and the interesting decisions
 * (classification, retry, de-dupe) live in modules that need no network at all.
 */
import { entschluessele } from '../crypto';

/** A response, whatever its status — 4xx and 5xx are values here, not exceptions. */
export interface AutotaskAntwort {
	status: number;
	/** Parsed JSON, or `undefined` when the body was empty or not JSON at all. */
	body?: unknown;
}

export type AutotaskMethode = 'GET' | 'POST' | 'PATCH';

/** The seam the ticket flow is written against. */
export interface AutotaskPort {
	/** `pfad` is relative to the zone base, e.g. `V1.0/Tickets`. */
	anfrage(methode: AutotaskMethode, pfad: string, koerper?: unknown): Promise<AutotaskAntwort>;
}

export interface AutotaskZugang {
	/** The zone-specific base URL from `zoneInformation`, e.g. `https://webservices3.…/atservicesrest/`. */
	zoneUrl: string;
	benutzer: string;
	secret: string;
	integrationCode: string;
}

/**
 * The API version segment. Autotask versions its REST API in the path, and every entity call goes
 * through here — so the one place to change on a future `V2.0` is this constant.
 */
export const API_VERSION = 'V1.0';

/**
 * Zone lookup is the one call that is not zone-specific: it lives on a fixed host, needs no
 * authentication and is not thread-limited (Research-Doc §1).
 */
const ZONE_BASIS = 'https://webservices.autotask.net/atservicesrest/';

/**
 * A request may not outlive its queue slot. The Autotask channel processes one job at a time
 * (`autotask/worker.ts`), so a socket that never answers would otherwise hold up every other
 * customer's ticket — and pg-boss' own `expireInSeconds` would only notice minutes later.
 */
const ZEITLIMIT_MS = 30_000;

function verbinde(basis: string, pfad: string): string {
	return `${basis.replace(/\/+$/, '')}/${pfad.replace(/^\/+/, '')}`;
}

/** A throttling or gateway response may well be HTML from a proxy; that must not throw here. */
async function leseJson(antwort: Response): Promise<unknown> {
	try {
		const text = await antwort.text();
		return text.trim() === '' ? undefined : JSON.parse(text);
	} catch {
		return undefined;
	}
}

export function erzeugeAutotaskPort(zugang: AutotaskZugang): AutotaskPort {
	return {
		async anfrage(methode, pfad, koerper): Promise<AutotaskAntwort> {
			const antwort = await fetch(verbinde(zugang.zoneUrl, `${API_VERSION}/${pfad}`), {
				method: methode,
				headers: {
					Username: zugang.benutzer,
					Secret: zugang.secret,
					APIIntegrationcode: zugang.integrationCode,
					'Content-Type': 'application/json',
					Accept: 'application/json'
				},
				body: koerper === undefined ? undefined : JSON.stringify(koerper),
				signal: AbortSignal.timeout(ZEITLIMIT_MS)
			});

			return { status: antwort.status, body: await leseJson(antwort) };
		}
	};
}

/**
 * Resolves the tenant's zone — the first call of every Autotask integration (Research-Doc §1).
 *
 * The result is persisted in `einstellungen.autotask_zone_url` and never looked up again: the
 * subdomain is a property of the customer's database, not of the moment.
 */
export async function holeZoneUrl(benutzer: string): Promise<string> {
	const url = `${verbinde(ZONE_BASIS, `${API_VERSION}/zoneInformation`)}?user=${encodeURIComponent(benutzer)}`;
	const antwort = await fetch(url, {
		headers: { Accept: 'application/json' },
		signal: AbortSignal.timeout(ZEITLIMIT_MS)
	});

	const body = (await leseJson(antwort)) as { url?: unknown } | undefined;
	if (antwort.status !== 200 || typeof body?.url !== 'string' || body.url.trim() === '') {
		throw new Error(`zoneInformation antwortete mit HTTP ${antwort.status}`);
	}
	return body.url.trim();
}

/**
 * The stored credentials, decrypted (SPEC §12) — the shape `erzeugeAutotaskPort` wants.
 *
 * Kept here rather than in `db.ts` so that the decision "what does a usable Autotask access
 * consist of?" sits next to the client that consumes it.
 */
export interface AutotaskChiffren {
	zoneUrl: string | null;
	benutzer: string | null;
	secretChiffre: string | null;
	integrationCodeChiffre: string | null;
}

/** Null when anything is missing — an incompletely configured instance simply has no access. */
export function entschluesseleZugang(chiffren: AutotaskChiffren): AutotaskZugang | null {
	const { zoneUrl, benutzer, secretChiffre, integrationCodeChiffre } = chiffren;
	if (!zoneUrl || !benutzer || !secretChiffre || !integrationCodeChiffre) return null;

	return {
		zoneUrl,
		benutzer,
		secret: entschluessele(secretChiffre),
		integrationCode: entschluessele(integrationCodeChiffre)
	};
}
