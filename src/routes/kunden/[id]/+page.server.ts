import { error, fail, redirect } from '@sveltejs/kit';
import { zuordnungsStufe, type ZuordnungsStufe } from '$lib/server/db/schema/enums';
import {
	aktualisiereKunde,
	entferneMerkmal,
	findeKollisionen,
	findeKollisionenJeMerkmal,
	holeKunde,
	legeMerkmalAn,
	listeMerkmale,
	loescheKunde,
	setzeKundeZustand
} from '$lib/server/zuordnung/db';
import { ganzzahlOderNull, text } from '$lib/server/zuordnung/formular';
import { normalisiereWert, pruefeWert } from '$lib/server/zuordnung/merkmal';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const kunde = await holeKunde(params.id);
	if (!kunde) error(404, 'Kunde nicht gefunden');

	const [merkmale, kollisionen] = await Promise.all([
		listeMerkmale(kunde.id),
		findeKollisionenJeMerkmal(kunde.id)
	]);

	return { kunde, merkmale, kollisionen };
};

function istStufe(wert: string): wert is ZuordnungsStufe {
	return (zuordnungsStufe.enumValues as readonly string[]).includes(wert);
}

/** The validation errors map onto message keys; the page turns them into text. */
const FEHLER_SCHLUESSEL = {
	leer: 'pflicht',
	plus_adresse: 'plus_adresse',
	zu_kurz: 'zu_kurz',
	absender: 'absender'
} as const;

/**
 * Keeps every failure the same shape. Without it the actions' return type is a union of object
 * literals and the page cannot index `fehler` by field name (same trick as the mailbox form).
 */
function abgelehnt(fehler: Record<string, string>, stufe = '', wert = '') {
	return { fehler, eingaben: { stufe, wert } };
}

export const actions: Actions = {
	stammdaten: async ({ request, params }) => {
		const daten = await request.formData();
		const name = text(daten, 'name');
		const autotaskCompanyId = ganzzahlOderNull(text(daten, 'autotaskCompanyId'));

		const fehler: Record<string, string> = {};
		if (name === '') fehler.name = 'pflicht';
		if (autotaskCompanyId === undefined) fehler.autotaskCompanyId = 'autotask';
		if (Object.keys(fehler).length > 0) return fail(400, abgelehnt(fehler));

		await aktualisiereKunde(params.id, {
			name,
			kundennummer: text(daten, 'kundennummer') || null,
			notiz: text(daten, 'notiz') || null,
			autotaskCompanyId: autotaskCompanyId ?? null
		});

		return { erfolg: 'gespeichert' as const };
	},

	zustand: async ({ request, params }) => {
		const daten = await request.formData();
		const archivieren = text(daten, 'archivieren') === 'true';

		await setzeKundeZustand(params.id, archivieren ? 'archiviert' : 'aktiv', new Date());
		return { erfolg: 'gespeichert' as const };
	},

	loeschen: async ({ params }) => {
		const ergebnis = await loescheKunde(params.id);
		if (ergebnis === 'historie') return fail(409, abgelehnt({ formular: 'historie' }));
		// A customer that is already gone is not an error worth a message — the list is the truth.
		redirect(303, '/kunden');
	},

	merkmalAnlegen: async ({ request, params }) => {
		const daten = await request.formData();
		const roh = text(daten, 'wert');
		const stufeRoh = text(daten, 'stufe');
		if (!istStufe(stufeRoh)) return fail(400, abgelehnt({ stufe: 'pflicht' }, '', roh));

		const wert = normalisiereWert(stufeRoh, roh);
		const problem = pruefeWert(stufeRoh, wert);
		if (problem) {
			return fail(400, abgelehnt({ wert: FEHLER_SCHLUESSEL[problem] }, stufeRoh, roh));
		}

		const ergebnis = await legeMerkmalAn({ kundeId: params.id, stufe: stufeRoh, wert });
		if (ergebnis === 'doppelt') {
			return fail(400, abgelehnt({ wert: 'doppelt' }, stufeRoh, roh));
		}

		// Saving is allowed on purpose (CONTEXT „Kollisionswarnung": transition phases); the warning
		// only makes the ambiguity visible where it can still be fixed. The query excludes this
		// customer, so running it after the insert reports the same thing and is skipped entirely
		// on the rejected paths above.
		const kollisionen = await findeKollisionen(stufeRoh, wert, params.id);

		return { erfolg: 'merkmal' as const, kollisionen: kollisionen.map((kunde) => kunde.name) };
	},

	merkmalEntfernen: async ({ request, params }) => {
		const daten = await request.formData();
		const id = text(daten, 'id');
		if (id === '') return fail(400, abgelehnt({ formular: 'unbekannt' }));

		await entferneMerkmal(id, params.id);
		return { erfolg: 'gespeichert' as const };
	}
};
