/**
 * Vorlagen und Ableitungs-Material gegen ein echtes Postgres.
 *
 * Das Format selbst hat seine Tests ohne Datenbank (`vorlage.test.ts`). Hier steht, was nur
 * Postgres beantworten kann: dass der Release-Sync wiederholbar ist und dabei weder eine eigene
 * Vorlage noch eine neuere Fassung überschreibt, und dass die Beispiel-Mail eines Einstiegs samt
 * gespeichertem Takt herauskommt — auch dann, wenn es zu ihr gar keine Sorte gibt.
 *
 * Läuft nur, wenn `DATABASE_URL` irgendwohin zeigt, genau wie die übrigen DB-Suiten.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { legeMonitorAn } from '../monitor/db';
import { legeKundeAn } from '../zuordnung/db';
import {
	importiereVorlagen,
	ladeQuelleAusMail,
	ladeQuelleAusSorte,
	ladeSortenVerlauf,
	listeVorlagen,
	loescheVorlage,
	synchronisiereVorlagen,
	vorlageAusMonitor
} from './db';
import { KURATIERTE_VORLAGEN } from './kuratiert';
import type { VorlagenEintrag } from './vorlage';

const databaseUrl = process.env.DATABASE_URL;
type Datenbank = ReturnType<typeof drizzle<typeof schema>>;

const EIGEN: VorlagenEintrag = {
	schluessel: 'eigen-report',
	name: 'Eigener Report',
	version: 1,
	absender: ['reports@kunde.test'],
	betreffMuster: [],
	schluesselwoerter: [],
	musterSchlecht: [],
	musterGut: []
};

describe.skipIf(!databaseUrl && !process.env.CI)('Regel-Entstehung', () => {
	let pool: pg.Pool;
	let db: Datenbank;

	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: databaseUrl });
		db = drizzle(pool, { schema });
		await migrate(db, { migrationsFolder: 'drizzle' });
	});

	afterAll(async () => {
		await pool?.end();
	});

	beforeEach(async () => {
		await db.delete(schema.regelVorlage);
		await db.delete(schema.postfach);
		await db.delete(schema.kunde);
	});

	// -----------------------------------------------------------------------------------------
	describe('Kuratierte Vorlagen', () => {
		it('spielt die mitgelieferten Vorlagen ein', async () => {
			const geschrieben = await synchronisiereVorlagen(db);

			expect(geschrieben).toBe(KURATIERTE_VORLAGEN.length);
			const vorlagen = await listeVorlagen(db);
			expect(vorlagen).toHaveLength(KURATIERTE_VORLAGEN.length);
			expect(vorlagen.every((vorlage) => vorlage.herkunft === 'kuratiert')).toBe(true);
		});

		/** Migrate-on-Startup läuft bei jedem Start (SPEC §14) — der zweite darf nichts tun. */
		it('schreibt beim zweiten Start nichts mehr', async () => {
			await synchronisiereVorlagen(db);

			expect(await synchronisiereVorlagen(db)).toBe(0);
		});

		it('hebt eine Vorlage an, wenn das Release eine höhere Version bringt', async () => {
			await synchronisiereVorlagen(db);
			const [schluessel] = KURATIERTE_VORLAGEN.map((vorlage) => vorlage.schluessel);

			// Eine ältere Fassung simulieren, wie sie eine Vorgänger-Version hinterlassen hätte.
			await db
				.update(schema.regelVorlage)
				.set({ version: 0, name: 'alt' })
				.where(eq(schema.regelVorlage.schluessel, schluessel));

			expect(await synchronisiereVorlagen(db)).toBe(1);
			const [zeile] = await db
				.select()
				.from(schema.regelVorlage)
				.where(eq(schema.regelVorlage.schluessel, schluessel));
			expect(zeile.name).not.toBe('alt');
		});

		it('senkt eine neuere Vorlage nicht auf die Version des Images ab', async () => {
			await synchronisiereVorlagen(db);
			const [schluessel] = KURATIERTE_VORLAGEN.map((vorlage) => vorlage.schluessel);
			await db
				.update(schema.regelVorlage)
				.set({ version: 99, name: 'aus der Zukunft' })
				.where(eq(schema.regelVorlage.schluessel, schluessel));

			expect(await synchronisiereVorlagen(db)).toBe(0);
			const [zeile] = await db
				.select()
				.from(schema.regelVorlage)
				.where(eq(schema.regelVorlage.schluessel, schluessel));
			expect(zeile.name).toBe('aus der Zukunft');
		});

		/** „Sein Fundus gehört ihm": ein Release fasst eine eigene Vorlage nie an. */
		it('rührt eine eigene Vorlage mit demselben Schlüssel nicht an', async () => {
			const schluessel = KURATIERTE_VORLAGEN[0].schluessel;
			await importiereVorlagen([{ ...EIGEN, schluessel, name: 'meine Fassung' }], db);

			// Die übrigen kuratierten Vorlagen entstehen ganz normal — nur die belegte Zeile bleibt.
			expect(await synchronisiereVorlagen(db)).toBe(KURATIERTE_VORLAGEN.length - 1);
			const [zeile] = await db
				.select()
				.from(schema.regelVorlage)
				.where(eq(schema.regelVorlage.schluessel, schluessel));
			expect(zeile).toMatchObject({ name: 'meine Fassung', herkunft: 'eigen' });
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Eigene Vorlagen', () => {
		it('legt eine importierte Vorlage als eigene an und aktualisiert sie beim zweiten Import', async () => {
			expect(await importiereVorlagen([EIGEN], db)).toEqual({ geschrieben: 1, abgelehnt: [] });
			expect(await importiereVorlagen([{ ...EIGEN, name: 'Neu' }], db)).toEqual({
				geschrieben: 1,
				abgelehnt: []
			});

			const [zeile] = await listeVorlagen(db);
			expect(zeile).toMatchObject({ name: 'Neu', herkunft: 'eigen' });
		});

		it('lehnt einen Import auf einen kuratierten Schlüssel ab', async () => {
			await synchronisiereVorlagen(db);
			const schluessel = KURATIERTE_VORLAGEN[0].schluessel;

			expect(await importiereVorlagen([{ ...EIGEN, schluessel }], db)).toEqual({
				geschrieben: 0,
				abgelehnt: [schluessel]
			});
		});

		it('löscht eigene Vorlagen, kuratierte nicht', async () => {
			await synchronisiereVorlagen(db);
			await importiereVorlagen([EIGEN], db);
			const vorlagen = await listeVorlagen(db);
			const eigene = vorlagen.find((vorlage) => vorlage.herkunft === 'eigen')!;
			const kuratierte = vorlagen.find((vorlage) => vorlage.herkunft === 'kuratiert')!;

			expect(await loescheVorlage(eigene.id, db)).toBe('geloescht');
			expect(await loescheVorlage(kuratierte.id, db)).toBe('kuratiert');
		});

		it('macht aus einer bestehenden Regel eine eigene Vorlage samt Parametern', async () => {
			const kundeId = await legeKundeAn(
				{ name: 'Kunde A', kundennummer: null, notiz: null, autotaskCompanyId: null },
				db
			);
			const angelegt = await legeMonitorAn(
				{
					kundeId,
					bezeichnung: 'Backup',
					art: 'heartbeat',
					parameter: {
						erwartungModus: 'intervall',
						erwartungIntervallSekunden: 86_400,
						karenzSekunden: 3600
					},
					regel: {
						absender: ['reports@veeam.test'],
						betreffMuster: ['^Backup'],
						schluesselwoerter: [],
						musterSchlecht: ['failed'],
						musterGut: ['success']
					},
					quelle: 'manuell'
				},
				db
			);
			expect(angelegt.art).toBe('ok');
			if (angelegt.art !== 'ok') return;

			const ergebnis = await vorlageAusMonitor(
				angelegt.id,
				{ schluessel: 'aus-monitor', name: 'Aus Monitor' },
				db
			);

			expect(ergebnis).toEqual({ geschrieben: 1, abgelehnt: [] });
			const [zeile] = await listeVorlagen(db);
			expect(zeile).toMatchObject({
				herkunft: 'eigen',
				vorgeschlageneArt: 'heartbeat',
				absender: ['reports@veeam.test'],
				musterGut: ['success']
			});
			expect(zeile.parameterDefaults).toEqual({
				erwartungModus: 'intervall',
				erwartungIntervallSekunden: 86_400,
				karenzSekunden: 3600
			});
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Material für die Ableitung', () => {
		const ANKUNFT = new Date('2026-07-27T03:40:00Z');
		let postfachId: string;

		beforeEach(async () => {
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
		});

		async function sorteMitMails(anzahl: number) {
			const kundeId = await legeKundeAn(
				{ name: 'Kunde A', kundennummer: null, notiz: null, autotaskCompanyId: null },
				db
			);
			const [sorte] = await db
				.insert(schema.mailSorte)
				.values({
					kundeId,
					signatur: 'sig',
					absender: 'reports@veeam.test',
					betreffMuster: 'Backup Job # completed',
					anzahl,
					taktKlasse: 'taeglich',
					taktUhrzeit: '05:40',
					taktVorkommen: anzahl,
					taktStreuungSekunden: 600
				})
				.returning({ id: schema.mailSorte.id });

			for (let i = 0; i < anzahl; i++) {
				await db.insert(schema.mail).values({
					postfachId,
					graphMessageId: `graph-${i}`,
					ankunftszeit: new Date(ANKUNFT.getTime() + i * 86_400_000),
					absender: 'reports@veeam.test',
					betreff: `Backup Job ${i} completed`,
					bodyText: i % 2 === 0 ? 'Leitung ab' : 'Leitung wieder da',
					kundeId,
					sorteId: sorte.id
				});
			}

			return sorte.id;
		}

		it('liefert die jüngste Mail einer Sorte samt gespeichertem Takt', async () => {
			const sorteId = await sorteMitMails(4);

			const quelle = await ladeQuelleAusSorte(sorteId, db);

			expect(quelle).toMatchObject({
				absender: 'reports@veeam.test',
				betreff: 'Backup Job 3 completed',
				sortenAnzahl: 4
			});
			expect(quelle?.takt).toEqual({
				klasse: 'taeglich',
				uhrzeit: '05:40',
				vorkommen: 4,
				streuungSekunden: 600
			});
		});

		/**
		 * Der Takt kommt aus der Sorte, nicht aus einer zweiten Rechnung — sonst zeigte die
		 * Sorten-Ansicht einen anderen Rhythmus als der Wizard, den sie geöffnet hat.
		 */
		it('liest den Takt der Sorte, nicht die Mails darunter', async () => {
			const sorteId = await sorteMitMails(4);
			await db
				.update(schema.mailSorte)
				.set({ taktKlasse: 'woechentlich', taktWochentag: 3, taktUhrzeit: '07:15' })
				.where(eq(schema.mailSorte.id, sorteId));

			const quelle = await ladeQuelleAusSorte(sorteId, db);

			expect(quelle?.takt).toMatchObject({ klasse: 'woechentlich', wochentag: 3 });
		});

		/** Eine Triage-Mail hat keinen Kunden und damit keine Sorte — die Ableitung läuft trotzdem. */
		it('liefert eine Mail ohne Sorte ohne Takt', async () => {
			const [zeile] = await db
				.insert(schema.mail)
				.values({
					postfachId,
					graphMessageId: 'graph-triage',
					ankunftszeit: ANKUNFT,
					absender: 'unbekannt@fremd.test',
					betreff: 'Etwas Neues',
					bodyText: null
				})
				.returning({ id: schema.mail.id });

			const quelle = await ladeQuelleAusMail(zeile.id, db);

			expect(quelle).toMatchObject({ kundeId: null, sorteId: null, takt: null, sortenAnzahl: 0 });
		});

		it('gibt den Verlauf einer Sorte aufsteigend heraus', async () => {
			const sorteId = await sorteMitMails(3);

			const verlauf = await ladeSortenVerlauf(sorteId, 500, db);

			expect(verlauf.map((mail) => mail.betreff)).toEqual([
				'Backup Job 0 completed',
				'Backup Job 1 completed',
				'Backup Job 2 completed'
			]);
		});
	});
});
