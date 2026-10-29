/**
 * The only place in the webhook channel that touches the network. Everything above it talks to
 * `WebhookPort`, which the tests implement with a fake.
 */

export interface WebhookAntwort {
	status: number;
	/** The first line of the response body, for the operator's diagnosis. Empty when there is none. */
	text: string;
}

/** The seam the delivery flow is written against. */
export interface WebhookPort {
	sende(url: string, koerper: string, kopfzeilen: Record<string, string>): Promise<WebhookAntwort>;
}

/**
 * A receiver may not outlive its queue slot by much. Ten seconds is generous for a webhook and
 * short enough that a hanging endpoint becomes a retry rather than a blocked worker.
 */
const ZEITLIMIT_MS = 10_000;

/** Enough to recognise an error page, little enough to keep out of the database. */
const TEXT_GRENZE = 300;

/** Trims a response to one line and a sane length before it is persisted or shown. */
export function beschreibeAntwort(text: string): string {
	const ersteZeile = text.split(/[\r\n]/, 1)[0].trim();
	return ersteZeile.length > TEXT_GRENZE ? `${ersteZeile.slice(0, TEXT_GRENZE - 1)}…` : ersteZeile;
}

export function erzeugeWebhookPort(): WebhookPort {
	return {
		async sende(url, koerper, kopfzeilen): Promise<WebhookAntwort> {
			const antwort = await fetch(url, {
				method: 'POST',
				headers: kopfzeilen,
				body: koerper,
				/**
				 * Redirects are **not** followed. A `301` to `http://` would be a silent downgrade of
				 * exactly the transport guarantee the target's opt-in is supposed to control, and a
				 * redirect to another host is no longer the receiver the operator configured. Node
				 * hands the 3xx back as an ordinary response, so it fails like any other non-2xx.
				 */
				redirect: 'manual',
				signal: AbortSignal.timeout(ZEITLIMIT_MS)
			});

			// A body is read even on success: it is discarded, but leaving it unread keeps the socket
			// out of the connection pool until the timeout.
			const text = await antwort.text().catch(() => '');
			return { status: antwort.status, text: beschreibeAntwort(text) };
		}
	};
}
