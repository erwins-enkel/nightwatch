/**
 * The assignment pipeline against a real Postgres.
 *
 * The pure rules — priority, first match, ambiguity, subject reduction — are asserted in
 * `engine.test.ts` without a database. What is left here is everything only Postgres can tell us:
 * that a claim hands a mail to exactly one worker, that the Sorten counter survives concurrency and
 * out-of-order arrival, that the delete guard cannot be raced, and that the triage list really is
 * the narrow slice it promises to be.
 *
 * Runs only when `DATABASE_URL` points somewhere, exactly like `db/schema.test.ts`.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import {
	claimUnverarbeitete,
	entferneMerkmal,
	findeKollisionen,
	findeKollisionenJeMerkmal,
	legeKundeAn,
	legeMerkmalAn,
	listeKunden,
	listeMerkmale,
	listeSorten,
	listeTriage,
	loescheKunde,
	setzeKundeZustand,
	stelleUnzugeordneteZurueck,
	upsertSorten,
	zaehleTriage
} from './db';
import { verarbeiteStapel } from './verarbeitung';

const databaseUrl = process.env.DATABASE_URL;
type Datenbank = ReturnType<typeof drizzle<typeof schema>>;

describe.skipIf(!databaseUrl && !process.env.CI)('Zuordnung', () => {
	let pool: pg.Pool;
	let db: Datenbank;
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

	// The pipeline commits — that *is* what most cases below assert — so a rollback per test would
	// hide the behaviour under test. The rows are wiped instead: deleting the mailbox takes its
	// mails, deleting the customers takes their traits and Sorten.
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
	});

	const ANKUNFT = new Date('2026-07-27T05:40:00Z');

	interface MailEingabe {
		absender?: string;
		empfaenger?: string[];
		betreff?: string;
		bodyText?: string | null;
		ankunftszeit?: Date;
		ausLernfenster?: boolean;
	}

	async function mailAnlegen(teile: MailEingabe = {}): Promise<string> {
		laufendeNummer += 1;
		const [zeile] = await db
			.insert(schema.mail)
			.values({
				postfachId,
				graphMessageId: `graph-${laufendeNummer}`,
				ankunftszeit: teile.ankunftszeit ?? ANKUNFT,
				ausLernfenster: teile.ausLernfenster ?? false,
				absender: teile.absender ?? 'reports@veeam.test',
				empfaenger: teile.empfaenger ?? ['noc@msp.test'],
				betreff: teile.betreff ?? 'Backup Report',
				bodyText: teile.bodyText ?? null
			})
			.returning({ id: schema.mail.id });
		return zeile.id;
	}

	async function kundeMitMerkmal(
		name: string,
		stufe: schema.ZuordnungsStufe,
		wert: string
	): Promise<string> {
		const kundeId = await legeKundeAn(
			{ name, kundennummer: null, notiz: null, autotaskCompanyId: null },
			db
		);
		await legeMerkmalAn({ kundeId, stufe, wert }, db);
		return kundeId;
	}

	const holeMail = async (id: string) => {
		const [zeile] = await db.select().from(schema.mail).where(eq(schema.mail.id, id));
		return zeile;
	};

	const stapel = (optionen: Parameters<typeof verarbeiteStapel>[0] = {}) =>
		verarbeiteStapel({ db, ...optionen });

	// -----------------------------------------------------------------------------------------
	describe('Claim', () => {
		it('gibt dieselbe Mail nicht an zwei Worker', async () => {
			await mailAnlegen();
			await mailAnlegen();

			await db.transaction(async (ersteTx) => {
				const erste = await claimUnverarbeitete(1, ersteTx);
				// Zweite Verbindung aus dem Pool, während die erste ihre Zeile noch hält.
				const zweite = await db.transaction((zweiteTx) => claimUnverarbeitete(1, zweiteTx));

				expect(erste).toHaveLength(1);
				expect(zweite).toHaveLength(1);
				expect(erste[0].id).not.toBe(zweite[0].id);
			});
		});

		it('nimmt die ältesten Mails zuerst', async () => {
			const jung = await mailAnlegen({ ankunftszeit: new Date('2026-07-27T09:00:00Z') });
			const alt = await mailAnlegen({ ankunftszeit: new Date('2026-07-20T09:00:00Z') });

			const geclaimt = await db.transaction((tx) => claimUnverarbeitete(2, tx));

			expect(geclaimt.map((zeile) => zeile.id)).toEqual([alt, jung]);
		});

		it('übergeht bereits verarbeitete Mails', async () => {
			await mailAnlegen();
			await stapel();

			expect(await db.transaction((tx) => claimUnverarbeitete(10, tx))).toHaveLength(0);
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Pipeline-Ergebnisse', () => {
		it('ordnet zu und vermerkt, welches Merkmal getroffen hat', async () => {
			const kundeId = await kundeMitMerkmal('Kunde A', 'absender', 'veeam.test');
			const mailId = await mailAnlegen();

			expect(await stapel()).toBe(1);

			const zeile = await holeMail(mailId);
			expect(zeile.kundeId).toBe(kundeId);
			expect(zeile.zuordnungsMerkmalId).not.toBeNull();
			expect(zeile.verarbeitetAm).not.toBeNull();
			// Kunde erkannt, aber kein Monitor passt: Grund ③, gruppiert statt einzeln.
			expect(zeile.triageGrund).toBe('kein_monitor');
			expect(zeile.sorteId).not.toBeNull();
		});

		it('meldet „kein Kunde", ohne irgendeinen Auffangkunden zu erfinden', async () => {
			await kundeMitMerkmal('Kunde A', 'absender', 'andere.test');
			const mailId = await mailAnlegen();

			await stapel();

			const zeile = await holeMail(mailId);
			expect(zeile.kundeId).toBeNull();
			expect(zeile.triageGrund).toBe('kein_kunde');
			expect(zeile.sorteId).toBeNull();
		});

		it('meldet mehrdeutig, ohne ein Merkmal als Begründung zu vermerken', async () => {
			await kundeMitMerkmal('Kunde A', 'absender', 'veeam.test');
			await kundeMitMerkmal('Kunde B', 'absender', 'reports@veeam.test');
			const mailId = await mailAnlegen();

			await stapel();

			const zeile = await holeMail(mailId);
			expect(zeile.triageGrund).toBe('mehrdeutig');
			expect(zeile.kundeId).toBeNull();
			expect(zeile.zuordnungsMerkmalId).toBeNull();
		});

		/**
		 * CONTEXT „Archiviert": Rest-Mails abgeklemmter Geräte werden dem archivierten Kunden
		 * zugerechnet und **still** abgelegt, statt die System-Triage zu fluten.
		 */
		it('legt Mails eines archivierten Kunden still ab', async () => {
			const kundeId = await kundeMitMerkmal('Kunde Alt', 'absender', 'veeam.test');
			await setzeKundeZustand(kundeId, 'archiviert', new Date(), db);
			const mailId = await mailAnlegen();

			await stapel();

			const zeile = await holeMail(mailId);
			expect(zeile.kundeId).toBe(kundeId);
			expect(zeile.zuordnungsMerkmalId).not.toBeNull();
			expect(zeile.triageGrund).toBeNull();
			expect(zeile.sorteId).toBeNull();
			expect(await db.select().from(schema.mailSorte)).toHaveLength(0);
		});

		it('verarbeitet keine Mail zweimal', async () => {
			await kundeMitMerkmal('Kunde A', 'absender', 'veeam.test');
			await mailAnlegen();

			expect(await stapel()).toBe(1);
			expect(await stapel()).toBe(0);

			const [sorte] = await db.select().from(schema.mailSorte);
			expect(sorte.anzahl).toBe(1);
		});

		it('hält sich an die Stapelgröße', async () => {
			await kundeMitMerkmal('Kunde A', 'absender', 'veeam.test');
			for (let i = 0; i < 3; i++) await mailAnlegen();

			expect(await stapel({ groesse: 2 })).toBe(2);
			expect(await stapel({ groesse: 2 })).toBe(1);
		});

		/** Der Steckplatz für #25: greift eine Monitor-Zuordnung, ist die Mail überwacht statt Sorte. */
		it('überlässt die Monitor-Stufe der eingesetzten Zuordnung', async () => {
			const kundeId = await kundeMitMerkmal('Kunde A', 'absender', 'veeam.test');
			const [monitorZeile] = await db
				.insert(schema.monitor)
				.values({
					kundeId,
					bezeichnung: 'Veeam',
					art: 'ereignis',
					autoZurueckSekunden: 86_400
				})
				.returning({ id: schema.monitor.id });
			const mailId = await mailAnlegen();

			await stapel({ monitorZuordnung: () => Promise.resolve(monitorZeile.id) });

			const zeile = await holeMail(mailId);
			expect(zeile.monitorId).toBe(monitorZeile.id);
			expect(zeile.triageGrund).toBeNull();
			expect(zeile.sorteId).toBeNull();
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Unüberwachte Mail-Sorten', () => {
		it('fasst denselben Report mehrerer Nächte zu einer Sorte zusammen', async () => {
			await kundeMitMerkmal('Kunde A', 'absender', 'veeam.test');
			await mailAnlegen({
				betreff: 'Backup Job 4711 completed 2026-07-25 05:40',
				ankunftszeit: new Date('2026-07-25T05:40:00Z')
			});
			await mailAnlegen({
				betreff: 'Backup Job 4712 completed 2026-07-26 05:41',
				ankunftszeit: new Date('2026-07-26T05:41:00Z')
			});
			await mailAnlegen({
				betreff: 'Backup Job 4713 completed 2026-07-27 05:39',
				ankunftszeit: new Date('2026-07-27T05:39:00Z')
			});

			await stapel();

			const [sorte] = await db.select().from(schema.mailSorte);
			expect(sorte.anzahl).toBe(3);
			expect(sorte.betreffMuster).toBe('Backup Job # completed #');
			expect(sorte.ersterEingang).toEqual(new Date('2026-07-25T05:40:00Z'));
			expect(sorte.letzterEingang).toEqual(new Date('2026-07-27T05:39:00Z'));
		});

		it('trennt dieselbe Sorte nach Kunde', async () => {
			await kundeMitMerkmal('Kunde A', 'plus_adresse', 'noc+a@msp.test');
			await kundeMitMerkmal('Kunde B', 'plus_adresse', 'noc+b@msp.test');
			await mailAnlegen({ empfaenger: ['noc+a@msp.test'] });
			await mailAnlegen({ empfaenger: ['noc+b@msp.test'] });

			await stapel();

			const sorten = await db.select().from(schema.mailSorte);
			expect(sorten).toHaveLength(2);
			expect(sorten.every((sorte) => sorte.anzahl === 1)).toBe(true);
		});

		it('zählt eine nachgereichte ältere Mail, ohne den letzten Eingang zurückzudrehen', async () => {
			const kundeId = await legeKundeAn(
				{ name: 'Kunde A', kundennummer: null, notiz: null, autotaskCompanyId: null },
				db
			);
			const gruppe = {
				kundeId,
				signatur: 'sig',
				absender: 'reports@veeam.test',
				betreffMuster: 'Backup #',
				anzahl: 1,
				ersterEingang: new Date('2026-07-20T05:00:00Z'),
				letzterEingang: new Date('2026-07-20T05:00:00Z')
			};

			await db.transaction((tx) => upsertSorten([gruppe], tx));
			await db.transaction((tx) =>
				upsertSorten(
					[
						{
							...gruppe,
							ersterEingang: new Date('2026-07-10T05:00:00Z'),
							letzterEingang: new Date('2026-07-10T05:00:00Z')
						}
					],
					tx
				)
			);

			const [sorte] = await db.select().from(schema.mailSorte);
			expect(sorte.anzahl).toBe(2);
			expect(sorte.ersterEingang).toEqual(new Date('2026-07-10T05:00:00Z'));
			expect(sorte.letzterEingang).toEqual(new Date('2026-07-20T05:00:00Z'));
		});

		it('listet die Sorten mit ihrem Kunden', async () => {
			await kundeMitMerkmal('Kunde A', 'absender', 'veeam.test');
			await mailAnlegen();
			await stapel();

			const sorten = await listeSorten(200, db);
			expect(sorten).toHaveLength(1);
			expect(sorten[0].kundeName).toBe('Kunde A');
			expect(sorten[0].anzahl).toBe(1);
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('System-Triage', () => {
		/**
		 * Der teuerste Fehler dieser Liste wäre, sie unbrauchbar lang zu machen: ein frisch
		 * verbundenes Postfach zieht ein Lernfenster, bevor ein einziger Kunde existiert.
		 */
		it('lässt Lernfenster-Mails außen vor, zählt sie aber in die Sorte', async () => {
			await kundeMitMerkmal('Kunde A', 'absender', 'veeam.test');
			await mailAnlegen({ ausLernfenster: true });
			await mailAnlegen({ ausLernfenster: true, absender: 'unbekannt@fremd.test' });

			await stapel();

			expect(await listeTriage(200, db)).toHaveLength(0);
			expect(await zaehleTriage(db)).toBe(0);

			const [sorte] = await db.select().from(schema.mailSorte);
			expect(sorte.anzahl).toBe(1);
		});

		it('führt „kein Kunde" und „mehrdeutig" einzeln, „kein Monitor" nicht', async () => {
			await kundeMitMerkmal('Kunde A', 'absender', 'veeam.test');
			await kundeMitMerkmal('Kunde B', 'absender', 'reports@veeam.test');
			await mailAnlegen(); // mehrdeutig
			await mailAnlegen({ absender: 'unbekannt@fremd.test' }); // kein Kunde
			await mailAnlegen({ absender: 'nur-a@veeam.test' }); // Kunde A, kein Monitor

			await stapel();

			const triage = await listeTriage(200, db);
			expect(triage.map((eintrag) => eintrag.grund).sort()).toEqual(['kein_kunde', 'mehrdeutig']);
			expect(await zaehleTriage(db)).toBe(2);
		});

		it('zeigt bei einer mehrdeutigen Mail die konkurrierenden Kunden', async () => {
			await kundeMitMerkmal('Kunde A', 'absender', 'veeam.test');
			await kundeMitMerkmal('Kunde B', 'absender', 'reports@veeam.test');
			await mailAnlegen();

			await stapel();

			const [eintrag] = await listeTriage(200, db);
			expect(eintrag.kandidaten.map((kandidat) => kandidat.kundeName)).toEqual([
				'Kunde A',
				'Kunde B'
			]);
		});

		it('gibt den Mail-Text nicht mit heraus', async () => {
			await mailAnlegen({ bodyText: 'streng vertraulich' });
			await stapel();

			const [eintrag] = await listeTriage(200, db);
			expect(eintrag).not.toHaveProperty('bodyText');
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Erneute Bewertung', () => {
		/**
		 * SPEC §4: „Das Auflösen eines Triage-Eintrags legt dauerhaft ein Zuordnungs-Merkmal an …
		 * nie nur die eine Mail zuordnen." Also muss dieselbe Mail danach wirklich verschwinden.
		 */
		it('ordnet unzugeordnete Mails nach einem neuen Merkmal zu', async () => {
			const mailId = await mailAnlegen();
			await stapel();
			expect((await holeMail(mailId)).triageGrund).toBe('kein_kunde');

			const kundeId = await kundeMitMerkmal('Kunde A', 'absender', 'veeam.test');
			await stapel();

			const zeile = await holeMail(mailId);
			expect(zeile.kundeId).toBe(kundeId);
			expect(await zaehleTriage(db)).toBe(0);
		});

		it('macht eine mehrdeutige Mail eindeutig, wenn ein kollidierendes Merkmal entfällt', async () => {
			const kundeA = await kundeMitMerkmal('Kunde A', 'absender', 'veeam.test');
			const kundeB = await kundeMitMerkmal('Kunde B', 'absender', 'veeam.test');
			const mailId = await mailAnlegen();
			await stapel();
			expect((await holeMail(mailId)).triageGrund).toBe('mehrdeutig');

			const [merkmalA] = await db
				.select({ id: schema.zuordnungsMerkmal.id })
				.from(schema.zuordnungsMerkmal)
				.where(eq(schema.zuordnungsMerkmal.kundeId, kundeA));
			await entferneMerkmal(merkmalA.id, kundeA, db);

			await stapel();
			expect((await holeMail(mailId)).kundeId).toBe(kundeB);
		});

		/**
		 * Eine bereits zugeordnete Mail neu zu bewerten würde die Beweislage umschreiben, auf der
		 * die Monitor-Historie steht — deshalb greift die Rückstellung nur bei Unzugeordnetem.
		 */
		it('rührt zugeordnete Mails nicht an', async () => {
			await kundeMitMerkmal('Kunde A', 'absender', 'veeam.test');
			const zugeordnet = await mailAnlegen();
			const offen = await mailAnlegen({ absender: 'unbekannt@fremd.test' });
			await stapel();

			expect(await stelleUnzugeordneteZurueck(db)).toBe(1);
			expect((await holeMail(zugeordnet)).verarbeitetAm).not.toBeNull();
			expect((await holeMail(offen)).verarbeitetAm).toBeNull();
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Kunden-Verwaltung', () => {
		it('warnt vor einem identischen Merkmal bei einem anderen Kunden — auch archiviert', async () => {
			const alt = await kundeMitMerkmal('Kunde Alt', 'absender', 'veeam.test');
			await setzeKundeZustand(alt, 'archiviert', new Date(), db);
			const neu = await legeKundeAn(
				{ name: 'Kunde Neu', kundennummer: null, notiz: null, autotaskCompanyId: null },
				db
			);

			const kollisionen = await findeKollisionen('absender', 'veeam.test', neu, db);

			expect(kollisionen).toHaveLength(1);
			expect(kollisionen[0]).toMatchObject({ name: 'Kunde Alt', zustand: 'archiviert' });
			// Speichern bleibt trotzdem erlaubt (Übergangsphasen).
			expect(await legeMerkmalAn({ kundeId: neu, stufe: 'absender', wert: 'veeam.test' }, db)).toBe(
				'angelegt'
			);
		});

		/**
		 * Die Warnung muss die Pflegeseite überleben, nicht nur die Antwort aufs Speichern — sonst
		 * sähe sie nur, wer zufällig gespeichert hat.
		 */
		it('hält die Kollision je Merkmal für die Pflegeseite bereit', async () => {
			const alt = await kundeMitMerkmal('Kunde Alt', 'absender', 'veeam.test');
			await setzeKundeZustand(alt, 'archiviert', new Date(), db);
			const neu = await kundeMitMerkmal('Kunde Neu', 'absender', 'veeam.test');
			await legeMerkmalAn({ kundeId: neu, stufe: 'absender', wert: 'allein.test' }, db);

			const merkmale = await listeMerkmale(neu, db);
			const kollidierend = merkmale.find((merkmal) => merkmal.wert === 'veeam.test');
			const ohneKollision = merkmale.find((merkmal) => merkmal.wert === 'allein.test');
			const kollisionen = await findeKollisionenJeMerkmal(neu, db);

			expect(kollisionen[kollidierend!.id]).toEqual([{ name: 'Kunde Alt', zustand: 'archiviert' }]);
			expect(kollisionen[ohneKollision!.id]).toBeUndefined();
		});

		/** Die Merkmal-ID kommt aus einem Formularfeld — sie darf nicht über den Kunden hinausreichen. */
		it('entfernt kein Merkmal eines fremden Kunden', async () => {
			const fremd = await kundeMitMerkmal('Kunde Fremd', 'absender', 'veeam.test');
			const eigen = await legeKundeAn(
				{ name: 'Kunde Eigen', kundennummer: null, notiz: null, autotaskCompanyId: null },
				db
			);
			const [fremdesMerkmal] = await listeMerkmale(fremd, db);

			await entferneMerkmal(fremdesMerkmal.id, eigen, db);

			expect(await listeMerkmale(fremd, db)).toHaveLength(1);
		});

		/**
		 * Merkmale entstehen nur hier — auch beim Auflösen eines Triage-Eintrags (#33). Ein
		 * ungefilterter Wert würde nicht laut scheitern, sondern einfach nie treffen.
		 */
		it('normalisiert den Wert beim Anlegen', async () => {
			const kundeId = await legeKundeAn(
				{ name: 'Kunde A', kundennummer: null, notiz: null, autotaskCompanyId: null },
				db
			);

			await legeMerkmalAn({ kundeId, stufe: 'absender', wert: '  @Veeam.TEST ' }, db);

			expect((await listeMerkmale(kundeId, db))[0].wert).toBe('veeam.test');
		});

		it('meldet dasselbe Merkmal am selben Kunden als Doppler', async () => {
			const kundeId = await kundeMitMerkmal('Kunde A', 'absender', 'veeam.test');

			expect(await legeMerkmalAn({ kundeId, stufe: 'absender', wert: 'veeam.test' }, db)).toBe(
				'doppelt'
			);
		});

		it('löscht eine Fehlanlage samt ihrer Merkmale', async () => {
			const kundeId = await kundeMitMerkmal('Kunde A', 'absender', 'veeam.test');

			expect(await loescheKunde(kundeId, db)).toBe('geloescht');
			expect(await db.select().from(schema.zuordnungsMerkmal)).toHaveLength(0);
		});

		it('verweigert das Löschen, sobald eine Mail zugeordnet ist', async () => {
			const kundeId = await kundeMitMerkmal('Kunde A', 'absender', 'veeam.test');
			await mailAnlegen();
			await stapel();

			expect(await loescheKunde(kundeId, db)).toBe('historie');
			expect(await db.select().from(schema.mail)).toHaveLength(1);
		});

		it('verweigert das Löschen, sobald ein Monitor existiert', async () => {
			const kundeId = await legeKundeAn(
				{ name: 'Kunde A', kundennummer: null, notiz: null, autotaskCompanyId: null },
				db
			);
			await db.insert(schema.monitor).values({
				kundeId,
				bezeichnung: 'Veeam',
				art: 'ereignis',
				autoZurueckSekunden: 86_400
			});

			expect(await loescheKunde(kundeId, db)).toBe('historie');
		});

		it('meldet eine unbekannte ID als unbekannt, nicht als Historie', async () => {
			expect(await loescheKunde('00000000-0000-0000-0000-000000000000', db)).toBe('unbekannt');
		});

		it('koppelt das Archiv-Datum an den Zustand', async () => {
			const kundeId = await legeKundeAn(
				{ name: 'Kunde A', kundennummer: null, notiz: null, autotaskCompanyId: null },
				db
			);

			await setzeKundeZustand(kundeId, 'archiviert', new Date(), db);
			const [archiviert] = await listeKunden(db);
			expect(archiviert.archiviertAm).not.toBeNull();

			await setzeKundeZustand(kundeId, 'aktiv', new Date(), db);
			const [wieder] = await listeKunden(db);
			expect(wieder.archiviertAm).toBeNull();
		});

		it('zeigt in der Liste, ob ein Kunde noch löschbar ist', async () => {
			const kundeId = await kundeMitMerkmal('Kunde A', 'absender', 'veeam.test');

			const [ohneHistorie] = await listeKunden(db);
			expect(ohneHistorie).toMatchObject({ hatHistorie: false, merkmale: 1, monitore: 0 });

			await mailAnlegen();
			await stapel();

			const [mitHistorie] = await listeKunden(db);
			expect(mitHistorie.hatHistorie).toBe(true);
			expect(mitHistorie.id).toBe(kundeId);
		});
	});
});
