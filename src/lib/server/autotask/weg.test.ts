/**
 * Der Alarmweg: wann Autotask überhaupt zugestellt bekommt, und wie eine Zustellung genau einmal in
 * die Queue gerät.
 *
 * `uebergib` braucht keine Datenbank, `plane` liest Einstellungen und Kunde — deshalb die zweite
 * Hälfte gegen echte Postgres, wie `alarm/db.test.ts`.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { PgBoss } from 'pg-boss';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { baueEreignis, type EpisodenSicht } from '../alarm/ereignis';
import * as schema from '../db/schema';
import { legeKundeAn } from '../zuordnung/db';
import { AUTOTASK_QUEUE, autotaskWeg } from './weg';

const databaseUrl = process.env.DATABASE_URL;
const BASIS = 'https://nightwatch.msp.example';

interface Gesendet {
	queue: string;
	daten: unknown;
	optionen: { id?: string } | undefined;
}

/** Merkt sich die Sendungen; genau wie pg-boss legt ein zweiter Anlauf derselben ID nichts an. */
function fakeBoss(gesendet: Gesendet[]): PgBoss {
	const ids = new Set<string>();
	return {
		send(queue: string, daten: unknown, optionen: { id?: string } | undefined) {
			gesendet.push({ queue, daten, optionen });
			if (optionen?.id && ids.has(optionen.id)) return Promise.resolve(null);
			if (optionen?.id) ids.add(optionen.id);
			return Promise.resolve(optionen?.id ?? 'job-1');
		}
	} as unknown as PgBoss;
}

function sicht(teile: Partial<EpisodenSicht> = {}): EpisodenSicht {
	return {
		alertId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
		vorgaengerAlertId: null,
		alarmgrund: 'ueberfaellig',
		begonnenAm: new Date('2026-07-28T04:00:00Z'),
		letztesVorkommenAm: new Date('2026-07-28T04:00:00Z'),
		vorkommen: 1,
		verschaerftAm: null,
		beendetAm: null,
		erholungsArt: null,
		monitor: {
			art: 'heartbeat',
			id: '11111111-1111-1111-1111-111111111111',
			bezeichnung: 'Veeam Nachtlauf'
		},
		kunde: { id: '33333333-3333-3333-3333-333333333333', name: 'Kunde A' },
		...teile
	};
}

describe('Übergabe an die Queue', () => {
	it('macht die Zustellungs-ID zur Identität des Jobs', async () => {
		const gesendet: Gesendet[] = [];
		const weg = autotaskWeg(fakeBoss(gesendet));

		const jobId = await weg.uebergib(baueEreignis(sicht(), 'alarm', BASIS), 'zustellung-1');

		expect(jobId).toBe('zustellung-1');
		expect(gesendet).toHaveLength(1);
		expect(gesendet[0].queue).toBe(AUTOTASK_QUEUE);
		expect(gesendet[0].optionen?.id).toBe('zustellung-1');
		expect(gesendet[0].daten).toEqual({ zustellungId: 'zustellung-1' });
	});

	it('meldet auch den Wiederholungsversuch als übergeben', async () => {
		// pg-boss legt bei gleicher ID nichts an und antwortet `null`. Würde der Weg das als „nicht
		// übergeben" zurückgeben, wiederholte der Publisher die Übergabe bei jedem Tick — für immer.
		const gesendet: Gesendet[] = [];
		const weg = autotaskWeg(fakeBoss(gesendet));
		const daten = baueEreignis(sicht(), 'alarm', BASIS);

		await weg.uebergib(daten, 'zustellung-1');
		expect(await weg.uebergib(daten, 'zustellung-1')).toBe('zustellung-1');
	});
});

describe.skipIf(!databaseUrl && !process.env.CI)('Planen', () => {
	let pool: pg.Pool;
	let db: ReturnType<typeof drizzle<typeof schema>>;
	let kundeId: string;

	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: databaseUrl });
		db = drizzle(pool, { schema });
		await migrate(db, { migrationsFolder: 'drizzle' });
	});

	afterAll(async () => {
		await pool?.end();
	});

	beforeEach(async () => {
		await db.delete(schema.kunde);
		await db
			.update(schema.einstellungen)
			.set({
				autotaskAktiv: true,
				autotaskZoneUrl: 'https://webservices3.autotask.net/atservicesrest/',
				autotaskBenutzer: 'api@msp.test',
				autotaskSecretChiffre: 'chiffre',
				autotaskIntegrationCodeChiffre: 'chiffre',
				autotaskTicketDefaults: {
					statusId: 1,
					priorityId: 2,
					notizTypId: 1,
					notizPublishId: 1
				}
			})
			.where(eq(schema.einstellungen.id, 1));

		kundeId = await legeKundeAn(
			{ name: 'Kunde A', kundennummer: null, notiz: null, autotaskCompanyId: 4711 },
			db
		);
	});

	const weg = autotaskWeg(fakeBoss([]));

	const plane = (teile: Partial<EpisodenSicht> = {}) =>
		db.transaction((tx) =>
			weg.plane(
				baueEreignis(sicht({ kunde: { id: kundeId, name: 'Kunde A' }, ...teile }), 'alarm', BASIS),
				tx
			)
		);

	it('plant eine Zustellung, wenn alles steht', async () => {
		expect(await plane()).toEqual([{ webhookZielId: null }]);
	});

	it('schaltet sich ab, solange Autotask aus ist', async () => {
		await db
			.update(schema.einstellungen)
			.set({ autotaskAktiv: false })
			.where(eq(schema.einstellungen.id, 1));

		expect(await plane()).toEqual([]);
	});

	it('plant nichts, solange die Ticket-Pflicht-IDs fehlen', async () => {
		// Ohne Status und Priorität scheitert jedes `POST /Tickets` — dann lieber gar nicht erst
		// zustellen, statt die Dead-Letter-Queue mit demselben Fehler zu füllen.
		await db
			.update(schema.einstellungen)
			.set({ autotaskTicketDefaults: { queueId: 8, notizTypId: 1, notizPublishId: 1 } })
			.where(eq(schema.einstellungen.id, 1));

		expect(await plane()).toEqual([]);
	});

	it('plant nichts, solange die Notiz-Pflicht-IDs fehlen', async () => {
		// Sonst öffnete der Alarm ein Ticket, das die Entwarnung nie kommentieren oder schließen
		// könnte — die Störung stünde offen und der Dead-Letter wüchse mit jedem Ereignis.
		await db
			.update(schema.einstellungen)
			.set({ autotaskTicketDefaults: { statusId: 1, priorityId: 2 } })
			.where(eq(schema.einstellungen.id, 1));

		expect(await plane()).toEqual([]);
	});

	it('plant nichts ohne Zone oder Zugangsdaten', async () => {
		await db
			.update(schema.einstellungen)
			.set({ autotaskZoneUrl: null })
			.where(eq(schema.einstellungen.id, 1));

		expect(await plane()).toEqual([]);
	});

	it('lässt den Kunden ohne Verknüpfung über Dashboard und Webhook laufen', async () => {
		// CONTEXT „Autotask-Verknüpfung": legitim, nicht jeder Betreiber nutzt Autotask.
		await db
			.update(schema.kunde)
			.set({ autotaskCompanyId: null })
			.where(eq(schema.kunde.id, kundeId));

		expect(await plane()).toEqual([]);
	});

	it('rührt Selbst-Monitor-Ereignisse nicht an', async () => {
		// Die sendet der Watchdog auf eigenem Pfad (SPEC §8).
		const selbst = await plane({
			monitor: {
				art: 'selbst',
				id: '22222222-2222-2222-2222-222222222222',
				bezeichnung: 'Nightwatch-Kern',
				schluessel: 'kern'
			},
			kunde: null
		});

		expect(selbst).toEqual([]);
	});
});
