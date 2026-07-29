import { getDb } from '../db/client';
import { env } from '../env';
import { createLogger } from '../logger';
import { ladeZustellung, vermerkeZustellung } from '../alarm/db';
import { baueEreignis, type AlarmEreignisDaten } from '../alarm/ereignis';
import type { AutotaskTicketDefaults } from '../db/schema/system';
import type { AutotaskMethode, AutotaskPort } from './client';
import {
	companyIdFuerKunde,
	holeOffeneKorrelation,
	letzteTicketNummer,
	merkeKommentar,
	merkeSchliessung,
	merkeTicket
} from './db';
import { AutotaskZustellFehler, klassifiziereAntwort, klassifiziereAusnahme } from './fehler';
import { externId, istUnberuehrt, notizFuer, notizKoerper, ticketKoerper } from './ticket';

/**
 * Executing one delivery instruction against Autotask (SPEC §7).
 *
 * The lifecycle already decided the *semantics* — `eroeffnen`, `kommentieren`, `schliessen`
 * (CONTEXT „Alarmweg"). This module decides the *state*: whether a ticket already exists, whether
 * it is untouched enough to be closed, and how a retry avoids creating a second one.
 *
 * **Failure policy:** every failure is retried until the queue's budget is spent (SPEC §7,
 * "Dead-Letter nach N Versuchen"). Nothing here shortcuts to a dead letter, and the error class is
 * used for the log level and the persisted diagnosis only.
 */

const log = createLogger('autotask');

type Db = ReturnType<typeof getDb>;

export interface AblaufOptionen {
	zustellungId: string;
	port: AutotaskPort;
	konfig: AutotaskTicketDefaults;
	jetzt?: Date;
	basisUrl?: string;
	db?: Db;
}

/** One call, with a non-2xx turned into the error that carries the diagnosis. */
async function ruf(
	port: AutotaskPort,
	methode: AutotaskMethode,
	pfad: string,
	koerper?: unknown
): Promise<unknown> {
	const antwort = await port.anfrage(methode, pfad, koerper);
	if (antwort.status < 200 || antwort.status >= 300) {
		throw new AutotaskZustellFehler(klassifiziereAntwort(antwort));
	}
	return antwort.body;
}

function text(wert: unknown): string | null {
	if (typeof wert === 'string' && wert.trim() !== '') return wert.trim();
	if (typeof wert === 'number') return String(wert);
	return null;
}

/**
 * The de-dupe query (SPEC §7): is there already a ticket carrying this correlation key?
 *
 * Deliberately **not** narrowed to open tickets. It closes the window between `POST /Tickets` and
 * the local `INSERT`, and a Nightwatch ticket that was created and then closed by hand within that
 * window must still be recognised — otherwise the retry opens a duplicate for a disruption that is
 * already being worked on.
 */
async function sucheTicket(port: AutotaskPort, externIdWert: string): Promise<unknown | null> {
	const body = await ruf(port, 'POST', 'Tickets/query', {
		filter: [{ op: 'eq', field: 'externalID', value: externIdWert }]
	});

	const items = (body as { items?: unknown } | null | undefined)?.items;
	return Array.isArray(items) && items.length > 0 ? items[0] : null;
}

async function holeTicket(port: AutotaskPort, ticketId: string): Promise<unknown | null> {
	const body = await ruf(port, 'GET', `Tickets/${encodeURIComponent(ticketId)}`);
	return (body as { item?: unknown } | null | undefined)?.item ?? null;
}

/**
 * A note on an existing ticket.
 *
 * The child collection URL is used **and** `ticketID` is set in the body — Autotask documents the
 * child path (`Tickets/{id}/Notes`) and the root entity (`/TicketNotes`, where `ticketID` is
 * required), and satisfying both costs one field.
 */
async function schreibeNotiz(
	port: AutotaskPort,
	ticketId: string,
	daten: AlarmEreignisDaten,
	konfig: AutotaskTicketDefaults
): Promise<void> {
	await ruf(
		port,
		'POST',
		`Tickets/${encodeURIComponent(ticketId)}/Notes`,
		notizKoerper(ticketId, notizFuer(daten), konfig)
	);
}

interface Umgebung {
	port: AutotaskPort;
	konfig: AutotaskTicketDefaults;
	daten: AlarmEreignisDaten;
	monitorId: string;
	companyId: number;
	uebergangId: string;
	jetzt: Date;
	db: Db;
}

/** „Sorge dafür, dass für diesen Monitor ein offenes Ticket existiert" (CONTEXT „Alarmweg"). */
async function eroeffne(umgebung: Umgebung): Promise<void> {
	const { port, konfig, daten, monitorId, db, jetzt } = umgebung;

	// SPEC §6, "ein offenes Ticket pro Monitor": a ticket outlives its episode, so a re-alarm
	// comments the open one instead of opening a second.
	const offene = await holeOffeneKorrelation(monitorId, db);
	if (offene?.ticketId) {
		await schreibeNotiz(port, offene.ticketId, daten, konfig);
		await merkeKommentar(offene.id, jetzt, db);
		return;
	}

	// Computed once and used for both the search and the write. If the two ever disagreed, the
	// retry below would not find its own ticket and would create a duplicate.
	const extern = externId(daten.korrelationsKey);

	const vorhanden = await sucheTicket(port, extern);
	let ticketId = vorhanden ? text((vorhanden as { id?: unknown }).id) : null;
	let ticketNummer = vorhanden
		? text((vorhanden as { ticketNumber?: unknown }).ticketNumber)
		: null;

	if (ticketId === null) {
		const angelegt = await ruf(
			port,
			'POST',
			'Tickets',
			ticketKoerper({
				daten,
				konfig,
				companyId: umgebung.companyId,
				externId: extern,
				vorgaengerTicket: await letzteTicketNummer(monitorId, db),
				jetzt
			})
		);

		ticketId = text((angelegt as { itemId?: unknown } | null | undefined)?.itemId);
		if (ticketId === null) {
			throw new AutotaskZustellFehler({
				klasse: 'transient',
				code: 'ohne_itemId',
				text: 'Autotask bestätigte die Ticket-Anlage ohne itemId'
			});
		}

		// The human-facing number is not in the create response; it is what the Vorgänger-Verweis of
		// a later ticket quotes, so it is worth the one extra read.
		ticketNummer = text(
			((await holeTicket(port, ticketId)) as { ticketNumber?: unknown })?.ticketNumber
		);
	}

	await merkeTicket(
		{
			monitorId,
			uebergangId: umgebung.uebergangId,
			korrelationsKey: daten.korrelationsKey,
			ticketId,
			ticketNummer,
			jetzt
		},
		db
	);

	log.info('Ticket bereit', { ticketId, ticketNummer, adoptiert: vorhanden !== null });
}

/** Verschärfung, and every Entwarnung that is not allowed to close (CONTEXT). */
async function kommentiere(umgebung: Umgebung): Promise<boolean> {
	const { port, konfig, daten, monitorId, db, jetzt } = umgebung;

	const offene = await holeOffeneKorrelation(monitorId, db);
	if (!offene?.ticketId) {
		// Somebody closed the ticket in Autotask; there is nothing left to comment on, and opening a
		// new ticket just to say "it recovered" would be noise.
		log.info('Kein offenes Ticket zum Kommentieren', { monitorId, ereignis: daten.ereignis });
		return false;
	}

	await schreibeNotiz(port, offene.ticketId, daten, konfig);
	await merkeKommentar(offene.id, jetzt, db);
	return true;
}

/**
 * „Kommentiert immer, schließt nur bei beweisbasierter Erholung **und** unberührtem Ticket"
 * (SPEC §6).
 *
 * The comment goes first: it is the part that is owed unconditionally. Should the PATCH fail
 * afterwards, the retry writes the note a second time — a duplicate note is a blemish, a missing
 * all-clear is a defect.
 */
async function schliesse(umgebung: Umgebung): Promise<void> {
	const { port, konfig, daten, monitorId, db, jetzt } = umgebung;

	const offene = await holeOffeneKorrelation(monitorId, db);
	if (!offene?.ticketId) {
		log.info('Kein offenes Ticket zum Schließen', { monitorId });
		return;
	}

	await schreibeNotiz(port, offene.ticketId, daten, konfig);
	await merkeKommentar(offene.id, jetzt, db);

	if (konfig.abschlussStatusId === undefined) {
		log.info('Kein Abschluss-Status konfiguriert — Ticket bleibt offen', { monitorId });
		return;
	}

	const ticket = await holeTicket(port, offene.ticketId);
	if (!istUnberuehrt(ticket, konfig)) {
		log.info('Ticket ist berührt — bleibt offen', { ticketId: offene.ticketId });
		return;
	}

	await ruf(port, 'PATCH', 'Tickets', {
		id: Number(offene.ticketId),
		status: konfig.abschlussStatusId
	});
	await merkeSchliessung(offene.id, jetzt, db);

	log.info('Ticket geschlossen', { ticketId: offene.ticketId, alertId: daten.alertId });
}

async function wirke(umgebung: Umgebung): Promise<void> {
	switch (umgebung.daten.weisung) {
		case 'eroeffnen':
			return eroeffne(umgebung);
		case 'kommentieren':
			await kommentiere(umgebung);
			return;
		case 'schliessen':
			return schliesse(umgebung);
	}
}

/**
 * Runs one delivery. Resolves when the instruction was carried out (or provably no longer applies),
 * throws when it has to be retried.
 */
export async function fuehreAus(optionen: AblaufOptionen): Promise<void> {
	const db = optionen.db ?? getDb();
	const jetzt = optionen.jetzt ?? new Date();
	const { zustellungId } = optionen;

	const auftrag = await ladeZustellung(zustellungId, db);
	if (!auftrag) {
		// The episode went with its monitor. Nothing is owed any more, and the job may finish.
		log.info('Zustellung nicht mehr vorhanden', { zustellungId });
		return;
	}

	const daten = baueEreignis(auftrag.episode, auftrag.ereignis, optionen.basisUrl ?? env.basisUrl);

	// Self-monitor events travel the watchdog's own path (SPEC §8, #30) and never reach this queue;
	// their correlation hangs off `selbst_monitor_id`, so treating one here would break the FK.
	const companyId = daten.kunde ? await companyIdFuerKunde(daten.kunde.id, db) : null;
	if (daten.monitor.art === 'selbst' || companyId === null) {
		// The link was removed after the event was planned — the operator said this customer no
		// longer goes to Autotask. Nothing is owed; releasing the chain is the correct outcome.
		log.info('Zustellung übersprungen', { zustellungId, alertId: daten.alertId });
		await vermerkeZustellung(zustellungId, 'zugestellt', jetzt, null, db);
		return;
	}

	try {
		await wirke({
			port: optionen.port,
			konfig: optionen.konfig,
			daten,
			monitorId: daten.monitor.id,
			companyId,
			uebergangId: auftrag.uebergangId,
			jetzt,
			db
		});
	} catch (err: unknown) {
		const fehler =
			err instanceof AutotaskZustellFehler
				? { klasse: err.klasse, code: err.code, text: err.message }
				: klassifiziereAusnahme(err);

		// Recorded on *every* attempt, so the operator sees the cause from the first failure on
		// rather than only once the dead letter arrives.
		await vermerkeZustellung(zustellungId, 'offen', jetzt, `${fehler.code}: ${fehler.text}`, db);

		const melde = fehler.klasse === 'dauerhaft' ? log.error : log.warn;
		melde('Ticket-Zustellung fehlgeschlagen', {
			zustellungId,
			alertId: daten.alertId,
			klasse: fehler.klasse,
			code: fehler.code,
			fehler: fehler.text
		});

		throw err;
	}

	await vermerkeZustellung(zustellungId, 'zugestellt', jetzt, null, db);
}
