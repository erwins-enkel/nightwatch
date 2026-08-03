import { error, fail } from '@sveltejs/kit';
import { monitorArt } from '$lib/server/db/schema/enums';
import { eingabenAus, istArt, parameterAus, regelAus, zahl } from '$lib/server/monitor/formular';
import { aktualisiereMonitor, holeMonitor, setzeAktivierung } from '$lib/server/monitor/db';
import { text } from '$lib/server/zuordnung/formular';
import type { Actions, PageServerLoad } from './$types';

/**
 * „Regel überarbeiten" (CONTEXT) — der Rückverweis aus dem Monitor-Drawer.
 *
 * Bewusst ein Formular und kein Assistent: das Anlegen einer Regel ist ein eigener Weg mit
 * Vorlagen, Ableitung aus einer Mail und vier Schritten (`/monitore/neu`). Wer hier landet, hat
 * einen laufenden Monitor, dessen Erkennung nicht stimmt — meistens, weil er „unklar" meldet und
 * die Zustandsmaschine genau hierher zeigt (`empfohleneAktion`).
 *
 * Die Felder liest `monitor/formular.ts`, dasselbe Modul, aus dem der Wizard liest: beide Flächen
 * legen dieselbe Sache an, und zwei Leser wären zwei Gelegenheiten, ein Feld zu vergessen.
 *
 * Der Kunde steht nicht zur Wahl: ein Monitor gehört genau einem, und ihn umzuhängen ließe seine
 * bisherigen Mails und seine Alarm-Historie bei jemand anderem zurück.
 */

export const load: PageServerLoad = async ({ params }) => {
	const monitor = await holeMonitor(params.id);
	if (monitor === undefined) error(404, 'Monitor nicht gefunden');

	return { monitor, arten: monitorArt.enumValues };
};

export const actions: Actions = {
	speichern: async ({ request, params }) => {
		const daten = await request.formData();
		const eingaben = eingabenAus(daten);

		const art = text(daten, 'art');
		if (!istArt(art)) return fail(400, { fehler: ['art_unbekannt'], eingaben });

		const ergebnis = await aktualisiereMonitor(params.id, {
			// Wird von `aktualisiereMonitor` nicht geschrieben; die Eingabe verlangt das Feld.
			kundeId: '',
			bezeichnung: text(daten, 'bezeichnung'),
			art,
			parameter: parameterAus(daten),
			entwarnungsStabilitaetSekunden: zahl(text(daten, 'entwarnungsStabilitaetSekunden')) ?? null,
			regel: regelAus(daten),
			// Eine von Hand überarbeitete Regel ist von Hand gemacht, was immer sie vorher war
			// (CONTEXT „Regel-Quelle": die drei Werte sind Vorbefüllungs-Grade, keine Herkunftsurkunde).
			quelle: 'manuell'
		});

		if (ergebnis.art === 'ungueltig') {
			return fail(400, { fehler: ergebnis.fehler as string[], eingaben });
		}
		if (ergebnis.art === 'unbekannt') return fail(404, { fehler: ['unbekannt'], eingaben });

		return { erfolg: 'gespeichert' as const };
	},

	/**
	 * Das Bestätigungs-Gate (SPEC §5). Es steht hier, weil eine überarbeitete Regel genau der
	 * Moment ist, in dem jemand sie bestätigt — und weil ein Entwurf sonst nirgends scharf würde.
	 */
	aktivierung: async ({ request, params }) => {
		const aktiv = text(await request.formData(), 'aktiv') === 'true';
		await setzeAktivierung(params.id, aktiv, new Date());

		return { erfolg: aktiv ? ('aktiviert' as const) : ('deaktiviert' as const) };
	}
};
