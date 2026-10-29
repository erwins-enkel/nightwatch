/**
 * The two artefacts a mailbox onboarding has to hand the operator (SPEC §3, Research-Doc §2/§3),
 * plus the credential expiry warning.
 *
 * Pure string building, deliberately: these end up in the UI *and* in the docs, and they are the
 * part an operator pastes into someone else's tenant — so they get asserted like code.
 */

/** Where the customer's admin grants consent. Multi-tenant app, one client id, consent per tenant. */
const LOGIN_HOST = 'https://login.microsoftonline.com';

/** Path of the page the consent redirect lands on; must be registered in the app registration. */
export const CONSENT_PFAD = '/einstellungen/postfaecher/consent';

/** SPEC §12: warn *before* the credential dies, not after. */
export const ABLAUF_WARNUNG_TAGE = 30;

export type CredentialZustand = 'ok' | 'bald' | 'abgelaufen' | 'unbekannt';

export interface ConsentEingabe {
	tenantId: string;
	clientId: string;
	/** The instance's public origin (`ORIGIN`), which is where the redirect comes back to. */
	origin: string;
}

/** The exact URI that has to be registered as a redirect URI in the app registration. */
export function consentRedirectUri(origin: string): string {
	return `${origin.replace(/\/+$/, '')}${CONSENT_PFAD}`;
}

/**
 * The admin-consent URL for one customer tenant.
 *
 * `/.default` rather than a named scope: application permissions can only be consented as a whole,
 * which is exactly what the v2 admin consent endpoint documents. `redirect_uri` is required and
 * must match the registration byte for byte — the UI shows it next to the link for that reason.
 */
export function adminConsentUrl({ tenantId, clientId, origin }: ConsentEingabe): string {
	const query = new URLSearchParams({
		client_id: clientId,
		scope: 'https://graph.microsoft.com/.default',
		redirect_uri: consentRedirectUri(origin),
		// Recommended by the protocol and round-tripped by Entra ID. It is *not* trusted on the way
		// back: the docs warn explicitly that anyone can craft this response, so the landing page
		// treats every returned value as display text, never as proof of anything.
		state: tenantId
	});
	return `${LOGIN_HOST}/${encodeURIComponent(tenantId)}/v2.0/adminconsent?${query}`;
}

/**
 * The Exchange Online RBAC snippet that scopes `Mail.Read` down to this one mailbox.
 *
 * Without it the consent grants the app *every* mailbox in the customer tenant, which is both a
 * needless risk and, in practice, the reason a customer admin refuses to consent at all. RBAC for
 * Applications rather than the older Application Access Policy, which Microsoft is replacing.
 *
 * The union caveat is in the snippet on purpose: RBAC grants are additive to Entra grants, so an
 * organisation-wide `Mail.Read` in Entra ID silently defeats the scope below. That is the single
 * most likely way for an operator to think they scoped this when they did not.
 */
export function rbacSnippet({
	clientId,
	adresse,
	tenantId
}: {
	clientId: string;
	adresse: string;
	tenantId: string;
}): string {
	// Exchange object names allow far less than an email address does; keep it conservative and
	// stable so re-running the snippet is idempotent rather than creating a second scope.
	const scopeName = `Nightwatch-${adresse.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

	return `# Nightwatch: Mail.Read auf genau dieses Postfach einschränken (Exchange Online RBAC).
# Voraussetzung: Admin-Consent ist erteilt, die App ist als Enterprise-Anwendung im Tenant sichtbar.
Connect-ExchangeOnline -Organization ${tenantId}

# Objekt-Id des Service Principals der Nightwatch-App in diesem Tenant.
$sp = Get-MgServicePrincipal -Filter "appId eq '${clientId}'"

# Exchange braucht einen eigenen Zeiger auf den Entra-Service-Principal.
New-ServicePrincipal -AppId ${clientId} -ObjectId $sp.Id -DisplayName "Nightwatch"

# Der Geltungsbereich: genau dieses Postfach.
New-ManagementScope -Name "${scopeName}" \`
  -RecipientRestrictionFilter "PrimarySmtpAddress -eq '${adresse}'"

# Die Rolle an den Geltungsbereich binden.
New-ManagementRoleAssignment -App $sp.Id -Role "Application Mail.Read" \`
  -CustomResourceScope "${scopeName}"

# Prüfen (umgeht den Berechtigungs-Cache, der sonst 30 Min bis 2 h nachhängt):
Test-ServicePrincipalAuthorization -Identity $sp.Id -Resource ${adresse}

# ACHTUNG: RBAC-Zuweisungen sind additiv zu Entra-Berechtigungen. Hat dieselbe App in Entra ID
# zusätzlich ein organisationsweites Mail.Read, hebt das diese Einschränkung wieder auf.`;
}

/**
 * How close the stored client secret is to expiring.
 *
 * `unbekannt` is its own state rather than a silent `ok`: the expiry date is typed in by hand at
 * onboarding, so "nobody entered one" and "it is fine" must not look the same in the dashboard.
 */
export function credentialZustand(
	ablaufAm: Date | null | undefined,
	jetzt: Date
): CredentialZustand {
	if (!ablaufAm) return 'unbekannt';
	const restMs = ablaufAm.getTime() - jetzt.getTime();
	if (restMs <= 0) return 'abgelaufen';
	return restMs <= ABLAUF_WARNUNG_TAGE * 86_400_000 ? 'bald' : 'ok';
}
