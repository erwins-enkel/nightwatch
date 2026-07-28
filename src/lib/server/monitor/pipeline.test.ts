/**
 * The monitor core against a real Postgres: Mail → Kunde → Monitor → Zustand.
 *
 * The readings of the four kinds and the state machine itself are asserted without a database in
 * `auswertung.test.ts` and `zustand.test.ts`. What is left here is everything only Postgres can
 * show: that the episode's partial unique index holds under concurrency, that the Zähler counts the
 * right mails, and that arrival order survives a pipeline whose claim deliberately does not
 * preserve it.
 *
 * Runs only when `DATABASE_URL` points somewhere, exactly like `zuordnung/db.test.ts`.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { MonitorArt } from '../db/schema/enums';
import type { MonitorParameter } from '../db/schema/monitor';
import { legeKundeAn, legeMerkmalAn } from '../zuordnung/db';
import { verarbeiteStapel } from '../zuordnung/verarbeitung';
import { legeMonitorAn, setzeAktivierung, setzePause } from './db';
import { monitorStufe } from './pipeline';
import type { RegelZeile } from './regel';

const databaseUrl = process.env.DATABASE_URL;
type Datenbank = ReturnType<typeof drizzle<typeof schema>>;

describe.skipIf(!databaseUrl && !process.env.CI)('Monitor-Kern', () => {
	let pool: pg.Pool;
	let db: Datenbank;
	let postfachId: string;
	let kundeId: string;
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
		await db.delete(schema.kunde);

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

		kundeId = await legeKundeAn(
			{ name: 'Kunde A', kundennummer: null, notiz: null, autotaskCompanyId: null },
			db
		);
		await legeMerkmalAn({ kundeId, stufe: 'absender', wert: 'veeam.test' }, db);
	});

	/** Der Monitor ist ab `aktiviertAm` scharf; alle Mails der Fälle liegen danach. */
	const AKTIVIERT = new Date('2026-07-27T00:00:00Z');
	const ANKUNFT = new Date('2026-07-27T05:40:00Z');

	const MATCH: RegelZeile = {
		absender: ['veeam.test'],
		betreffMuster: [],
		schluesselwoerter: [],
		musterSchlecht: [],
		musterGut: []
	};

	async function legeAn(
		art: MonitorArt,
		parameter: MonitorParameter,
		regel: Partial<RegelZeile> = {},
		aktiviertAm: Date | null = AKTIVIERT
	): Promise<string> {
		const ergebnis = await legeMonitorAn(
			{
				kundeId,
				bezeichnung: `${art} ${laufendeNummer++}`,
				art,
				parameter,
				regel: { ...MATCH, ...regel },
				quelle: 'manuell'
			},
			db
		);
		if (ergebnis.art !== 'ok') throw new Error(`Anlage fehlgeschlagen: ${ergebnis.art}`);

		if (aktiviertAm) {
			await setzeAktivierung(ergebnis.id, true, aktiviertAm, db);
		}
		return ergebnis.id;
	}

	interface MailEingabe {
		betreff?: string;
		bodyText?: string | null;
		ankunftszeit?: Date;
		ausLernfenster?: boolean;
	}

	async function mailAnlegen(teile: MailEingabe = {}): Promise<string> {
		const [zeile] = await db
			.insert(schema.mail)
			.values({
				postfachId,
				graphMessageId: `msg-${laufendeNummer++}`,
				ankunftszeit: teile.ankunftszeit ?? ANKUNFT,
				ausLernfenster: teile.ausLernfenster ?? false,
				absender: 'reports@veeam.test',
				empfaenger: ['noc@msp.test'],
				betreff: teile.betreff ?? 'Backup Report',
				bodyText: teile.bodyText ?? null
			})
			.returning({ id: schema.mail.id });
		return zeile.id;
	}

	const stapel = (groesse = 100) => verarbeiteStapel({ db, monitorStufe, groesse });

	const holeMonitorZeile = async (id: string) => {
		const [zeile] = await db.select().from(schema.monitor).where(eq(schema.monitor.id, id));
		return zeile;
	};

	const holeMail = async (id: string) => {
		const [zeile] = await db.select().from(schema.mail).where(eq(schema.mail.id, id));
		return zeile;
	};

	const holeUebergaenge = (monitorId: string) =>
		db
			.select()
			.from(schema.uebergang)
			.where(eq(schema.uebergang.monitorId, monitorId))
			.orderBy(schema.uebergang.begonnenAm);

	// -----------------------------------------------------------------------------------------
	describe('Zuordnung', () => {
		it('bindet die Mail an den Monitor, statt eine Sorte zu zählen', async () => {
			const monitorId = await legeAn('ereignis', {}, { betreffMuster: ['Backup'] });
			const mailId = await mailAnlegen();

			await stapel();

			const zeile = await holeMail(mailId);
			expect(zeile.monitorId).toBe(monitorId);
			expect(zeile.klassifikation).toBe('fehler');
			expect(zeile.triageGrund).toBeNull();
			expect(await db.select().from(schema.mailSorte)).toHaveLength(0);
		});

		/** Das Ingestion-Gate (#26/#30) braucht das Postfach am Monitor. */
		it('merkt sich das Postfach der zugeordneten Mails', async () => {
			const monitorId = await legeAn('ereignis', {});
			await mailAnlegen();

			await stapel();

			expect((await holeMonitorZeile(monitorId)).postfachId).toBe(postfachId);
		});

		/** „Keine Regel wird ohne menschliche Bestätigung aktiv" (SPEC §5). */
		it('lässt einen unbestätigten Monitor nicht matchen', async () => {
			await legeAn('ereignis', {}, {}, null);
			const mailId = await mailAnlegen();

			await stapel();

			const zeile = await holeMail(mailId);
			expect(zeile.monitorId).toBeNull();
			expect(zeile.triageGrund).toBe('kein_monitor');
			expect(await db.select().from(schema.mailSorte)).toHaveLength(1);
		});

		it('gibt die Mail bei Überlappung dem älteren Monitor', async () => {
			const aelter = await legeAn('ereignis', {}, { betreffMuster: ['Backup'] });
			await legeAn('ereignis', {}, { betreffMuster: ['Report'] });
			const mailId = await mailAnlegen();

			await stapel();

			expect((await holeMail(mailId)).monitorId).toBe(aelter);
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Mail-getriggerte Übergänge', () => {
		const heartbeat = () =>
			legeAn(
				'heartbeat',
				{ erwartungModus: 'intervall', erwartungIntervallSekunden: 86_400, karenzSekunden: 3600 },
				{ musterSchlecht: ['failed'], musterGut: ['completed'] }
			);

		it('stört bei einer Fehlermail und erholt beweisbasiert bei OK', async () => {
			const monitorId = await heartbeat();
			await mailAnlegen({ betreff: 'Backup failed' });
			await stapel();

			const gestoert = await holeMonitorZeile(monitorId);
			expect(gestoert.zustand).toBe('gestoert');
			expect(gestoert.alarmgrund).toBe('fehler_gemeldet');
			expect(gestoert.zuletztGesehenAm).toEqual(ANKUNFT);

			const erholung = new Date(+ANKUNFT + 3_600_000);
			await mailAnlegen({ betreff: 'Backup completed', ankunftszeit: erholung });
			await stapel();

			const gesund = await holeMonitorZeile(monitorId);
			expect(gesund.zustand).toBe('gesund');
			expect(gesund.alarmgrund).toBeNull();

			const [episode] = await holeUebergaenge(monitorId);
			expect(episode.beendetAm).toEqual(erholung);
			expect(episode.erholungsArt).toBe('beweis');
			// Die Außenwirkung ist #27 — hier endet die Episode nur intern.
			expect(episode.entwarntAm).toBeNull();
		});

		/** „Ein Alarm pro Übergang" (SPEC §6): weitere Vorkommen zählen nur. */
		it('zählt Wiederholungen in eine Episode', async () => {
			const monitorId = await heartbeat();
			await mailAnlegen({ betreff: 'Backup failed' });
			await mailAnlegen({
				betreff: 'Backup failed again',
				ankunftszeit: new Date(+ANKUNFT + 60_000)
			});

			await stapel();

			const episoden = await holeUebergaenge(monitorId);
			expect(episoden).toHaveLength(1);
			expect(episoden[0].vorkommen).toBe(2);
		});

		it('hält die Verschärfung als eigenen Zeitpunkt fest', async () => {
			const monitorId = await heartbeat();
			await mailAnlegen({ betreff: 'Backup skipped' });
			await stapel();
			expect((await holeMonitorZeile(monitorId)).alarmgrund).toBe('unklar');

			const spaeter = new Date(+ANKUNFT + 60_000);
			await mailAnlegen({ betreff: 'Backup failed', ankunftszeit: spaeter });
			await stapel();

			const [episode] = await holeUebergaenge(monitorId);
			expect(episode.alarmgrund).toBe('fehler_gemeldet');
			expect(episode.verschaerftAm).toEqual(spaeter);
			expect(episode.vorkommen).toBe(2);
		});

		it('führt beim Paar genau einen offenen Zustand', async () => {
			const monitorId = await legeAn(
				'paar',
				{ maxOffenzeitSekunden: 0 },
				{ musterSchlecht: ['Leitung ab'], musterGut: ['Leitung wieder da'] }
			);

			await mailAnlegen({ betreff: 'Leitung ab' });
			await mailAnlegen({ betreff: 'Leitung ab', ankunftszeit: new Date(+ANKUNFT + 60_000) });
			await stapel();

			const offen = await holeMonitorZeile(monitorId);
			expect(offen.zustand).toBe('gestoert');
			expect(offen.alarmgrund).toBe('paar_zu_lange_offen');
			// Die Offenzeit läuft ab dem *ersten* Auf.
			expect(offen.paarOffenSeit).toEqual(ANKUNFT);
			expect((await holeUebergaenge(monitorId))[0].vorkommen).toBe(2);

			await mailAnlegen({
				betreff: 'Leitung wieder da',
				ankunftszeit: new Date(+ANKUNFT + 120_000)
			});
			await stapel();

			const zu = await holeMonitorZeile(monitorId);
			expect(zu.zustand).toBe('gesund');
			expect(zu.paarOffenSeit).toBeNull();
		});

		/** CONTEXT „Paar-Monitor": kein Alarm, kein Unklar, nur „zuletzt gesehen". */
		it('lässt eine Zu-Mail ohne offenen Zustand neutral', async () => {
			const monitorId = await legeAn(
				'paar',
				{ maxOffenzeitSekunden: 0 },
				{ musterSchlecht: ['Leitung ab'], musterGut: ['Leitung wieder da'] }
			);
			await mailAnlegen({ betreff: 'Leitung wieder da' });

			await stapel();

			const zeile = await holeMonitorZeile(monitorId);
			expect(zeile.zustand).toBe('gesund');
			expect(zeile.zuletztGesehenAm).toEqual(ANKUNFT);
			expect(await holeUebergaenge(monitorId)).toHaveLength(0);
		});

		it('lässt eine harmlose Ereignis-Mail folgenlos', async () => {
			const monitorId = await legeAn('ereignis', {}, { musterGut: ['erfolgreich installiert'] });
			await mailAnlegen({ betreff: 'Update erfolgreich installiert' });

			await stapel();

			expect((await holeMonitorZeile(monitorId)).zustand).toBe('gesund');
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Auswertungs-Gate', () => {
		it('ordnet eine Lernfenster-Mail zu, bewegt aber den Zustand nicht', async () => {
			const monitorId = await legeAn(
				'heartbeat',
				{ erwartungModus: 'intervall', erwartungIntervallSekunden: 86_400, karenzSekunden: 3600 },
				{ musterSchlecht: ['failed'], musterGut: ['completed'] }
			);
			const mailId = await mailAnlegen({ betreff: 'Backup failed', ausLernfenster: true });

			await stapel();

			const mailZeile = await holeMail(mailId);
			expect(mailZeile.monitorId).toBe(monitorId);
			expect(mailZeile.klassifikation).toBe('fehler');

			const zeile = await holeMonitorZeile(monitorId);
			expect(zeile.zustand).toBe('gesund');
			expect(zeile.zuletztGesehenAm).toBeNull();
		});

		it('ignoriert eine Mail von vor der Aktivierung', async () => {
			const monitorId = await legeAn('ereignis', {});
			await mailAnlegen({ ankunftszeit: new Date(+AKTIVIERT - 60_000) });

			await stapel();

			expect((await holeMonitorZeile(monitorId)).zustand).toBe('gesund');
		});

		/**
		 * Ein *später* verbundenes Postfach zieht ein Lernfenster, dessen Mails jünger sein können als
		 * die Aktivierung eines bestehenden Monitors. Hebt die Backfill-Mail die Ordnungsmarke, wird
		 * die danach verarbeitete reguläre Mail stumm — genau die Mail, die wirken muss.
		 */
		it('lässt eine reguläre Mail nach einem jüngeren Backfill-Eingang wirken', async () => {
			const monitorId = await legeAn('ereignis', {});

			await mailAnlegen({
				ankunftszeit: new Date(+ANKUNFT + 3_600_000),
				ausLernfenster: true
			});
			await stapel();
			expect((await holeMonitorZeile(monitorId)).zuletztGesehenAm).toBeNull();

			await mailAnlegen({ ankunftszeit: ANKUNFT });
			await stapel();

			const zeile = await holeMonitorZeile(monitorId);
			expect(zeile.zustand).toBe('gestoert');
			expect(zeile.alarmgrund).toBe('ereignis_eingetroffen');
		});

		/** „Während Pausiert feuert keine Schlecht-Bedingung und kein Alarm" — Beobachtung schon. */
		it('unterdrückt bei Pausiert die Störung, nicht die Beobachtung', async () => {
			const monitorId = await legeAn('ereignis', {});
			await setzePause(monitorId, true, null, db);
			await mailAnlegen();

			await stapel();

			const zeile = await holeMonitorZeile(monitorId);
			expect(zeile.zustand).toBe('gesund');
			expect(zeile.zuletztGesehenAm).toEqual(ANKUNFT);
			expect(await holeUebergaenge(monitorId)).toHaveLength(0);
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Zähler', () => {
		const zaehler = () => legeAn('zaehler', { zaehlerFensterSekunden: 3600, zaehlerObergrenze: 3 });

		it('feuert mit der Mail, die die Obergrenze reißt', async () => {
			const monitorId = await zaehler();
			for (let i = 0; i < 3; i++) {
				await mailAnlegen({ ankunftszeit: new Date(+ANKUNFT + i * 60_000) });
			}

			await stapel();
			expect((await holeMonitorZeile(monitorId)).zustand).toBe('gesund');

			await mailAnlegen({ ankunftszeit: new Date(+ANKUNFT + 180_000) });
			await stapel();

			const zeile = await holeMonitorZeile(monitorId);
			expect(zeile.zustand).toBe('gestoert');
			expect(zeile.alarmgrund).toBe('zaehler_ueber_obergrenze');
		});

		/**
		 * Lernfenster- und Vor-Aktivierungs-Mails tragen `monitor_id` wie jede andere. Zählte das
		 * Fenster sie mit, risse die erste reguläre Mail die Obergrenze aus dreißig Tagen Backfill
		 * heraus — „Historie ist Lernmaterial, nicht Überwachungsmaterial".
		 */
		it('zählt weder Lernfenster- noch Vor-Aktivierungs-Mails mit', async () => {
			const monitorId = await zaehler();

			for (let i = 0; i < 5; i++) {
				await mailAnlegen({
					ankunftszeit: new Date(+ANKUNFT - (i + 1) * 60_000),
					ausLernfenster: true
				});
			}
			await mailAnlegen({ ankunftszeit: new Date(+AKTIVIERT - 60_000) });
			await stapel();

			for (let i = 0; i < 3; i++) {
				await mailAnlegen({ ankunftszeit: new Date(+ANKUNFT + i * 60_000) });
			}
			await stapel();

			// Drei zählbare Mails im Fenster — die Obergrenze von 3 ist nicht überschritten.
			expect((await holeMonitorZeile(monitorId)).zustand).toBe('gesund');

			await mailAnlegen({ ankunftszeit: new Date(+ANKUNFT + 180_000) });
			await stapel();

			expect((await holeMonitorZeile(monitorId)).zustand).toBe('gestoert');
		});

		it('lässt herausgealterte Mails aus dem Fenster fallen', async () => {
			const monitorId = await zaehler();
			for (let i = 0; i < 3; i++) {
				await mailAnlegen({ ankunftszeit: new Date(+ANKUNFT + i * 60_000) });
			}
			await stapel();

			// Zwei Stunden später ist von den drei nichts mehr im Ein-Stunden-Fenster.
			await mailAnlegen({ ankunftszeit: new Date(+ANKUNFT + 7_200_000) });
			await stapel();

			expect((await holeMonitorZeile(monitorId)).zustand).toBe('gesund');
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Reihenfolge und Nebenläufigkeit', () => {
		const paar = () =>
			legeAn(
				'paar',
				{ maxOffenzeitSekunden: 0 },
				{ musterSchlecht: ['Leitung ab'], musterGut: ['Leitung wieder da'] }
			);

		/**
		 * `claimUnverarbeitete` least mit `SKIP LOCKED`, ein jüngerer Stapel kann also zuerst
		 * festschreiben. Ohne Sortierung wäre das „Zu" neutral und das nachgereichte „Auf" bliebe
		 * für immer offen.
		 */
		it('faltet einen Stapel in Ankunftsreihenfolge, nicht in Claim-Reihenfolge', async () => {
			const monitorId = await paar();
			// Absichtlich verdreht eingefügt: die spätere Zu-Mail zuerst.
			await mailAnlegen({
				betreff: 'Leitung wieder da',
				ankunftszeit: new Date(+ANKUNFT + 60_000)
			});
			await mailAnlegen({ betreff: 'Leitung ab', ankunftszeit: ANKUNFT });

			await stapel();

			const zeile = await holeMonitorZeile(monitorId);
			expect(zeile.zustand).toBe('gesund');
			expect(zeile.paarOffenSeit).toBeNull();
			expect((await holeUebergaenge(monitorId))[0].erholungsArt).toBe('beweis');
		});

		it('lässt ein nachgereichtes älteres Auf den geschlossenen Zustand nicht aufreißen', async () => {
			const monitorId = await paar();
			await mailAnlegen({
				betreff: 'Leitung wieder da',
				ankunftszeit: new Date(+ANKUNFT + 60_000)
			});
			await stapel();

			await mailAnlegen({ betreff: 'Leitung ab', ankunftszeit: ANKUNFT });
			await stapel();

			const zeile = await holeMonitorZeile(monitorId);
			expect(zeile.paarOffenSeit).toBeNull();
			expect(zeile.zustand).toBe('gesund');
		});

		/** Zwei Worker, ein Monitor: die Sperre entscheidet, nicht der Unique-Index. */
		it('erzeugt bei gleichzeitigen Stapeln genau eine offene Episode', async () => {
			const monitorId = await legeAn('ereignis', {});
			await mailAnlegen({ ankunftszeit: ANKUNFT });
			await mailAnlegen({ ankunftszeit: new Date(+ANKUNFT + 60_000) });

			await Promise.all([stapel(1), stapel(1)]);

			const offene = await db
				.select()
				.from(schema.uebergang)
				.where(and(eq(schema.uebergang.monitorId, monitorId), isNull(schema.uebergang.beendetAm)));

			expect(offene).toHaveLength(1);
			expect(offene[0].vorkommen).toBe(2);
			expect((await holeMonitorZeile(monitorId)).zustand).toBe('gestoert');
		});
	});
});
