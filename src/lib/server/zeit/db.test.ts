/**
 * Der Zeit-Scheduler gegen eine echte Postgres.
 *
 * Die Entscheidungen selbst hängen in `faelligkeit.test.ts` und `kalenderplan.test.ts` ohne
 * Datenbank. Hier steht nur, was allein Postgres beweist: die Bewertungs-Schranke, das Rennen
 * zwischen Ingestion, Zuordnung und Auswertung, der Cursor über Neustarts hinweg und dass zwei
 * Ticks nicht zweimal alarmieren.
 *
 * Läuft nur, wenn `DATABASE_URL` irgendwohin zeigt — wie `monitor/db.test.ts`.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { legeMonitorAn, setzeAktivierung } from '../monitor/db';
import { monitorStufe } from '../monitor/pipeline';
import { verarbeiteStapel } from '../zuordnung/verarbeitung';
import { legeKundeAn, legeMerkmalAn, setzeKundeZustand } from '../zuordnung/db';
import {
	bewertungsSchranke,
	legeAusnahmekalenderAn,
	setzeAusnahmetage,
	verknuepfeKalender
} from './db';
import { werteZeitAus } from './scheduler';
import type { Gate } from './gate';

const databaseUrl = process.env.DATABASE_URL;
type Datenbank = ReturnType<typeof drizzle<typeof schema>>;

/** Ein Mittwoch. Der Kalenderplan unten steht auf werktäglich 06:00 Berlin = 04:00Z. */
const MITTWOCH_SOLL = new Date('2026-06-03T04:00:00Z');
/** Bewertet wird das Soll erst nach der Karenz von 600 s. */
const SOLL_DEADLINE = new Date(MITTWOCH_SOLL.getTime() + 600_000);
/** Der Rückstands-Teil der Schranke ist exklusiv: bewertbar ist alles *vor* der ersten offenen Mail. */
const knappVor = (iso: string) => new Date(new Date(iso).getTime() - 1);

describe.skipIf(!databaseUrl && !process.env.CI)('Zeit-Scheduler', () => {
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
		await db.delete(schema.postfach);
		await db.delete(schema.selbstMonitor).where(eq(schema.selbstMonitor.art, 'postfach'));
		await db.delete(schema.kunde);
		await db.delete(schema.ausnahmekalender);

		const [zeile] = await db
			.insert(schema.postfach)
			.values({
				bezeichnung: 'NOC',
				adresse: `noc${laufendeNummer++}@msp.test`,
				tenantId: 'tenant',
				clientId: 'client',
				erstelltAm: new Date('2026-05-01T00:00:00Z'),
				// Die Zusage: alles bis hierher ist abgeholt. Ohne sie bliebe sie null, und null
				// blockiert jede Auswertung — die Fälle unten kämen gar nicht erst zum Urteilen.
				// Weit genug in der Zukunft, dass sie nur hält, wo ein Fall sie eigens vorzieht.
				ingestionStandAm: new Date('2026-06-30T00:00:00Z')
			})
			.returning({ id: schema.postfach.id });
		postfachId = zeile.id;

		kundeId = await legeKundeAn(
			{ name: 'Kunde A', kundennummer: null, notiz: null, autotaskCompanyId: null },
			db
		);
		await legeMerkmalAn({ kundeId, stufe: 'absender', wert: 'backup.test' }, db);
	});

	const setzeIngestionsStand = (stand: Date) =>
		db
			.update(schema.postfach)
			.set({ ingestionStandAm: stand })
			.where(eq(schema.postfach.id, postfachId));

	/** Ein aktivierter Monitor mit Regel; `aktiviertAm`/Cursor werden fixiert. */
	async function monitor(
		art: schema.MonitorArt,
		parameter: Record<string, unknown>,
		aktiviertAm = new Date('2026-06-02T00:00:00Z')
	): Promise<string> {
		const ergebnis = await legeMonitorAn(
			{
				kundeId,
				bezeichnung: `Monitor ${art} ${laufendeNummer++}`,
				art,
				parameter,
				regel: {
					absender: ['reports@backup.test'],
					betreffMuster: [],
					schluesselwoerter: [],
					musterSchlecht: art === 'heartbeat' ? ['failed'] : [],
					musterGut: art === 'heartbeat' || art === 'paar' ? ['completed'] : []
				},
				quelle: 'manuell'
			},
			db
		);
		if (ergebnis.art !== 'ok') throw new Error(`Monitor ungültig: ${JSON.stringify(ergebnis)}`);

		await setzeAktivierung(ergebnis.id, true, aktiviertAm, db);
		return ergebnis.id;
	}

	/** Legt eine Mail ab, wie die Ingestion es täte: unverarbeitet, ohne Monitor-Bezug. */
	async function ingestiere(ankunftszeit: Date, betreff = 'Backup completed'): Promise<void> {
		await db.insert(schema.mail).values({
			postfachId,
			graphMessageId: `m${laufendeNummer++}`,
			ankunftszeit,
			ausLernfenster: false,
			absender: 'reports@backup.test',
			empfaenger: ['noc@msp.test'],
			betreff,
			bodyText: betreff
		});
	}

	/** Die echte Zuordnungs-Pipeline — keine von Hand gesetzten Spalten. */
	const ordneZu = () =>
		verarbeiteStapel({ db, monitorStufe, jetzt: new Date('2026-06-30T00:00:00Z') });

	const zustand = async (id: string) => {
		const [zeile] = await db.select().from(schema.monitor).where(eq(schema.monitor.id, id));
		return zeile;
	};

	const episoden = (id: string) =>
		db.select().from(schema.uebergang).where(eq(schema.uebergang.monitorId, id));

	const offeneEpisode = async (id: string) => {
		const [zeile] = await db
			.select()
			.from(schema.uebergang)
			.where(and(eq(schema.uebergang.monitorId, id), isNull(schema.uebergang.beendetAm)));
		return zeile;
	};

	const KALENDERPLAN = {
		erwartungModus: 'kalenderplan' as const,
		erwartungPlan: { wochentage: [1, 2, 3, 4, 5], uhrzeit: '06:00' },
		karenzSekunden: 600
	};

	describe('Bewertungs-Schranke', () => {
		it('nimmt jetzt, wenn Ingestion und Zuordnung aufgeholt haben', async () => {
			const jetzt = new Date('2026-06-03T05:00:00Z');

			expect(await bewertungsSchranke(jetzt, db)).toEqual({
				bewertbarBis: jetzt,
				haltendVon: 'jetzt'
			});
		});

		it('wird von der Ingestions-Zusage gehalten', async () => {
			await setzeIngestionsStand(new Date('2026-06-03T04:30:00Z'));

			expect(await bewertungsSchranke(new Date('2026-06-03T05:00:00Z'), db)).toEqual({
				bewertbarBis: new Date('2026-06-03T04:30:00Z'),
				haltendVon: 'ingestion'
			});
		});

		it('wird vom Zuordnungs-Rückstand gehalten', async () => {
			await ingestiere(new Date('2026-06-03T03:58:00Z'));

			expect(await bewertungsSchranke(new Date('2026-06-03T05:00:00Z'), db)).toEqual({
				bewertbarBis: knappVor('2026-06-03T03:58:00Z'),
				haltendVon: 'zuordnung'
			});
		});

		/**
		 * Beide Teile stammen aus **einem** Statement, also aus einem Snapshot. Eine Transaktion, die
		 * Mail und Zusage zusammen schreibt, ist danach ganz sichtbar — nie die Zusage ohne die Mail.
		 */
		it('sieht eine gemeinsam committete Mail und Zusage nur zusammen', async () => {
			await db.transaction(async (tx) => {
				await tx.insert(schema.mail).values({
					postfachId,
					graphMessageId: 'm-atomar',
					ankunftszeit: new Date('2026-06-03T03:58:00Z'),
					ausLernfenster: false,
					absender: 'reports@backup.test',
					empfaenger: ['noc@msp.test'],
					betreff: 'Backup completed'
				});
				await tx
					.update(schema.postfach)
					.set({ ingestionStandAm: new Date('2026-06-03T04:59:00Z') })
					.where(eq(schema.postfach.id, postfachId));
			});

			expect(await bewertungsSchranke(new Date('2026-06-03T05:00:00Z'), db)).toEqual({
				bewertbarBis: knappVor('2026-06-03T03:58:00Z'),
				haltendVon: 'zuordnung'
			});
		});

		/**
		 * `min()` überspringt NULL. Würde die fehlende Zusage einfach mitgemittelt, fiele ausgerechnet
		 * das Postfach aus der Schranke, das noch gar nichts gelesen hat — deshalb wird sie gezählt
		 * und blockiert.
		 */
		it('blockiert alles, solange ein aktives Postfach nichts zugesagt hat', async () => {
			await db
				.update(schema.postfach)
				.set({ ingestionStandAm: null })
				.where(eq(schema.postfach.id, postfachId));

			expect(await bewertungsSchranke(new Date('2026-06-03T05:00:00Z'), db)).toEqual({
				bewertbarBis: new Date(0),
				haltendVon: 'keine_zusage'
			});
		});

		it('lässt ein Postfach ohne Zusage die Schranke nicht halten, wenn es inaktiv ist', async () => {
			await db
				.update(schema.postfach)
				.set({ ingestionStandAm: null, aktiv: false })
				.where(eq(schema.postfach.id, postfachId));
			const jetzt = new Date('2026-06-03T05:00:00Z');

			expect((await bewertungsSchranke(jetzt, db)).bewertbarBis).toEqual(jetzt);
		});

		it('lässt ein inaktives Postfach die Schranke nicht halten', async () => {
			await setzeIngestionsStand(new Date('2026-06-01T00:00:00Z'));
			await db
				.update(schema.postfach)
				.set({ aktiv: false })
				.where(eq(schema.postfach.id, postfachId));
			const jetzt = new Date('2026-06-03T05:00:00Z');

			expect((await bewertungsSchranke(jetzt, db)).bewertbarBis).toEqual(jetzt);
		});
	});

	/**
	 * Das Rennen, um das es geht: die Mail ist unterwegs, der Monitor sieht sie noch nicht — und
	 * darf trotzdem nicht alarmieren.
	 */
	describe('Rennen zwischen Ingestion, Zuordnung und Auswertung', () => {
		it('alarmiert nicht, solange die Ingestions-Zusage vor der Deadline liegt', async () => {
			const id = await monitor('heartbeat', KALENDERPLAN);
			// Abgeholt ist erst bis 03:00 — die Deadline des Solls (04:10) liegt dahinter.
			await setzeIngestionsStand(new Date('2026-06-03T03:00:00Z'));

			const bericht = await werteZeitAus({ jetzt: new Date('2026-06-03T05:00:00Z'), db });

			expect(bericht.schranke.haltendVon).toBe('ingestion');
			expect(await episoden(id)).toHaveLength(0);
			// Ausgesetzt, nicht verworfen: der Cursor rückt höchstens bis zur Schranke und bleibt
			// damit vor der Deadline des Solls (04:10Z) — die wird später erneut angeboten.
			expect((await zustand(id)).sollGeprueftBisAm).toEqual(new Date('2026-06-03T03:00:00Z'));
			expect(SOLL_DEADLINE.getTime()).toBeGreaterThan(
				(await zustand(id)).sollGeprueftBisAm!.getTime()
			);
		});

		it('bewertet dasselbe Soll als abgedeckt, sobald Mail und Zusage nachgezogen sind', async () => {
			const id = await monitor('heartbeat', KALENDERPLAN);
			await setzeIngestionsStand(new Date('2026-06-03T03:00:00Z'));
			await werteZeitAus({ jetzt: new Date('2026-06-03T05:00:00Z'), db });

			// Genau die Mail, die im Rennen „zu spät" kam: eingetroffen um 03:58, also *vor* dem Soll.
			await ingestiere(new Date('2026-06-03T03:58:00Z'));
			await setzeIngestionsStand(new Date('2026-06-03T04:59:00Z'));
			await ordneZu();

			await werteZeitAus({ jetzt: new Date('2026-06-03T05:00:00Z'), db });

			expect(await episoden(id)).toHaveLength(0);
			expect((await zustand(id)).zustand).toBe('gesund');
			expect((await zustand(id)).sollGeprueftBisAm).toEqual(new Date('2026-06-03T04:59:00Z'));
		});

		/** Die Gegenprobe: ohne die Mail alarmiert derselbe Ablauf — genau einmal. */
		it('alarmiert genau einmal, wenn die Mail wirklich fehlt', async () => {
			const id = await monitor('heartbeat', KALENDERPLAN);
			await setzeIngestionsStand(new Date('2026-06-03T04:59:00Z'));

			await werteZeitAus({ jetzt: new Date('2026-06-03T05:00:00Z'), db });

			const alle = await episoden(id);
			expect(alle).toHaveLength(1);
			expect(alle[0]).toMatchObject({ alarmgrund: 'ueberfaellig', vorkommen: 1 });
			// Datiert auf die Deadline des Solls, nicht auf den Tick.
			expect(alle[0].begonnenAm).toEqual(new Date(MITTWOCH_SOLL.getTime() + 600_000));
		});

		it('alarmiert nicht, solange die Mail zwar da, aber noch nicht zugeordnet ist', async () => {
			const id = await monitor('heartbeat', KALENDERPLAN);
			await ingestiere(new Date('2026-06-03T03:58:00Z'));
			await setzeIngestionsStand(new Date('2026-06-03T04:59:00Z'));

			const bericht = await werteZeitAus({ jetzt: new Date('2026-06-03T05:00:00Z'), db });

			expect(bericht.schranke.haltendVon).toBe('zuordnung');
			expect(await episoden(id)).toHaveLength(0);
			// Wieder: höchstens bis zur Schranke, also vor der Deadline des Solls.
			expect((await zustand(id)).sollGeprueftBisAm).toEqual(knappVor('2026-06-03T03:58:00Z'));

			// Nach der echten Pipeline ist das Soll abgedeckt — und bleibt es.
			await ordneZu();
			await werteZeitAus({ jetzt: new Date('2026-06-03T05:00:00Z'), db });
			expect(await episoden(id)).toHaveLength(0);
		});

		/**
		 * Der Fall, an dem die Schranke ihre Millisekunde verdient.
		 *
		 * Drei zugeordnete Mails füllen das Fenster, drei frische liegen noch im Rückstand. Würde der
		 * Tick gegen `jetzt` (05:30) urteilen, sähe er im Fenster (04:30, 05:30] **null** Mails — die
		 * alten sind herausgealtert, die neuen noch unsichtbar — und risse die Untergrenze. Gegen die
		 * Schranke urteilt er über das Fenster, das kurz vor der ersten unverarbeiteten Mail endet,
		 * und findet dort die drei alten.
		 */
		it('reißt den Zähler nicht, solange sein Fenster noch unverarbeitete Mails enthält', async () => {
			const id = await monitor('zaehler', { zaehlerFensterSekunden: 3600, zaehlerUntergrenze: 3 });
			for (const minute of ['04:05', '04:15', '04:25']) {
				await ingestiere(new Date(`2026-06-03T${minute}:00Z`));
			}
			await ordneZu();

			for (const minute of ['05:05', '05:15', '05:25']) {
				await ingestiere(new Date(`2026-06-03T${minute}:00Z`));
			}
			await setzeIngestionsStand(new Date('2026-06-03T05:29:00Z'));

			const bericht = await werteZeitAus({ jetzt: new Date('2026-06-03T05:30:00Z'), db });
			expect(bericht.schranke.haltendVon).toBe('zuordnung');
			expect(await episoden(id)).toHaveLength(0);

			await ordneZu();
			await werteZeitAus({ jetzt: new Date('2026-06-03T05:30:00Z'), db });

			expect(await episoden(id)).toHaveLength(0);
			expect((await zustand(id)).zustand).toBe('gesund');
		});

		/** Eine Mail mit älterer Ankunftszeit zieht die Schranke zurück — der Cursor darf nicht mit. */
		it('lässt den Cursor bei zurückspringender Schranke stehen', async () => {
			const id = await monitor('heartbeat', KALENDERPLAN);
			await setzeIngestionsStand(new Date('2026-06-03T04:59:00Z'));
			await werteZeitAus({ jetzt: new Date('2026-06-03T05:00:00Z'), db });
			const nachErstemTick = (await zustand(id)).sollGeprueftBisAm;

			await ingestiere(new Date('2026-06-03T02:00:00Z'));
			await werteZeitAus({ jetzt: new Date('2026-06-03T05:05:00Z'), db });

			expect((await zustand(id)).sollGeprueftBisAm).toEqual(nachErstemTick);
			// Und kein zweites Vorkommen für dasselbe, bereits bewertete Soll.
			expect((await episoden(id))[0]).toMatchObject({ vorkommen: 1 });
		});
	});

	describe('Erwartung', () => {
		it('alarmiert ein Intervall erst nach Intervall plus Karenz', async () => {
			const id = await monitor('heartbeat', {
				erwartungModus: 'intervall',
				erwartungIntervallSekunden: 3600,
				karenzSekunden: 600
			});
			await db
				.update(schema.monitor)
				.set({ zuletztGesehenAm: new Date('2026-06-03T03:00:00Z') })
				.where(eq(schema.monitor.id, id));

			await werteZeitAus({ jetzt: new Date('2026-06-03T04:09:00Z'), db });
			expect(await episoden(id)).toHaveLength(0);

			await werteZeitAus({ jetzt: new Date('2026-06-03T04:11:00Z'), db });
			expect(await episoden(id)).toHaveLength(1);
		});

		/** Neustart: sechs Tage Stillstand, ein einziger Tag ohne Mail. */
		it('holt verpasste Solls nach, ohne je Soll eine Episode zu eröffnen', async () => {
			const id = await monitor('heartbeat', KALENDERPLAN, new Date('2026-05-29T00:00:00Z'));
			await setzeIngestionsStand(new Date('2026-06-05T12:00:00Z'));

			await werteZeitAus({ jetzt: new Date('2026-06-05T12:00:00Z'), db });

			const alle = await episoden(id);
			// Eine Episode, nicht fünf — die Zustandsmaschine fasst sie zusammen …
			expect(alle).toHaveLength(1);
			// … zählt die verpassten Solls aber einzeln (Mo–Fr = 5).
			expect(alle[0].vorkommen).toBe(5);
		});

		it('bewertet ein Soll nicht zweimal', async () => {
			const id = await monitor('heartbeat', KALENDERPLAN);
			await setzeIngestionsStand(new Date('2026-06-03T04:59:00Z'));

			await werteZeitAus({ jetzt: new Date('2026-06-03T05:00:00Z'), db });
			await werteZeitAus({ jetzt: new Date('2026-06-03T05:01:00Z'), db });
			await werteZeitAus({ jetzt: new Date('2026-06-03T05:02:00Z'), db });

			expect((await episoden(id))[0]).toMatchObject({ vorkommen: 1 });
		});

		/** Der Anlauf des Kalenderplans: das erste unvollständige Fenster wird nicht beurteilt. */
		it('alarmiert einen frisch aktivierten Monitor nicht rückwirkend', async () => {
			const id = await monitor('heartbeat', KALENDERPLAN, new Date('2026-06-02T12:00:00Z'));
			await setzeIngestionsStand(new Date('2026-06-03T04:59:00Z'));

			await werteZeitAus({ jetzt: new Date('2026-06-03T05:00:00Z'), db });

			expect(await episoden(id)).toHaveLength(0);
		});
	});

	describe('Ausnahmetage', () => {
		const mitKalender = async (monitorId: string, daten: string[]) => {
			const kalenderId = await legeAusnahmekalenderAn('Feiertage', null, db);
			await setzeAusnahmetage(
				kalenderId,
				daten.map((datum) => ({ datum })),
				db
			);
			await verknuepfeKalender(monitorId, [kalenderId], db);
		};

		it('setzt das Kalenderplan-Soll aus', async () => {
			const id = await monitor('heartbeat', KALENDERPLAN);
			await mitKalender(id, ['2026-06-03']);
			await setzeIngestionsStand(new Date('2026-06-03T04:59:00Z'));

			await werteZeitAus({ jetzt: new Date('2026-06-03T05:00:00Z'), db });

			expect(await episoden(id)).toHaveLength(0);
		});

		it('wertet die Zähler-Untergrenze am Ausnahmetag nicht', async () => {
			const id = await monitor('zaehler', { zaehlerFensterSekunden: 3600, zaehlerUntergrenze: 5 });
			await mitKalender(id, ['2026-06-03']);
			await setzeIngestionsStand(new Date('2026-06-03T12:00:00Z'));

			await werteZeitAus({ jetzt: new Date('2026-06-03T12:00:00Z'), db });

			expect(await episoden(id)).toHaveLength(0);
		});

		/** „Danach greift der Anlauf": nach dem Ausnahmetag braucht die Untergrenze wieder ein Fenster T. */
		it('lässt nach dem Ausnahmetag erst ein volles Fenster verstreichen', async () => {
			const id = await monitor('zaehler', { zaehlerFensterSekunden: 3600, zaehlerUntergrenze: 5 });
			await mitKalender(id, ['2026-06-03']);
			await setzeIngestionsStand(new Date('2026-06-04T12:00:00Z'));

			// Der Ausnahmetag endet am 04.06. um 00:00 Berlin = 03.06. 22:00Z; eine Stunde später ist
			// der Anlauf durch — davor nicht.
			await werteZeitAus({ jetzt: new Date('2026-06-03T22:30:00Z'), db });
			expect(await episoden(id)).toHaveLength(0);

			await werteZeitAus({ jetzt: new Date('2026-06-03T23:30:00Z'), db });
			expect(await episoden(id)).toHaveLength(1);
		});

		it('lässt die Obergrenze am Ausnahmetag scharf', async () => {
			const id = await monitor('zaehler', { zaehlerFensterSekunden: 3600, zaehlerObergrenze: 1 });
			await mitKalender(id, ['2026-06-03']);
			await db
				.update(schema.monitor)
				.set({ zustand: 'gestoert', alarmgrund: 'zaehler_ueber_obergrenze' })
				.where(eq(schema.monitor.id, id));
			await db.insert(schema.uebergang).values({
				monitorId: id,
				alarmgrund: 'zaehler_ueber_obergrenze',
				begonnenAm: new Date('2026-06-03T11:00:00Z'),
				letztesVorkommenAm: new Date('2026-06-03T11:00:00Z')
			});
			await setzeIngestionsStand(new Date('2026-06-03T12:00:00Z'));

			// Der Zähler ist leer, liegt also im Band — die Erholung wirkt auch am Ausnahmetag.
			await werteZeitAus({ jetzt: new Date('2026-06-03T12:00:00Z'), db });

			const [episode] = await episoden(id);
			expect(episode).toMatchObject({ erholungsArt: 'beweis' });
			expect((await zustand(id)).zustand).toBe('gesund');
		});
	});

	describe('Paar und Ereignis', () => {
		it('alarmiert nach Ablauf der maximalen Offenzeit', async () => {
			const id = await monitor('paar', { maxOffenzeitSekunden: 900 });
			await db
				.update(schema.monitor)
				.set({ paarOffenSeit: new Date('2026-06-03T11:00:00Z') })
				.where(eq(schema.monitor.id, id));
			await setzeIngestionsStand(new Date('2026-06-03T12:00:00Z'));

			await werteZeitAus({ jetzt: new Date('2026-06-03T11:10:00Z'), db });
			expect(await episoden(id)).toHaveLength(0);

			await werteZeitAus({ jetzt: new Date('2026-06-03T11:20:00Z'), db });
			const [episode] = await episoden(id);
			expect(episode).toMatchObject({ alarmgrund: 'paar_zu_lange_offen' });
			expect(episode.begonnenAm).toEqual(new Date('2026-06-03T11:15:00Z'));
		});

		/** Nicht `beweis` — sonst schlösse #27 ein ungelesenes Ticket. */
		it('erholt ein Ereignis per Auto-Zurück mit der richtigen Erholungs-Art', async () => {
			const id = await monitor('ereignis', { autoZurueckSekunden: 86_400 });
			await db
				.update(schema.monitor)
				.set({ zustand: 'gestoert', alarmgrund: 'ereignis_eingetroffen' })
				.where(eq(schema.monitor.id, id));
			await db.insert(schema.uebergang).values({
				monitorId: id,
				alarmgrund: 'ereignis_eingetroffen',
				begonnenAm: new Date('2026-06-02T10:00:00Z'),
				letztesVorkommenAm: new Date('2026-06-02T10:00:00Z')
			});
			await setzeIngestionsStand(new Date('2026-06-03T12:00:00Z'));

			// Die Auto-Zurück-Zeit läuft bis 06-03 10:00Z; davor passiert nichts.
			await werteZeitAus({ jetzt: new Date('2026-06-03T09:00:00Z'), db });
			expect(await offeneEpisode(id)).toBeDefined();

			await werteZeitAus({ jetzt: new Date('2026-06-03T11:00:00Z'), db });
			expect(await offeneEpisode(id)).toBeUndefined();

			const [episode] = await episoden(id);
			expect(episode).toMatchObject({ erholungsArt: 'auto_zurueck' });
			expect(episode.beendetAm).toEqual(new Date('2026-06-03T10:00:00Z'));
			expect((await zustand(id)).zustand).toBe('gesund');
		});
	});

	describe('Abgrenzungen', () => {
		it('wertet den Monitor eines archivierten Kunden nicht aus', async () => {
			const id = await monitor('heartbeat', KALENDERPLAN);
			await setzeKundeZustand(kundeId, 'archiviert', new Date('2026-06-02T12:00:00Z'), db);
			await setzeIngestionsStand(new Date('2026-06-03T04:59:00Z'));

			const bericht = await werteZeitAus({ jetzt: new Date('2026-06-03T05:00:00Z'), db });

			expect(bericht.geprueft).toBe(0);
			expect(await episoden(id)).toHaveLength(0);
		});

		it('unterdrückt bei Pausiert die Schlecht-Richtung, schiebt den Cursor aber weiter', async () => {
			const id = await monitor('heartbeat', KALENDERPLAN);
			await db.update(schema.monitor).set({ pausiert: true }).where(eq(schema.monitor.id, id));
			await setzeIngestionsStand(new Date('2026-06-03T04:59:00Z'));

			await werteZeitAus({ jetzt: new Date('2026-06-03T05:00:00Z'), db });

			expect(await episoden(id)).toHaveLength(0);
			// Eine Wartung ist die bewusste Entscheidung, nicht zu alarmieren — die Solls der Pause
			// werden danach nicht nachgespielt.
			expect((await zustand(id)).sollGeprueftBisAm).toEqual(new Date('2026-06-03T04:59:00Z'));
		});

		it('schweigt bei geschlossenem Gate und lässt den Cursor stehen', async () => {
			const id = await monitor('heartbeat', KALENDERPLAN);
			await setzeIngestionsStand(new Date('2026-06-03T04:59:00Z'));
			const zu: Gate = { offen: () => false };

			await werteZeitAus({
				jetzt: new Date('2026-06-03T05:00:00Z'),
				db,
				gate: () => Promise.resolve(zu)
			});

			expect(await episoden(id)).toHaveLength(0);
			expect((await zustand(id)).sollGeprueftBisAm).toEqual(new Date('2026-06-02T00:00:00Z'));

			// Gate wieder offen: dasselbe Soll wird jetzt bewertet — ausgesetzt, nicht verworfen.
			await werteZeitAus({ jetzt: new Date('2026-06-03T05:00:00Z'), db });
			expect(await episoden(id)).toHaveLength(1);
		});

		/** Der Dead-Man's-Switch schweigt lieber, als über ein Postfach zu urteilen, das nichts gelesen hat. */
		it('wertet gar nichts aus, solange ein Postfach nichts zugesagt hat', async () => {
			const id = await monitor('heartbeat', KALENDERPLAN);
			await db
				.update(schema.postfach)
				.set({ ingestionStandAm: null })
				.where(eq(schema.postfach.id, postfachId));

			const bericht = await werteZeitAus({ jetzt: new Date('2026-06-03T05:00:00Z'), db });

			expect(bericht.schranke.haltendVon).toBe('keine_zusage');
			expect(bericht.geprueft).toBe(0);
			expect(await episoden(id)).toHaveLength(0);
			// Ausgesetzt, nicht verworfen: der Cursor steht unverändert auf der Aktivierung.
			expect((await zustand(id)).sollGeprueftBisAm).toEqual(new Date('2026-06-02T00:00:00Z'));
		});

		it('wertet einen nicht aktivierten Monitor nicht aus', async () => {
			const id = await monitor('heartbeat', KALENDERPLAN);
			await setzeAktivierung(id, false, new Date('2026-06-01T00:00:00Z'), db);
			await setzeIngestionsStand(new Date('2026-06-03T04:59:00Z'));

			const bericht = await werteZeitAus({ jetzt: new Date('2026-06-03T05:00:00Z'), db });

			expect(bericht.geprueft).toBe(0);
		});

		/** Zwei Ticks nebeneinander dürfen nicht zweimal dieselbe Episode eröffnen. */
		it('eröffnet auch bei gleichzeitigen Durchläufen nur eine Episode', async () => {
			const id = await monitor('heartbeat', KALENDERPLAN);
			await setzeIngestionsStand(new Date('2026-06-03T04:59:00Z'));
			const jetzt = new Date('2026-06-03T05:00:00Z');

			await Promise.all([
				werteZeitAus({ jetzt, db }),
				werteZeitAus({ jetzt, db }),
				werteZeitAus({ jetzt, db })
			]);

			expect(await episoden(id)).toHaveLength(1);
		});

		it('blättert über mehrere Seiten', async () => {
			await monitor('heartbeat', KALENDERPLAN);
			await monitor('heartbeat', KALENDERPLAN);
			await monitor('heartbeat', KALENDERPLAN);
			await setzeIngestionsStand(new Date('2026-06-03T04:59:00Z'));

			const bericht = await werteZeitAus({
				jetzt: new Date('2026-06-03T05:00:00Z'),
				seitenGroesse: 1,
				db
			});

			expect(bericht.geprueft).toBe(3);
			expect(bericht.wirkungen).toBe(3);
		});
	});
});
