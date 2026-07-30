/**
 * Der Watchdog-Tick als Ganzes, gegen eine echte Postgres.
 *
 * Zwei Fehlerbilder werden erst hier sichtbar, weil beide aus dem *Zusammenspiel* entstehen:
 *
 *  - Die **Wurzel-Unterdrückung im ersten Tick eines Ausfalls**. Kern und Postfächer werden im
 *    selben Durchlauf stale; würde `kernGestoert` aus der beim Tick-Beginn gelesenen Zeile kommen,
 *    entstünde eine Postfach-Episode je Postfach neben der Kern-Episode.
 *  - Der **ganze Zyklus einer Zustell-Störung**: Kunden-Dead-Letter ⇒ Kern gestört ⇒ Selbst-Alarm
 *    scheitert wiederholt, ohne aufzugeben und ohne eine zweite Störung zu erzeugen ⇒ Ziel repariert
 *    ⇒ dieselbe Zustellung kommt durch ⇒ Kern gesund ⇒ Entwarnung. Ohne den letzten Schritt bliebe
 *    eine Regel unbemerkt, die den Kern nie wieder gesund werden lässt.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { verschluessele } from '../crypto';
import type { WebhookAntwort, WebhookPort } from '../webhook/client';
import { werteSelbstAus } from './scheduler';
import { SELBST_MAX_VERSUCHE, type VersandPorts } from './versand';

const databaseUrl = process.env.DATABASE_URL;
type Datenbank = ReturnType<typeof drizzle<typeof schema>>;

const T = (hhmm: string) => new Date(`2026-07-29T${hhmm}:00Z`);
const STALENESS = 900;

/** Ein Webhook-Empfänger, den der Test kaputt und wieder heil schalten kann. */
class TestWebhook implements WebhookPort {
	erreichbar = true;
	aufrufe = 0;

	sende(): Promise<WebhookAntwort> {
		this.aufrufe++;
		return this.erreichbar
			? Promise.resolve({ status: 200, text: '' })
			: Promise.reject(new Error('Empfänger weg'));
	}
}

describe.skipIf(!databaseUrl && !process.env.CI)('Watchdog-Tick', () => {
	let pool: pg.Pool;
	let db: Datenbank;
	let webhook: TestWebhook;
	let ports: VersandPorts;
	let laufendeNummer = 0;
	/** Ein Wegwerf-Cache: der Notfall-Pfad ist hier nicht das Thema, soll aber echt geschrieben werden. */
	let cacheDatei: string;

	beforeAll(async () => {
		// Der Webhook-Weg signiert, und ohne Schlüssel käme die „reparierte" Zustellung nie durch.
		process.env.NIGHTWATCH_SECRET_KEY ??= Buffer.alloc(32, 3).toString('base64');
		cacheDatei = join(await mkdtemp(join(tmpdir(), 'nightwatch-tick-')), 'cache.enc');
		pool = new pg.Pool({ connectionString: databaseUrl });
		db = drizzle(pool, { schema });
		await migrate(db, { migrationsFolder: 'drizzle' });
	});

	/** Auch am Ende: der Kern wird geseedet und überlebt sonst als „gestört" in fremde Suiten. */
	async function raeumeAuf() {
		await db.delete(schema.zustellung);
		await db.delete(schema.uebergang);
		await db.delete(schema.webhookZiel);
		await db.delete(schema.selbstMonitor).where(eq(schema.selbstMonitor.art, 'postfach'));
		await db.delete(schema.postfach);
		await db.delete(schema.monitor);
		await db.delete(schema.kunde);
		await db.delete(schema.heartbeat);
		await db
			.update(schema.selbstMonitor)
			.set({
				zustand: 'gesund',
				alarmgrund: null,
				stalenessSekunden: STALENESS,
				entwarnungsStabilitaetSekunden: 0,
				zustandSeit: T('00:00')
			})
			.where(eq(schema.selbstMonitor.art, 'kern'));
		await db
			.update(schema.einstellungen)
			.set({ heartbeatPingUrlChiffre: null })
			.where(eq(schema.einstellungen.id, 1));
	}

	afterAll(async () => {
		await raeumeAuf();
		await pool?.end();
		await rm(dirname(cacheDatei), { recursive: true, force: true });
	});

	beforeEach(async () => {
		await raeumeAuf();

		webhook = new TestWebhook();
		// Autotask ist in diesen Fällen aus: der Weg ist in `autotask/ablauf.test.ts` abgedeckt.
		ports = { webhook, autotask: null, autotaskDefaults: {} };
	});

	async function tick(jetzt: Date) {
		return werteSelbstAus({
			jetzt,
			beobachtetSeit: T('00:00'),
			cacheDatei,
			versandPorts: ports,
			db
		});
	}

	async function neuesPostfach(letzterErfolgAm: Date): Promise<string> {
		const nummer = laufendeNummer++;
		const [zeile] = await db
			.insert(schema.postfach)
			.values({
				bezeichnung: `NOC ${nummer}`,
				adresse: `noc${nummer}@msp.test`,
				tenantId: 'tenant',
				clientId: 'client',
				letzterErfolgreicherPoll: letzterErfolgAm
			})
			.returning({ id: schema.postfach.id });

		await db.insert(schema.selbstMonitor).values({
			schluessel: `postfach:${zeile.id}`,
			art: 'postfach',
			postfachId: zeile.id,
			bezeichnung: `Ingestion NOC ${nummer}`,
			stalenessSekunden: STALENESS,
			entwarnungsStabilitaetSekunden: 0
		});

		return zeile.id;
	}

	async function schreibeHeartbeat(dienst: string, zuletztGesehen: Date) {
		await db
			.insert(schema.heartbeat)
			.values({ dienst, zuletztGesehen, gestartetAm: T('00:00'), version: 'test', pid: 1 })
			.onConflictDoUpdate({ target: schema.heartbeat.dienst, set: { zuletztGesehen } });
	}

	/**
	 * Ein Tick mit frisch gemeldeten Diensten — für die Fälle, in denen die Dienste nicht das Thema
	 * sind. Ohne ihn liefe dem Test nach einer Viertelstunde Testzeit der Kern aus einem zweiten
	 * Grund weg, und die Zusage, die er prüft, wäre nicht mehr die, die er misst.
	 */
	async function tickMitDiensten(jetzt: Date) {
		await schreibeHeartbeat('web', jetzt);
		await schreibeHeartbeat('worker', jetzt);
		return tick(jetzt);
	}

	async function offeneEpisoden() {
		return db
			.select({
				selbstMonitorId: schema.uebergang.selbstMonitorId,
				alarmgrund: schema.uebergang.alarmgrund
			})
			.from(schema.uebergang)
			.where(isNull(schema.uebergang.beendetAm));
	}

	async function kern() {
		const [zeile] = await db
			.select()
			.from(schema.selbstMonitor)
			.where(eq(schema.selbstMonitor.art, 'kern'));
		return zeile;
	}

	// -----------------------------------------------------------------------------------------
	describe('Wurzel-Unterdrückung', () => {
		/**
		 * Der Fall, der nur im ersten Tick auftritt und den ein Test je Monitor-Art nie sähe: alles
		 * wird gleichzeitig stale. Genau **eine** Episode darf entstehen — die des Kerns.
		 */
		it('erzeugt im ersten Tick eines Ausfalls nur die Kern-Episode', async () => {
			await schreibeHeartbeat('web', T('06:00'));
			await schreibeHeartbeat('worker', T('06:00'));
			await neuesPostfach(T('06:00'));
			await neuesPostfach(T('06:00'));
			await neuesPostfach(T('06:00'));

			await tick(T('09:00'));

			const episoden = await offeneEpisoden();
			expect(episoden.length).toBe(1);
			expect(episoden[0].selbstMonitorId).toBe((await kern()).id);
		});

		it('erzeugt auch im Folgetick keine zusätzliche Postfach-Episode', async () => {
			await schreibeHeartbeat('web', T('06:00'));
			await schreibeHeartbeat('worker', T('06:00'));
			await neuesPostfach(T('06:00'));

			await tick(T('09:00'));
			await tick(T('09:30'));

			expect((await offeneEpisoden()).length).toBe(1);
		});

		/**
		 * Unterdrückt wird der Weg **in** die Störung, nicht der Weg heraus — dieselbe Semantik, die
		 * `Pausiert` für Kunden-Monitore hat.
		 */
		it('lässt eine schon offene Postfach-Episode sich trotzdem erholen', async () => {
			await schreibeHeartbeat('web', T('08:50'));
			await schreibeHeartbeat('worker', T('08:50'));
			const postfachId = await neuesPostfach(T('06:00'));

			// Erster Tick: nur das Postfach ist stale, der Kern ist gesund.
			await tick(T('09:00'));
			expect((await offeneEpisoden()).length).toBe(1);

			// Jetzt fällt der Kern aus — und das Postfach pollt wieder.
			await db
				.update(schema.postfach)
				.set({ letzterErfolgreicherPoll: T('09:30') })
				.where(eq(schema.postfach.id, postfachId));
			await tick(T('09:35'));

			const [selbst] = await db
				.select({ zustand: schema.selbstMonitor.zustand })
				.from(schema.selbstMonitor)
				.where(eq(schema.selbstMonitor.postfachId, postfachId));
			expect(selbst.zustand).toBe('gesund');
		});

		/** Ohne Kern-Störung ist ein Alarm je Postfach die richtige Antwort. */
		it('alarmiert je Postfach, solange der Kern gesund ist', async () => {
			await schreibeHeartbeat('web', T('08:55'));
			await schreibeHeartbeat('worker', T('08:55'));
			await neuesPostfach(T('06:00'));
			await neuesPostfach(T('06:00'));

			await tick(T('09:00'));

			expect((await offeneEpisoden()).length).toBe(2);
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Zustell-Störung, ganzer Zyklus', () => {
		async function kundenDeadLetter(zielId: string, aufgegebenAm: Date) {
			const [kunde] = await db
				.insert(schema.kunde)
				.values({ name: `Kunde ${laufendeNummer++}` })
				.returning({ id: schema.kunde.id });
			const [monitor] = await db
				.insert(schema.monitor)
				.values({
					kundeId: kunde.id,
					bezeichnung: 'Backup',
					art: 'heartbeat',
					erwartungModus: 'intervall',
					erwartungIntervallSekunden: 86_400,
					karenzSekunden: 3600
				})
				.returning({ id: schema.monitor.id });
			const [episode] = await db
				.insert(schema.uebergang)
				.values({
					monitorId: monitor.id,
					alarmgrund: 'ueberfaellig',
					beendetAm: aufgegebenAm,
					erholungsArt: 'beweis',
					alarmiertAm: aufgegebenAm,
					entwarntAm: aufgegebenAm
				})
				.returning({ id: schema.uebergang.id });

			await db.insert(schema.zustellung).values({
				uebergangId: episode.id,
				ereignis: 'alarm',
				kanal: 'webhook',
				webhookZielId: zielId,
				zustand: 'fehlgeschlagen',
				versuche: 8,
				aufgegebenAm
			});
		}

		it('alarmiert, hält durch und entwarnt, sobald derselbe Empfänger wieder annimmt', async () => {
			const [ziel] = await db
				.insert(schema.webhookZiel)
				.values({
					bezeichnung: 'RMM',
					url: 'https://rmm.msp.test/hook',
					secretChiffre: verschluessele('streng-geheim')
				})
				.returning({ id: schema.webhookZiel.id });

			await kundenDeadLetter(ziel.id, T('08:00'));

			// Der Empfänger ist tot: der Selbst-Alarm entsteht, wird veröffentlicht und scheitert.
			webhook.erreichbar = false;
			const ersterTick = await tickMitDiensten(T('09:00'));

			expect(ersterTick.veroeffentlicht).toBe(1);
			const nachAlarm = await offeneEpisoden();
			expect(nachAlarm.length).toBe(1);
			expect(nachAlarm[0].alarmgrund).toBe('fehler_gemeldet');

			// Viele Ticks später: die Zustellung hat aufgegeben — nein, hat sie nicht. Solange ihre
			// Episode offen ist, bleibt sie die einzige wiederkehrende Probe auf dieses Ziel.
			for (const minute of [
				'09:30',
				'10:00',
				'10:30',
				'11:00',
				'11:30',
				'12:00',
				'12:30',
				'12:45'
			]) {
				await tickMitDiensten(T(minute));
			}

			const [probe] = await db
				.select({ zustand: schema.zustellung.zustand, versuche: schema.zustellung.versuche })
				.from(schema.zustellung)
				.innerJoin(schema.uebergang, eq(schema.uebergang.id, schema.zustellung.uebergangId))
				.where(
					and(
						eq(schema.zustellung.ereignis, 'alarm'),
						eq(schema.zustellung.kanal, 'webhook'),
						isNull(schema.uebergang.monitorId)
					)
				);
			expect(probe.zustand).toBe('offen');
			// Über dem Budget und trotzdem nicht aufgegeben: genau das macht sie zur Probe, an der die
			// Erholung des Ziels überhaupt erst sichtbar werden kann.
			expect(probe.versuche).toBeGreaterThan(SELBST_MAX_VERSUCHE);

			// Und die gescheiterten Selbst-Zustellungen haben keine zweite Kern-Störung erzeugt.
			expect((await offeneEpisoden()).length).toBe(1);

			// Der Empfänger ist repariert. Dieser Tick bewertet noch gegen die alte Lage und stellt dann
			// zu — der Beweis entsteht also *während* des Ticks, gelesen wird er vom nächsten.
			webhook.erreichbar = true;
			await tickMitDiensten(T('13:00'));
			expect((await kern()).zustand).toBe('gestoert');

			// Der nächste Tick sieht den Erfolg auf demselben Ziel: der Kern erholt sich, und die
			// Entwarnung geht raus.
			await tickMitDiensten(T('13:30'));

			expect((await kern()).zustand).toBe('gesund');
			const [entwarnung] = await db
				.select({ ereignis: schema.zustellung.ereignis })
				.from(schema.zustellung)
				.where(eq(schema.zustellung.ereignis, 'entwarnung'));
			expect(entwarnung).toBeDefined();
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Ruhezustand', () => {
		it('lässt ein frisch eingetragenes, nie benutztes Webhook-Ziel den Kern gesund', async () => {
			await db
				.insert(schema.webhookZiel)
				.values({ bezeichnung: 'frisch', url: 'https://frisch.msp.test/hook' });

			await tickMitDiensten(T('09:00'));

			expect((await kern()).zustand).toBe('gesund');
			expect((await offeneEpisoden()).length).toBe(0);
		});

		/** Ein deaktiviertes Postfach beendet seine laufende Störung still — ohne Entwarnung. */
		it('beendet die Episode eines deaktivierten Postfachs still', async () => {
			const postfachId = await neuesPostfach(T('06:00'));

			await tickMitDiensten(T('09:00'));
			expect((await offeneEpisoden()).length).toBe(1);

			await db
				.update(schema.postfach)
				.set({ aktiv: false })
				.where(eq(schema.postfach.id, postfachId));
			await tickMitDiensten(T('09:30'));

			expect((await offeneEpisoden()).length).toBe(0);
			const [episode] = await db
				.select({ art: schema.uebergang.erholungsArt })
				.from(schema.uebergang);
			expect(episode.art).toBe('archiviert');
		});
	});
});
