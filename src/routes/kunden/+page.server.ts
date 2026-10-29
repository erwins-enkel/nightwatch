import { fail, redirect } from '@sveltejs/kit';
import { legeKundeAn, listeKunden } from '$lib/server/zuordnung/db';
import { ganzzahlOderNull, text } from '$lib/server/zuordnung/formular';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => ({ kunden: await listeKunden() });

export const actions: Actions = {
	anlegen: async ({ request }) => {
		const daten = await request.formData();
		const eingaben = {
			name: text(daten, 'name'),
			kundennummer: text(daten, 'kundennummer'),
			notiz: text(daten, 'notiz'),
			autotaskCompanyId: text(daten, 'autotaskCompanyId')
		};

		const fehler: Record<string, string> = {};
		if (eingaben.name === '') fehler.name = 'pflicht';

		const autotaskCompanyId = ganzzahlOderNull(eingaben.autotaskCompanyId);
		if (autotaskCompanyId === undefined) fehler.autotaskCompanyId = 'autotask';

		if (Object.keys(fehler).length > 0) return fail(400, { fehler, eingaben });

		const id = await legeKundeAn({
			name: eingaben.name,
			kundennummer: eingaben.kundennummer || null,
			notiz: eingaben.notiz || null,
			autotaskCompanyId: autotaskCompanyId ?? null
		});

		// Straight on to the traits: a customer without one cannot be assigned any mail, so the
		// list page would only be a detour on the way to the thing that actually has to happen.
		redirect(303, `/kunden/${id}`);
	}
};
