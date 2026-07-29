import { fail, type Actions } from '@sveltejs/kit';
import { verschluessele } from '$lib/server/crypto';
import { createLogger, describeError } from '$lib/server/logger';
import {
	aktualisiereZiel,
	entferneZiel,
	legeZielAn,
	listeZiele,
	setzeAktiv,
	type ZielEingabe
} from '$lib/server/webhook/db';
import { text } from '$lib/server/zuordnung/formular';
import type { PageServerLoad } from './$types';

const log = createLogger('web');

/**
 * The webhook receivers (SPEC §7, §9): several targets, one secret each, HTTPS only.
 *
 * The validation below mirrors the `webhook_ziel_transport` CHECK rather than replacing it. The
 * database is what actually guarantees the transport rule; this form exists so the operator gets a
 * sentence instead of a constraint violation.
 */

export const load: PageServerLoad = async () => ({ ziele: await listeZiele() });

interface Eingaben {
	bezeichnung: string;
	url: string;
	httpErlaubt: boolean;
}

/** Keeps every failure's `fehler` the same shape, like the other settings forms. */
function abgelehnt(fehler: Record<string, string>, eingaben?: Eingaben) {
	return {
		fehler,
		eingaben: eingaben ?? { bezeichnung: '', url: '', httpErlaubt: false }
	};
}

function alsUrl(roh: string): URL | null {
	try {
		return new URL(roh);
	} catch {
		return null;
	}
}

/**
 * Validates the form and reports every problem at once.
 *
 * The secret is echoed back on failure by nobody: it is never sent to a client (SPEC §12), so a
 * rejected form asks for it again rather than round-tripping a credential through the browser.
 * `neu` says whether a secret is mandatory — on edit, an empty field means "keep the stored one".
 *
 * The URL is stored **normalised** (`href`), not as typed. `webhook_ziel_transport` compares with
 * `LIKE`, which is case sensitive, so a `HTTPS://…` would pass this check and then be refused by
 * the database — a rejection the operator could not make sense of.
 */
function pruefe(
	daten: FormData,
	neu: boolean
): { fehler: Record<string, string>; eingaben: Eingaben } {
	const fehler: Record<string, string> = {};
	const url = alsUrl(text(daten, 'url'));
	const eingaben: Eingaben = {
		bezeichnung: text(daten, 'bezeichnung'),
		url: url?.href ?? text(daten, 'url'),
		httpErlaubt: text(daten, 'httpErlaubt') === 'true'
	};

	if (eingaben.bezeichnung === '') fehler.bezeichnung = 'pflicht';
	if (neu && text(daten, 'secret') === '') fehler.secret = 'pflicht';

	// The opt-in grants HTTP, and only HTTP — every other scheme is refused whether it is set or
	// not, exactly like the `webhook_ziel_transport` CHECK behind this form.
	if (url === null) fehler.url = 'url';
	else if (url.protocol !== 'https:' && url.protocol !== 'http:') fehler.url = 'schema';
	else if (url.protocol === 'http:' && !eingaben.httpErlaubt) fehler.url = 'https';

	return { fehler, eingaben };
}

function alsZiel(daten: FormData, eingaben: Eingaben): ZielEingabe {
	const secret = text(daten, 'secret');
	return {
		bezeichnung: eingaben.bezeichnung,
		url: eingaben.url,
		httpErlaubt: eingaben.httpErlaubt,
		secretChiffre: secret === '' ? null : verschluessele(secret)
	};
}

export const actions: Actions = {
	anlegen: async ({ request }) => {
		const daten = await request.formData();
		const { fehler, eingaben } = pruefe(daten, true);
		if (Object.keys(fehler).length > 0) return fail(400, abgelehnt(fehler, eingaben));

		try {
			await legeZielAn(alsZiel(daten, eingaben));
		} catch (err: unknown) {
			// The message may name the receiver but never the secret, and `describeError` keeps it to
			// name and message — no stack, no bound parameters.
			log.warn('Webhook-Ziel anlegen fehlgeschlagen', { error: describeError(err) });
			return fail(400, abgelehnt({ formular: 'anlegen' }, eingaben));
		}

		return { erfolg: 'gespeichert' as const };
	},

	bearbeiten: async ({ request }) => {
		const daten = await request.formData();
		const id = text(daten, 'id');
		if (id === '') return fail(400, abgelehnt({ formular: 'unbekannt' }));

		const { fehler, eingaben } = pruefe(daten, false);
		if (Object.keys(fehler).length > 0) {
			return fail(400, { ...abgelehnt(fehler, eingaben), bearbeitet: id });
		}

		try {
			await aktualisiereZiel(id, alsZiel(daten, eingaben));
		} catch (err: unknown) {
			log.warn('Webhook-Ziel speichern fehlgeschlagen', { error: describeError(err) });
			return fail(400, { ...abgelehnt({ formular: 'anlegen' }, eingaben), bearbeitet: id });
		}

		return { erfolg: 'gespeichert' as const };
	},

	umschalten: async ({ request }) => {
		const daten = await request.formData();
		const id = text(daten, 'id');
		if (id === '') return fail(400, abgelehnt({ formular: 'unbekannt' }));

		await setzeAktiv(id, text(daten, 'aktiv') === 'true');
		return { erfolg: 'umgeschaltet' as const };
	},

	entfernen: async ({ request }) => {
		const daten = await request.formData();
		const id = text(daten, 'id');
		if (id === '') return fail(400, abgelehnt({ formular: 'unbekannt' }));

		try {
			await entferneZiel(id);
		} catch (err: unknown) {
			// The foreign key refuses while deliveries still point at this receiver — that record is
			// the evidence a dead letter happened (SPEC §8). Switching it off keeps both.
			log.info('Webhook-Ziel nicht löschbar', { error: describeError(err) });
			return fail(400, abgelehnt({ formular: 'in_benutzung' }));
		}

		return { erfolg: 'entfernt' as const };
	}
};
