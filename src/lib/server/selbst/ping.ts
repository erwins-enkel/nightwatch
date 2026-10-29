/**
 * The outgoing Heartbeat-Ping (SPEC §8, CONTEXT „Heartbeat-Ping").
 *
 * Nightwatch's Dead-Man's-Switch principle applied to itself: a healthy instance calls a URL of the
 * operator's choosing on a schedule, and a degraded one **goes quiet**. It is the only mechanism
 * that covers the total outage — host down, network gone, watchdog dead — because no process of a
 * dead instance can report anything at all.
 *
 * Opt-in, and without a receiver the total outage is simply unobserved; the settings page says so
 * rather than pretending otherwise.
 */

/** The seam the schedule is written against, so the tests need no network. */
export interface PingPort {
	sende(url: string): Promise<number>;
}

/**
 * Short on purpose: a ping that has not landed within a few seconds has failed for every practical
 * purpose, and holding the watchdog's tick open longer helps nobody.
 */
const ZEITLIMIT_MS = 10_000;

export function erzeugePingPort(): PingPort {
	return {
		async sende(url): Promise<number> {
			const antwort = await fetch(url, {
				method: 'GET',
				// Not followed, for the same reason as in the webhook client: a redirect is no longer
				// the receiver the operator configured, and a `301` to `http://` would silently
				// downgrade the transport.
				redirect: 'manual',
				signal: AbortSignal.timeout(ZEITLIMIT_MS)
			});

			// The body is read and discarded so the socket returns to the pool instead of waiting out
			// the timeout. Uptime receivers answer with a word or nothing at all.
			await antwort.text().catch(() => '');
			return antwort.status;
		}
	};
}

/**
 * „Feuert nur bei innerer Gesundheit" (CONTEXT), and this is what that means concretely: the
 * database answers, and no self-monitor is disturbed.
 *
 * Deliberately strict. A ping is a statement that everything is fine; sending one while a mailbox
 * has been unreachable for an hour would make the receiver's silence-detection actively misleading
 * — worse than having no ping at all.
 */
export function innereGesundheit(
	dbErreichbar: boolean,
	zustaende: readonly { zustand: 'gesund' | 'gestoert' }[]
): boolean {
	return dbErreichbar && zustaende.every((eintrag) => eintrag.zustand === 'gesund');
}

/**
 * Whether the next ping is due.
 *
 * Measured from the last **successful** one, so a receiver that was briefly unreachable is retried
 * on the next tick rather than after another full interval.
 */
export function pingFaellig(
	zuletztAm: Date | null,
	intervallSekunden: number,
	jetzt: Date
): boolean {
	if (zuletztAm === null) return true;
	return jetzt.getTime() - zuletztAm.getTime() >= intervallSekunden * 1000;
}

/** 2xx is a ping that arrived. Everything else is a receiver that did not take it. */
export function istAngekommen(status: number): boolean {
	return status >= 200 && status < 300;
}
