import { Client, ResponseType, RetryHandlerOptions } from '@microsoft/microsoft-graph-client';
import { holeAccessToken, type GraphZugangsdaten } from './token';

/**
 * The only place in Nightwatch that touches the network (SPEC §2: `@microsoft/microsoft-graph-client`
 * plus `@azure/msal-node`). Everything above it talks to `GraphPort`.
 *
 * Two deliberate deviations from the SDK's comfortable path, both for the same reason — this issue
 * requires Nightwatch to *see* `429`/`503` and honour `Retry-After` itself:
 *
 *  - `ResponseType.RAW` hands back the native `Response` for any status without throwing, so the
 *    status code and the `Retry-After` header are readable at all. The SDK's JSON path throws a
 *    `GraphError` that carries neither.
 *  - The SDK's own retry middleware is switched off per request. It would silently retry a `429`
 *    three times inside one call, which both hides the signal and makes the *persisted* backoff
 *    (`postfach.naechster_poll_fruehestens_am`) a lie.
 */

export interface GraphAntwort {
	status: number;
	/** Parsed JSON, or `undefined` when the body was empty or not JSON at all. */
	body?: unknown;
	retryAfter: string | null;
}

/** The seam the poller is written against; the fake in the tests implements exactly this. */
export interface GraphPort {
	holeSeite(url: string): Promise<GraphAntwort>;
}

/**
 * Sent on every request of a round. Unlike the query options, `Prefer` is not encoded into the
 * delta link, so it has to be repeated — and `outlook.body-content-type` is what makes Graph do
 * the HTML→text reduction server-side, which is far better than anything we could do locally.
 */
export const DELTA_PREFER = 'odata.maxpagesize=50, outlook.body-content-type="text"';

/** Disables the SDK's retry middleware for a single request. */
const OHNE_SDK_RETRY = new RetryHandlerOptions(0, 0);

function graphClient(token: string): Client {
	return Client.initWithMiddleware({
		defaultVersion: 'v1.0',
		authProvider: { getAccessToken: () => Promise.resolve(token) }
	});
}

/**
 * A Graph port bound to one mailbox's credentials.
 *
 * The token is asked for once per page rather than once per round. MSAL answers from its in-memory
 * cache until shortly before expiry, so this is nearly free — and it means a round that pages for
 * minutes can never run into a token that expired halfway through.
 */
export function erzeugeGraphPort(zugang: GraphZugangsdaten): GraphPort {
	return {
		async holeSeite(url: string): Promise<GraphAntwort> {
			const client = graphClient(await holeAccessToken(zugang));
			const antwort: Response = await client
				.api(url)
				.middlewareOptions([OHNE_SDK_RETRY])
				.header('Prefer', DELTA_PREFER)
				.responseType(ResponseType.RAW)
				.get();

			return {
				status: antwort.status,
				body: await leseJson(antwort),
				retryAfter: antwort.headers.get('retry-after')
			};
		}
	};
}

/** A throttling response may well be HTML from a proxy; that must not crash the poll loop. */
async function leseJson(antwort: Response): Promise<unknown> {
	try {
		const text = await antwort.text();
		return text.trim() === '' ? undefined : JSON.parse(text);
	} catch {
		return undefined;
	}
}
