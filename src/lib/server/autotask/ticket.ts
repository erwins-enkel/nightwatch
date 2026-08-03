import { createHash } from 'node:crypto';
import type { AutotaskTicketDefaults } from '../db/schema/system';
import type { Alarmgrund, ErholungsArt, MonitorArt } from '../db/schema/enums';
import type { AlarmEreignisDaten } from '../alarm/ereignis';

/**
 * What Autotask receives: the external ID, the ticket body and the note texts (SPEC §7).
 *
 * Pure like `alarm/lebenszyklus.ts` — no network, no database, no clock of its own. The lifecycle
 * already decided *what* is to be said (`weisung`, `alarmgrund`, `zusammenfassung`); this module
 * only decides how it reads inside a PSA.
 *
 * The texts are English and carry no i18n: they are built in the worker, which has no request and
 * therefore no locale, and English is the project's base locale. A configurable ticket language
 * would be a knob of its own.
 */

/**
 * Autotask's `externalID` holds **50 characters**, the correlation key `nw:{uuid}:{uuid}` needs 78
 * (Research-Doc §4). So the key travels hashed — deterministic, prefix preserved, 43 characters for
 * a monitor and 45 for a self-monitor.
 *
 * This is the *only* mapping onto that field. Every write and every de-dupe query must use the same
 * value: if one side sent the full key while the other searched for the hash, a retry after a crash
 * would not find the ticket it created moments ago and would open a second one — the exact
 * duplicate this whole mechanism exists to prevent (`ablauf.ts` therefore computes it once per job).
 *
 * The full key stays in `ticket_korrelation.korrelations_key`; nothing is lost, it only travels
 * shortened.
 */
export function externId(korrelationsKey: string): string {
	const praefix = korrelationsKey.startsWith('self:') ? 'self:' : 'nw:';
	return praefix + createHash('sha256').update(korrelationsKey).digest('base64url').slice(0, 40);
}

/** Autotask truncates a longer title silently; cutting it here keeps the ticket readable. */
const TITEL_MAX = 250;

const ALARMGRUND_TEXT: Record<Alarmgrund, string> = {
	ueberfaellig: 'expected mail overdue',
	fehler_gemeldet: 'error reported',
	unklar: 'unclear — the rule did not decide',
	ereignis_eingetroffen: 'event arrived',
	paar_zu_lange_offen: 'pair open for too long',
	zaehler_ueber_obergrenze: 'counter above upper limit',
	zaehler_unter_untergrenze: 'counter below lower limit'
};

const ART_TEXT: Record<MonitorArt | 'selbst', string> = {
	heartbeat: 'heartbeat',
	ereignis: 'event',
	paar: 'pair',
	zaehler: 'counter',
	selbst: 'self-monitor'
};

/**
 * How the disruption ended. Only `beweis` may close a ticket (CONTEXT „Beweisbasierte Erholung"),
 * so the note says which one it was — that is the operator's justification for a ticket that stayed
 * open.
 */
const ERHOLUNG_TEXT: Record<ErholungsArt, string> = {
	beweis: 'evidence-based (a matching mail arrived)',
	erledigt: 'marked done by hand',
	auto_zurueck: 'automatic reset after the configured time',
	archiviert: 'customer archived'
};

/** Deliberately not `toLocaleString()`: the container's locale says nothing about the reader's. */
function zeitpunkt(wert: Date): string {
	return `${wert.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function dauer(sekunden: number): string {
	if (sekunden < 60) return `${sekunden} s`;
	const minuten = Math.round(sekunden / 60);
	if (minuten < 60) return `${minuten} min`;
	const stunden = Math.floor(minuten / 60);
	return `${stunden} h ${minuten % 60} min`;
}

function kundeName(daten: AlarmEreignisDaten): string {
	// „Gehört keinem Kunden" — a self-monitor event (CONTEXT „Selbst-Monitor").
	return daten.kunde?.name ?? 'Nightwatch (self-monitor)';
}

function zeilen(eintraege: (string | null)[]): string {
	return eintraege.filter((zeile): zeile is string => zeile !== null).join('\n');
}

export function ticketTitel(daten: AlarmEreignisDaten): string {
	const titel = `[Nightwatch] ${kundeName(daten)} · ${daten.monitor.bezeichnung} — ${ALARMGRUND_TEXT[daten.alarmgrund]}`;
	return titel.length > TITEL_MAX ? `${titel.slice(0, TITEL_MAX - 1)}…` : titel;
}

/**
 * The ticket body. Self-carrying on purpose: whoever picks the ticket up must be able to act on it
 * without opening Nightwatch — and if they do want to, the Rückverweis is right there (CONTEXT).
 */
export function ticketBeschreibung(
	daten: AlarmEreignisDaten,
	vorgaengerTicket: string | null
): string {
	return zeilen([
		'Nightwatch detected a disruption.',
		'',
		`Customer:  ${kundeName(daten)}`,
		`Monitor:   ${daten.monitor.bezeichnung} (${ART_TEXT[daten.monitor.art]})`,
		`Reason:    ${ALARMGRUND_TEXT[daten.alarmgrund]}`,
		`Since:     ${zeitpunkt(daten.zusammenfassung.ersteAm)}`,
		`Alert ID:  ${daten.alertId}`,
		daten.vorgaengerAlertId ? `Previous alert: ${daten.vorgaengerAlertId}` : null,
		vorgaengerTicket ? `Previous ticket: ${vorgaengerTicket}` : null,
		'',
		`Open the monitor: ${daten.rueckverweis}`
	]);
}

export interface Notiz {
	titel: string;
	text: string;
}

/**
 * The note an event leaves on an existing ticket.
 *
 * Three occasions, all of them from SPEC §6: a re-alarm that found the monitor's ticket still open,
 * the one automatic mid-episode comment (Verschärfung), and the Entwarnung — which comments
 * **always**, whether or not it is also allowed to close.
 */
export function notizFuer(daten: AlarmEreignisDaten): Notiz {
	const kopf = zeilen([
		`Customer:  ${kundeName(daten)}`,
		`Monitor:   ${daten.monitor.bezeichnung} (${ART_TEXT[daten.monitor.art]})`,
		`Alert ID:  ${daten.alertId}`
	]);
	const fuss = `Open the monitor: ${daten.rueckverweis}`;

	if (daten.ereignis === 'verschaerfung') {
		return {
			titel: '[Nightwatch] Disruption escalated',
			text: zeilen([
				'The monitor now reports an actual error, on top of the reason this ticket was opened.',
				'',
				kopf,
				`Escalated at: ${zeitpunkt(daten.zusammenfassung.verschaerftAm ?? daten.zusammenfassung.letzteAm)}`,
				'',
				fuss
			])
		};
	}

	if (daten.ereignis === 'entwarnung') {
		const { vorkommen, ersteAm, letzteAm, verschaerftAm, stoerungsdauerSekunden } =
			daten.zusammenfassung;

		return {
			titel: '[Nightwatch] All clear',
			text: zeilen([
				'The monitor is healthy again.',
				'',
				kopf,
				`Reason it opened: ${ALARMGRUND_TEXT[daten.alarmgrund]}`,
				`Recovery:  ${daten.erholungsArt ? ERHOLUNG_TEXT[daten.erholungsArt] : 'unknown'}`,
				stoerungsdauerSekunden === null ? null : `Duration:  ${dauer(stoerungsdauerSekunden)}`,
				`Occurrences: ${vorkommen} (first ${zeitpunkt(ersteAm)}, last ${zeitpunkt(letzteAm)})`,
				verschaerftAm ? `Escalated at: ${zeitpunkt(verschaerftAm)}` : null,
				'',
				fuss
			])
		};
	}

	return {
		titel: '[Nightwatch] Alarm on an already open ticket',
		text: zeilen([
			'The monitor broke again while this ticket was still open, so no second ticket was opened.',
			'',
			kopf,
			`Reason:    ${ALARMGRUND_TEXT[daten.alarmgrund]}`,
			`Since:     ${zeitpunkt(daten.zusammenfassung.ersteAm)}`,
			daten.vorgaengerAlertId ? `Previous alert: ${daten.vorgaengerAlertId}` : null,
			'',
			fuss
		])
	};
}

export interface TicketKoerperEingabe {
	daten: AlarmEreignisDaten;
	konfig: AutotaskTicketDefaults;
	companyId: number;
	/** Computed once per job by `ablauf.ts` and shared with the de-dupe query. */
	externId: string;
	vorgaengerTicket: string | null;
	jetzt: Date;
}

/**
 * The `POST /Tickets` payload (Research-Doc §3).
 *
 * Every numeric ID comes from the instance configuration; the only literals here are field names.
 * Optional fields are omitted rather than sent as null — Autotask treats an explicit null as "clear
 * this", which for `queueID` would fail against a category that requires one.
 */
export function ticketKoerper(eingabe: TicketKoerperEingabe): Record<string, unknown> {
	const { daten, konfig, companyId, jetzt } = eingabe;

	const koerper: Record<string, unknown> = {
		companyID: companyId,
		title: ticketTitel(daten),
		description: ticketBeschreibung(daten, eingabe.vorgaengerTicket),
		status: konfig.statusId,
		priority: konfig.priorityId,
		externalID: eingabe.externId
	};

	if (konfig.queueId !== undefined) koerper.queueID = konfig.queueId;
	if (konfig.arbeitstypId !== undefined) koerper.billingCodeID = konfig.arbeitstypId;
	if (konfig.faelligkeitStunden !== undefined) {
		koerper.dueDateTime = new Date(
			jetzt.getTime() + konfig.faelligkeitStunden * 3_600_000
		).toISOString();
	}

	return koerper;
}

/** The `TicketNotes` payload; `noteType` and `publish` are tenant picklists, hence configured. */
export function notizKoerper(
	ticketId: string,
	notiz: Notiz,
	konfig: AutotaskTicketDefaults
): Record<string, unknown> {
	return {
		ticketID: Number(ticketId),
		title: notiz.titel.slice(0, TITEL_MAX),
		description: notiz.text,
		noteType: konfig.notizTypId,
		publish: konfig.notizPublishId
	};
}

/** The slice of an Autotask ticket the close decision looks at. */
interface TicketZustandsFelder {
	status?: unknown;
	assignedResourceID?: unknown;
}

/**
 * „Schließen darf nur, wer eine beweisbasierte Erholung **und** ein unberührtes Ticket vorfindet"
 * (CONTEXT „Alarmweg"). Untouched is exactly two things: still in the status Nightwatch created it
 * with, and nobody assigned to it. Anything else means a human has taken it on, and an automatic
 * close would pull the work out from under them.
 */
export function istUnberuehrt(ticket: unknown, konfig: AutotaskTicketDefaults): boolean {
	const felder = ticket as TicketZustandsFelder | null | undefined;
	if (!felder || konfig.statusId === undefined) return false;

	const bearbeiter = felder.assignedResourceID;
	return (
		Number(felder.status) === konfig.statusId &&
		(bearbeiter === null || bearbeiter === undefined || bearbeiter === 0)
	);
}
