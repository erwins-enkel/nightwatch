import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
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
 * Whether this instance can carry an alarm episode through to its end.
 *
 * Deliberately not just "can it create a ticket": an episode is alarm, possibly Verschärfung, and
 * an Entwarnung, and the last two are **notes**. `noteType` and `publish` are required on
 * `TicketNotes` exactly as `status` and `priority` are required on `Tickets`, so an instance that
 * has only the ticket half configured would open a ticket it can then never comment on or close —
 * the all-clear would dead-letter while the alarm stands, which is worse than not alerting through
 * Autotask at all.
 *
 * `abschlussStatusId` is **not** in here on purpose: without it Nightwatch simply never closes
 * automatically, which is a supported choice rather than a broken configuration.
 */
export function istEinsatzbereit(konfig: AutotaskKonfig): boolean {
	const { statusId, priorityId, notizTypId, notizPublishId } = konfig.defaults;

	return (
		konfig.aktiv &&
		konfig.zoneUrl !== null &&
		konfig.benutzer !== null &&
		konfig.secretChiffre !== null &&
		konfig.integrationCodeChiffre !== null &&
		statusId !== undefined &&
		priorityId !== undefined &&
		notizTypId !== undefined &&
		notizPublishId !== undefined
	);
}

export interface ZugangsEingabe {
	benutzer: string;
	/** Already encrypted; null leaves the stored value untouched (SPEC §12: never round-tripped). */
	secretChiffre: string | null;
	integrationCodeChiffre: string | null;
	aktiv: boolean;
}

/**
 * Saves the access — and drops the stored zone whenever the API user changes.
 *
 * The zone belongs to *that user's* Autotask database (Research-Doc §1), so a new user can mean a
 * different database. Keeping the old URL would leave the instance looking ready while pointing
 * every authenticated request at the previous tenant. Invalidating it costs the operator one click
 * on „Zone ermitteln"; not invalidating it costs them a silent misroute.
 *
 * Done as one statement rather than read-compare-write: the comparison happens in the same UPDATE
 * that overwrites the value it compares against, so no concurrent save can slip between the two.
 */
export async function speichereZugang(
	eingabe: ZugangsEingabe,
	db: Ausfuehrer = getDb()
): Promise<void> {
	await db
		.update(einstellungen)
		.set({
			autotaskBenutzer: eingabe.benutzer,
			autotaskZoneUrl: sql`case when ${einstellungen.autotaskBenutzer} is distinct from ${eingabe.benutzer}
				then null else ${einstellungen.autotaskZoneUrl} end`,
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
