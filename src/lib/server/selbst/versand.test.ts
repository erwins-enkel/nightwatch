/**
 * Der Direktversand, soweit ihn nur eine echte Postgres zeigt: was der Watchdog pro Tick an Ports
 * aufbaut und welche Zustellungen ein Selbst-Ereignis überhaupt bekommt.
 *
 * Der wichtigste Fall ist der stillste: ein unlesbarer Autotask-Zugang darf **nicht** als
 * „Datenbank weg" durchschlagen. Der Aufrufer deutet jede Ausnahme aus diesem Pfad als
 * Postgres-Ausfall — ein falscher `NIGHTWATCH_SECRET_KEY` würde sonst einen Datenbank-Alarm
 * auslösen, den es nicht gibt. Ein Selbst-Monitor, der über sich selbst die Unwahrheit sagt, ist
 * genau das, was diese Funktion nicht sein darf.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verschluessele } from '../crypto';
import * as schema from '../db/schema';
import type { AutotaskTicketDefaults } from '../db/schema/system';
import { baueVersandPorts, planeSelbstZustellungen } from './versand';

const databaseUrl = process.env.DATABASE_URL;
type Datenbank = ReturnType<typeof drizzle<typeof schema>>;

/** Alles, was `istEinsatzbereit()` verlangt — der Abschluss-Status ist bewusst optional. */
const VOLLSTAENDIG: AutotaskTicketDefaults = {
	statusId: 1,
	priorityId: 2,
	notizTypId: 3,
	notizPublishId: 4
};

describe.skipIf(!databaseUrl && !process.env.CI)('Selbst-Versand', () => {
	let pool: pg.Pool;
	let db: Datenbank;

	beforeAll(async () => {
		process.env.NIGHTWATCH_SECRET_KEY ??= Buffer.alloc(32, 5).toString('base64');
		pool = new pg.Pool({ connectionString: databaseUrl });
		db = drizzle(pool, { schema });
		await migrate(db, { migrationsFolder: 'drizzle' });
	});

	async function raeumeAuf() {
		await db.delete(schema.zustellung);
		await db.delete(schema.webhookZiel);
		await db
			.update(schema.einstellungen)
			.set({
				autotaskAktiv: false,
				autotaskZoneUrl: null,
				autotaskBenutzer: null,
				autotaskSecretChiffre: null,
				autotaskIntegrationCodeChiffre: null,
				autotaskTicketDefaults: null
			})
			.where(eq(schema.einstellungen.id, 1));
	}

	afterAll(async () => {
		await raeumeAuf();
		await pool?.end();
	});

	beforeEach(raeumeAuf);

	async function setzeAutotask(
		defaults: AutotaskTicketDefaults,
		chiffren: { secret: string; code: string }
	) {
		await db
			.update(schema.einstellungen)
			.set({
				autotaskAktiv: true,
				autotaskZoneUrl: 'https://webservices3.autotask.net/atservicesrest/',
				autotaskBenutzer: 'api@msp.test',
				autotaskSecretChiffre: chiffren.secret,
				autotaskIntegrationCodeChiffre: chiffren.code,
				autotaskTicketDefaults: defaults
			})
			.where(eq(schema.einstellungen.id, 1));
	}

	describe('Ports', () => {
		it('hat ohne Autotask-Konfiguration nur den Webhook-Port', async () => {
			const ports = await baueVersandPorts(db);

			expect(ports.webhook).toBeDefined();
			expect(ports.autotask).toBeNull();
		});

		it('baut den Autotask-Port, sobald alles steht und eine Firma benannt ist', async () => {
			await setzeAutotask(
				{ ...VOLLSTAENDIG, selbstCompanyId: 42 },
				{ secret: verschluessele('s3cr3t'), code: verschluessele('code') }
			);

			expect((await baueVersandPorts(db)).autotask).not.toBeNull();
		});

		/** „Gehört keinem Kunden; wohin sein Ticket geht, ist reine Transport-Konfiguration." */
		it('lässt Autotask aus, solange keine Firma für Selbst-Monitore benannt ist', async () => {
			await setzeAutotask(VOLLSTAENDIG, {
				secret: verschluessele('s3cr3t'),
				code: verschluessele('code')
			});

			expect((await baueVersandPorts(db)).autotask).toBeNull();
		});

		/**
		 * Der Fall, für den diese Datei existiert: ein rotierter oder falsch getippter Schlüssel darf
		 * keine Ausnahme aus diesem Pfad werfen — der Aufrufer läse sie als Postgres-Ausfall.
		 */
		it('wirft nicht, wenn der Zugang nicht entschlüsselbar ist', async () => {
			await setzeAutotask(
				{ ...VOLLSTAENDIG, selbstCompanyId: 42 },
				{ secret: 'v1.kaputt', code: 'v1.auch-kaputt' }
			);

			const ports = await baueVersandPorts(db);
			expect(ports.autotask).toBeNull();
			expect(ports.webhook).toBeDefined();
		});
	});

	describe('Planung', () => {
		it('plant je aktivem Webhook-Ziel eine Zustellung', async () => {
			await db.insert(schema.webhookZiel).values([
				{ bezeichnung: 'A', url: 'https://a.msp.test/hook' },
				{ bezeichnung: 'B', url: 'https://b.msp.test/hook' },
				{ bezeichnung: 'Alt', url: 'https://alt.msp.test/hook', aktiv: false }
			]);

			const eintraege = await db.transaction((tx) => planeSelbstZustellungen(tx));

			expect(eintraege.filter((eintrag) => eintrag.kanal === 'webhook').length).toBe(2);
		});

		it('plant Autotask nur mit vollständiger Konfiguration und benannter Firma', async () => {
			await setzeAutotask(VOLLSTAENDIG, {
				secret: verschluessele('s3cr3t'),
				code: verschluessele('code')
			});
			expect(await db.transaction((tx) => planeSelbstZustellungen(tx))).toEqual([]);

			await setzeAutotask(
				{ ...VOLLSTAENDIG, selbstCompanyId: 42 },
				{ secret: verschluessele('s3cr3t'), code: verschluessele('code') }
			);
			expect(await db.transaction((tx) => planeSelbstZustellungen(tx))).toEqual([
				{ kanal: 'autotask', webhookZielId: null }
			]);
		});

		it('plant gar nichts, solange kein Kanal eingerichtet ist', async () => {
			expect(await db.transaction((tx) => planeSelbstZustellungen(tx))).toEqual([]);
		});
	});
});
