import { ConfidentialClientApplication } from '@azure/msal-node';

/**
 * Access tokens for the client-credentials flow (SPEC §3, Research-Doc §4).
 *
 * There are no refresh tokens in this flow — the whole "token cache" is MSAL's in-memory one, and
 * getting it is a matter of *reusing the same client object* instead of building a new one per
 * poll. That is all this module does: keep one `ConfidentialClientApplication` per credential and
 * ask it for a token, which it serves from cache until shortly before expiry.
 */

/** App-only against Graph: application permissions are only ever granted as a whole. */
const SCOPE = 'https://graph.microsoft.com/.default';

export interface GraphZugangsdaten {
	tenantId: string;
	clientId: string;
	clientSecret: string;
}

/**
 * Keyed by the full credential, not by mailbox: the multi-tenant app model means many mailboxes in
 * one tenant share a client, and they should share its token cache too. Rotating a secret changes
 * the key, so the stale client is simply no longer reached.
 */
const clients = new Map<string, ConfidentialClientApplication>();

function schluessel({ tenantId, clientId, clientSecret }: GraphZugangsdaten): string {
	return `${tenantId}|${clientId}|${clientSecret}`;
}

function client(zugang: GraphZugangsdaten): ConfidentialClientApplication {
	const key = schluessel(zugang);
	let vorhanden = clients.get(key);
	if (!vorhanden) {
		vorhanden = new ConfidentialClientApplication({
			auth: {
				clientId: zugang.clientId,
				authority: `https://login.microsoftonline.com/${zugang.tenantId}`,
				clientSecret: zugang.clientSecret
			}
		});
		clients.set(key, vorhanden);
	}
	return vorhanden;
}

/**
 * Throws on a revoked consent, a deleted registration or an expired secret — all of which arrive
 * as `AADSTS…` messages that `klassifiziereAusnahme` turns into an `zugriff` failure.
 */
export async function holeAccessToken(zugang: GraphZugangsdaten): Promise<string> {
	const ergebnis = await client(zugang).acquireTokenByClientCredential({ scopes: [SCOPE] });
	if (!ergebnis?.accessToken) {
		throw new Error('Microsoft Entra ID lieferte keinen Access-Token zurück');
	}
	return ergebnis.accessToken;
}
