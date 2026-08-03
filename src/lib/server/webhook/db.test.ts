/**
 * Die Webhook-Ziele gegen eine echte Postgres.
 *
 * Zwei Zusagen hängen hier an der Datenbank statt am Formular: **nur HTTPS** (HTTP ausschließlich
 * mit ausdrücklichem Opt-in, SPEC §12) und **kein Löschen, solange Zustellungen daran hängen** —
 * die sind der Beleg dafür, dass Alarme diesen Empfänger nicht erreicht haben (SPEC §8).
 *
 * Läuft nur, wenn `DATABASE_URL` irgendwohin zeigt — wie `alarm/db.test.ts`.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import {
	aktiveZiele,
	aktualisiereZiel,
	entferneZiel,
	ladeZiel,
	legeZielAn,
	listeZiele,
	setzeAktiv,
	type ZielEingabe
} from './db';

const databaseUrl = process.env.DATABASE_URL;
type Datenbank = ReturnType<typeof drizzle<typeof schema>>;

describe.skipIf(!databaseUrl && !process.env.CI)('Webhook-Ziele', () => {
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
		await db.delete(schema.zustellung);
		await db.delete(schema.uebergang);
		await db.delete(schema.webhookZiel);
	});

	/**
	 * Die Regel, an der Postgres die Anweisung abgewiesen hat — drizzle verpackt den Treiberfehler,
	 * und nur der `pg`-Fehler darunter kennt den Namen. Dieselbe Grabung wie in `schema.test.ts`.
	 */
	function verletzteRegel(fehler: unknown): string | undefined {
		for (let e: unknown = fehler; e instanceof Error; e = e.cause) {
			const { constraint } = e as { constraint?: unknown };
			if (typeof constraint === 'string') return constraint;
		}
		return undefined;
	}

	/**
	 * Prüft, dass eine Anweisung an einer **benannten** Zusage scheitert. Ein bloßes „es warf" ginge
	 * auch bei einem Tippfehler durch, und die Zusage könnte still fehlen.
	 */
	async function wirdAbgelehnt(verstoss: string, body: () => Promise<unknown>): Promise<void> {
		const fehler = await body().then(
			() => undefined,
			(err: unknown) => err
		);

		expect(fehler, `erwartet: Verletzung von ${verstoss}, tatsächlich ging es durch`).toBeDefined();
		expect(verletzteRegel(fehler)).toBe(verstoss);
	}

	function eingabe(teile: Partial<ZielEingabe> = {}): ZielEingabe {
		return {
			bezeichnung: 'RMM',
			url: 'https://rmm.msp.test/hook',
			httpErlaubt: false,
			secretChiffre: 'v1.chiffre',
			...teile
		};
	}

	/** Eine Zustellung an dieses Ziel — hängt an der Episode des Kern-Selbst-Monitors. */
	async function legeZustellungAn(zielId: string): Promise<string> {
		const [kern] = await db
			.select({ id: schema.selbstMonitor.id })
			.from(schema.selbstMonitor)
			.where(eq(schema.selbstMonitor.schluessel, 'kern'));

		const [episode] = await db
			.insert(schema.uebergang)
			.values({ selbstMonitorId: kern.id, alarmgrund: 'ueberfaellig' })
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

	// -----------------------------------------------------------------------------------------
	describe('Transport', () => {
		it('nimmt HTTPS an — mit und ohne Opt-in', async () => {
			await expect(legeZielAn(eingabe())).resolves.toBeTypeOf('string');
			await expect(
				legeZielAn(eingabe({ url: 'https://zweit.msp.test/hook', httpErlaubt: true }))
			).resolves.toBeTypeOf('string');
		});

		it('weist HTTP ohne Opt-in ab und nimmt es mit Opt-in an', async () => {
			await wirdAbgelehnt('webhook_ziel_transport', () =>
				legeZielAn(eingabe({ url: 'http://intern.msp.test/hook' }))
			);

			await expect(
				legeZielAn(eingabe({ url: 'http://intern.msp.test/hook', httpErlaubt: true }))
			).resolves.toBeTypeOf('string');
		});

		/** Das Opt-in erlaubt **HTTP** — kein beliebiges Schema. */
		it('weist ein fremdes Schema ab, auch mit Opt-in', async () => {
			await wirdAbgelehnt('webhook_ziel_transport', () =>
				legeZielAn(eingabe({ url: 'ftp://datei.msp.test/hook' }))
			);

			await wirdAbgelehnt('webhook_ziel_transport', () =>
				legeZielAn(eingabe({ url: 'ftp://datei.msp.test/hook', httpErlaubt: true }))
			);
		});

		/** Auch der Umweg über das Bearbeiten führt nicht an der Zusage vorbei. */
		it('lässt ein bestehendes Ziel nicht nachträglich auf HTTP fallen', async () => {
			const id = await legeZielAn(eingabe());

			await wirdAbgelehnt('webhook_ziel_transport', () =>
				aktualisiereZiel(id, eingabe({ url: 'http://intern.msp.test/hook' }))
			);

			const [unveraendert] = await listeZiele();
			expect(unveraendert.url).toBe('https://rmm.msp.test/hook');
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Verwaltung', () => {
		it('zeigt nur, dass ein Secret hinterlegt ist — nie seinen Wert', async () => {
			await legeZielAn(eingabe());
			await legeZielAn(eingabe({ url: 'https://ohne.msp.test/hook', secretChiffre: null }));

			const ziele = await listeZiele();

			expect(ziele.map((ziel) => ziel.secretGespeichert)).toEqual([true, false]);
			expect(JSON.stringify(ziele)).not.toContain('chiffre');
		});

		it('behält das gespeicherte Secret, wenn das Formular keines mitschickt', async () => {
			const id = await legeZielAn(eingabe());

			await aktualisiereZiel(id, eingabe({ bezeichnung: 'RMM neu', secretChiffre: null }));

			const [zeile] = await db
				.select({
					bezeichnung: schema.webhookZiel.bezeichnung,
					secretChiffre: schema.webhookZiel.secretChiffre
				})
				.from(schema.webhookZiel)
				.where(eq(schema.webhookZiel.id, id));

			expect(zeile.bezeichnung).toBe('RMM neu');
			expect(zeile.secretChiffre).toBe('v1.chiffre');
		});

		it('führt nur aktive Ziele für die Planung', async () => {
			const aktiv = await legeZielAn(eingabe());
			const still = await legeZielAn(eingabe({ url: 'https://still.msp.test/hook' }));
			await setzeAktiv(still, false);

			expect((await aktiveZiele()).map((ziel) => ziel.id)).toEqual([aktiv]);
		});

		/**
		 * Der Fremdschlüssel steht auf `restrict`: das Löschen eines Empfängers darf den Nachweis
		 * nicht mitnehmen, dass Alarme ihn nicht erreicht haben. Zum Abschalten gibt es `aktiv`.
		 */
		it('verweigert das Löschen, solange Zustellungen daran hängen', async () => {
			const id = await legeZielAn(eingabe());
			await legeZustellungAn(id);

			await wirdAbgelehnt('zustellung_webhook_ziel_id_webhook_ziel_id_fk', () => entferneZiel(id));

			await setzeAktiv(id, false);
			expect((await listeZiele()).map((ziel) => ziel.aktiv)).toEqual([false]);
		});

		it('löscht ein Ziel, an dem nichts mehr hängt', async () => {
			const id = await legeZielAn(eingabe());

			await entferneZiel(id);

			expect(await listeZiele()).toEqual([]);
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Ziel einer Zustellung', () => {
		it('findet den Empfänger über die Zustellung', async () => {
			const id = await legeZielAn(eingabe());
			const zustellungId = await legeZustellungAn(id);

			expect(await ladeZiel(zustellungId)).toEqual({
				id,
				url: 'https://rmm.msp.test/hook',
				aktiv: true,
				secretChiffre: 'v1.chiffre'
			});
		});

		it('liefert nichts für eine unbekannte Zustellung', async () => {
			expect(await ladeZiel('00000000-0000-0000-0000-000000000000')).toBeNull();
		});
	});
});
