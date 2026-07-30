import { fail } from '@sveltejs/kit';
import type { AnzeigeZustand } from '$lib/board/anzeige';
import { setzeQuittierung } from '$lib/server/alarm/db';
import {
	ladeAlarmLeiste,
	ladeBoardKunden,
	ladeBoardMonitore,
	ladeKundenDetail,
	ladeMonitorDetail
} from '$lib/server/board/db';
import { alsBoardMonitor, baueKarten, type BoardFilter } from '$lib/server/board/filter';
import { baueZeitachse } from '$lib/server/board/zeitachse';
import { monitorArt, type MonitorArt } from '$lib/server/db/schema/enums';
import { setzePause } from '$lib/server/monitor/db';
import { empfohleneAktion } from '$lib/server/monitor/zustand';
import { systemStatus } from '$lib/server/selbst/db';
import { ladeZeitzone, verknuepfeKalender } from '$lib/server/zeit/db';
import { listeTriage, zaehleTriage } from '$lib/server/zuordnung/db';
import { text } from '$lib/server/zuordnung/formular';
import type { Actions, PageServerLoad } from './$types';

/**
 * Das Kundenboard (SPEC §9) — Variante A aus dem Prototyp (#8).
 *
 * Der Zustand der beiden Schubladen steht in der URL (`?kunde=`, `?monitor=`), nicht im Client:
 * damit ist ein Alarm-Chip ein verlinkbarer Zeiger auf seinen Monitor, das Detail wird serverseitig
 * geladen, und beides funktioniert ohne JavaScript.
 */

/** Die Reihenfolge, in der die Filterliste sie anbietet — vom Dringendsten zum Ruhigsten. */
const ZUSTAENDE: AnzeigeZustand[] = ['gestoert', 'pausiert', 'entwurf', 'gesund'];

/** Wie viele Triage-Einträge das Board zeigt. Die eigene Ansicht mit allen kommt mit #33. */
const TRIAGE_AUF_DEM_BOARD = 5;

/**
 * Die anbietbaren Pausen-Längen (CONTEXT „Pausiert": „optional mit Auto-Ende").
 *
 * Eine Auswahl statt eines Zeitstempels, mit Absicht: ein `datetime-local` trägt keine Zone, und
 * der Server müsste raten, ob „14:00" die des Browsers oder seine eigene meint. Eine Dauer ist in
 * jeder Zone dieselbe — und „acht Stunden Wartung" ist ohnehin, was jemand meint.
 */
export const PAUSE_DAUERN = [3600, 4 * 3600, 8 * 3600, 24 * 3600, 7 * 24 * 3600];

function leseFilter(params: URLSearchParams): BoardFilter {
	const zustand = params.get('zustand') ?? '';
	const art = params.get('art') ?? '';

	return {
		suche: params.get('q') ?? '',
		zustand: ZUSTAENDE.includes(zustand as AnzeigeZustand) ? (zustand as AnzeigeZustand) : null,
		art: (monitorArt.enumValues as readonly string[]).includes(art) ? (art as MonitorArt) : null
	};
}

/** Der Monitor-Drawer. Die Ankünfte selbst bleiben auf dem Server — nur die Spalten gehen raus. */
async function monitorDrawer(id: string, jetzt: Date) {
	const detail = await ladeMonitorDetail(id, jetzt);
	if (detail === null) return null;

	const monitor = alsBoardMonitor(detail, jetzt);

	return {
		id: detail.id,
		kundeId: detail.kundeId,
		kundeName: detail.kundeName,
		bezeichnung: detail.bezeichnung,
		art: detail.art,
		anzeige: monitor.anzeige,
		pauseWirksam: monitor.pauseWirksam,
		zustandSeit: detail.zustandSeit,
		pausiertBis: detail.pausiertBis,
		aktiviertAm: detail.aktiviertAm,
		zuletztGesehenAm: detail.zuletztGesehenAm,

		// Erwartung, für die eine Zeile über der Achse.
		erwartungModus: detail.erwartungModus,
		erwartungIntervallSekunden: detail.erwartungIntervallSekunden,
		erwartungPlan: detail.erwartungPlan,
		karenzSekunden: detail.karenzSekunden,
		autoZurueckSekunden: detail.autoZurueckSekunden,
		maxOffenzeitSekunden: detail.maxOffenzeitSekunden,
		zaehlerFensterSekunden: detail.zaehlerFensterSekunden,
		zaehlerObergrenze: detail.zaehlerObergrenze,
		zaehlerUntergrenze: detail.zaehlerUntergrenze,

		regel: {
			absender: detail.regelAbsender,
			betreffMuster: detail.regelBetreffMuster,
			schluesselwoerter: detail.regelSchluesselwoerter,
			musterSchlecht: detail.regelMusterSchlecht,
			musterGut: detail.regelMusterGut,
			quelle: detail.regelQuelle
		},

		episode: detail.episode,
		/** CONTEXT: „unklar" verweist auf die Regel, alles andere auf die Störung selbst. */
		empfehlung: detail.alarmgrund === null ? null : empfohleneAktion(detail.alarmgrund),
		letzteMails: detail.letzteMails,
		kalender: detail.kalender,
		spalten: baueZeitachse(
			detail,
			{
				zone: detail.zone,
				ausnahmetage: new Set(detail.ausnahmetage),
				ankuenfte: detail.ankuenfte
			},
			jetzt
		)
	};
}

async function kundenDrawer(id: string, jetzt: Date) {
	const detail = await ladeKundenDetail(id);
	if (detail === null) return null;

	return {
		kunde: detail.kunde,
		monitore: detail.monitore.map((zeile) => alsBoardMonitor(zeile, jetzt))
	};
}

export const load: PageServerLoad = async ({ url }) => {
	const jetzt = new Date();
	const filter = leseFilter(url.searchParams);
	const monitorId = url.searchParams.get('monitor');
	const kundeId = url.searchParams.get('kunde');

	const [
		alarme,
		kunden,
		monitore,
		system,
		triage,
		triageAnzahl,
		zone,
		monitorDetail,
		kundenDetail
	] = await Promise.all([
		ladeAlarmLeiste(),
		ladeBoardKunden(),
		ladeBoardMonitore(),
		systemStatus(),
		listeTriage(TRIAGE_AUF_DEM_BOARD),
		zaehleTriage(),
		ladeZeitzone(),
		monitorId === null ? null : monitorDrawer(monitorId, jetzt),
		kundeId === null ? null : kundenDrawer(kundeId, jetzt)
	]);

	const karten = baueKarten(kunden, monitore, filter, jetzt);

	/**
	 * Die Leiste folgt demselben Filter wie die Karten — wer „veeam" sucht, meint das ganze Board.
	 *
	 * Sie tut es aber nicht still: was der Filter verdeckt, wird darunter gezählt. Ein Alarm, der
	 * unbemerkt verschwindet, weil noch ein Filter von vorhin stand, wäre genau die Blindstelle,
	 * gegen die Nightwatch gebaut ist.
	 */
	const sichtbar = new Set(karten.flatMap((karte) => karte.treffer.map((monitor) => monitor.id)));
	const gefilterteAlarme = alarme.filter((alarm) => sichtbar.has(alarm.monitorId));

	return {
		jetzt,
		zone,
		filter,
		arten: monitorArt.enumValues,
		zustaende: ZUSTAENDE,
		pauseDauern: PAUSE_DAUERN,
		alarme: gefilterteAlarme,
		alarmeVerdeckt: alarme.length - gefilterteAlarme.length,
		karten,
		/** „Ohne konfigurierten Empfänger ist der Totalausfall unbeobachtet" (SPEC §8). */
		system: {
			gestoerte: system.monitore.filter((monitor) => monitor.zustand === 'gestoert'),
			unbeobachtet: !system.heartbeatPingKonfiguriert && !system.webhookZielVorhanden
		},
		triage: {
			anzahl: triageAnzahl,
			eintraege: triage.map((zeile) => ({
				id: zeile.id,
				ankunftszeit: zeile.ankunftszeit,
				absender: zeile.absender,
				betreff: zeile.betreff,
				grund: zeile.grund,
				kandidaten: zeile.kandidaten.map((kandidat) => kandidat.kundeName)
			}))
		},
		monitorDetail,
		kundenDetail
	};
};

function abgelehnt(fehler: string) {
	return { fehler };
}

export const actions: Actions = {
	/** CONTEXT „Quittieren": ein Vermerk am Alarm, ohne jede Außenwirkung. */
	quittieren: async ({ request }) => {
		const daten = await request.formData();
		const monitorId = text(daten, 'monitorId');
		if (monitorId === '') return fail(400, abgelehnt('unbekannt'));

		const ergebnis = await setzeQuittierung(
			monitorId,
			text(daten, 'quittiert') === 'true',
			new Date()
		);
		// Die Episode kann zwischen dem Laden des Boards und dem Klick erholt sein — dann gibt es
		// nichts mehr zu quittieren, und das ist eine gute Nachricht, kein Serverfehler.
		if (ergebnis === 'kein_alarm') return fail(409, abgelehnt('kein_alarm'));

		return { erfolg: 'gespeichert' as const };
	},

	pause: async ({ request }) => {
		const daten = await request.formData();
		const monitorId = text(daten, 'monitorId');
		if (monitorId === '') return fail(400, abgelehnt('unbekannt'));

		const pausieren = text(daten, 'pausiert') === 'true';
		const roh = text(daten, 'dauerSekunden');
		const dauer = roh === '' ? null : Number(roh);
		if (dauer !== null && !PAUSE_DAUERN.includes(dauer)) return fail(400, abgelehnt('dauer'));

		await setzePause(
			monitorId,
			pausieren,
			pausieren && dauer !== null ? new Date(Date.now() + dauer * 1000) : null
		);

		return { erfolg: 'gespeichert' as const };
	},

	/** Die Zuordnung der Ausnahmekalender am Monitor; gepflegt werden sie anderswo. */
	kalender: async ({ request }) => {
		const daten = await request.formData();
		const monitorId = text(daten, 'monitorId');
		if (monitorId === '') return fail(400, abgelehnt('unbekannt'));

		const kalenderIds = daten
			.getAll('kalender')
			.filter((wert): wert is string => typeof wert === 'string');

		await verknuepfeKalender(monitorId, kalenderIds);
		return { erfolg: 'gespeichert' as const };
	}
};
