/**
 * Turning a failed Graph call into a decision (SPEC §3, Research-Doc §6).
 *
 * The poll loop must not care about HTTP trivia, it must know one of five things: wait as told,
 * throw the delta state away, tell the operator their access is gone, tell them the mailbox is
 * gone, or simply try again later. Everything that reads a status code lives here, and it is pure
 * so every branch is testable without a network.
 */

/**
 * `zugriff` and `nicht_gefunden` are the two that a human has to fix — they are what SPEC §8 calls
 * "harte Ursachen", which later (#30) produce a better ticket text than mere staleness.
 */
export type FehlerKlasse = 'throttling' | 'resync' | 'zugriff' | 'nicht_gefunden' | 'transient';

export interface GraphFehler {
	klasse: FehlerKlasse;
	/** Short, stable, safe to persist and to show: `429`, `resyncRequired`, `AADSTS7000215`. */
	code: string;
	/** One line for the operator. Never carries a secret — see `beschreibeFehler`. */
	text: string;
	/** Only set when the service told us how long to wait; it always wins over our own backoff. */
	retryAfterMs?: number;
}

/** The shape of the Graph error envelope, as far as we rely on it. */
interface GraphFehlerBody {
	error?: { code?: unknown; message?: unknown };
}

/**
 * Graph answers a stale delta token with `410 Gone` / `resyncRequired`, but the same condition also
 * shows up as `400` with `SyncStateNotFound` on some resources — both mean the same thing to us.
 */
const RESYNC_CODES = new Set(['resyncrequired', 'syncstatenotfound']);

const ZUGRIFF_CODES = new Set([
	'erroraccessdenied',
	'accessdenied',
	'authenticationerror',
	'invalidauthenticationtoken',
	'unauthenticated'
]);

const NICHT_GEFUNDEN_CODES = new Set([
	'errorinvaliduser',
	'mailboxnotenabledforrestapi',
	'resourcenotfound',
	'errormailboxnotfound',
	'request_resourcenotfound'
]);

function textAus(body: unknown): string | undefined {
	const message = (body as GraphFehlerBody | null | undefined)?.error?.message;
	return typeof message === 'string' && message.trim() !== '' ? message.trim() : undefined;
}

function codeAus(body: unknown): string | undefined {
	const code = (body as GraphFehlerBody | null | undefined)?.error?.code;
	return typeof code === 'string' && code.trim() !== '' ? code.trim() : undefined;
}

/**
 * `Retry-After` is "delay-seconds OR HTTP-date" per RFC 9110, and Graph uses both in the wild.
 * Anything unparsable yields `undefined` so the caller falls back to its own backoff curve rather
 * than waiting zero milliseconds and hammering a throttled endpoint.
 */
export function retryAfterMs(
	kopfzeile: string | null | undefined,
	jetzt: Date
): number | undefined {
	if (!kopfzeile) return undefined;
	const roh = kopfzeile.trim();
	if (roh === '') return undefined;

	if (/^\d+$/.test(roh)) return Number(roh) * 1000;

	const zeitpunkt = Date.parse(roh);
	if (Number.isNaN(zeitpunkt)) return undefined;
	// A date in the past means "you may retry now", not "wait a negative amount".
	return Math.max(0, zeitpunkt - jetzt.getTime());
}

export interface KlassifiziereEingabe {
	status: number;
	body?: unknown;
	retryAfter?: string | null;
	jetzt: Date;
}

/** Classifies a non-2xx Graph response. */
export function klassifiziereFehler(eingabe: KlassifiziereEingabe): GraphFehler {
	const { status, body, jetzt } = eingabe;
	const graphCode = codeAus(body);
	const normalisiert = graphCode?.toLowerCase();
	const text = textAus(body) ?? `Graph antwortete mit HTTP ${status}`;
	const warte = retryAfterMs(eingabe.retryAfter, jetzt);

	// The delta state check comes first: Graph sends `410` for it, but `400 SyncStateNotFound`
	// would otherwise be mistaken for a permanent client error and never resync.
	if (status === 410 || (normalisiert && RESYNC_CODES.has(normalisiert))) {
		return { klasse: 'resync', code: graphCode ?? String(status), text };
	}

	if (status === 429 || status === 503) {
		return { klasse: 'throttling', code: String(status), text, retryAfterMs: warte };
	}

	if (status === 401 || status === 403) {
		return { klasse: 'zugriff', code: graphCode ?? String(status), text };
	}

	if (status === 404) {
		return { klasse: 'nicht_gefunden', code: graphCode ?? '404', text };
	}

	if (normalisiert && ZUGRIFF_CODES.has(normalisiert)) {
		return { klasse: 'zugriff', code: graphCode as string, text };
	}

	if (normalisiert && NICHT_GEFUNDEN_CODES.has(normalisiert)) {
		return { klasse: 'nicht_gefunden', code: graphCode as string, text };
	}

	return { klasse: 'transient', code: graphCode ?? String(status), text, retryAfterMs: warte };
}

/**
 * Classifies a thrown error — a failed token request or a dead socket, i.e. everything that never
 * produced an HTTP response.
 *
 * MSAL reports a revoked consent, a deleted app registration and an expired secret all as
 * `AADSTS…` codes (Research-Doc §6). Those are `zugriff`: waiting does not help, a human has to
 * act. Anything else is assumed transient — a network blip must not look like a permission
 * problem, or the operator chases the wrong cause.
 */
export function klassifiziereAusnahme(fehler: unknown): GraphFehler {
	const text = fehler instanceof Error ? fehler.message : String(fehler);
	const aadsts = /\b(AADSTS\d{4,7})\b/.exec(text);

	if (aadsts) {
		return { klasse: 'zugriff', code: aadsts[1], text: beschreibeFehler(text) };
	}

	const name = fehler instanceof Error ? fehler.name : 'Fehler';
	return { klasse: 'transient', code: name, text: beschreibeFehler(text) };
}

/**
 * Trims an error message to its first line and a sane length before it is persisted or shown.
 *
 * MSAL error messages are multi-paragraph and end with trace and correlation IDs; the first line
 * is the diagnosis, the rest is noise in a dashboard column.
 */
export function beschreibeFehler(text: string): string {
	const ersteZeile = text.split(/[\r\n]/, 1)[0].trim();
	return ersteZeile.length > 300 ? `${ersteZeile.slice(0, 299)}…` : ersteZeile;
}
