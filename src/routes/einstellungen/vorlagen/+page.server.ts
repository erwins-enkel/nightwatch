import { fail } from '@sveltejs/kit';
import { listeMonitore } from '$lib/server/monitor/db';
import {
	importiereVorlagen,
	listeVorlagen,
	loescheVorlage,
	vorlageAusMonitor
} from '$lib/server/regel/db';
import { liesVorlagenDatei } from '$lib/server/regel/vorlage';
import { text } from '$lib/server/zuordnung/formular';
import type { Actions, PageServerLoad } from './$types';

/**
 * Der Fundus (CONTEXT „Regel-Vorlage").
 *
 * Zwei Herkünfte auf einer Seite: **kuratierte** Vorlagen kommen mit dem Image und werden mit
 * Releases aktualisiert — sie sind hier nur zu sehen, nicht zu löschen, denn beim nächsten Start
 * wären sie ohnehin wieder da. **Eigene** entstehen aus einem bestehenden Monitor oder aus einem
 * Import und gehören dem Betreiber.
 *
 * Export und Import gehen durch dasselbe Format wie die kuratierten Daten, und das trägt
 * ausschließlich Regel- und Parameter-Felder: „Export/Import von Regel-Vorlagen enthält nie
 * Credentials" (SPEC §12) ist keine Zusage der Oberfläche, sondern eine Eigenschaft des Formats.
 */

export const load: PageServerLoad = async () => {
	const [vorlagen, monitore] = await Promise.all([listeVorlagen(), listeMonitore()]);

	return {
		vorlagen,
		monitore: monitore.map((monitor) => ({
			id: monitor.id,
			bezeichnung: monitor.bezeichnung,
			kundeName: monitor.kundeName
		}))
	};
};

/** Datei-Upload oder eingefügter Text — beides landet als JSON-Zeichenkette hier. */
async function rohtextAus(daten: FormData): Promise<string> {
	const datei = daten.get('datei');
	if (datei instanceof File && datei.size > 0) return datei.text();
	return text(daten, 'inhalt');
}

export const actions: Actions = {
	importieren: async ({ request }) => {
		const daten = await request.formData();
		const rohtext = await rohtextAus(daten);
		if (rohtext.trim() === '') return fail(400, { fehler: ['leer'] });

		let geparst: unknown;
		try {
			geparst = JSON.parse(rohtext);
		} catch {
			return fail(400, { fehler: ['kein_json'] });
		}

		const gelesen = liesVorlagenDatei(geparst);
		if (gelesen.art === 'ungueltig') {
			return fail(400, {
				fehler: gelesen.fehler.map((eintrag) =>
					eintrag.eintrag === null
						? eintrag.schluessel
						: `${eintrag.schluessel}#${eintrag.eintrag + 1}`
				)
			});
		}

		const ergebnis = await importiereVorlagen(gelesen.vorlagen);
		return { erfolg: 'importiert' as const, ...ergebnis };
	},

	loeschen: async ({ request }) => {
		const ergebnis = await loescheVorlage(text(await request.formData(), 'id'));
		if (ergebnis !== 'geloescht') return fail(400, { fehler: [ergebnis] });

		return { erfolg: 'geloescht' as const };
	},

	ausMonitor: async ({ request }) => {
		const daten = await request.formData();
		const monitorId = text(daten, 'monitorId');
		if (monitorId === '') return fail(400, { fehler: ['monitor_fehlt'] });

		const ergebnis = await vorlageAusMonitor(monitorId, {
			schluessel: text(daten, 'schluessel'),
			name: text(daten, 'name'),
			beschreibung: text(daten, 'beschreibung') || undefined
		});

		if ('ungueltig' in ergebnis) return fail(400, { fehler: ['vorlage_ungueltig'] });
		if (ergebnis.abgelehnt.length > 0) return fail(400, { fehler: ['schluessel_kuratiert'] });

		return { erfolg: 'erzeugt' as const };
	}
};
