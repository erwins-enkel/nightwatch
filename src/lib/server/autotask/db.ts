import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { getDb } from '../db/client';
import { einstellungen, kunde, ticketKorrelation } from '../db/schema';
import type { AutotaskTicketDefaults } from '../db/schema/system';
import type { Tx } from '../zuordnung/db';

/**
 * Every database statement the Autotask channel needs, so the modules above it stay pure.
 *
 * Two tables carry the whole integration: `einstellungen` holds the instance's access and its
 * tenant-resolved IDs, `ticket_korrelation` holds the mapping "monitor ↔ open PSA ticket" that
 * makes "ein offenes Ticket pro Monitor" (SPEC §6) a database guarantee rather than a convention.
 */

type Db = ReturnType<typeof getDb>;
type Ausfuehrer = Db | Tx;

// ---------------------------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------------------------

export interface AutotaskKonfig {
	aktiv: boolean;
	zoneUrl: string | null;
	benutzer: string | null;
	secretChiffre: string | null;
	integrationCodeChiffre: string | null;
	defaults: AutotaskTicketDefaults;
}

export async function holeKonfig(db: Ausfuehrer = getDb()): Promise<AutotaskKonfig> {
	const [zeile] = await db
		.select({
			aktiv: einstellungen.autotaskAktiv,
			zoneUrl: einstellungen.autotaskZoneUrl,
			benutzer: einstellungen.autotaskBenutzer,
			secretChiffre: einstellungen.autotaskSecretChiffre,
			integrationCodeChiffre: einstellungen.autotaskIntegrationCodeChiffre,
			defaults: einstellungen.autotaskTicketDefaults
		})
		.from(einstellungen)
		.limit(1);

	return {
		aktiv: zeile?.aktiv ?? false,
		zoneUrl: zeile?.zoneUrl ?? null,
		benutzer: zeile?.benutzer ?? null,
		secretChiffre: zeile?.secretChiffre ?? null,
		integrationCodeChiffre: zeile?.integrationCodeChiffre ?? null,
		defaults: zeile?.defaults ?? {}
	};
}

/**
 * Whether this instance can create a ticket at all.
 *
 * `statusId` and `priorityId` are Autotask's only unconditional requirements besides the company
 * (Research-Doc §3); without them every `POST /Tickets` would fail, so a half-configured instance
 * plans no delivery rather than filling the dead-letter queue with the same mistake.
 */
export function istEinsatzbereit(konfig: AutotaskKonfig): boolean {
	return (
		konfig.aktiv &&
		konfig.zoneUrl !== null &&
		konfig.benutzer !== null &&
		konfig.secretChiffre !== null &&
		konfig.integrationCodeChiffre !== null &&
		konfig.defaults.statusId !== undefined &&
		konfig.defaults.priorityId !== undefined
	);
}

export interface ZugangsEingabe {
	benutzer: string;
	/** Already encrypted; null leaves the stored value untouched (SPEC §12: never round-tripped). */
	secretChiffre: string | null;
	integrationCodeChiffre: string | null;
	aktiv: boolean;
}

export async function speichereZugang(
	eingabe: ZugangsEingabe,
	db: Ausfuehrer = getDb()
): Promise<void> {
	await db
		.update(einstellungen)
		.set({
			autotaskBenutzer: eingabe.benutzer,
			...(eingabe.secretChiffre === null ? {} : { autotaskSecretChiffre: eingabe.secretChiffre }),
			...(eingabe.integrationCodeChiffre === null
				? {}
				: { autotaskIntegrationCodeChiffre: eingabe.integrationCodeChiffre }),
			autotaskAktiv: eingabe.aktiv,
			geaendertAm: new Date()
		})
		.where(eq(einstellungen.id, 1));
}

export async function setzeZoneUrl(zoneUrl: string, db: Ausfuehrer = getDb()): Promise<void> {
	await db
		.update(einstellungen)
		.set({ autotaskZoneUrl: zoneUrl, geaendertAm: new Date() })
		.where(eq(einstellungen.id, 1));
}

export async function speichereDefaults(
	defaults: AutotaskTicketDefaults,
	db: Ausfuehrer = getDb()
): Promise<void> {
	await db
		.update(einstellungen)
		.set({ autotaskTicketDefaults: defaults, geaendertAm: new Date() })
		.where(eq(einstellungen.id, 1));
}

/** CONTEXT „Autotask-Verknüpfung": the stable company ID, set through the picker. */
export async function companyIdFuerKunde(
	kundeId: string,
	db: Ausfuehrer = getDb()
): Promise<number | null> {
	const [zeile] = await db
		.select({ companyId: kunde.autotaskCompanyId })
		.from(kunde)
		.where(eq(kunde.id, kundeId))
		.limit(1);

	return zeile?.companyId ?? null;
}

export async function setzeCompanyId(
	kundeId: string,
	companyId: number | null,
	db: Ausfuehrer = getDb()
): Promise<void> {
	await db.update(kunde).set({ autotaskCompanyId: companyId }).where(eq(kunde.id, kundeId));
}

// ---------------------------------------------------------------------------------------------
// Ticket-Korrelation
// ---------------------------------------------------------------------------------------------

export interface Korrelation {
	id: string;
	korrelationsKey: string;
	ticketId: string | null;
	ticketNummer: string | null;
}

/**
 * The monitor's open ticket, if it has one.
 *
 * A ticket outlives its episode — Erledigen and Auto-Zurück only comment — so a re-alarm has to
 * attach to it instead of opening a second one. The partial unique index
 * `ticket_offen_je_monitor_key` guarantees there is at most one row to find.
 */
export async function holeOffeneKorrelation(
	monitorId: string,
	db: Ausfuehrer = getDb()
): Promise<Korrelation | null> {
	const [zeile] = await db
		.select({
			id: ticketKorrelation.id,
			korrelationsKey: ticketKorrelation.korrelationsKey,
			ticketId: ticketKorrelation.ticketId,
			ticketNummer: ticketKorrelation.ticketNummer
		})
		.from(ticketKorrelation)
		.where(and(eq(ticketKorrelation.monitorId, monitorId), eq(ticketKorrelation.zustand, 'offen')))
		.limit(1);

	return zeile ?? null;
}

/**
 * The number of the monitor's most recently created ticket — the „Vorgänger-Verweis" a re-alarm
 * after a closed ticket carries (SPEC §6).
 */
export async function letzteTicketNummer(
	monitorId: string,
	db: Ausfuehrer = getDb()
): Promise<string | null> {
	const [zeile] = await db
		.select({ ticketNummer: ticketKorrelation.ticketNummer })
		.from(ticketKorrelation)
		.where(and(eq(ticketKorrelation.monitorId, monitorId), isNotNull(ticketKorrelation.angelegtAm)))
		.orderBy(desc(ticketKorrelation.angelegtAm))
		.limit(1);

	return zeile?.ticketNummer ?? null;
}

export interface TicketVermerk {
	monitorId: string;
	uebergangId: string;
	korrelationsKey: string;
	ticketId: string;
	ticketNummer: string | null;
	jetzt: Date;
}

/**
 * Records the ticket a correlation key stands for.
 *
 * Upsert on the key rather than a plain insert: the row is written *after* the ticket exists in
 * Autotask, so a retry that adopted an already-created ticket (via the `externalID` query) lands
 * here a second time with the same key and must not fail.
 */
export async function merkeTicket(vermerk: TicketVermerk, db: Ausfuehrer = getDb()): Promise<void> {
	await db
		.insert(ticketKorrelation)
		.values({
			monitorId: vermerk.monitorId,
			uebergangId: vermerk.uebergangId,
			korrelationsKey: vermerk.korrelationsKey,
			ticketId: vermerk.ticketId,
			ticketNummer: vermerk.ticketNummer,
			zustand: 'offen',
			angelegtAm: vermerk.jetzt
		})
		.onConflictDoUpdate({
			target: ticketKorrelation.korrelationsKey,
			set: {
				ticketId: vermerk.ticketId,
				ticketNummer: vermerk.ticketNummer,
				angelegtAm: vermerk.jetzt
			}
		});
}

export async function merkeKommentar(
	korrelationId: string,
	jetzt: Date,
	db: Ausfuehrer = getDb()
): Promise<void> {
	await db
		.update(ticketKorrelation)
		.set({ letzterKommentarAm: jetzt })
		.where(eq(ticketKorrelation.id, korrelationId));
}

export async function merkeSchliessung(
	korrelationId: string,
	jetzt: Date,
	db: Ausfuehrer = getDb()
): Promise<void> {
	await db
		.update(ticketKorrelation)
		.set({ zustand: 'geschlossen', geschlossenAm: jetzt })
		.where(eq(ticketKorrelation.id, korrelationId));
}
