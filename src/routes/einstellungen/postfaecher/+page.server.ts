import { fail, type Actions } from '@sveltejs/kit';
import { verschluessele } from '$lib/server/crypto';
import {
	entfernePostfach,
	legePostfachAn,
	listePostfaecher,
	setzeAktiv
} from '$lib/server/ingestion/db';
import { createLogger, describeError } from '$lib/server/logger';
import {
	adminConsentUrl,
	consentRedirectUri,
	credentialZustand,
	rbacSnippet
} from '$lib/server/onboarding';
import type { PageServerLoad } from './$types';

const log = createLogger('web');

/** SPEC §3: 60–300 s per mailbox. Outside that the throttling maths stops holding. */
const INTERVALL_MIN = 60;
const INTERVALL_MAX = 300;
/** SPEC §11: retention's floor is the learning window, so an unbounded one is not allowed. */
const LERNFENSTER_MIN = 1;
const LERNFENSTER_MAX = 90;

export const load: PageServerLoad = async ({ url }) => {
	const jetzt = new Date();
	const postfaecher = await listePostfaecher();

	return {
		redirectUri: consentRedirectUri(url.origin),
		postfaecher: postfaecher.map((eintrag) => ({
			...eintrag,
			// The secret itself never leaves the server (SPEC §12) — not even masked, since the row
			// only ever needs to say "a credential is stored and it expires then".
			credentialZustand: credentialZustand(eintrag.secretAblaufAm, jetzt),
			consentUrl: adminConsentUrl({
				tenantId: eintrag.tenantId,
				clientId: eintrag.clientId,
				origin: url.origin
			}),
			rbacSnippet: rbacSnippet({
				clientId: eintrag.clientId,
				adresse: eintrag.adresse,
				tenantId: eintrag.tenantId
			})
		}))
	};
};

/**
 * Keeps every failure's `fehler` the same shape. Without it the action's return type is a union of
 * object literals, and the page cannot index it by field name.
 */
function formularFehler(grund: string): Record<string, string> {
	return { formular: grund };
}

function text(daten: FormData, feld: string): string {
	const wert = daten.get(feld);
	return typeof wert === 'string' ? wert.trim() : '';
}

function ganzzahl(daten: FormData, feld: string, ersatz: number): number {
	const roh = text(daten, feld);
	if (roh === '') return ersatz;
	const zahl = Number(roh);
	return Number.isInteger(zahl) ? zahl : Number.NaN;
}

interface Eingaben {
	bezeichnung: string;
	adresse: string;
	tenantId: string;
	clientId: string;
	pollIntervallSekunden: number;
	lernfensterTage: number;
	secretAblaufAm: string;
}

/**
 * Validates the form and reports every problem at once.
 *
 * The values are echoed back on failure — except the secret, which is never sent to a client, so a
 * rejected form asks for it again rather than round-tripping a credential through the browser.
 */
function pruefe(daten: FormData): { fehler: Record<string, string>; eingaben: Eingaben } {
	const fehler: Record<string, string> = {};
	const eingaben: Eingaben = {
		bezeichnung: text(daten, 'bezeichnung'),
		adresse: text(daten, 'adresse').toLowerCase(),
		tenantId: text(daten, 'tenantId'),
		clientId: text(daten, 'clientId'),
		pollIntervallSekunden: ganzzahl(daten, 'pollIntervallSekunden', 120),
		lernfensterTage: ganzzahl(daten, 'lernfensterTage', 30),
		secretAblaufAm: text(daten, 'secretAblaufAm')
	};

	if (eingaben.bezeichnung === '') fehler.bezeichnung = 'pflicht';
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(eingaben.adresse)) fehler.adresse = 'adresse';
	if (eingaben.tenantId === '') fehler.tenantId = 'pflicht';
	if (eingaben.clientId === '') fehler.clientId = 'pflicht';
	if (text(daten, 'clientSecret') === '') fehler.clientSecret = 'pflicht';

	if (
		!Number.isInteger(eingaben.pollIntervallSekunden) ||
		eingaben.pollIntervallSekunden < INTERVALL_MIN ||
		eingaben.pollIntervallSekunden > INTERVALL_MAX
	) {
		fehler.pollIntervallSekunden = 'bereich';
	}

	if (
		!Number.isInteger(eingaben.lernfensterTage) ||
		eingaben.lernfensterTage < LERNFENSTER_MIN ||
		eingaben.lernfensterTage > LERNFENSTER_MAX
	) {
		fehler.lernfensterTage = 'bereich';
	}

	if (eingaben.secretAblaufAm !== '' && Number.isNaN(Date.parse(eingaben.secretAblaufAm))) {
		fehler.secretAblaufAm = 'datum';
	}

	return { fehler, eingaben };
}

export const actions: Actions = {
	anlegen: async ({ request }) => {
		const daten = await request.formData();
		const { fehler, eingaben } = pruefe(daten);
		if (Object.keys(fehler).length > 0) return fail(400, { fehler, eingaben });

		try {
			await legePostfachAn({
				bezeichnung: eingaben.bezeichnung,
				adresse: eingaben.adresse,
				tenantId: eingaben.tenantId,
				clientId: eingaben.clientId,
				clientSecretChiffre: verschluessele(text(daten, 'clientSecret')),
				secretAblaufAm: eingaben.secretAblaufAm === '' ? null : new Date(eingaben.secretAblaufAm),
				pollIntervallSekunden: eingaben.pollIntervallSekunden,
				lernfensterTage: eingaben.lernfensterTage
			});
		} catch (err) {
			// The message may name the mailbox but never the secret, and `describeError` keeps it to
			// name and message — no stack, no bound parameters.
			log.warn('Postfach anlegen fehlgeschlagen', {
				adresse: eingaben.adresse,
				error: describeError(err)
			});
			return fail(400, { fehler: formularFehler('anlegen'), eingaben });
		}

		return { erfolg: 'angelegt' as const };
	},

	umschalten: async ({ request }) => {
		const daten = await request.formData();
		const id = text(daten, 'id');
		if (id === '') return fail(400, { fehler: formularFehler('unbekannt') });

		await setzeAktiv(id, text(daten, 'aktiv') === 'true');
		return { erfolg: 'umgeschaltet' as const };
	},

	entfernen: async ({ request }) => {
		const daten = await request.formData();
		const id = text(daten, 'id');
		if (id === '') return fail(400, { fehler: formularFehler('unbekannt') });

		// SPEC §11: this takes the mailbox's mails and delta state with it; the self-monitor and
		// any ticket correlation survive so an open PSA ticket does not go orphaned.
		await entfernePostfach(id);
		return { erfolg: 'entfernt' as const };
	}
};
