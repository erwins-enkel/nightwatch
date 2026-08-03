import type { GraphFehler } from '../graph/fehler';

/**
 * How long a mailbox waits after a failed poll (SPEC §3).
 *
 * Pure, with the randomness injected, so the curve is asserted rather than hoped for.
 */

/** Never wait longer than this on our own account — a fixed permission comes back within 15 min. */
export const MAX_BACKOFF_MS = 900_000;

/**
 * `Retry-After` is obeyed, but not blindly: a service that asks for a day would take a mailbox out
 * of monitoring for a day, and nobody would see why.
 */
export const MAX_RETRY_AFTER_MS = 3_600_000;

/** ±20 %, so a hundred mailboxes that were throttled together do not return in lockstep. */
const JITTER = 0.2;

export interface BackoffEingabe {
	fehler: GraphFehler;
	/** Consecutive failures *including* this one, i.e. 1 on the first. */
	fehlerInFolge: number;
	/** The mailbox's normal poll interval — the base of the curve. */
	intervallSekunden: number;
	/** Injected for tests; expected to return [0, 1). */
	zufall?: () => number;
}

/**
 * Exponential backoff with jitter, overridden by `Retry-After` when the service sent one.
 *
 * The cap matters more than the curve: it is what guarantees that once an operator fixes a consent
 * or renews a secret, ingestion resumes within a quarter of an hour without anyone restarting a
 * container.
 */
export function backoffMs(eingabe: BackoffEingabe): number {
	const { fehler, fehlerInFolge, intervallSekunden } = eingabe;
	const zufall = eingabe.zufall ?? Math.random;

	// The service knows better than our curve does — but it is still capped, and it is not
	// jittered: Graph told us a time, spreading it around would only reintroduce the collision.
	if (fehler.retryAfterMs !== undefined) {
		return Math.min(fehler.retryAfterMs, MAX_RETRY_AFTER_MS);
	}

	const versuche = Math.max(1, fehlerInFolge);
	const basis = Math.max(1, intervallSekunden) * 1000;
	// Cap the exponent before the multiplication so a long-broken mailbox cannot overflow into
	// Infinity — `Math.min` of Infinity would still work, but the intermediate is nonsense.
	const potenz = 2 ** Math.min(versuche - 1, 20);
	const roh = Math.min(basis * potenz, MAX_BACKOFF_MS);

	const streuung = 1 + (zufall() * 2 - 1) * JITTER;
	return Math.round(roh * streuung);
}
