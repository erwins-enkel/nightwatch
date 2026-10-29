import { error, fail, redirect } from '@sveltejs/kit';
import { entschluesseleZugang, erzeugeAutotaskPort } from '$lib/server/autotask/client';
import { holeCompanyName, sucheCompanies } from '$lib/server/autotask/company';
import { holeKonfig, setzeCompanyId } from '$lib/server/autotask/db';
import { zuordnungsStufe, type ZuordnungsStufe } from '$lib/server/db/schema/enums';
import { createLogger, describeError } from '$lib/server/logger';
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

const log = createLogger('web');

/** The Autotask access, or null when the instance has none — the picker is then simply absent. */
async function autotaskPort() {
	const zugang = entschluesseleZugang(await holeKonfig());
	return zugang ? erzeugeAutotaskPort(zugang) : null;
}

export const load: PageServerLoad = async ({ params }) => {
	const kunde = await holeKunde(params.id);
	if (!kunde) error(404, 'Kunde nicht gefunden');

	const [merkmale, kollisionen, port] = await Promise.all([
		listeMerkmale(kunde.id),
		findeKollisionenJeMerkmal(kunde.id),
		autotaskPort()
	]);

	// CONTEXT „Autotask-Verknüpfung": only the ID is stored, so the name is looked up live. A PSA
	// that is down must not take the customer page with it — the bare ID is still the truth.
	let companyName: string | null = null;
	if (port && kunde.autotaskCompanyId !== null) {
		try {
			companyName = await holeCompanyName(port, kunde.autotaskCompanyId);
		} catch (err: unknown) {
			log.warn('Autotask-Company nicht auflösbar', {
				companyId: kunde.autotaskCompanyId,
				error: describeError(err)
			});
		}
	}

	return { kunde, merkmale, kollisionen, autotaskVerfuegbar: port !== null, companyName };
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
		if (name === '') return fail(400, abgelehnt({ name: 'pflicht' }));

		const kunde = await holeKunde(params.id);
		if (!kunde) return fail(404, abgelehnt({ formular: 'unbekannt' }));

		await aktualisiereKunde(params.id, {
			name,
			kundennummer: text(daten, 'kundennummer') || null,
			notiz: text(daten, 'notiz') || null,
			// The link is not master data any more; it has its own picker below.
			autotaskCompanyId: kunde.autotaskCompanyId
		});

		return { erfolg: 'gespeichert' as const };
	},

	/**
	 * The picker's search (SPEC §7): names are unreliable and not unique, so the operator picks once
	 * and Nightwatch keeps the ID — no name matching at alarm time.
	 */
	autotaskSuchen: async ({ request }) => {
		const begriff = text(await request.formData(), 'suche');
		if (begriff.length < 2) return fail(400, abgelehnt({ suche: 'suche_kurz' }));

		const port = await autotaskPort();
		if (!port) return fail(400, abgelehnt({ suche: 'nicht_konfiguriert' }));

		try {
			return { erfolg: 'gesucht' as const, treffer: await sucheCompanies(port, begriff), begriff };
		} catch (err: unknown) {
			log.warn('Autotask-Suche fehlgeschlagen', { error: describeError(err) });
			return fail(400, abgelehnt({ suche: 'suche' }));
		}
	},

	autotaskVerknuepfen: async ({ request, params }) => {
		const companyId = ganzzahlOderNull(text(await request.formData(), 'companyId'));
		if (companyId === undefined || companyId === null) {
			return fail(400, abgelehnt({ suche: 'autotask' }));
		}

		await setzeCompanyId(params.id, companyId);
		return { erfolg: 'gespeichert' as const };
	},

	autotaskLoesen: async ({ params }) => {
		await setzeCompanyId(params.id, null);
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
