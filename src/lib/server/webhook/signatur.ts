import { createHmac } from 'node:crypto';

/**
 * `X-Nightwatch-Signature` (SPEC §7): HMAC-SHA256 over the body, one secret per receiver.
 *
 * **Over the body and nothing else.** Everything a receiver needs in order to judge a call — the
 * event, the `alert_id`, the timestamp of this attempt — is a field of the payload and therefore
 * covered by the signature. Headers are not, which is why none of them carries meaning that would
 * be worth forging (`docs/webhook.md` says so in as many words).
 *
 * The `sha256=` prefix is the widely used convention (GitHub, and every library modelled on it).
 * It costs nothing, names the algorithm at the point of use, and leaves room to tell a second one
 * apart should SPEC ever add one.
 */

export const SIGNATUR_KOPF = 'X-Nightwatch-Signature';

/** The signature exactly as it goes on the wire, including its prefix. */
export function signiere(secret: string, koerper: string): string {
	return `sha256=${createHmac('sha256', secret).update(koerper, 'utf8').digest('hex')}`;
}
