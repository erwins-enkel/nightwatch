/**
 * Die Lesezugriffe des Kundenboards gegen ein echtes Postgres.
 *
 * Was hier geprüft wird, ist genau das, was die reinen Module nicht können: dass die Abfragen die
 * richtigen Zeilen holen — offene statt beendeter Episoden, Kunden-Monitore statt Selbst-Monitore,
 * aktive Kunden statt archivierter — und dass sie in der Reihenfolge kommen, in der die Ansicht sie
 * liest. Die Auswertung selbst steht in `filter.test.ts` und `zeitachse.test.ts`, ohne Datenbank.
 *
 * Läuft nur, wenn `DATABASE_URL` irgendwohin zeigt, genau wie `monitor/db.test.ts`.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { legeMonitorAn, setzeAktivierung, type MonitorEingabe } from '../monitor/db';
import { legeAusnahmekalenderAn, setzeAusnahmetage, verknuepfeKalender } from '../zeit/db';
import { legeKundeAn, setzeKundeZustand } from '../zuordnung/db';
import {
	LETZTE_MAILS,
	ladeAlarmLeiste,
	ladeBoardKunden,
	ladeBoardMonitore,
	ladeKundenDetail,
	ladeMonitorDetail
} from './db';

const databaseUrl = process.env.DATABASE_URL;
type Datenbank = ReturnType<typeof drizzle<typeof schema>>;

const JETZT = new Date('2026-07-30T06:00:00Z');

describe.skipIf(!databaseUrl && !process.env.CI)('Board-Lesezugriffe', () => {
	let pool: pg.Pool;
	let db: Datenbank;
	let kundeId: string;
	let postfachId: string;
	let laufendeNummer = 0;

	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: databaseUrl });
		db = drizzle(pool, { schema });
		await migrate(db, { migrationsFolder: 'drizzle' });
	});

	afterAll(async () => {
		await pool?.end();
	});

	beforeEach(async () => {
		await db.delete(schema.monitorAusnahmekalender);
		await db.delete(schema.ausnahmekalender);
		await db.delete(schema.postfach);
		await db.delete(schema.kunde);

		const [zeile] = await db
			.insert(schema.postfach)
			.values({
				bezeichnung: 'NOC',
				adresse: 'noc@msp.test',
				tenantId: 'tenant',
				clientId: 'client'
			})
			.returning({ id: schema.postfach.id });
		postfachId = zeile.id;

		kundeId = await legeKundeAn(
			{ name: 'Alpha AG', kundennummer: 'K-1', notiz: 'Notiz', autotaskCompanyId: null },
			db
		);
	});

	function eingabe(teile: Partial<MonitorEingabe> = {}): MonitorEingabe {
		laufendeNummer += 1;
		return {
			kundeId,
			bezeichnung: `Monitor ${laufendeNummer}`,
			art: 'heartbeat',
			parameter: {
				erwartungModus: 'intervall',
				erwartungIntervallSekunden: 86_400,
				karenzSekunden: 3600
			},
			regel: {
				absender: ['veeam.test'],
				betreffMuster: [],
				schluesselwoerter: [],
				musterSchlecht: ['failed'],
				musterGut: ['completed']
			},
			quelle: 'manuell',
			...teile
		};
	}

	async function anlegen(teile: Partial<MonitorEingabe> = {}): Promise<string> {
		const ergebnis = await legeMonitorAn(eingabe(teile), db);
		if (ergebnis.art !== 'ok') throw new Error(`Anlage fehlgeschlagen: ${ergebnis.art}`);
		return ergebnis.id;
	}

	async function stoere(
		monitorId: string,
		teile: Partial<typeof schema.uebergang.$inferInsert> = {}
	): Promise<void> {
		await db
			.update(schema.monitor)
			.set({ zustand: 'gestoert', alarmgrund: 'ueberfaellig' })
			.where(eq(schema.monitor.id, monitorId));

		await db.insert(schema.uebergang).values({
			monitorId,
			alarmgrund: 'ueberfaellig',
			begonnenAm: JETZT,
			...teile
		});
	}

	async function mailFuer(monitorId: string, ankunftszeit: Date, betreff = 'Backup report') {
		laufendeNummer += 1;
		await db.insert(schema.mail).values({
			postfachId,
			graphMessageId: `graph-${laufendeNummer}`,
			ankunftszeit,
			absender: 'veeam@alpha.test',
			betreff,
			kundeId,
			monitorId,
			klassifikation: 'ok'
		});
	}

	// -----------------------------------------------------------------------------------------
	describe('Alarm-Leiste', () => {
		it('zeigt offene Episoden mit Kunde und Monitor, älteste zuerst', async () => {
			const jung = await anlegen({ bezeichnung: 'Jung' });
			const alt = await anlegen({ bezeichnung: 'Alt' });
			await stoere(jung, { begonnenAm: new Date('2026-07-30T05:00:00Z') });
			await stoere(alt, { begonnenAm: new Date('2026-07-29T05:00:00Z') });

			const leiste = await ladeAlarmLeiste(db);

			expect(leiste.map((zeile) => zeile.monitorBezeichnung)).toEqual(['Alt', 'Jung']);
			expect(leiste[0].kundeName).toBe('Alpha AG');
			expect(leiste[0].alarmgrund).toBe('ueberfaellig');
			expect(leiste[0].alertId).toMatch(/^[0-9a-f-]{36}$/);
		});

		it('lässt beendete Episoden weg — die Leiste ist keine Historie', async () => {
			const id = await anlegen();
			await stoere(id, { beendetAm: JETZT, erholungsArt: 'beweis' });

			expect(await ladeAlarmLeiste(db)).toHaveLength(0);
		});

		/** Selbst-Monitore haben ihr eigenes Banner (SPEC §8) und gehören keinem Kunden. */
		it('lässt die Episoden der Selbst-Monitore weg', async () => {
			const [selbst] = await db
				.select({ id: schema.selbstMonitor.id })
				.from(schema.selbstMonitor)
				.limit(1);
			await db
				.insert(schema.uebergang)
				.values({ selbstMonitorId: selbst.id, alarmgrund: 'ueberfaellig' });

			expect(await ladeAlarmLeiste(db)).toHaveLength(0);
		});

		/**
		 * Archivieren rührt die Monitore nicht an, eine laufende Störung überlebt es also. Auf dem
		 * Board hat sie nichts mehr verloren — der Kunde steht dort nicht mehr, und eine Entwarnung
		 * bekommt für ihn niemand mehr (CONTEXT „Archiviert (Kunde)").
		 */
		it('lässt die offenen Episoden archivierter Kunden weg', async () => {
			const id = await anlegen();
			await stoere(id);
			expect(await ladeAlarmLeiste(db)).toHaveLength(1);

			await setzeKundeZustand(kundeId, 'archiviert', JETZT, db);

			expect(await ladeAlarmLeiste(db)).toHaveLength(0);
		});

		it('reicht Quittierung und Verschärfung durch', async () => {
			const id = await anlegen();
			await stoere(id, { quittiertAm: JETZT, verschaerftAm: JETZT, vorkommen: 4 });

			const [zeile] = await ladeAlarmLeiste(db);
			expect(zeile.quittiertAm).not.toBeNull();
			expect(zeile.verschaerftAm).not.toBeNull();
			expect(zeile.vorkommen).toBe(4);
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Kunden und Monitore', () => {
		it('liefert nur aktive Kunden', async () => {
			const archiviert = await legeKundeAn(
				{ name: 'Beta GmbH', kundennummer: null, notiz: null, autotaskCompanyId: null },
				db
			);
			await setzeKundeZustand(archiviert, 'archiviert', JETZT, db);

			expect((await ladeBoardKunden(db)).map((zeile) => zeile.name)).toEqual(['Alpha AG']);
		});

		it('lässt die Monitore archivierter Kunden weg', async () => {
			await anlegen();
			await setzeKundeZustand(kundeId, 'archiviert', JETZT, db);

			expect(await ladeBoardMonitore(undefined, db)).toHaveLength(0);
		});

		it('grenzt auf einen Kunden ein', async () => {
			const anderer = await legeKundeAn(
				{ name: 'Beta GmbH', kundennummer: null, notiz: null, autotaskCompanyId: null },
				db
			);
			await anlegen({ bezeichnung: 'Alpha-Monitor' });
			await anlegen({ kundeId: anderer, bezeichnung: 'Beta-Monitor' });

			const zeilen = await ladeBoardMonitore(kundeId, db);

			expect(zeilen.map((zeile) => zeile.bezeichnung)).toEqual(['Alpha-Monitor']);
		});

		it('trägt die Felder, aus denen das Abzeichen entsteht', async () => {
			const id = await anlegen();
			await setzeAktivierung(id, true, JETZT, db);

			const [zeile] = await ladeBoardMonitore(kundeId, db);

			expect(zeile.aktiviertAm).not.toBeNull();
			expect(zeile.zustand).toBe('gesund');
			expect(zeile.pausiert).toBe(false);
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Monitor-Detail', () => {
		it('gibt null für einen Monitor, den es nicht gibt', async () => {
			const fehlt = await ladeMonitorDetail('00000000-0000-0000-0000-000000000000', JETZT, db);
			expect(fehlt).toBeNull();
		});

		it('bringt Regel, Kunde und Zeitzone mit', async () => {
			const id = await anlegen({ bezeichnung: 'Veeam' });

			const detail = await ladeMonitorDetail(id, JETZT, db);

			expect(detail?.bezeichnung).toBe('Veeam');
			expect(detail?.kundeName).toBe('Alpha AG');
			expect(detail?.regelAbsender).toEqual(['veeam.test']);
			expect(detail?.zone).toBe('Europe/Berlin');
		});

		it('zeigt die jüngsten Mails, absteigend und begrenzt', async () => {
			const id = await anlegen();
			for (let tag = 1; tag <= LETZTE_MAILS + 3; tag += 1) {
				await mailFuer(id, new Date(`2026-07-${String(tag).padStart(2, '0')}T05:00:00Z`));
			}

			const detail = await ladeMonitorDetail(id, JETZT, db);

			expect(detail?.letzteMails).toHaveLength(LETZTE_MAILS);
			expect(detail?.letzteMails[0].ankunftszeit.getTime()).toBeGreaterThan(
				detail!.letzteMails[1].ankunftszeit.getTime()
			);
		});

		/** Die Zeitachse liest aufsteigend — sonst stimmt ihre Intervall-Kette nicht. */
		it('liefert die Ankünfte aufsteigend', async () => {
			const id = await anlegen();
			await mailFuer(id, new Date('2026-07-29T05:00:00Z'));
			await mailFuer(id, new Date('2026-07-27T05:00:00Z'));
			await mailFuer(id, new Date('2026-07-28T05:00:00Z'));

			const detail = await ladeMonitorDetail(id, JETZT, db);
			const zeiten = detail?.ankuenfte.map((ankunft) => ankunft.ankunftszeit.getTime()) ?? [];

			expect(zeiten).toEqual([...zeiten].sort((a, b) => a - b));
			expect(zeiten).toHaveLength(3);
		});

		it('lässt Mails anderer Monitore und uralte Mails draußen', async () => {
			const id = await anlegen();
			const fremd = await anlegen();
			await mailFuer(fremd, new Date('2026-07-29T05:00:00Z'));
			await mailFuer(id, new Date('2026-01-01T05:00:00Z'));

			expect((await ladeMonitorDetail(id, JETZT, db))?.ankuenfte).toHaveLength(0);
		});

		it('nennt die offene Episode und schweigt über die beendete', async () => {
			const offen = await anlegen();
			const erledigt = await anlegen();
			await stoere(offen);
			await stoere(erledigt, { beendetAm: JETZT, erholungsArt: 'beweis' });

			expect((await ladeMonitorDetail(offen, JETZT, db))?.episode?.alarmgrund).toBe('ueberfaellig');
			expect((await ladeMonitorDetail(erledigt, JETZT, db))?.episode).toBeNull();
		});

		it('markiert die zugeordneten Ausnahmekalender und listet die übrigen mit', async () => {
			const id = await anlegen();
			const feiertage = await legeAusnahmekalenderAn('Feiertage NRW', null, db);
			const werksferien = await legeAusnahmekalenderAn('Werksferien', null, db);
			await setzeAusnahmetage(feiertage, [{ datum: '2026-07-29' }], db);
			await verknuepfeKalender(id, [feiertage], db);

			const detail = await ladeMonitorDetail(id, JETZT, db);

			expect(detail?.kalender).toEqual([
				{ id: feiertage, name: 'Feiertage NRW', zugeordnet: true },
				{ id: werksferien, name: 'Werksferien', zugeordnet: false }
			]);
			expect(detail?.ausnahmetage).toEqual(['2026-07-29']);
		});

		it('nimmt nur die Ausnahmetage der zugeordneten Kalender', async () => {
			const id = await anlegen();
			const fremd = await legeAusnahmekalenderAn('Fremd', null, db);
			await setzeAusnahmetage(fremd, [{ datum: '2026-07-29' }], db);

			expect((await ladeMonitorDetail(id, JETZT, db))?.ausnahmetage).toEqual([]);
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Kunden-Detail', () => {
		it('bringt Stammdaten und Monitore', async () => {
			await anlegen({ bezeichnung: 'Veeam' });

			const detail = await ladeKundenDetail(kundeId, db);

			expect(detail?.kunde.name).toBe('Alpha AG');
			expect(detail?.kunde.kundennummer).toBe('K-1');
			expect(detail?.monitore.map((zeile) => zeile.bezeichnung)).toEqual(['Veeam']);
		});

		it('gibt null für einen Kunden, den es nicht gibt', async () => {
			expect(await ladeKundenDetail('00000000-0000-0000-0000-000000000000', db)).toBeNull();
		});
	});
});
