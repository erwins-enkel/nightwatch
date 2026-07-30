import { and, asc, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import {
	ausnahmekalender,
	kunde,
	mail,
	monitor,
	monitorAusnahmekalender,
	uebergang
} from '../db/schema';
import type { Alarmgrund, Klassifikation, MonitorArt } from '../db/schema/enums';
import { holeMonitor } from '../monitor/db';
import { ladeAusnahmetage, ladeZeitzone } from '../zeit/db';
import type { Tx } from '../zuordnung/db';
import type { BoardMonitorZeile, KundenZeile } from './filter';
import { ACHSE_TAGE, VORLAUF_TAGE, type Ankunft } from './zeitachse';

/**
 * Die Lesezugriffe des Kundenboards (SPEC §9) — nur Abfragen, keine Entscheidungen. Was aus ihnen
 * wird, entscheiden `filter.ts` und `zeitachse.ts`, und die sehen keine Datenbank.
 */

type Db = ReturnType<typeof getDb>;
type Ausfuehrer = Db | Tx;

const TAG_MS = 86_400_000;

/**
 * Wie viele Ankünfte die Zeitachse höchstens bekommt.
 *
 * Weit über jeder realen Konfiguration — ein Monitor, der in sechs Wochen zweitausend Mails
 * einsammelt, ist selbst schon der Befund. Die Grenze greift von hinten, damit die jüngsten Tage
 * vollständig bleiben; würde sie je erreicht, könnte die älteste Spalte eine Lücke untertreiben.
 */
const ANKUENFTE_GRENZE = 2000;

/** Wie viele Mails der Drawer unter „letzte zugeordnete Mails" zeigt. */
export const LETZTE_MAILS = 10;

// ---------------------------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------------------------

export interface AlarmZeile {
	/** Die nach außen veröffentlichte Kennung (SPEC §6) — auch im UI die zitierfähige. */
	alertId: string;
	monitorId: string;
	monitorBezeichnung: string;
	art: MonitorArt;
	kundeId: string;
	kundeName: string;
	alarmgrund: Alarmgrund;
	begonnenAm: Date;
	vorkommen: number;
	quittiertAm: Date | null;
	verschaerftAm: Date | null;
}

/**
 * Der Rumpf jeder Alarm-Abfrage.
 *
 * Der innere Join auf `monitor` ist zugleich der Filter auf Kunden-Monitore: die Episoden der
 * Selbst-Monitore tragen `monitor_id = null` und fallen hier heraus. Sie haben ihr eigenes Banner
 * (SPEC §8) und gehören keinem Kunden.
 */
function alarmAbfrage(db: Ausfuehrer) {
	return db
		.select({
			alertId: uebergang.alertId,
			monitorId: monitor.id,
			monitorBezeichnung: monitor.bezeichnung,
			art: monitor.art,
			kundeId: kunde.id,
			kundeName: kunde.name,
			alarmgrund: uebergang.alarmgrund,
			begonnenAm: uebergang.begonnenAm,
			vorkommen: uebergang.vorkommen,
			quittiertAm: uebergang.quittiertAm,
			verschaerftAm: uebergang.verschaerftAm
		})
		.from(uebergang)
		.innerJoin(monitor, eq(monitor.id, uebergang.monitorId))
		.innerJoin(kunde, eq(kunde.id, monitor.kundeId));
}

/**
 * Die Alarm-Leiste: jede offene Episode eines Monitors eines **aktiven** Kunden, älteste zuerst.
 *
 * Älteste zuerst, weil die Leiste eine Arbeitsliste ist und kein Nachrichtenticker — was am
 * längsten steht, ist am längsten unbearbeitet.
 *
 * Der Filter auf aktive Kunden ist keine Kosmetik: das Archivieren rührt die Monitore nicht an
 * (`zuordnung/db.ts` → `setzeKundeZustand`), eine laufende Störung überlebt es also erst einmal.
 * Ohne ihn stünde in der Leiste ein Alarm, dessen Kunde auf dem Board gar nicht mehr vorkommt —
 * und für den niemand mehr eine Entwarnung bekommt (CONTEXT „Archiviert (Kunde)").
 */
export function ladeAlarmLeiste(db: Ausfuehrer = getDb()): Promise<AlarmZeile[]> {
	return alarmAbfrage(db)
		.where(and(isNull(uebergang.beendetAm), eq(kunde.zustand, 'aktiv')))
		.orderBy(asc(uebergang.begonnenAm));
}

/**
 * Die aktiven Kunden. Archivierte gehören in die Kunden-Verwaltung: ihre Monitore werten nicht mehr
 * aus und ihre Störungen enden still (CONTEXT „Archiviert (Kunde)").
 */
export function ladeBoardKunden(db: Ausfuehrer = getDb()): Promise<KundenZeile[]> {
	return db
		.select({
			id: kunde.id,
			name: kunde.name,
			kundennummer: kunde.kundennummer,
			autotaskCompanyId: kunde.autotaskCompanyId
		})
		.from(kunde)
		.where(eq(kunde.zustand, 'aktiv'))
		.orderBy(asc(kunde.name));
}

/**
 * Die Monitore der aktiven Kunden, flach.
 *
 * Gruppiert und gefiltert wird in `filter.ts`, nicht in SQL: die Zeilen sind schmal und ihre Zahl
 * folgt der Konfiguration, nicht dem Mailaufkommen — ein MSP mit zweihundert Kunden zu je zwanzig
 * Monitoren liegt im niedrigen vierstelligen Bereich. Dafür ist die Filter-Logik ohne Datenbank
 * prüfbar, und das ist der Teil, der Fehler machen kann.
 */
export function ladeBoardMonitore(
	kundeId?: string,
	db: Ausfuehrer = getDb()
): Promise<BoardMonitorZeile[]> {
	return db
		.select({
			id: monitor.id,
			kundeId: monitor.kundeId,
			bezeichnung: monitor.bezeichnung,
			art: monitor.art,
			zustand: monitor.zustand,
			alarmgrund: monitor.alarmgrund,
			pausiert: monitor.pausiert,
			pausiertBis: monitor.pausiertBis,
			zustandSeit: monitor.zustandSeit,
			aktiviertAm: monitor.aktiviertAm,
			zuletztGesehenAm: monitor.zuletztGesehenAm
		})
		.from(monitor)
		.innerJoin(kunde, eq(kunde.id, monitor.kundeId))
		.where(
			kundeId === undefined
				? eq(kunde.zustand, 'aktiv')
				: and(eq(kunde.zustand, 'aktiv'), eq(monitor.kundeId, kundeId))
		)
		.orderBy(asc(monitor.bezeichnung));
}

// ---------------------------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------------------------

export interface MailZeile {
	id: string;
	ankunftszeit: Date;
	absender: string;
	betreff: string;
	klassifikation: Klassifikation | null;
}

export interface KalenderZeile {
	id: string;
	name: string;
	zugeordnet: boolean;
}

export type MonitorDetail = NonNullable<Awaited<ReturnType<typeof holeMonitor>>> & {
	/** Die offene Episode, oder null. Den Zustand trägt der Monitor selbst. */
	episode: AlarmZeile | null;
	letzteMails: MailZeile[];
	ankuenfte: Ankunft[];
	ausnahmetage: string[];
	kalender: KalenderZeile[];
	zone: string;
};

/** Höchstens eine — „ein Alarm pro Übergang" ist ein partieller Unique-Index (SPEC §6). */
async function offeneEpisode(monitorId: string, db: Ausfuehrer): Promise<AlarmZeile | null> {
	const [zeile] = await alarmAbfrage(db)
		.where(and(isNull(uebergang.beendetAm), eq(uebergang.monitorId, monitorId)))
		.limit(1);

	return zeile ?? null;
}

function letzteMails(monitorId: string, db: Ausfuehrer): Promise<MailZeile[]> {
	return db
		.select({
			id: mail.id,
			ankunftszeit: mail.ankunftszeit,
			absender: mail.absender,
			betreff: mail.betreff,
			klassifikation: mail.klassifikation
		})
		.from(mail)
		.where(eq(mail.monitorId, monitorId))
		.orderBy(desc(mail.ankunftszeit))
		.limit(LETZTE_MAILS);
}

/**
 * Die Ankünfte, aus denen die Zeitachse ihre Spalten baut.
 *
 * Der Vorlauf ist keine Bequemlichkeit: das Deckungsfenster eines Soll reicht bis zum vorherigen
 * wirksamen Soll zurück, bei einem Wochenplan mit Ausnahmetagen bis zu `VORLAUF_TAGE`. Ohne ihn
 * hielte die Achse den ersten Soll des Fensters für ungedeckt, nur weil die deckende Mail knapp
 * davor eintraf.
 */
async function ankuenfte(monitorId: string, jetzt: Date, db: Ausfuehrer): Promise<Ankunft[]> {
	// Ein Tag Zugabe: das Fenster beginnt an der Tagesgrenze der Instanz-Zeitzone, hier wird aber
	// vom Instant aus gerechnet.
	const von = new Date(jetzt.getTime() - (ACHSE_TAGE + VORLAUF_TAGE + 1) * TAG_MS);

	const zeilen = await db
		.select({ ankunftszeit: mail.ankunftszeit, klassifikation: mail.klassifikation })
		.from(mail)
		.where(and(eq(mail.monitorId, monitorId), gte(mail.ankunftszeit, von)))
		.orderBy(desc(mail.ankunftszeit))
		.limit(ANKUENFTE_GRENZE);

	// Die Zeitachse liest aufsteigend; die Abfrage sortiert absteigend, damit die Grenze von hinten
	// greift.
	return zeilen.reverse();
}

/** Alle Ausnahmekalender, jeder mit der Angabe, ob er an diesem Monitor hängt. */
function kalenderFuer(monitorId: string, db: Ausfuehrer): Promise<KalenderZeile[]> {
	return db
		.select({
			id: ausnahmekalender.id,
			name: ausnahmekalender.name,
			zugeordnet: sql<boolean>`${monitorAusnahmekalender.monitorId} is not null`
		})
		.from(ausnahmekalender)
		.leftJoin(
			monitorAusnahmekalender,
			and(
				eq(monitorAusnahmekalender.kalenderId, ausnahmekalender.id),
				eq(monitorAusnahmekalender.monitorId, monitorId)
			)
		)
		.orderBy(asc(ausnahmekalender.name));
}

/**
 * `YYYY-MM-DD` in UTC — nur als Grenze für die Ausnahmetag-Abfrage, die einen Tag zu weit greifen
 * darf. Welcher Tag wirklich ein Ausnahmetag ist, entscheidet die Zeitachse in der Instanz-Zone.
 */
function isoTag(zeitpunkt: Date): string {
	return zeitpunkt.toISOString().slice(0, 10);
}

/** Alles, was der Monitor-Drawer zeigt — oder null, wenn es den Monitor nicht gibt. */
export async function ladeMonitorDetail(
	id: string,
	jetzt: Date,
	db: Ausfuehrer = getDb()
): Promise<MonitorDetail | null> {
	const grund = await holeMonitor(id, db);
	if (grund === undefined) return null;

	const von = isoTag(new Date(jetzt.getTime() - (ACHSE_TAGE + 1) * TAG_MS));
	const bis = isoTag(new Date(jetzt.getTime() + TAG_MS));

	const [episode, mails, verlauf, tage, kalender, zone] = await Promise.all([
		offeneEpisode(id, db),
		letzteMails(id, db),
		ankuenfte(id, jetzt, db),
		ladeAusnahmetage([id], von, bis, db),
		kalenderFuer(id, db),
		ladeZeitzone(db)
	]);

	return {
		...grund,
		episode,
		letzteMails: mails,
		ankuenfte: verlauf,
		ausnahmetage: tage.get(id) ?? [],
		kalender,
		zone
	};
}

export interface KundenDetail {
	kunde: KundenZeile & { notiz: string | null };
	monitore: BoardMonitorZeile[];
}

/** Alles, was der Kunden-Drawer zeigt — oder null, wenn es den Kunden nicht (mehr) gibt. */
export async function ladeKundenDetail(
	id: string,
	db: Ausfuehrer = getDb()
): Promise<KundenDetail | null> {
	const [zeile] = await db
		.select({
			id: kunde.id,
			name: kunde.name,
			kundennummer: kunde.kundennummer,
			autotaskCompanyId: kunde.autotaskCompanyId,
			notiz: kunde.notiz
		})
		.from(kunde)
		.where(eq(kunde.id, id))
		.limit(1);

	if (zeile === undefined) return null;

	return { kunde: zeile, monitore: await ladeBoardMonitore(id, db) };
}
