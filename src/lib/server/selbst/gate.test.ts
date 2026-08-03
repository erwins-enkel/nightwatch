/**
 * Das Ingestion-Gate gegen eine echte Postgres.
 *
 * Zwei Zusagen stehen hier auf dem Spiel. Erstens: ein gestörtes Postfach setzt seine
 * Überfällig-Entscheidungen aus, und zwar so lange, bis die Erholung gehalten **und** der Rückstand
 * aufgeholt ist. Zweitens — und die ist teurer, wenn sie fehlt: ein toter Kern schließt jedes Gate,
 * eine reine Zustell-Störung dagegen keines. Ohne die erste Hälfte gibt es bei totem Poller einen
 * Ticket-Sturm, ohne die zweite steht bei einem kaputten Webhook die ganze Kunden-Bewertung.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { baueGate, ladeGateSchnappschuss } from './gate';

const databaseUrl = process.env.DATABASE_URL;
type Datenbank = ReturnType<typeof drizzle<typeof schema>>;

const T = (hhmm: string) => new Date(`2026-07-29T${hhmm}:00Z`);
const STABILITAET = 900;

describe.skipIf(!databaseUrl && !process.env.CI)('Ingestion-Gate', () => {
	let pool: pg.Pool;
	let db: Datenbank;
	let postfachId: string;
	let selbstId: string;
	let laufendeNummer = 0;

	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: databaseUrl });
		db = drizzle(pool, { schema });
		await migrate(db, { migrationsFolder: 'drizzle' });
	});

	/** Auch am Ende: der Kern wird geseedet und überlebt sonst als „gestört" in fremde Suiten. */
	async function raeumeAuf() {
		await db.delete(schema.zustellung);
		await db.delete(schema.uebergang);
		await db.delete(schema.selbstMonitor).where(eq(schema.selbstMonitor.art, 'postfach'));
		await db.delete(schema.postfach);
		await db.delete(schema.heartbeat);
		await db
			.update(schema.selbstMonitor)
			.set({ zustand: 'gesund', alarmgrund: null, stalenessSekunden: 900 })
			.where(eq(schema.selbstMonitor.art, 'kern'));
	}

	afterAll(async () => {
		await raeumeAuf();
		await pool?.end();
	});

	beforeEach(async () => {
		await raeumeAuf();

		const nummer = laufendeNummer++;
		const [zeile] = await db
			.insert(schema.postfach)
			.values({
				bezeichnung: `NOC ${nummer}`,
				adresse: `noc${nummer}@msp.test`,
				tenantId: 'tenant',
				clientId: 'client',
				ingestionStandAm: T('12:00')
			})
			.returning({ id: schema.postfach.id });
		postfachId = zeile.id;

		const [selbst] = await db
			.insert(schema.selbstMonitor)
			.values({
				schluessel: `postfach:${postfachId}`,
				art: 'postfach',
				postfachId,
				bezeichnung: `Ingestion NOC ${nummer}`,
				entwarnungsStabilitaetSekunden: STABILITAET,
				zustandSeit: T('06:00')
			})
			.returning({ id: schema.selbstMonitor.id });
		selbstId = selbst.id;
	});

	async function setzeSelbst(teile: Partial<typeof schema.selbstMonitor.$inferInsert>) {
		await db.update(schema.selbstMonitor).set(teile).where(eq(schema.selbstMonitor.id, selbstId));
	}

	async function setzeKern(teile: Partial<typeof schema.selbstMonitor.$inferInsert>) {
		await db.update(schema.selbstMonitor).set(teile).where(eq(schema.selbstMonitor.art, 'kern'));
	}

	async function schreibeHeartbeat(dienst: string, zuletztGesehen: Date) {
		await db
			.insert(schema.heartbeat)
			.values({ dienst, zuletztGesehen, gestartetAm: T('00:00'), version: 'test', pid: 1 })
			.onConflictDoUpdate({ target: schema.heartbeat.dienst, set: { zuletztGesehen } });
	}

	async function gate(jetzt: Date) {
		return baueGate(await ladeGateSchnappschuss(jetzt, db));
	}

	// -----------------------------------------------------------------------------------------
	describe('Postfach-Klausel', () => {
		it('ist offen, solange das Postfach gesund und aufgeholt ist', async () => {
			expect((await gate(T('13:00'))).offen(postfachId)).toBe(true);
		});

		it('schließt, solange der Selbst-Monitor gestört ist', async () => {
			await setzeSelbst({ zustand: 'gestoert', alarmgrund: 'ueberfaellig' });

			expect((await gate(T('13:00'))).offen(postfachId)).toBe(false);
		});

		/** „Öffnet erst nach stabiler Erholung" — die frische Erholung zählt noch nicht. */
		it('bleibt zu, bis die Erholung das Stabilitätsfenster überstanden hat', async () => {
			await setzeSelbst({ zustand: 'gesund', alarmgrund: null, zustandSeit: T('12:50') });
			// Der Rückstand ist aufgeholt, damit hier wirklich nur das Stabilitätsfenster misst.
			await db
				.update(schema.postfach)
				.set({ ingestionStandAm: T('12:51') })
				.where(eq(schema.postfach.id, postfachId));

			expect((await gate(T('12:55'))).offen(postfachId)).toBe(false);
			expect((await gate(T('13:06'))).offen(postfachId)).toBe(true);
		});

		/**
		 * „Und aufgeholtem Rückstand": die Vollständigkeits-Zusage rückt nur vor, wenn eine Delta-Runde
		 * abschließt — sie ist damit der Beweis, dass die aufgelaufene Mail wirklich da ist.
		 */
		it('bleibt zu, solange die Vollständigkeits-Zusage hinter der Erholung liegt', async () => {
			await setzeSelbst({ zustandSeit: T('06:00') });
			await db
				.update(schema.postfach)
				.set({ ingestionStandAm: T('05:00') })
				.where(eq(schema.postfach.id, postfachId));

			expect((await gate(T('13:00'))).offen(postfachId)).toBe(false);
		});

		it('bleibt zu, wenn nie eine Runde abgeschlossen hat', async () => {
			await db
				.update(schema.postfach)
				.set({ ingestionStandAm: null })
				.where(eq(schema.postfach.id, postfachId));

			expect((await gate(T('13:00'))).offen(postfachId)).toBe(false);
		});

		it('lässt einen Monitor ohne Postfach-Bezug durch', async () => {
			expect((await gate(T('13:00'))).offen(null)).toBe(true);
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Kern-Klausel', () => {
		/**
		 * Ein toter Kern macht zwangsläufig alle Postfächer still. Bliebe das Gate offen, liefe genau
		 * der Ticket-Sturm los, den es verhindern soll.
		 */
		it('schließt jedes Gate, wenn der Kern gestört und der worker still ist', async () => {
			await setzeKern({ zustand: 'gestoert', alarmgrund: 'ueberfaellig' });
			await schreibeHeartbeat('worker', T('06:00'));

			const offen = await gate(T('13:00'));
			expect(offen.offen(postfachId)).toBe(false);
			expect(offen.offen(null)).toBe(false);
		});

		it('schließt auch, wenn der worker überhaupt nie gemeldet hat', async () => {
			await setzeKern({ zustand: 'gestoert', alarmgrund: 'ueberfaellig' });

			expect((await gate(T('13:00'))).offen(postfachId)).toBe(false);
		});

		/**
		 * Die Ausnahme, ohne die die Klausel zu scharf wäre: ein kaputter Webhook hält die Ingestion
		 * nicht an, also darf er auch die Kunden-Bewertung nicht anhalten.
		 */
		it('lässt eine reine Zustell-Störung das Gate offen', async () => {
			await setzeKern({ zustand: 'gestoert', alarmgrund: 'fehler_gemeldet' });
			await schreibeHeartbeat('worker', T('12:59'));

			expect((await gate(T('13:00'))).offen(postfachId)).toBe(true);
		});

		/**
		 * Auch wenn der lebende Grund durch eine Verschärfung auf „Fehler gemeldet" gewandert ist:
		 * gezählt wird der Heartbeat, nicht die Spalte — sonst verschwände „die Dienste schweigen"
		 * genau dann aus der Bewertung, wenn zusätzlich die Zustellung bricht.
		 */
		it('schließt trotz verschärftem Grund, solange der worker still ist', async () => {
			await setzeKern({ zustand: 'gestoert', alarmgrund: 'fehler_gemeldet' });
			await schreibeHeartbeat('worker', T('06:00'));

			expect((await gate(T('13:00'))).offen(postfachId)).toBe(false);
		});

		it('schließt nichts, solange der Kern gesund ist', async () => {
			await schreibeHeartbeat('worker', T('06:00'));

			expect((await gate(T('13:00'))).offen(postfachId)).toBe(true);
		});
	});
});
