import { describe, expect, it } from 'vitest';
import {
	ABLAUF_WARNUNG_TAGE,
	adminConsentUrl,
	consentRedirectUri,
	credentialZustand,
	rbacSnippet
} from './onboarding';

const tenantId = 'aaaabbbb-0000-cccc-1111-dddd2222eeee';
const clientId = '00001111-aaaa-2222-bbbb-3333cccc4444';

describe('Admin-Consent-Link (SPEC §3)', () => {
	const url = new URL(adminConsentUrl({ tenantId, clientId, origin: 'https://nw.example.test' }));

	it('zeigt auf den v2-Consent-Endpunkt des Kunden-Tenants', () => {
		expect(url.origin).toBe('https://login.microsoftonline.com');
		expect(url.pathname).toBe(`/${tenantId}/v2.0/adminconsent`);
	});

	it('fordert .default an — App-Berechtigungen gehen nur als Ganzes', () => {
		expect(url.searchParams.get('scope')).toBe('https://graph.microsoft.com/.default');
		expect(url.searchParams.get('client_id')).toBe(clientId);
	});

	it('trägt die Redirect-URI, die auch registriert werden muss', () => {
		expect(url.searchParams.get('redirect_uri')).toBe(
			'https://nw.example.test/einstellungen/postfaecher/consent'
		);
	});

	it('schneidet einen abschließenden Schrägstrich der Origin weg', () => {
		// Sonst entstünde `…test//einstellungen/…` und Entra ID lehnt die Redirect-URI ab, weil sie
		// nicht mehr zeichengenau der registrierten entspricht.
		expect(consentRedirectUri('https://nw.example.test/')).toBe(
			'https://nw.example.test/einstellungen/postfaecher/consent'
		);
	});
});

describe('RBAC-PowerShell-Snippet (Research-Doc §3)', () => {
	const snippet = rbacSnippet({ clientId, adresse: 'noc@example.test', tenantId });

	it('bindet die Rolle Application Mail.Read an einen Scope für genau dieses Postfach', () => {
		expect(snippet).toContain('-Role "Application Mail.Read"');
		expect(snippet).toContain(
			`-RecipientRestrictionFilter "PrimarySmtpAddress -eq 'noc@example.test'"`
		);
	});

	it('baut einen Scope-Namen, den Exchange als Objektnamen akzeptiert', () => {
		expect(snippet).toContain('New-ManagementScope -Name "Nightwatch-noc-example-test"');
	});

	it('warnt vor der Union-Semantik gegenüber Entra-Berechtigungen', () => {
		// Der wahrscheinlichste Weg, das Scoping versehentlich wirkungslos zu machen.
		expect(snippet).toContain('additiv');
	});

	it('enthält kein Secret', () => {
		expect(snippet).not.toMatch(/secret/i);
	});
});

describe('Credential-Ablauf-Warnung', () => {
	const jetzt = new Date('2026-07-27T12:00:00Z');
	const inTagen = (tage: number) => new Date(jetzt.getTime() + tage * 86_400_000);

	it.each([
		['unbekannt', null, 'unbekannt'],
		['abgelaufen', inTagen(-1), 'abgelaufen'],
		['gerade abgelaufen', jetzt, 'abgelaufen'],
		['knapp vor der Schwelle', inTagen(ABLAUF_WARNUNG_TAGE - 1), 'bald'],
		['genau auf der Schwelle', inTagen(ABLAUF_WARNUNG_TAGE), 'bald'],
		['weit weg', inTagen(ABLAUF_WARNUNG_TAGE + 1), 'ok']
	])('meldet %s', (_name, ablauf, erwartet) => {
		expect(credentialZustand(ablauf as Date | null, jetzt)).toBe(erwartet);
	});
});
