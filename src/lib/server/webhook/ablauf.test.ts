/**
 * Die Zustellung gegen echte Postgres, mit einem gefälschten Empfänger.
 *
 * Die Bausteine hängen ohne Datenbank in `nutzlast.test.ts` und `signatur.test.ts`; hier steht das
 * Zusammenspiel, das nur mit Datenbank sichtbar wird: dass ein Erfolg die Zeile schließt, dass ein
 * Fehlschlag seine Diagnose hinterlässt und geworfen wird (damit die Queue erneut anläuft), dass
 * ein abgeschaltetes Ziel die Kette freigibt — und dass ein Selbst-Monitor-Ereignis wirklich
 * hinausgeht.
 *
 * Läuft nur, wenn `DATABASE_URL` irgendwohin zeigt — wie `alarm/db.test.ts`.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verschluessele } from '../crypto';
import * as schema from '../db/schema';
import { legeMonitorAn, setzeAktivierung } from '../monitor/db';
import { legeKundeAn } from '../zuordnung/db';
import { fuehreAus } from './ablauf';
import type { WebhookAntwort, WebhookPort } from './client';
import { legeZielAn, setzeAktiv } from './db';
import type { WebhookNutzlast } from './nutzlast';

const databaseUrl = process.env.DATABASE_URL;
const BASIS = 'https://nightwatch.msp.test';
const SECRET = 'ein-geheimnis';
const JETZT = new Date('2026-07-28T07:00:00Z');

interface Aufruf {
	url: string;
	koerper: string;
	kopfzeilen: Record<string, string>;
}

/** Ein Empfänger, der sich merkt, was ankommt — und auf Wunsch die Antwort verweigert. */
class FakeEmpfaenger implements WebhookPort {
	readonly aufrufe: Aufruf[] = [];
	antwort: WebhookAntwort = { status: 200, text: '' };
	/** Statt einer Antwort ein toter Socket. */
	wirft: Error | null = null;

	sende(url: string, koerper: string, kopfzeilen: Record<string, string>): Promise<WebhookAntwort> {
		this.aufrufe.push({ url, koerper, kopfzeilen });
		if (this.wirft) return Promise.reject(this.wirft);
		return Promise.resolve(this.antwort);
	}

	/** Der Körper, wie ihn ein Empfänger parst — nach der Signaturprüfung, nicht davor. */
	nutzlast(index = 0): WebhookNutzlast {
		return JSON.parse(this.aufrufe[index].koerper) as WebhookNutzlast;
	}
}

describe.skipIf(!databaseUrl && !process.env.CI)('Webhook-Zustellung', () => {
	let pool: pg.Pool;
	let db: ReturnType<typeof drizzle<typeof schema>>;
	let port: FakeEmpfaenger;
	let zielId: string;
	let kundeId: string;

	/**
	 * Der Ablauf entschlüsselt das Secret über den impliziten Weg (`entschluessele(chiffre)`), also
	 * muss ein Schlüssel in der Umgebung stehen. Der Fall stellt ihn selbst — wie `crypto.test.ts`
	 * — statt ihn von außen zu erwarten: `bun run test` soll ohne gesetztes
	 * `NIGHTWATCH_SECRET_KEY` durchlaufen, lokal wie in der CI.
	 */
	const urspruenglicherSchluessel = process.env.NIGHTWATCH_SECRET_KEY;

	beforeAll(async () => {
		process.env.NIGHTWATCH_SECRET_KEY = randomBytes(32).toString('base64');
		pool = new pg.Pool({ connectionString: databaseUrl });
		db = drizzle(pool, { schema });
		await migrate(db, { migrationsFolder: 'drizzle' });
	});

	afterAll(async () => {
		if (urspruenglicherSchluessel === undefined) delete process.env.NIGHTWATCH_SECRET_KEY;
		else process.env.NIGHTWATCH_SECRET_KEY = urspruenglicherSchluessel;
		await pool?.end();
	});

	beforeEach(async () => {
		await db.delete(schema.zustellung);
		await db.delete(schema.uebergang);
		await db.delete(schema.webhookZiel);
		await db.delete(schema.selbstMonitor).where(eq(schema.selbstMonitor.art, 'postfach'));
		await db.delete(schema.kunde);

		port = new FakeEmpfaenger();
		zielId = await legeZielAn(
			{
				bezeichnung: 'RMM',
				url: 'https://rmm.msp.test/hook',
				httpErlaubt: false,
				secretChiffre: verschluessele(SECRET)
			},
			db
		);
		kundeId = await legeKundeAn(
			{ name: 'Muster GmbH', kundennummer: null, notiz: null, autotaskCompanyId: null },
			db
		);
	});

	// -----------------------------------------------------------------------------------------
	// Aufbau
	// -----------------------------------------------------------------------------------------

	async function legeMonitor(): Promise<string> {
		const ergebnis = await legeMonitorAn(
			{
				kundeId,
				bezeichnung: 'Veeam Nachtlauf',
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
				quelle: 'manuell'
			},
			db
		);
		if (ergebnis.art !== 'ok') throw new Error(`Anlage fehlgeschlagen: ${ergebnis.art}`);
		await setzeAktivierung(ergebnis.id, true, new Date('2026-07-28T00:00:00Z'), db);
		return ergebnis.id;
	}

	/** Episode plus offene Zustellung — geschrieben, wie der Publisher (bzw. #30) es tut. */
	async function legeZustellungAn(
		besitzer: { monitorId: string } | { selbstMonitorId: string },
		teile: Partial<typeof schema.uebergang.$inferInsert> = {}
	): Promise<string> {
		const [episode] = await db
			.insert(schema.uebergang)
			.values({
				...besitzer,
				alarmgrund: 'ueberfaellig',
				begonnenAm: new Date('2026-07-28T06:10:00Z'),
				letztesVorkommenAm: new Date('2026-07-28T06:10:00Z'),
				alarmiertAm: new Date('2026-07-28T06:11:00Z'),
				...teile
			})
			.returning({ id: schema.uebergang.id });

		const [zeile] = await db
			.insert(schema.zustellung)
			.values({
				uebergangId: episode.id,
				ereignis: 'alarm',
				kanal: 'webhook',
				webhookZielId: zielId
			})
			.returning({ id: schema.zustellung.id });

		return zeile.id;
	}

	const stelleZu = (zustellungId: string) =>
		fuehreAus({ zustellungId, port, jetzt: JETZT, basisUrl: BASIS, db });

	async function zustellZeile(id: string) {
		const [zeile] = await db.select().from(schema.zustellung).where(eq(schema.zustellung.id, id));
		return zeile;
	}

	// -----------------------------------------------------------------------------------------
	describe('Erfolg', () => {
		it('sendet den signierten Körper und schließt die Zeile', async () => {
			const monitorId = await legeMonitor();
			const id = await legeZustellungAn({ monitorId });

			await stelleZu(id);

			expect(port.aufrufe).toHaveLength(1);
			const [aufruf] = port.aufrufe;
			expect(aufruf.url).toBe('https://rmm.msp.test/hook');
			expect(aufruf.kopfzeilen['Content-Type']).toBe('application/json');
			expect(aufruf.kopfzeilen['X-Nightwatch-Event']).toBe('alarm');

			// Die Signatur gehört zu **diesen** Bytes — genau die Rechnung, die die Doku vorgibt.
			const erwartet = createHmac('sha256', SECRET).update(aufruf.koerper, 'utf8').digest('hex');
			expect(aufruf.kopfzeilen['X-Nightwatch-Signature']).toBe(`sha256=${erwartet}`);

			const nutzlast = port.nutzlast();
			expect(nutzlast.ereignis).toBe('alarm');
			expect(nutzlast.monitor).toEqual({
				art: 'heartbeat',
				id: monitorId,
				bezeichnung: 'Veeam Nachtlauf'
			});
			expect(nutzlast.kunde).toEqual({ id: kundeId, name: 'Muster GmbH' });
			expect(nutzlast.rueckverweis).toBe(`${BASIS}/monitore/${monitorId}`);

			const zeile = await zustellZeile(id);
			expect(zeile.zustand).toBe('zugestellt');
			expect(zeile.zugestelltAm).toEqual(JETZT);
			expect(zeile.versuche).toBe(1);
			expect(zeile.letzterFehler).toBeNull();
		});

		/**
		 * Der Fall, den dieser Kanal als einziger trägt (SPEC §7): `monitor.art = "selbst"`,
		 * `kunde = null`, Rückverweis auf das System-Banner statt auf eine Monitor-Seite.
		 */
		it('stellt ein Selbst-Monitor-Ereignis zu', async () => {
			const [selbst] = await db
				.insert(schema.selbstMonitor)
				.values({
					schluessel: 'postfach:noc',
					art: 'postfach',
					bezeichnung: 'Ingestion Postfach NOC'
				})
				.returning({ id: schema.selbstMonitor.id });

			const id = await legeZustellungAn({ selbstMonitorId: selbst.id });

			await stelleZu(id);

			const nutzlast = port.nutzlast();
			expect(nutzlast.monitor).toEqual({
				art: 'selbst',
				id: selbst.id,
				bezeichnung: 'Ingestion Postfach NOC',
				schluessel: 'postfach:noc'
			});
			expect(nutzlast.kunde).toBeNull();
			expect(nutzlast.rueckverweis).toBe(`${BASIS}/system`);

			const erwartet = createHmac('sha256', SECRET)
				.update(port.aufrufe[0].koerper, 'utf8')
				.digest('hex');
			expect(port.aufrufe[0].kopfzeilen['X-Nightwatch-Signature']).toBe(`sha256=${erwartet}`);
			expect((await zustellZeile(id)).zustand).toBe('zugestellt');
		});

		it('nimmt jede 2xx-Antwort an', async () => {
			const monitorId = await legeMonitor();
			const id = await legeZustellungAn({ monitorId });
			port.antwort = { status: 204, text: '' };

			await stelleZu(id);

			expect((await zustellZeile(id)).zustand).toBe('zugestellt');
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Fehlschlag', () => {
		it('hält die Zeile offen, vermerkt die Diagnose und wirft', async () => {
			const monitorId = await legeMonitor();
			const id = await legeZustellungAn({ monitorId });
			port.antwort = { status: 503, text: 'upstream down' };

			await expect(stelleZu(id)).rejects.toThrow(/503/);

			const zeile = await zustellZeile(id);
			expect(zeile.zustand).toBe('offen');
			expect(zeile.versuche).toBe(1);
			expect(zeile.letzterFehler).toBe('HTTP 503: upstream down');
			expect(zeile.zugestelltAm).toBeNull();
		});

		/** Umleitungen werden nicht verfolgt — ein 301 ist ein Fehlschlag, kein stiller Umzug. */
		it('behandelt eine Umleitung als Fehlschlag', async () => {
			const monitorId = await legeMonitor();
			const id = await legeZustellungAn({ monitorId });
			port.antwort = { status: 301, text: '' };

			await expect(stelleZu(id)).rejects.toThrow(/301/);
			expect((await zustellZeile(id)).letzterFehler).toBe('HTTP 301');
		});

		it('vermerkt einen toten Socket', async () => {
			const monitorId = await legeMonitor();
			const id = await legeZustellungAn({ monitorId });
			port.wirft = new Error('socket hang up');

			await expect(stelleZu(id)).rejects.toThrow(/socket hang up/);
			expect((await zustellZeile(id)).letzterFehler).toBe('Error: socket hang up');
		});

		/** SPEC §7 kennt keinen unsignierten Webhook: lieber Dead-Letter als ungeschützt senden. */
		it('sendet nicht ohne Secret', async () => {
			const monitorId = await legeMonitor();
			const id = await legeZustellungAn({ monitorId });
			await db
				.update(schema.webhookZiel)
				.set({ secretChiffre: null })
				.where(eq(schema.webhookZiel.id, zielId));

			await expect(stelleZu(id)).rejects.toThrow(/Secret/);

			expect(port.aufrufe).toEqual([]);
			const zeile = await zustellZeile(id);
			expect(zeile.zustand).toBe('offen');
			expect(zeile.letzterFehler).toMatch(/Secret/);
		});

		/** Jeder Versuch stempelt neu — sonst verwürfe ein Zeitfenster beim Empfänger den Retry. */
		it('stempelt den Wiederholungsversuch neu', async () => {
			const monitorId = await legeMonitor();
			const id = await legeZustellungAn({ monitorId });
			port.antwort = { status: 500, text: '' };

			await expect(stelleZu(id)).rejects.toThrow();
			port.antwort = { status: 200, text: '' };
			const spaeter = new Date(JETZT.getTime() + 3_600_000);
			await fuehreAus({ zustellungId: id, port, jetzt: spaeter, basisUrl: BASIS, db });

			expect(port.nutzlast(0).gesendet_am).toBe(JETZT.toISOString());
			expect(port.nutzlast(1).gesendet_am).toBe(spaeter.toISOString());
			// Die Identität bleibt — daran erkennt der Empfänger, dass es dasselbe Ereignis ist.
			expect(port.nutzlast(1).alert_id).toBe(port.nutzlast(0).alert_id);

			const zeile = await zustellZeile(id);
			expect(zeile.zustand).toBe('zugestellt');
			expect(zeile.versuche).toBe(2);
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Nichts mehr zu tun', () => {
		it('lässt eine abgeschaltete Zustellung die Kette freigeben', async () => {
			const monitorId = await legeMonitor();
			const id = await legeZustellungAn({ monitorId });
			await setzeAktiv(zielId, false, db);

			await stelleZu(id);

			expect(port.aufrufe).toEqual([]);
			expect((await zustellZeile(id)).zustand).toBe('zugestellt');
		});

		it('nimmt eine verschwundene Zustellung hin', async () => {
			await expect(
				fuehreAus({
					zustellungId: '00000000-0000-0000-0000-000000000000',
					port,
					jetzt: JETZT,
					basisUrl: BASIS,
					db
				})
			).resolves.toBeUndefined();

			expect(port.aufrufe).toEqual([]);
		});
	});
});
