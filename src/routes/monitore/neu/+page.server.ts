import { fail, redirect } from '@sveltejs/kit';
import { monitorArt, type MonitorArt, type RegelQuelle } from '$lib/server/db/schema/enums';
import type { MonitorParameter } from '$lib/server/db/schema/monitor';
import { legeMonitorAn, setzeAktivierung } from '$lib/server/monitor/db';
import {
	eingabenAus,
	istArt,
	parameterAus,
	regelAus,
	zahl,
	type Eingaben
} from '$lib/server/monitor/formular';
import {
	normalisiereParameter,
	normalisiereRegel,
	pruefeMonitor
} from '$lib/server/monitor/parameter';
import {
	beobachteteOffenzeit,
	leiteAb,
	zaehlerVorschlag,
	type Beleg,
	type Vorbefuellung
} from '$lib/server/regel/ableitung';
import {
	alsEintrag,
	holeVorlage,
	ladeQuelleAusMail,
	ladeQuelleAusSorte,
	ladeSortenAnkunftszeiten,
	ladeSortenVerlauf,
	listeVorlagen
} from '$lib/server/regel/db';
import { vorlageAlsRegel } from '$lib/server/regel/vorlage';
import { ladeZeitzone } from '$lib/server/zeit/db';
import { listeKunden } from '$lib/server/zuordnung/db';
import { text } from '$lib/server/zuordnung/formular';
import type { Actions, PageServerLoad } from './$types';

/**
 * Der 4-Schritt-Wizard: Kunde → Art → Erkennung → Parameter (SPEC §9).
 *
 * Die drei **Regel-Quellen** sind hier keine drei Wege, sondern drei Vorbefüllungs-Grade derselben
 * Fläche (CONTEXT „Regel-Quelle"): manuell füllt nichts, eine Vorlage füllt Art, Erkennung und
 * Parameter-Defaults, eine Beispiel-Mail füllt Erkennung, Art-Vermutung und Takt. Woher die
 * Vorbefüllung kommt, steht in der URL (`?mail=`, `?sorte=`, `?vorlage=`, `?kunde=`) — damit ist
 * der Einstieg „aus Mail ableiten" ein Link, den Triage, Mail-Suche und die unüberwachten Sorten
 * (#33) setzen können, ohne hier etwas zu wissen.
 *
 * **Der Schritt steht auf dem Server, nicht im Browser.** Jedes „Weiter" ist ein POST, der die
 * bisherigen Eingaben in Hidden-Feldern mitträgt. Das kostet einen Roundtrip und macht den
 * Assistenten dafür ohne JavaScript vollständig bedienbar; mit `use:enhance` merkt man den
 * Unterschied nicht. Es ist außerdem die Voraussetzung dafür, dass zwischen Schritt 3 und 4
 * gerechnet werden kann — die Paar-Offenzeit entsteht erst, wenn die Muster stehen.
 *
 * Angelegt wird ausschließlich im letzten Schritt, und `legeMonitorAn` lässt `aktiviert_am` null:
 * „Keine Regel wird ohne menschliche Bestätigung aktiv" (SPEC §5).
 */

/**
 * Welcher Schritt einen Fehler zu verantworten hat.
 *
 * Damit prüft „Weiter" nur, was hinter einem liegt: wer auf Schritt 2 steht, soll nicht über eine
 * fehlende Karenz stolpern, die er erst auf Schritt 4 eingibt.
 */
const SCHRITT_JE_FEHLER: Record<string, number> = {
	kunde_fehlt: 1,
	bezeichnung_leer: 1,
	art_unbekannt: 2,
	kein_match_kriterium: 3,
	muster_ungueltig: 3,
	slot_ungenutzt: 3,
	erwartung_fehlt: 4,
	erwartung_unvollstaendig: 4,
	karenz_fehlt: 4,
	auto_zurueck_ungueltig: 4,
	offenzeit_ungueltig: 4,
	fenster_fehlt: 4,
	grenze_fehlt: 4,
	grenzen_verdreht: 4,
	grenze_negativ: 4,
	stabilitaet_negativ: 4
};

export const load: PageServerLoad = async ({ url }) => {
	const mailId = url.searchParams.get('mail');
	const sorteId = url.searchParams.get('sorte');
	const vorlageId = url.searchParams.get('vorlage');

	const [kunden, vorlagen] = await Promise.all([listeKunden(), listeVorlagen()]);

	const quelle = mailId
		? await ladeQuelleAusMail(mailId)
		: sorteId
			? await ladeQuelleAusSorte(sorteId)
			: undefined;

	// Aus einer Vorlage *und* aus einer Mail gleichzeitig vorzubefüllen wäre nicht auflösbar — die
	// Mail gewinnt, weil sie das konkretere Material ist. Die Vorlage bleibt im Schritt 1 wählbar.
	const vorbefuellung: Vorbefuellung | null = quelle
		? leiteAb(
				{ absender: quelle.absender, betreff: quelle.betreff },
				quelle.takt,
				quelle.sortenAnzahl
			)
		: vorlageId
			? await vorlageAlsVorbefuellung(vorlageId)
			: null;

	return {
		// Ein archivierter Kunde bekommt keine neuen Monitore — seine bestehenden sind mitarchiviert
		// (CONTEXT „Archiviert (Kunde)").
		kunden: kunden
			.filter((kunde) => kunde.zustand === 'aktiv')
			.map((kunde) => ({ id: kunde.id, name: kunde.name })),
		vorlagen: vorlagen.map((vorlage) => ({
			id: vorlage.id,
			name: vorlage.name,
			hersteller: vorlage.hersteller,
			herkunft: vorlage.herkunft
		})),
		quelle: quelle ?? null,
		vorbefuellung,
		vorlageId: vorlageId ?? '',
		kundeId: url.searchParams.get('kunde') ?? quelle?.kundeId ?? '',
		/**
		 * Der Query-String, an den die Formular-Aktionen gehängt werden.
		 *
		 * `formaction="?/schritt"` ersetzt die Suche vollständig — die Quelle (`?sorte=…`) wäre nach
		 * dem ersten „Weiter" weg, und mit ihr die Beispiel-Mail in Schritt 3 und die nachgelagerten
		 * Vorschläge in Schritt 4. Also wird sie mitgeführt: `?sorte=…&/schritt`.
		 *
		 * Der Aktions-Parameter selbst muss dabei heraus. Er steht nach dem POST in genau dieser
		 * Suche, und ungefiltert hinge der nächste Knopf ein zweites `&/schritt` an — SvelteKit
		 * lehnt zwei Aktionen in einer Anfrage ab, und der dritte Schritt liefe in einen 400.
		 */
		suche: ohneAktion(url),
		arten: monitorArt.enumValues
	};
};

/** Die Suche ohne SvelteKits Aktions-Parameter (die Schlüssel, die mit `/` beginnen). */
function ohneAktion(url: URL): string {
	const suche = new URLSearchParams(url.search);
	for (const schluessel of [...suche.keys()]) {
		if (schluessel.startsWith('/')) suche.delete(schluessel);
	}

	const text = suche.toString();
	return text === '' ? '' : `?${text}`;
}

async function vorlageAlsVorbefuellung(vorlageId: string): Promise<Vorbefuellung | null> {
	const zeile = await holeVorlage(vorlageId);
	if (!zeile) return null;

	const vorlage = alsEintrag(zeile);
	return {
		bezeichnung: vorlage.name,
		art: vorlage.vorgeschlageneArt ?? 'heartbeat',
		regel: vorlageAlsRegel(vorlage),
		parameter: vorlage.parameterDefaults ?? {},
		belege: []
	};
}

/** Die Wizard-Eingaben: die Regel-Felder plus das, was nur dieser Weg kennt. */
type WizardEingaben = Eingaben & { kundeId: string; vorlageId: string; vorlageAngewandt: string };

function wizardEingabenAus(daten: FormData): WizardEingaben {
	return {
		...eingabenAus(daten),
		kundeId: text(daten, 'kundeId'),
		vorlageId: text(daten, 'vorlageId'),
		vorlageAngewandt: text(daten, 'vorlageAngewandt')
	};
}

/**
 * Prüft alles, was bis einschließlich `schritt` eingegeben sein muss.
 *
 * Es ist dieselbe `pruefeMonitor`, die auch das Speichern bewacht — hier nur gefiltert. Eine
 * zweite, „weichere" Prüfung für den Assistenten wäre der sichere Weg zu einem letzten Schritt,
 * der Fehler zeigt, die drei Schritte vorher hätten auffallen müssen.
 */
function pruefeBis(schritt: number, eingaben: WizardEingaben, daten: FormData): string[] {
	const fehler: string[] = [];

	if (eingaben.kundeId === '') fehler.push('kunde_fehlt');
	if (eingaben.bezeichnung.trim() === '') fehler.push('bezeichnung_leer');

	const art = eingaben.art;
	if (!istArt(art)) {
		if (schritt >= 2) fehler.push('art_unbekannt');
		return begrenze(fehler, schritt);
	}

	if (schritt >= 3) {
		const parameter = normalisiereParameter(art, parameterAus(daten));
		const regel = normalisiereRegel(regelAus(daten));
		fehler.push(
			...pruefeMonitor({
				bezeichnung: eingaben.bezeichnung,
				art,
				parameter,
				entwarnungsStabilitaetSekunden: zahl(eingaben.entwarnungsStabilitaetSekunden) ?? null,
				regel
			})
		);
	}

	return begrenze(fehler, schritt);
}

function begrenze(fehler: string[], schritt: number): string[] {
	return [...new Set(fehler)].filter((eintrag) => (SCHRITT_JE_FEHLER[eintrag] ?? 4) <= schritt);
}

/**
 * Die Vorschläge, die erst entstehen, wenn die Wahl der Art und die Muster stehen.
 *
 * Beide sind nachgelagert und beide nur ein Vorschlag: sie überschreiben nie ein Feld, in dem schon
 * etwas steht. Wer die Offenzeit von Hand auf zwei Stunden gesetzt und dann noch einmal „Zurück"
 * gedrückt hat, findet seine zwei Stunden wieder.
 */
async function nachgelagerteVorschlaege(
	art: MonitorArt,
	eingaben: WizardEingaben,
	daten: FormData,
	sorteId: string | null
): Promise<{ eingaben: WizardEingaben; belege: Beleg[] }> {
	if (!sorteId) return { eingaben, belege: [] };

	if (art === 'paar' && eingaben.maxOffenzeitSekunden === '') {
		const verlauf = await ladeSortenVerlauf(sorteId);
		const vorschlag = beobachteteOffenzeit(verlauf, normalisiereRegel(regelAus(daten)));
		if (vorschlag) {
			return {
				eingaben: { ...eingaben, maxOffenzeitSekunden: String(vorschlag.maxOffenzeitSekunden) },
				belege: [vorschlag.beleg]
			};
		}
	}

	if (art === 'zaehler' && eingaben.zaehlerFensterSekunden === '') {
		const zeiten = await ladeSortenAnkunftszeiten(sorteId);
		const vorschlag = zaehlerVorschlag(zeiten, await ladeZeitzone());
		if (vorschlag) {
			const p = vorschlag.parameter;
			return {
				eingaben: {
					...eingaben,
					zaehlerFensterSekunden: String(p.zaehlerFensterSekunden ?? ''),
					zaehlerObergrenze: String(p.zaehlerObergrenze ?? ''),
					zaehlerUntergrenze: p.zaehlerUntergrenze === undefined ? '' : String(p.zaehlerUntergrenze)
				},
				belege: [vorschlag.beleg]
			};
		}
	}

	return { eingaben, belege: [] };
}

/** Eine im Schritt 1 gewählte Vorlage in die Felder schreiben. */
async function wendeVorlageAn(eingaben: WizardEingaben): Promise<WizardEingaben> {
	const zeile = await holeVorlage(eingaben.vorlageId);
	if (!zeile) return { ...eingaben, vorlageAngewandt: eingaben.vorlageId };

	const vorlage = alsEintrag(zeile);
	const parameter = vorlage.parameterDefaults ?? {};

	return {
		...eingaben,
		...parameterFelder(parameter),
		art: vorlage.vorgeschlageneArt ?? eingaben.art,
		absender: vorlage.absender.join('\n'),
		betreffMuster: vorlage.betreffMuster.join('\n'),
		schluesselwoerter: vorlage.schluesselwoerter.join('\n'),
		musterSchlecht: vorlage.musterSchlecht.join('\n'),
		musterGut: vorlage.musterGut.join('\n'),
		wochentage: (parameter.erwartungPlan?.wochentage ?? []).map(String),
		vorlageAngewandt: eingaben.vorlageId
	};
}

/** Parameter als Formularwerte — leer, wo die Vorlage nichts vorgibt. */
function parameterFelder(parameter: MonitorParameter) {
	const alsText = (wert: number | undefined) => (wert === undefined ? '' : String(wert));

	return {
		erwartungModus: parameter.erwartungModus ?? '',
		erwartungIntervallSekunden: alsText(parameter.erwartungIntervallSekunden),
		uhrzeit: parameter.erwartungPlan?.uhrzeit ?? '',
		karenzSekunden: alsText(parameter.karenzSekunden),
		autoZurueckSekunden: alsText(parameter.autoZurueckSekunden),
		maxOffenzeitSekunden: alsText(parameter.maxOffenzeitSekunden),
		zaehlerFensterSekunden: alsText(parameter.zaehlerFensterSekunden),
		zaehlerObergrenze: alsText(parameter.zaehlerObergrenze),
		zaehlerUntergrenze: alsText(parameter.zaehlerUntergrenze)
	};
}

/**
 * Woher die Regel stammt (CONTEXT „Regel-Quelle").
 *
 * Die zuletzt angewandte Vorlage gewinnt: wer eine Vorlage über eine abgeleitete Vorbefüllung legt,
 * hat am Ende die Vorlage vor sich.
 */
function quelleAus(eingaben: WizardEingaben, url: URL): RegelQuelle {
	if (eingaben.vorlageAngewandt !== '') return 'vorlage';
	if (url.searchParams.has('mail') || url.searchParams.has('sorte')) return 'abgeleitet';
	return 'manuell';
}

export const actions: Actions = {
	/** Vor oder zurück. Vorwärts nur, wenn alles bis hierher stimmt; zurück immer. */
	schritt: async ({ request, url }) => {
		const daten = await request.formData();
		let eingaben = wizardEingabenAus(daten);

		const von = Number(text(daten, 'von')) || 1;
		const ziel = Math.min(4, Math.max(1, Number(text(daten, 'ziel')) || 1));

		if (ziel < von)
			return { schritt: ziel, eingaben, fehler: [] as string[], belege: [] as Beleg[] };

		if (eingaben.vorlageId !== '' && eingaben.vorlageId !== eingaben.vorlageAngewandt) {
			eingaben = await wendeVorlageAn(eingaben);
		}

		const fehler = pruefeBis(von, eingaben, daten);
		if (fehler.length > 0) return fail(400, { schritt: von, eingaben, fehler, belege: [] });

		const art = eingaben.art;
		const { eingaben: ergaenzt, belege } =
			ziel === 4 && istArt(art)
				? await nachgelagerteVorschlaege(art, eingaben, daten, url.searchParams.get('sorte'))
				: { eingaben, belege: [] };

		return { schritt: ziel, eingaben: ergaenzt, fehler: [] as string[], belege };
	},

	/** Das Bestätigungs-Gate: hier entsteht der Monitor, und hier wird er scharf. */
	anlegen: async ({ request, url }) => {
		const daten = await request.formData();
		const eingaben = wizardEingabenAus(daten);
		const aktivieren = text(daten, 'aktivieren') === 'true';

		const art = eingaben.art;
		if (!istArt(art)) {
			return fail(400, { schritt: 2, eingaben, fehler: ['art_unbekannt'], belege: [] });
		}
		if (eingaben.kundeId === '') {
			return fail(400, { schritt: 1, eingaben, fehler: ['kunde_fehlt'], belege: [] });
		}

		const ergebnis = await legeMonitorAn({
			kundeId: eingaben.kundeId,
			bezeichnung: eingaben.bezeichnung,
			art,
			parameter: parameterAus(daten),
			entwarnungsStabilitaetSekunden: zahl(eingaben.entwarnungsStabilitaetSekunden) ?? null,
			regel: regelAus(daten),
			quelle: quelleAus(eingaben, url),
			vorlageId: eingaben.vorlageAngewandt === '' ? null : eingaben.vorlageAngewandt
		});

		if (ergebnis.art !== 'ok') {
			const fehler = ergebnis.art === 'ungueltig' ? (ergebnis.fehler as string[]) : ['unbekannt'];
			// Zurück auf den frühesten Schritt, der etwas zu korrigieren hat — dorthin zu springen ist
			// hilfreicher, als den Fehler auf der Zusammenfassung stehen zu lassen.
			const schritt = Math.min(...fehler.map((eintrag) => SCHRITT_JE_FEHLER[eintrag] ?? 4));
			return fail(400, { schritt, eingaben, fehler, belege: [] });
		}

		if (aktivieren) await setzeAktivierung(ergebnis.id, true, new Date());

		redirect(303, `/?monitor=${encodeURIComponent(ergebnis.id)}`);
	}
};
