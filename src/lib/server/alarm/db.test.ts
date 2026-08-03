/**
 * Der Alarm-Lebenszyklus gegen eine echte Postgres.
 *
 * Die Regeln selbst hängen in `lebenszyklus.test.ts` und `ereignis.test.ts` ohne Datenbank. Hier
 * steht nur, was allein Postgres beweist: dass jedes Ereignis genau einmal rausgeht (auch bei zwei
 * Ticks), dass eine im Stabilitätsfenster gerissene Erholung ihre Entwarnung dauerhaft verliert,
 * dass die Weisungen eines Ziels nacheinander ausgeführt werden — und dass ein Absturz zwischen
 * Enqueue und `job_id` keinen zweiten Job erzeugt.
 *
 * Läuft nur, wenn `DATABASE_URL` irgendwohin zeigt — wie `zeit/db.test.ts`.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { Alarmgrund, ErholungsArt, ZustellKanal } from '../db/schema/enums';
import { legeMonitorAn, schreibeWirkung, setzeAktivierung, sperreMonitore } from '../monitor/db';
import type { MonitorEingabe } from '../monitor/db';
import { wendeAn } from '../monitor/zustand';
import { legeKundeAn } from '../zuordnung/db';
import {
	erledige,
	ladeOffeneZustellungen,
	ladeZustellung,
	setzeQuittierung,
	vermerkeZustellung
} from './db';
import type { AlarmEreignisDaten } from './ereignis';
import { werteAlarmeAus } from './scheduler';
import { setzeAlarmwege, type Alarmweg, type ZustellPlan } from './wege';

const databaseUrl = process.env.DATABASE_URL;
type Datenbank = ReturnType<typeof drizzle<typeof schema>>;

const BASIS = 'https://nightwatch.msp.test';

/** Ein Wegwerf-Alarmweg: merkt sich Jobs unter der Zustellungs-ID, wie es der Vertrag verlangt. */
class TestWeg implements Alarmweg {
	readonly jobs = new Map<string, AlarmEreignisDaten>();
	/** `ereignis:alertId` in der Reihenfolge, in der die Weisungen übergeben wurden. */
	readonly reihenfolge: string[] = [];
	/** Stellt den Absturz **nach** dem Enqueue nach: der Job steht, die `job_id` nicht. */
	brichtAb = false;

	constructor(
		readonly kanal: ZustellKanal,
		private readonly ziele: (string | null)[]
	) {}

	plane(): Promise<ZustellPlan[]> {
		return Promise.resolve(this.ziele.map((webhookZielId) => ({ webhookZielId })));
	}

	uebergib(ereignis: AlarmEreignisDaten, zustellungId: string): Promise<string | null> {
		// Die Zustellungs-ID *ist* die Identität des Jobs — ein zweiter Anlauf legt keinen zweiten an.
		if (!this.jobs.has(zustellungId)) {
			this.jobs.set(zustellungId, ereignis);
			this.reihenfolge.push(`${ereignis.ereignis}:${ereignis.alertId}`);
		}
		if (this.brichtAb) return Promise.reject(new Error('Queue weg'));
		return Promise.resolve(zustellungId);
	}
}

describe.skipIf(!databaseUrl && !process.env.CI)('Alarm-Lebenszyklus', () => {
	let pool: pg.Pool;
	let db: Datenbank;
	let kundeId: string;
	let postfachId: string;
	let webhookZielId: string;
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
		await db.delete(schema.zustellung);
		await db.delete(schema.webhookZiel);
		await db.delete(schema.postfach);
		await db.delete(schema.selbstMonitor).where(eq(schema.selbstMonitor.art, 'postfach'));
		await db.delete(schema.kunde);
		setzeAlarmwege([]);

		const [zeile] = await db
			.insert(schema.postfach)
			.values({
				bezeichnung: 'NOC',
				adresse: `noc${laufendeNummer++}@msp.test`,
				tenantId: 'tenant',
				clientId: 'client',
				// Die Vollständigkeits-Zusage: ohne sie steht die Bewertungs-Schranke auf der Epoche
				// und keine Entwarnung würde je fällig. Weit genug in der Zukunft, dass nur die Fälle
				// sie zurückholen, die es eigens wollen.
				ingestionStandAm: new Date('2026-12-31T00:00:00Z')
			})
			.returning({ id: schema.postfach.id });
		postfachId = zeile.id;

		const [ziel] = await db
			.insert(schema.webhookZiel)
			.values({ bezeichnung: 'RMM', url: 'https://rmm.msp.test/hook' })
			.returning({ id: schema.webhookZiel.id });
		webhookZielId = ziel.id;

		kundeId = await legeKundeAn(
			{ name: 'Kunde A', kundennummer: null, notiz: null, autotaskCompanyId: null },
			db
		);
	});

	// -----------------------------------------------------------------------------------------
	// Aufbau
	// -----------------------------------------------------------------------------------------

	const AKTIVIERT = new Date('2026-07-28T00:00:00Z');

	function eingabe(teile: Partial<MonitorEingabe> = {}): MonitorEingabe {
		return {
			kundeId,
			bezeichnung: 'Veeam Backup',
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

	async function legeAn(teile: Partial<MonitorEingabe> = {}): Promise<string> {
		const ergebnis = await legeMonitorAn(eingabe(teile), db);
		if (ergebnis.art !== 'ok') throw new Error(`Anlage fehlgeschlagen: ${ergebnis.art}`);
		await setzeAktivierung(ergebnis.id, true, AKTIVIERT, db);
		await db.update(schema.monitor).set({ postfachId }).where(eq(schema.monitor.id, ergebnis.id));
		return ergebnis.id;
	}

	/**
	 * Treibt den Monitor über die echte Zustandsmaschine — derselbe Pfad, den Mail-Pipeline und
	 * Zeit-Scheduler nehmen, nur ohne die Mail. Was hier entsteht, ist eine echte Episode.
	 */
	async function wirke(
		monitorId: string,
		wirkung:
			{ art: 'stoerung'; grund: Alarmgrund } | { art: 'erholung'; erholungsArt: ErholungsArt },
		zeitpunkt: Date
	): Promise<void> {
		await db.transaction(async (tx) => {
			const laufzeit = (await sperreMonitore([monitorId], tx)).get(monitorId);
			if (!laufzeit) throw new Error('Monitor nicht gefunden');
			const aenderung = wendeAn(laufzeit, wirkung, zeitpunkt);
			if (aenderung.art === 'keine') return;
			await schreibeWirkung(laufzeit, {}, aenderung, zeitpunkt, tx);
		});
	}

	const stoere = (id: string, grund: Alarmgrund, am: Date) =>
		wirke(id, { art: 'stoerung', grund }, am);
	const erhole = (id: string, am: Date, erholungsArt: ErholungsArt = 'beweis') =>
		wirke(id, { art: 'erholung', erholungsArt }, am);

	const tick = (jetzt: Date) => werteAlarmeAus({ jetzt, db, basisUrl: BASIS });

	async function episoden(monitorId: string) {
		return db
			.select()
			.from(schema.uebergang)
			.where(eq(schema.uebergang.monitorId, monitorId))
			.orderBy(schema.uebergang.begonnenAm);
	}

	const RANG = { alarm: 0, verschaerfung: 1, entwarnung: 2 } as const;

	/**
	 * Die Zustellungen in Veröffentlichungs-Reihenfolge — Episode, dann Ereignis-Rang.
	 *
	 * Nicht nach `erstellt_am`: eine Runde veröffentlicht die Ereignisse einer Episode in *einer*
	 * Transaktion, und `now()` ist dort für alle dasselbe.
	 */
	async function zustellungen() {
		const zeilen = await db
			.select({ zustellung: schema.zustellung, begonnenAm: schema.uebergang.begonnenAm })
			.from(schema.zustellung)
			.innerJoin(schema.uebergang, eq(schema.uebergang.id, schema.zustellung.uebergangId));

		return zeilen
			.sort(
				(a, b) =>
					a.begonnenAm.getTime() - b.begonnenAm.getTime() ||
					RANG[a.zustellung.ereignis] - RANG[b.zustellung.ereignis]
			)
			.map((zeile) => zeile.zustellung);
	}

	/** Was der Kanal-Worker täte: die übergebene Weisung als zugestellt vermerken. */
	async function bestaetigeUebergebene(weg: TestWeg, jetzt: Date) {
		for (const jobId of weg.jobs.keys()) {
			await vermerkeZustellung(jobId, 'zugestellt', jetzt, null, db);
		}
	}

	const T = (uhrzeit: string) => new Date(`2026-07-28T${uhrzeit}:00Z`);

	// -----------------------------------------------------------------------------------------
	describe('Veröffentlichen', () => {
		it('meldet einen Alarm genau einmal, auch über mehrere Ticks', async () => {
			const weg = new TestWeg('webhook', [webhookZielId]);
			setzeAlarmwege([weg]);
			const id = await legeAn();

			await stoere(id, 'ueberfaellig', T('06:00'));

			expect((await tick(T('06:01'))).veroeffentlicht).toBe(1);
			expect((await tick(T('06:02'))).veroeffentlicht).toBe(0);

			const [episode] = await episoden(id);
			expect(episode.alarmiertAm).not.toBeNull();
			expect((await zustellungen()).length).toBe(1);
			expect(weg.reihenfolge).toEqual([`alarm:${episode.alertId}`]);
		});

		/** „Ein Alarm pro Übergang" — zwei Worker dürfen daraus keine zwei machen. */
		it('lässt zwei gleichzeitige Ticks nicht doppelt alarmieren', async () => {
			setzeAlarmwege([new TestWeg('webhook', [webhookZielId])]);
			const id = await legeAn();
			await stoere(id, 'ueberfaellig', T('06:00'));

			const berichte = await Promise.all([tick(T('06:01')), tick(T('06:01'))]);

			expect(berichte.reduce((summe, bericht) => summe + bericht.veroeffentlicht, 0)).toBe(1);
			expect((await zustellungen()).length).toBe(1);
		});

		/**
		 * CONTEXT „Verschärfung": der Wechsel **zu** „Fehler gemeldet" ist der einzige automatische
		 * Zwischen-Kommentar — jedes weitere Vorkommen wird nur intern gezählt.
		 */
		it('meldet die Verschärfung einmal und schweigt zum Rest', async () => {
			const weg = new TestWeg('webhook', [webhookZielId]);
			setzeAlarmwege([weg]);
			const id = await legeAn();

			await stoere(id, 'ueberfaellig', T('06:00'));
			await tick(T('06:01'));
			await bestaetigeUebergebene(weg, T('06:02'));

			await stoere(id, 'fehler_gemeldet', T('06:10'));
			expect((await tick(T('06:11'))).veroeffentlicht).toBe(1);

			// Weitere Vorkommen und ein Grundwechsel *weg* von „Fehler gemeldet" bleiben stumm.
			await stoere(id, 'fehler_gemeldet', T('06:20'));
			await stoere(id, 'ueberfaellig', T('06:30'));
			expect((await tick(T('06:31'))).veroeffentlicht).toBe(0);

			const [episode] = await episoden(id);
			expect(episode.vorkommen).toBe(4);
			expect(weg.reihenfolge).toEqual([
				`alarm:${episode.alertId}`,
				`verschaerfung:${episode.alertId}`
			]);
		});

		it('hält die Entwarnung zurück, bis das Stabilitätsfenster hielt', async () => {
			const weg = new TestWeg('webhook', [webhookZielId]);
			setzeAlarmwege([weg]);
			const id = await legeAn({ entwarnungsStabilitaetSekunden: 900 });

			await stoere(id, 'ueberfaellig', T('06:00'));
			await tick(T('06:01'));
			await erhole(id, T('06:05'));

			// Der Zustand ist intern längst gesund — das Dashboard ist live, die Entwarnung nicht.
			const [gesund] = await db
				.select({ zustand: schema.monitor.zustand })
				.from(schema.monitor)
				.where(eq(schema.monitor.id, id));
			expect(gesund.zustand).toBe('gesund');

			expect((await tick(T('06:19'))).veroeffentlicht).toBe(0);
			expect((await tick(T('06:20'))).veroeffentlicht).toBe(1);

			const [episode] = await episoden(id);
			expect(episode.entwarntAm).not.toBeNull();
			expect(weg.jobs.size).toBe(1); // erst der Alarm; die Kette gibt die Entwarnung später frei
		});

		/**
		 * Die Fälligkeit ist ein Urteil über eine Abwesenheit („es kam kein Re-Alarm") und darf
		 * deshalb nur bis zur Bewertungs-Schranke reichen — sonst entwarnt eine Instanz mitten im
		 * Aufholen, während die Mail, die den Monitor erneut reißt, noch unverarbeitet daliegt.
		 */
		it('wartet auf die Bewertungs-Schranke, nicht auf die Wanduhr', async () => {
			setzeAlarmwege([]);
			const id = await legeAn({ entwarnungsStabilitaetSekunden: 900 });

			await stoere(id, 'ueberfaellig', T('06:00'));
			await tick(T('06:01'));
			await erhole(id, T('06:05'));

			// Rückstand: eine unverarbeitete Mail von 06:10 hält die Schranke dort fest.
			await db.insert(schema.mail).values({
				postfachId,
				graphMessageId: 'rueckstand',
				ankunftszeit: T('06:10'),
				absender: 'veeam@veeam.test',
				empfaenger: ['noc@msp.test'],
				betreff: 'Backup',
				bodyText: 'failed'
			});

			expect((await tick(T('06:30'))).veroeffentlicht).toBe(0);

			await db
				.update(schema.mail)
				.set({ verarbeitetAm: T('06:31') })
				.where(eq(schema.mail.graphMessageId, 'rueckstand'));

			expect((await tick(T('06:32'))).veroeffentlicht).toBe(1);
		});

		/** „Ein Monitor, der abgeschaltet wurde, schuldet niemandem eine Entwarnung." */
		it('schweigt zu einer still beendeten Episode', async () => {
			setzeAlarmwege([]);
			const id = await legeAn();

			await stoere(id, 'ueberfaellig', T('06:00'));
			await tick(T('06:01'));
			await setzeAktivierung(id, false, T('06:05'), db);

			expect((await tick(T('07:00'))).veroeffentlicht).toBe(0);

			const [episode] = await episoden(id);
			expect(episode.erholungsArt).toBe('archiviert');
			expect(episode.entwarntAm).toBeNull();
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Flattern', () => {
		/**
		 * Der Re-Alarm *im* Fenster beweist, dass die Erholung nicht hielt: die Entwarnung entfällt
		 * dauerhaft, und der Monitor hält genau ein offenes Ticket statt einer Ticket-Serie.
		 */
		it('entwertet die Entwarnung, wenn der Re-Alarm ins Fenster fällt', async () => {
			const weg = new TestWeg('webhook', [webhookZielId]);
			setzeAlarmwege([weg]);
			const id = await legeAn({ entwarnungsStabilitaetSekunden: 900 });

			await stoere(id, 'ueberfaellig', T('06:00'));
			await tick(T('06:01'));
			await erhole(id, T('06:05'));
			await stoere(id, 'fehler_gemeldet', T('06:10'));

			const [erste, zweite] = await episoden(id);
			expect(erste.entwarnungEntfaelltAm).toEqual(T('06:10'));
			expect(zweite.vorgaengerId).toBe(erste.id);

			// Auch Stunden später bleibt es dabei — die Zeile ist aus dem Claim verschwunden.
			expect((await tick(T('09:00'))).veroeffentlicht).toBe(1); // nur der Alarm der zweiten
			const [erneut] = await episoden(id);
			expect(erneut.entwarntAm).toBeNull();
			expect(weg.reihenfolge.filter((eintrag) => eintrag.startsWith('entwarnung'))).toEqual([]);
		});

		/**
		 * Nach dem Fenster ist die Entwarnung geschuldet — auch wenn der Publisher stillstand und
		 * beide Episoden auf einmal vorfindet. Sie muss dann **vor** dem jüngeren Alarm rausgehen,
		 * sonst schließt sie ein Ticket, das der neue Alarm gerade wieder aufgemacht hat.
		 */
		it('holt die Entwarnung nach, wenn der Re-Alarm nach dem Fenster kam', async () => {
			const weg = new TestWeg('webhook', [webhookZielId]);
			setzeAlarmwege([weg]);
			const id = await legeAn({ entwarnungsStabilitaetSekunden: 900 });

			await stoere(id, 'ueberfaellig', T('06:00'));
			await erhole(id, T('06:05'));
			await stoere(id, 'fehler_gemeldet', T('06:25'));

			const [erste, zweite] = await episoden(id);
			expect(erste.entwarnungEntfaelltAm).toBeNull();

			// Ein einziger Tick holt alles nach: Alarm(E1), Entwarnung(E1), Alarm(E2).
			expect((await tick(T('06:30'))).veroeffentlicht).toBe(3);
			expect((await zustellungen()).length).toBe(3);

			// Die Kette gibt eine Weisung nach der anderen frei — die Reihenfolge ist die Zusage.
			for (let runde = 0; runde < 3; runde++) {
				await tick(T('06:31'));
				await bestaetigeUebergebene(weg, T('06:31'));
			}

			expect(weg.reihenfolge).toEqual([
				`alarm:${erste.alertId}`,
				`entwarnung:${erste.alertId}`,
				`alarm:${zweite.alertId}`
			]);
		});

		it('verkettet jede Episode mit ihrer Vorgängerin', async () => {
			setzeAlarmwege([]);
			const id = await legeAn({ entwarnungsStabilitaetSekunden: 0 });

			await stoere(id, 'ueberfaellig', T('06:00'));
			await erhole(id, T('06:05'));
			await stoere(id, 'ueberfaellig', T('06:10'));
			await erhole(id, T('06:15'));
			await stoere(id, 'ueberfaellig', T('06:20'));

			const kette = await episoden(id);
			expect(kette.map((episode) => episode.vorgaengerId)).toEqual([
				null,
				kette[0].id,
				kette[1].id
			]);
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Übergabe', () => {
		/**
		 * Der Absturz zwischen Enqueue und `job_id`: der nächste Tick übergibt dieselbe
		 * Zustellungs-ID erneut, und weil sie die Identität des Jobs ist, entsteht kein zweiter.
		 */
		it('übergibt nach einem Absturz erneut, ohne einen zweiten Job zu erzeugen', async () => {
			const weg = new TestWeg('webhook', [webhookZielId]);
			setzeAlarmwege([weg]);
			const id = await legeAn();

			await stoere(id, 'ueberfaellig', T('06:00'));

			// Der Job steht in der Queue, dann stirbt der Prozess: `job_id` bleibt leer.
			weg.brichtAb = true;
			await tick(T('06:01'));

			expect(weg.jobs.size).toBe(1);
			const [nachBruch] = await zustellungen();
			expect(nachBruch.jobId).toBeNull();

			weg.brichtAb = false;
			await tick(T('06:02'));

			// Dieselbe Zustellungs-ID, derselbe Job — kein zweites Ticket, kein zweiter Aufruf.
			expect(weg.jobs.size).toBe(1);
			expect(weg.reihenfolge.length).toBe(1);
			const [nachErholung] = await zustellungen();
			expect(nachErholung.jobId).toBe(nachBruch.id);

			// Und danach ist nichts mehr zu übergeben.
			expect((await tick(T('06:03'))).uebergeben).toBe(0);
		});

		/**
		 * „Ein offenes Ticket pro Monitor" hängt daran, dass der Adapter die Weisungen in der
		 * gedachten Reihenfolge ausführt: läuft der Alarm der nächsten Episode vor dem Schließ-Job
		 * der vorigen, findet er deren Ticket noch offen und kommentiert es, statt ein neues
		 * anzulegen.
		 */
		it('hält die nächste Weisung zurück, solange die Schließung offen ist', async () => {
			const weg = new TestWeg('webhook', [webhookZielId]);
			setzeAlarmwege([weg]);
			const id = await legeAn({ entwarnungsStabilitaetSekunden: 900 });

			await stoere(id, 'ueberfaellig', T('06:00'));
			await erhole(id, T('06:05'));
			await stoere(id, 'fehler_gemeldet', T('06:25'));
			await tick(T('06:30'));

			const [erste, zweite] = await episoden(id);
			const [alarmZeile, entwarnZeile] = await zustellungen();

			// Der Tick oben hat die Kette bereits mit dem Alarm der ersten Episode eröffnet.
			expect(weg.reihenfolge).toEqual([`alarm:${erste.alertId}`]);
			await vermerkeZustellung(alarmZeile.id, 'zugestellt', T('06:31'), null, db);

			// Als Nächstes die Entwarnung — sie bleibt offen, der Schließ-Job hängt.
			await tick(T('06:32'));
			expect(weg.reihenfolge.at(-1)).toBe(`entwarnung:${erste.alertId}`);

			// Solange sie hängt, rührt sich der Alarm der zweiten Episode nicht.
			await tick(T('06:33'));
			await tick(T('06:34'));
			expect(weg.reihenfolge.length).toBe(2);

			await vermerkeZustellung(entwarnZeile.id, 'zugestellt', T('06:35'), null, db);

			await tick(T('06:36'));
			expect(weg.reihenfolge).toEqual([
				`alarm:${erste.alertId}`,
				`entwarnung:${erste.alertId}`,
				`alarm:${zweite.alertId}`
			]);
		});

		/** Der Dead-Letter ist das Ventil: ein toter Kanal darf die Kette nicht dauerhaft stauen. */
		it('löst die Kette, wenn eine Weisung endgültig scheitert', async () => {
			const weg = new TestWeg('webhook', [webhookZielId]);
			setzeAlarmwege([weg]);
			const id = await legeAn({ entwarnungsStabilitaetSekunden: 900 });

			await stoere(id, 'ueberfaellig', T('06:00'));
			await erhole(id, T('06:05'));
			await stoere(id, 'fehler_gemeldet', T('06:25'));
			await tick(T('06:30'));

			const [erste] = await episoden(id);
			const [alarmZeile] = await zustellungen();
			expect(weg.reihenfolge).toEqual([`alarm:${erste.alertId}`]);

			// Die Versuche sind erschöpft — der Dead-Letter gibt die Kette frei, statt sie zu stauen.
			await vermerkeZustellung(alarmZeile.id, 'fehlgeschlagen', T('06:31'), 'Ziel weg', db);
			await tick(T('06:32'));

			expect(weg.reihenfolge).toEqual([`alarm:${erste.alertId}`, `entwarnung:${erste.alertId}`]);

			const [gescheitert] = await zustellungen();
			expect(gescheitert.zustand).toBe('fehlgeschlagen');
			expect(gescheitert.versuche).toBe(1);
			expect(gescheitert.letzterFehler).toBe('Ziel weg');
		});

		/** Die Serialisierung wirkt je Ziel — ein hängender Kanal darf keinen anderen aufhalten. */
		it('bremst fremde Ziele nicht mit aus', async () => {
			const webhook = new TestWeg('webhook', [webhookZielId]);
			const autotask = new TestWeg('autotask', [null]);
			setzeAlarmwege([webhook, autotask]);
			const id = await legeAn({ entwarnungsStabilitaetSekunden: 900 });

			await stoere(id, 'ueberfaellig', T('06:00'));
			await erhole(id, T('06:05'));
			await stoere(id, 'fehler_gemeldet', T('06:25'));
			await tick(T('06:30'));

			// Beide Kanäle bekommen ihre eigene Kette, und beide starten sie im selben Tick.
			await tick(T('06:31'));
			expect(webhook.reihenfolge.length).toBe(1);
			expect(autotask.reihenfolge.length).toBe(1);

			// Der Webhook kommt weiter, während Autotask hängt.
			for (const jobId of webhook.jobs.keys()) {
				await vermerkeZustellung(jobId, 'zugestellt', T('06:32'), null, db);
			}
			await tick(T('06:33'));

			expect(webhook.reihenfolge.length).toBe(2);
			expect(autotask.reihenfolge.length).toBe(1);
		});

		/**
		 * Der Alarm einer jüngeren Episode darf die Entwarnung der älteren nicht überholen — auch
		 * dann nicht, wenn er längst veröffentlicht ist und sie noch auf die Bewertungs-Schranke
		 * wartet. Sonst legte der Adapter für E2 ein Ticket an, das die verspätete Entwarnung von
		 * E1 gleich wieder schlösse.
		 */
		it('hält den jüngeren Alarm zurück, solange die ältere Episode etwas schuldet', async () => {
			const weg = new TestWeg('webhook', [webhookZielId]);
			setzeAlarmwege([weg]);
			const id = await legeAn({ entwarnungsStabilitaetSekunden: 900 });

			await stoere(id, 'ueberfaellig', T('06:00'));
			await erhole(id, T('06:05'));
			await stoere(id, 'fehler_gemeldet', T('06:25'));

			// Ein Rückstand zieht die Schranke hinter das Fensterende zurück: der Alarm der zweiten
			// Episode ist veröffentlichbar, die Entwarnung der ersten nicht.
			await db.insert(schema.mail).values({
				postfachId,
				graphMessageId: 'rueckstand',
				ankunftszeit: T('06:15'),
				absender: 'usv@usv.test',
				empfaenger: ['noc@msp.test'],
				betreff: 'Netzausfall',
				bodyText: 'down'
			});

			await tick(T('06:30'));
			const [erste, zweite] = await episoden(id);
			expect(erste.entwarntAm).toBeNull();
			expect((await zustellungen()).map((zeile) => zeile.ereignis)).toEqual(['alarm', 'alarm']);

			// Der Alarm der zweiten Episode wartet — nicht hinter einer Zustellung, sondern hinter
			// der offenen Pflicht der ersten.
			await tick(T('06:31'));
			expect(weg.reihenfolge).toEqual([`alarm:${erste.alertId}`]);
			await bestaetigeUebergebene(weg, T('06:32'));
			await tick(T('06:33'));
			expect(weg.reihenfolge).toEqual([`alarm:${erste.alertId}`]);

			// Erst als der Rückstand weg ist, geht die Entwarnung raus — und dann der jüngere Alarm.
			await db
				.update(schema.mail)
				.set({ verarbeitetAm: T('06:34') })
				.where(eq(schema.mail.graphMessageId, 'rueckstand'));

			await tick(T('06:35'));
			await bestaetigeUebergebene(weg, T('06:36'));
			await tick(T('06:37'));

			expect(weg.reihenfolge).toEqual([
				`alarm:${erste.alertId}`,
				`entwarnung:${erste.alertId}`,
				`alarm:${zweite.alertId}`
			]);
		});

		/**
		 * Ein Monitor mit langem Rückstand darf die anderen nicht aushungern: begrenzt wird die
		 * Zahl der **Ziele**, nicht die der Zeilen — jede Kette stellt genau einen Kandidaten.
		 */
		it('gibt je Ziel einen Kopf zurück, statt das Fenster mit einer Kette zu füllen', async () => {
			setzeAlarmwege([new TestWeg('webhook', [webhookZielId])]);
			const flatternd = await legeAn({ entwarnungsStabilitaetSekunden: 0 });

			// Drei Episoden, drei offene Zustellungen — alle älter als die des zweiten Monitors.
			await stoere(flatternd, 'ueberfaellig', T('06:00'));
			await erhole(flatternd, T('06:01'));
			await stoere(flatternd, 'ueberfaellig', T('06:02'));
			await erhole(flatternd, T('06:03'));
			await stoere(flatternd, 'ueberfaellig', T('06:04'));

			const ruhig = await legeAn({ bezeichnung: 'USV' });
			await stoere(ruhig, 'fehler_gemeldet', T('06:10'));

			await tick(T('06:20'));
			expect((await zustellungen()).length).toBeGreaterThan(3);

			// Zwei Ziele, zwei Köpfe — der flatternde Monitor belegt einen Platz, nicht das Fenster.
			const koepfe = await ladeOffeneZustellungen(2, 'kunde', db);
			const monitore = koepfe.map((kopf) => kopf.episode.monitor.id);
			expect(monitore).toContain(flatternd);
			expect(monitore).toContain(ruhig);
		});

		it('lässt eine Zustellung ohne registrierten Weg als Nachweis liegen', async () => {
			const weg = new TestWeg('webhook', [webhookZielId]);
			setzeAlarmwege([weg]);
			const id = await legeAn({ entwarnungsStabilitaetSekunden: 0 });

			await stoere(id, 'ueberfaellig', T('06:00'));
			await erhole(id, T('06:05'));
			await tick(T('06:10'));

			const [alarmZeile, entwarnZeile] = await zustellungen();
			await vermerkeZustellung(alarmZeile.id, 'zugestellt', T('06:11'), null, db);

			// Der Weg verschwindet (Konfiguration entfernt), bevor die Entwarnung dran war.
			setzeAlarmwege([]);
			expect((await tick(T('06:12'))).uebergeben).toBe(0);

			const [, unberuehrt] = await zustellungen();
			expect(unberuehrt.id).toBe(entwarnZeile.id);
			expect(unberuehrt.zustand).toBe('offen');
			expect(unberuehrt.jobId).toBeNull();
		});
	});

	// -----------------------------------------------------------------------------------------
	/**
	 * Selbst-Monitor-Episoden (SPEC §7–8): `monitor.art = "selbst"`, `kunde = null`.
	 *
	 * Sie entstehen nicht über den Publisher — den Sende-Pfad fährt der Watchdog (#30) —, deshalb
	 * legen die Fälle hier Episode und Zustellung direkt an, genau so, wie er es tun wird. Was
	 * geprüft wird, ist der Teil, der dem Kanal gehört: dass die Zeile lesbar ist und dass die
	 * Ketten-Ordnung für Selbst-Monitore genauso gilt wie für Kunden-Monitore.
	 */
	describe('Selbst-Monitore', () => {
		async function legeSelbstMonitorAn(schluessel: string, bezeichnung: string): Promise<string> {
			const [zeile] = await db
				.insert(schema.selbstMonitor)
				.values({ schluessel, art: 'postfach', bezeichnung })
				.returning({ id: schema.selbstMonitor.id });
			return zeile.id;
		}

		/** Eine Episode samt Zustellung, wie der Watchdog sie schreiben wird. */
		async function legeEpisodeAn(
			selbstMonitorId: string,
			begonnenAm: Date,
			teile: Partial<typeof schema.uebergang.$inferInsert> = {}
		): Promise<{ uebergangId: string; alertId: string; zustellungId: string }> {
			const [episode] = await db
				.insert(schema.uebergang)
				.values({
					selbstMonitorId,
					alarmgrund: 'ueberfaellig',
					begonnenAm,
					letztesVorkommenAm: begonnenAm,
					alarmiertAm: begonnenAm,
					...teile
				})
				.returning({ id: schema.uebergang.id, alertId: schema.uebergang.alertId });

			const [zustellungZeile] = await db
				.insert(schema.zustellung)
				.values({
					uebergangId: episode.id,
					ereignis: 'alarm',
					kanal: 'webhook',
					webhookZielId
				})
				.returning({ id: schema.zustellung.id });

			return {
				uebergangId: episode.id,
				alertId: episode.alertId,
				zustellungId: zustellungZeile.id
			};
		}

		it('liest eine Selbst-Monitor-Zustellung als „selbst" ohne Kunden', async () => {
			const selbstId = await legeSelbstMonitorAn('postfach:noc', 'Ingestion Postfach NOC');
			const { zustellungId } = await legeEpisodeAn(selbstId, T('06:00'));

			const auftrag = await ladeZustellung(zustellungId, db);

			expect(auftrag).not.toBeNull();
			expect(auftrag?.episode.kunde).toBeNull();
			expect(auftrag?.episode.monitor).toEqual({
				art: 'selbst',
				id: selbstId,
				bezeichnung: 'Ingestion Postfach NOC',
				schluessel: 'postfach:noc'
			});
		});

		/**
		 * Ohne eigene Ketten-Identität fielen alle Selbst-Monitore in die eine NULL-Partition: der
		 * Alarm des einen blockierte den des anderen, obwohl sie nichts miteinander zu tun haben.
		 */
		it('gibt jedem Selbst-Monitor eine eigene Kette', async () => {
			const ersterId = await legeSelbstMonitorAn('postfach:a', 'Ingestion Postfach A');
			const zweiterId = await legeSelbstMonitorAn('postfach:b', 'Ingestion Postfach B');

			await legeEpisodeAn(ersterId, T('06:00'));
			await legeEpisodeAn(zweiterId, T('06:10'));

			const koepfe = await ladeOffeneZustellungen(10, 'selbst', db);

			expect(koepfe.map((kopf) => kopf.episode.monitor.id).sort()).toEqual(
				[ersterId, zweiterId].sort()
			);
		});

		/** Dieselbe Zusage wie beim Kunden-Monitor: die jüngere Episode wartet auf die ältere. */
		it('hält die jüngere Episode hinter der offenen Pflicht der älteren zurück', async () => {
			const selbstId = await legeSelbstMonitorAn('postfach:c', 'Ingestion Postfach C');

			// Die ältere Episode schuldet noch ihre Entwarnung: beendet, aber nicht entwarnt.
			const aeltere = await legeEpisodeAn(selbstId, T('06:00'), {
				beendetAm: T('06:05'),
				erholungsArt: 'beweis'
			});
			await legeEpisodeAn(selbstId, T('06:10'));

			const gebremst = await ladeOffeneZustellungen(10, 'selbst', db);
			expect(gebremst.map((kopf) => kopf.id)).toEqual([aeltere.zustellungId]);

			// Erst als die ältere nichts mehr schuldet, rückt die jüngere nach.
			await db
				.update(schema.uebergang)
				.set({ entwarntAm: T('06:20') })
				.where(eq(schema.uebergang.id, aeltere.uebergangId));
			await vermerkeZustellung(aeltere.zustellungId, 'zugestellt', T('06:21'), null, db);

			const frei = await ladeOffeneZustellungen(10, 'selbst', db);
			expect(frei.length).toBe(1);
			expect(frei[0].id).not.toBe(aeltere.zustellungId);
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Quittieren und Erledigen', () => {
		/** CONTEXT „Quittieren": reiner Dashboard-Marker, ohne Außenwirkung. */
		it('setzt den Quittiert-Marker am laufenden Alarm', async () => {
			const weg = new TestWeg('webhook', [webhookZielId]);
			setzeAlarmwege([weg]);
			const id = await legeAn();

			expect(await setzeQuittierung(id, true, T('06:00'), db)).toBe('kein_alarm');

			await stoere(id, 'ueberfaellig', T('06:00'));
			await tick(T('06:01'));
			const vorher = weg.reihenfolge.length;

			expect(await setzeQuittierung(id, true, T('06:02'), db)).toBe('gesetzt');
			const [quittiert] = await episoden(id);
			expect(quittiert.quittiertAm).toEqual(T('06:02'));

			// Kein Ereignis, keine Zustellung — der Marker bleibt im Haus.
			expect((await tick(T('06:03'))).veroeffentlicht).toBe(0);
			expect(weg.reihenfolge.length).toBe(vorher);

			expect(await setzeQuittierung(id, false, T('06:04'), db)).toBe('gesetzt');
			expect((await episoden(id))[0].quittiertAm).toBeNull();
		});

		/** „Erlischt mit der Erholung": die nächste Episode fängt unquittiert an. */
		it('lässt den Marker mit der Erholung erlöschen', async () => {
			setzeAlarmwege([]);
			const id = await legeAn({ entwarnungsStabilitaetSekunden: 0 });

			await stoere(id, 'ueberfaellig', T('06:00'));
			await setzeQuittierung(id, true, T('06:01'), db);
			await erhole(id, T('06:05'));
			await stoere(id, 'ueberfaellig', T('06:30'));

			expect(await setzeQuittierung(id, true, T('06:31'), db)).toBe('gesetzt');
			const kette = await episoden(id);
			expect(kette[0].quittiertAm).toEqual(T('06:01'));
			expect(kette[1].quittiertAm).toEqual(T('06:31'));

			// Der offene Marker sitzt an der neuen Episode; die alte bleibt, wie sie war.
			const [offen] = await db
				.select({ id: schema.uebergang.id })
				.from(schema.uebergang)
				.where(and(eq(schema.uebergang.monitorId, id), isNull(schema.uebergang.beendetAm)));
			expect(offen.id).toBe(kette[1].id);
		});

		/**
		 * CONTEXT „Erledigen": die manuelle Erholung eines **Ereignis**-Monitors. Sie ist kein
		 * Beweis — das Ticket wird kommentiert, nie geschlossen.
		 */
		it('erledigt einen gestörten Ereignis-Monitor und lässt nur kommentieren', async () => {
			const weg = new TestWeg('webhook', [webhookZielId]);
			setzeAlarmwege([weg]);
			const id = await legeAn({
				art: 'ereignis',
				parameter: { autoZurueckSekunden: 86_400 },
				// Der Ereignis-Art fehlt der Fehler-Slot: die Ankunft selbst ist das Ereignis.
				regel: {
					absender: ['usv.test'],
					betreffMuster: [],
					schluesselwoerter: [],
					musterSchlecht: [],
					musterGut: []
				},
				entwarnungsStabilitaetSekunden: 0
			});

			expect(await erledige(id, T('06:00'), db)).toBe('nicht_gestoert');

			await stoere(id, 'ereignis_eingetroffen', T('06:00'));
			await tick(T('06:01'));

			expect(await erledige(id, T('06:10'), db)).toBe('erledigt');

			const [episode] = await episoden(id);
			expect(episode.erholungsArt).toBe('erledigt');
			expect(episode.beendetAm).toEqual(T('06:10'));

			await tick(T('06:11'));
			const entwarnung = [...weg.jobs.values()].find((job) => job.ereignis === 'entwarnung');
			expect(entwarnung).toBeUndefined(); // die Kette hält noch beim Alarm

			await bestaetigeUebergebene(weg, T('06:11'));
			await tick(T('06:12'));

			const gemeldet = [...weg.jobs.values()].find((job) => job.ereignis === 'entwarnung');
			expect(gemeldet?.weisung).toBe('kommentieren');
			expect(gemeldet?.rueckverweis).toBe(`${BASIS}/monitore/${id}`);
		});

		it('weist das Erledigen für andere Arten ab', async () => {
			const id = await legeAn();
			await stoere(id, 'ueberfaellig', T('06:00'));

			expect(await erledige(id, T('06:10'), db)).toBe('falsche_art');
			expect(await erledige('00000000-0000-0000-0000-000000000000', T('06:10'), db)).toBe(
				'unbekannt'
			);
		});
	});
});
