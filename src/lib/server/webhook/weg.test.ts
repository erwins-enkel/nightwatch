/**
 * Der Alarmweg: an wen ein Ereignis überhaupt geht, und wie eine Zustellung genau einmal in die
 * Queue gerät.
 *
 * `uebergib` braucht keine Datenbank, `plane` liest die Ziele — deshalb die zweite Hälfte gegen
 * echte Postgres, wie `autotask/weg.test.ts`.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { PgBoss } from 'pg-boss';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { baueEreignis, type EpisodenSicht } from '../alarm/ereignis';
import * as schema from '../db/schema';
import { legeZielAn, setzeAktiv } from './db';
import { WEBHOOK_QUEUE, webhookWeg } from './weg';

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
		const weg = webhookWeg(fakeBoss(gesendet));

		const jobId = await weg.uebergib(baueEreignis(sicht(), 'alarm', BASIS), 'zustellung-1');

		expect(jobId).toBe('zustellung-1');
		expect(gesendet).toHaveLength(1);
		expect(gesendet[0].queue).toBe(WEBHOOK_QUEUE);
		expect(gesendet[0].optionen?.id).toBe('zustellung-1');
		expect(gesendet[0].daten).toEqual({ zustellungId: 'zustellung-1' });
	});

	it('meldet auch den Wiederholungsversuch als übergeben', async () => {
		// pg-boss legt bei gleicher ID nichts an und antwortet `null`. Würde der Weg das als „nicht
		// übergeben" zurückgeben, wiederholte der Publisher die Übergabe bei jedem Tick — für immer.
		const gesendet: Gesendet[] = [];
		const weg = webhookWeg(fakeBoss(gesendet));
		const daten = baueEreignis(sicht(), 'alarm', BASIS);

		await weg.uebergib(daten, 'zustellung-1');
		expect(await weg.uebergib(daten, 'zustellung-1')).toBe('zustellung-1');
	});
});

describe.skipIf(!databaseUrl && !process.env.CI)('Planen', () => {
	let pool: pg.Pool;
	let db: ReturnType<typeof drizzle<typeof schema>>;

	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: databaseUrl });
		db = drizzle(pool, { schema });
		await migrate(db, { migrationsFolder: 'drizzle' });
	});

	afterAll(async () => {
		await pool?.end();
	});

	beforeEach(async () => {
		await db.delete(schema.zustellung);
		await db.delete(schema.webhookZiel);
	});

	const weg = webhookWeg(fakeBoss([]));

	const plane = (teile: Partial<EpisodenSicht> = {}) =>
		db.transaction((tx) => weg.plane(baueEreignis(sicht(teile), 'alarm', BASIS), tx));

	it('plant nichts, solange kein Ziel eingerichtet ist', async () => {
		expect(await plane()).toEqual([]);
	});

	it('plant je aktivem Ziel eine Zustellung', async () => {
		const erstes = await legeZielAn({
			bezeichnung: 'RMM',
			url: 'https://rmm.msp.test/hook',
			httpErlaubt: false,
			secretChiffre: 'v1.chiffre'
		});
		const zweites = await legeZielAn({
			bezeichnung: 'PSA',
			url: 'https://psa.msp.test/hook',
			httpErlaubt: false,
			secretChiffre: 'v1.chiffre'
		});

		expect(await plane()).toEqual([{ webhookZielId: erstes }, { webhookZielId: zweites }]);
	});

	it('übergeht ein abgeschaltetes Ziel', async () => {
		const aktiv = await legeZielAn({
			bezeichnung: 'RMM',
			url: 'https://rmm.msp.test/hook',
			httpErlaubt: false,
			secretChiffre: 'v1.chiffre'
		});
		const still = await legeZielAn({
			bezeichnung: 'Alt',
			url: 'https://alt.msp.test/hook',
			httpErlaubt: false,
			secretChiffre: 'v1.chiffre'
		});
		await setzeAktiv(still, false);

		expect(await plane()).toEqual([{ webhookZielId: aktiv }]);
	});

	/**
	 * SPEC §7: „Selbst-Monitor-Events tragen `monitor.art = "selbst"`, `kunde = null`." Anders als
	 * bei Autotask ist das hier kein Ausschlussgrund — der Webhook ist der Kanal, der sie trägt.
	 */
	it('plant auch für ein Selbst-Monitor-Ereignis', async () => {
		const ziel = await legeZielAn({
			bezeichnung: 'RMM',
			url: 'https://rmm.msp.test/hook',
			httpErlaubt: false,
			secretChiffre: 'v1.chiffre'
		});

		const geplant = await plane({
			monitor: {
				art: 'selbst',
				id: '22222222-2222-2222-2222-222222222222',
				bezeichnung: 'Nightwatch-Kern',
				schluessel: 'kern'
			},
			kunde: null
		});

		expect(geplant).toEqual([{ webhookZielId: ziel }]);
	});
});
