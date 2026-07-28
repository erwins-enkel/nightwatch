/**
 * The ingestion's database behaviour, checked against a real Postgres.
 *
 * The interesting parts here are not the columns but the concurrency and the idempotency: that a
 * claim hands the same mailbox to only one worker, that re-reading a delta page cannot duplicate a
 * mail, and that the learning-window marking is decided by arrival time. None of those can be
 * asserted against a mock.
 *
 * Runs only when `DATABASE_URL` points somewhere, exactly like `db/schema.test.ts`.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { MailZeile } from '../graph/nachricht';
import {
	claimFaellige,
	entfernePostfach,
	legePostfachAn,
	listePostfaecher,
	setzeAktiv,
	speichereMails,
	vermerkeErfolg,
	vermerkeFehler
} from './db';

const databaseUrl = process.env.DATABASE_URL;
type Datenbank = ReturnType<typeof drizzle<typeof schema>>;

describe.skipIf(!databaseUrl && !process.env.CI)('Ingestion-Persistenz', () => {
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

	// These cases claim rows and race each other, so a rollback-per-test would hide exactly what is
	// under test. The mailboxes are wiped instead — the cascade takes their mails with them. Their
	// self-monitors survive a deleted mailbox by design, so those are cleared explicitly; the
	// global `kern` monitor is seeded and must stay.
	beforeEach(async () => {
		await db.delete(schema.postfach);
		await db.delete(schema.selbstMonitor).where(eq(schema.selbstMonitor.art, 'postfach'));
		await db.delete(schema.kunde);
	});

	const erstelltAm = new Date('2026-07-27T10:00:00Z');

	const neuesPostfach = async (adresse = 'noc@example.test', rest = {}) => {
		const id = await legePostfachAn(
			{
				bezeichnung: `Postfach ${adresse}`,
				adresse,
				tenantId: 'tenant-1',
				clientId: 'client-1',
				clientSecretChiffre: 'v1.aa.bb.cc',
				secretAblaufAm: null,
				pollIntervallSekunden: 120,
				lernfensterTage: 30,
				...rest
			},
			db
		);
		// `erstellt_am` has a database default; the learning-window boundary is pinned so the
		// assertions below do not depend on wall-clock timing.
		await db.update(schema.postfach).set({ erstelltAm }).where(eq(schema.postfach.id, id));
		return id;
	};

	const mailZeile = (id: string, ankunft: string): MailZeile => ({
		graphMessageId: id,
		ankunftszeit: new Date(ankunft),
		absender: 'reports@hersteller.test',
		empfaenger: ['noc@example.test'],
		betreff: 'Backup completed',
		bodyText: 'ok'
	});

	describe('Anlegen', () => {
		it('legt mit dem Postfach seinen Selbst-Monitor an', async () => {
			// CONTEXT „Selbst-Monitor": einer pro Postfach. Entstünde er nicht mit, gäbe es ein
			// Postfach, dessen Ingestion niemand überwacht — genau der blinde Fleck, den Nightwatch
			// abschaffen soll.
			const id = await neuesPostfach();

			const [selbst] = await db
				.select()
				.from(schema.selbstMonitor)
				.where(eq(schema.selbstMonitor.postfachId, id));

			expect(selbst).toMatchObject({
				schluessel: `postfach:${id}`,
				art: 'postfach',
				zustand: 'gesund'
			});
		});

		it('lässt kein zweites Postfach auf dieselbe Adresse zu', async () => {
			await neuesPostfach('doppelt@example.test');

			await expect(neuesPostfach('doppelt@example.test')).rejects.toThrow();

			// Die Transaktion ist zurückgerollt: kein verwaister Selbst-Monitor bleibt zurück.
			const monitore = await db
				.select()
				.from(schema.selbstMonitor)
				.where(eq(schema.selbstMonitor.art, 'postfach'));
			expect(monitore).toHaveLength(1);
		});
	});

	describe('Claim', () => {
		it('gibt ein fälliges Postfach genau einmal heraus', async () => {
			// Der eigentliche Nebenläufigkeitsschutz: zwei Worker dürfen dasselbe Postfach nicht
			// gleichzeitig pollen.
			await neuesPostfach();
			const jetzt = new Date();

			const ersterLauf = await claimFaellige(4, jetzt, db);
			const zweiterLauf = await claimFaellige(4, jetzt, db);

			expect(ersterLauf).toHaveLength(1);
			expect(zweiterLauf).toHaveLength(0);
		});

		it('schiebt die Fälligkeit beim Claim um das Poll-Intervall vor', async () => {
			const id = await neuesPostfach('takt@example.test', { pollIntervallSekunden: 300 });
			const jetzt = new Date('2026-07-27T12:00:00Z');

			await claimFaellige(4, jetzt, db);

			const [zeile] = await db.select().from(schema.postfach).where(eq(schema.postfach.id, id));
			expect(zeile.naechsterPollFruehestensAm).toEqual(new Date('2026-07-27T12:05:00Z'));
		});

		it('überspringt inaktive Postfächer', async () => {
			const id = await neuesPostfach();
			await setzeAktiv(id, false, db);

			expect(await claimFaellige(4, new Date(), db)).toHaveLength(0);
		});

		it('achtet auf das Limit und nimmt die am längsten wartenden zuerst', async () => {
			const alt = await neuesPostfach('alt@example.test');
			const neu = await neuesPostfach('neu@example.test');
			await db
				.update(schema.postfach)
				.set({ naechsterPollFruehestensAm: new Date('2020-01-01T00:00:00Z') })
				.where(eq(schema.postfach.id, alt));
			await db
				.update(schema.postfach)
				.set({ naechsterPollFruehestensAm: new Date('2026-07-27T11:59:00Z') })
				.where(eq(schema.postfach.id, neu));

			const geclaimt = await claimFaellige(1, new Date(), db);

			expect(geclaimt).toHaveLength(1);
			expect(geclaimt[0].id).toBe(alt);
		});

		it('bedient ein noch nie gepolltes Postfach zuerst', async () => {
			// `nulls first`: ein frisch angebundenes Postfach soll nicht hinter Postfächern warten,
			// die schon im Takt laufen — sein Lernfenster-Backfill ist das Dringendste.
			const laufend = await neuesPostfach('laufend@example.test');
			await db
				.update(schema.postfach)
				.set({ naechsterPollFruehestensAm: new Date('2020-01-01T00:00:00Z') })
				.where(eq(schema.postfach.id, laufend));
			const frisch = await neuesPostfach('frisch@example.test');

			const geclaimt = await claimFaellige(1, new Date(), db);

			expect(geclaimt[0].id).toBe(frisch);
		});

		it('liefert alles mit, was der Poller und der Graph-Port brauchen', async () => {
			await neuesPostfach();

			const [geclaimt] = await claimFaellige(4, new Date(), db);

			expect(geclaimt).toMatchObject({
				adresse: 'noc@example.test',
				tenantId: 'tenant-1',
				clientId: 'client-1',
				clientSecretChiffre: 'v1.aa.bb.cc',
				lernfensterTage: 30,
				fehlerInFolge: 0,
				erstelltAm
			});
		});

		it('liefert Zeitstempel als Date und Zahlen als number', async () => {
			// Die Abfrage ist handgeschriebenes SQL über `db.execute`, das ohne die Typ-Umwandlung des
			// Query-Builders zurückkommt: Zeitstempel kämen als String an, und der Poller rechnet mit
			// ihnen (`.getTime()`). Das bräche erst zur Laufzeit — deshalb hier festgenagelt.
			const id = await neuesPostfach();
			await vermerkeErfolg(
				{
					postfachId: id,
					jetzt: new Date('2026-07-27T11:00:00Z'),
					deltaToken: 'https://graph/delta-1',
					deltaFolgeLink: null,
					rundeAbgeschlossen: true,
					lernfensterAbgeschlossen: true,
					intervallSekunden: 120
				},
				db
			);
			await db
				.update(schema.postfach)
				.set({ naechsterPollFruehestensAm: null })
				.where(eq(schema.postfach.id, id));

			const [geclaimt] = await claimFaellige(4, new Date(), db);

			expect(geclaimt.erstelltAm).toBeInstanceOf(Date);
			expect(geclaimt.letzterErfolgreicherPoll).toBeInstanceOf(Date);
			expect(geclaimt.lernfensterAbgeschlossenAm).toBeInstanceOf(Date);
			expect(geclaimt.erstelltAm.getTime()).toBe(erstelltAm.getTime());
			expect(typeof geclaimt.pollIntervallSekunden).toBe('number');
			expect(typeof geclaimt.fehlerInFolge).toBe('number');
		});
	});

	describe('Mails schreiben', () => {
		it('markiert Mails vor der Anlage als Lernmaterial und spätere nicht', async () => {
			// CONTEXT „Lernfenster": Historie ist Lernmaterial, nicht Überwachungsmaterial.
			const id = await neuesPostfach();

			await speichereMails(
				id,
				erstelltAm,
				[mailZeile('alt-1', '2026-07-01T05:00:00Z'), mailZeile('neu-1', '2026-07-27T11:00:00Z')],
				db
			);

			const mails = await db.select().from(schema.mail).where(eq(schema.mail.postfachId, id));
			const nachId = Object.fromEntries(mails.map((m) => [m.graphMessageId, m.ausLernfenster]));
			expect(nachId).toEqual({ 'alt-1': true, 'neu-1': false });
		});

		it('nimmt dieselbe Nachricht kein zweites Mal an und zählt nur die neuen', async () => {
			// Delta meldet eine Nachricht bei jedem Gelesen-Wechsel erneut, und ein Resync liest ein
			// ganzes Überlappungsfenster nochmal.
			const id = await neuesPostfach();
			const erste = mailZeile('m1', '2026-07-27T11:00:00Z');

			expect(await speichereMails(id, erstelltAm, [erste], db)).toBe(1);
			expect(
				await speichereMails(id, erstelltAm, [erste, mailZeile('m2', '2026-07-27T11:05:00Z')], db)
			).toBe(1);

			const mails = await db.select().from(schema.mail).where(eq(schema.mail.postfachId, id));
			expect(mails).toHaveLength(2);
		});

		it('überschreibt eine bereits zugeordnete Mail nicht', async () => {
			// #24 hängt Kunde, Monitor und Klassifikation an genau diese Zeile; ein erneuter
			// Delta-Treffer darf das nicht zurücksetzen.
			const id = await neuesPostfach();
			const [kunde] = await db.insert(schema.kunde).values({ name: 'Kunde A' }).returning();
			await speichereMails(id, erstelltAm, [mailZeile('m1', '2026-07-27T11:00:00Z')], db);
			await db
				.update(schema.mail)
				.set({ kundeId: kunde.id, klassifikation: 'ok' })
				.where(eq(schema.mail.postfachId, id));

			await speichereMails(id, erstelltAm, [mailZeile('m1', '2026-07-27T11:00:00Z')], db);

			const [zeile] = await db.select().from(schema.mail).where(eq(schema.mail.postfachId, id));
			expect(zeile).toMatchObject({ kundeId: kunde.id, klassifikation: 'ok' });
		});

		it('schreibt nichts bei einer leeren Seite', async () => {
			const id = await neuesPostfach();
			expect(await speichereMails(id, erstelltAm, [], db)).toBe(0);
		});
	});

	describe('Status vermerken', () => {
		it('räumt bei Erfolg den Fehlerstand ab und setzt die nächste Fälligkeit', async () => {
			const id = await neuesPostfach();
			const jetzt = new Date('2026-07-27T12:00:00Z');
			await vermerkeFehler(
				{
					postfachId: id,
					jetzt,
					fehler: { klasse: 'transient', code: '500', text: 'kaputt' },
					wartenMs: 60_000,
					deltaZuruecksetzen: false
				},
				db
			);

			await vermerkeErfolg(
				{
					postfachId: id,
					jetzt,
					deltaToken: 'https://graph/delta-1',
					deltaFolgeLink: null,
					rundeAbgeschlossen: true,
					lernfensterAbgeschlossen: true,
					intervallSekunden: 120
				},
				db
			);

			const [zeile] = await db.select().from(schema.postfach).where(eq(schema.postfach.id, id));
			expect(zeile).toMatchObject({
				deltaToken: 'https://graph/delta-1',
				deltaFolgeLink: null,
				letzterErfolgreicherPoll: jetzt,
				letzterFehlerCode: null,
				letzterFehlerText: null,
				letzterFehlerAm: null,
				fehlerInFolge: 0,
				lernfensterAbgeschlossenAm: jetzt,
				naechsterPollFruehestensAm: new Date('2026-07-27T12:02:00Z')
			});
		});

		it('macht ein Postfach mit laufender Runde sofort wieder fällig', async () => {
			// Sonst bräuchte ein 200-seitiger Backfill 200 Intervalle.
			const id = await neuesPostfach();
			const jetzt = new Date('2026-07-27T12:00:00Z');

			await vermerkeErfolg(
				{
					postfachId: id,
					jetzt,
					deltaToken: null,
					deltaFolgeLink: 'https://graph/next-3',
					rundeAbgeschlossen: false,
					lernfensterAbgeschlossen: false,
					intervallSekunden: 120
				},
				db
			);

			const [zeile] = await db.select().from(schema.postfach).where(eq(schema.postfach.id, id));
			expect(zeile).toMatchObject({
				deltaFolgeLink: 'https://graph/next-3',
				naechsterPollFruehestensAm: jetzt,
				lernfensterAbgeschlossenAm: null
			});
		});

		it('zählt Fehler hoch und rührt den letzten erfolgreichen Poll nicht an', async () => {
			// `letzter_erfolgreicher_poll` ist das Staleness-Signal des Selbst-Monitors (#30) — ein
			// Fehlschlag darf nicht wie Aktivität aussehen.
			const id = await neuesPostfach();
			const erfolgAm = new Date('2026-07-27T11:00:00Z');
			await vermerkeErfolg(
				{
					postfachId: id,
					jetzt: erfolgAm,
					deltaToken: 'https://graph/delta-1',
					deltaFolgeLink: null,
					rundeAbgeschlossen: true,
					lernfensterAbgeschlossen: true,
					intervallSekunden: 120
				},
				db
			);

			const jetzt = new Date('2026-07-27T12:00:00Z');
			for (let versuch = 0; versuch < 2; versuch++) {
				await vermerkeFehler(
					{
						postfachId: id,
						jetzt,
						fehler: { klasse: 'zugriff', code: 'ErrorAccessDenied', text: 'Access is denied.' },
						wartenMs: 120_000,
						deltaZuruecksetzen: false
					},
					db
				);
			}

			const [zeile] = await db.select().from(schema.postfach).where(eq(schema.postfach.id, id));
			expect(zeile).toMatchObject({
				fehlerInFolge: 2,
				letzterFehlerCode: 'ErrorAccessDenied',
				letzterErfolgreicherPoll: erfolgAm,
				// Zugriffsprobleme lassen den Delta-Zustand unangetastet.
				deltaToken: 'https://graph/delta-1',
				naechsterPollFruehestensAm: new Date('2026-07-27T12:02:00Z')
			});
		});

		it('verwirft den Delta-Zustand, wenn ein Resync verlangt wird', async () => {
			const id = await neuesPostfach();
			const jetzt = new Date('2026-07-27T12:00:00Z');
			await vermerkeErfolg(
				{
					postfachId: id,
					jetzt,
					deltaToken: 'https://graph/delta-1',
					deltaFolgeLink: null,
					rundeAbgeschlossen: true,
					lernfensterAbgeschlossen: true,
					intervallSekunden: 120
				},
				db
			);

			await vermerkeFehler(
				{
					postfachId: id,
					jetzt,
					fehler: { klasse: 'resync', code: 'resyncRequired', text: 'Resync required' },
					wartenMs: 1_000,
					deltaZuruecksetzen: true
				},
				db
			);

			const [zeile] = await db.select().from(schema.postfach).where(eq(schema.postfach.id, id));
			// Das Lernfenster bleibt abgeschlossen — der Resync ist kein zweiter Backfill.
			expect(zeile).toMatchObject({
				deltaToken: null,
				deltaFolgeLink: null,
				lernfensterAbgeschlossenAm: jetzt
			});
		});
	});

	/**
	 * Die Ingestions-Zusage (#26): `ingestion_stand_am` behauptet „jede Mail bis hierhin ist eine
	 * Zeile". Der Zeit-Scheduler urteilt nicht darüber hinaus, also entscheidet diese Spalte, ob ein
	 * Heartbeat überhaupt überfällig werden darf — sie wird hier geprüft, wo sie geschrieben wird,
	 * und nicht über den Scheduler, der sie nur liest.
	 */
	describe('Vollständigkeits-Zusage', () => {
		const stand = async (id: string) => {
			const [zeile] = await db.select().from(schema.postfach).where(eq(schema.postfach.id, id));
			return zeile;
		};

		/**
		 * `ingestion_stand_am` steht per Default auf `now()` — ein frisches Postfach sagt über die
		 * Vergangenheit nichts zu. Die Fälle unten spielen in fixierter Vergangenheit, also wird die
		 * Ausgangs-Zusage mitfixiert; sonst gewönne der Default jedes `greatest`.
		 */
		const AUSGANGS_STAND = new Date('2026-07-27T00:00:00Z');

		const claimUndRunde = async (id: string, begonnenAm: Date) => {
			await db
				.update(schema.postfach)
				.set({ naechsterPollFruehestensAm: null, ingestionStandAm: AUSGANGS_STAND })
				.where(eq(schema.postfach.id, id));
			await claimFaellige(4, begonnenAm, db);
		};

		/**
		 * Ein frisches Postfach hat nichts gelesen, also darf es auch nichts zusagen. Ein `now()`-
		 * Default würde Mail beglaubigen, die noch bei Graph liegt — und die Migration reichte
		 * dieselbe Falschaussage an jedes Bestands-Postfach weiter, auch an die gerade gestörten.
		 */
		it('sagt vor der ersten abgeschlossenen Runde nichts zu', async () => {
			const id = await neuesPostfach();

			expect((await stand(id)).ingestionStandAm).toBeNull();
		});

		it('gibt die erste Zusage mit der ersten abgeschlossenen Runde', async () => {
			const id = await neuesPostfach();
			await db
				.update(schema.postfach)
				.set({ naechsterPollFruehestensAm: null })
				.where(eq(schema.postfach.id, id));
			await claimFaellige(4, new Date('2026-07-27T12:00:00Z'), db);

			await vermerkeErfolg(
				{
					postfachId: id,
					jetzt: new Date('2026-07-27T12:00:30Z'),
					deltaToken: 'https://graph/delta-1',
					deltaFolgeLink: null,
					rundeAbgeschlossen: true,
					lernfensterAbgeschlossen: true,
					intervallSekunden: 120
				},
				db
			);

			expect((await stand(id)).ingestionStandAm).toEqual(new Date('2026-07-27T11:59:00Z'));
		});

		it('stempelt den Rundenbeginn beim Claim, der eine neue Runde startet', async () => {
			const id = await neuesPostfach();
			const begonnenAm = new Date('2026-07-27T12:00:00Z');

			await claimUndRunde(id, begonnenAm);

			expect((await stand(id)).rundeBegonnenAm).toEqual(begonnenAm);
		});

		it('behält den Rundenbeginn, während dieselbe Runde weiterpagt', async () => {
			const id = await neuesPostfach();
			const begonnenAm = new Date('2026-07-27T12:00:00Z');
			await claimUndRunde(id, begonnenAm);

			// Ein Lauf, der das Seiten-Budget ausschöpft, hinterlässt den nextLink …
			await vermerkeErfolg(
				{
					postfachId: id,
					jetzt: new Date('2026-07-27T12:00:30Z'),
					deltaToken: null,
					deltaFolgeLink: 'https://graph/next-2',
					rundeAbgeschlossen: false,
					lernfensterAbgeschlossen: false,
					intervallSekunden: 120
				},
				db
			);
			// … und der nächste Claim setzt die Runde fort, statt eine neue zu beginnen.
			await claimFaellige(4, new Date('2026-07-27T12:05:00Z'), db);

			expect((await stand(id)).rundeBegonnenAm).toEqual(begonnenAm);
		});

		it('schiebt den Stand nur bei abgeschlossener Runde, und auf deren Beginn', async () => {
			const id = await neuesPostfach();
			const begonnenAm = new Date('2026-07-27T12:00:00Z');
			await claimUndRunde(id, begonnenAm);
			const vorher = (await stand(id)).ingestionStandAm;

			await vermerkeErfolg(
				{
					postfachId: id,
					jetzt: new Date('2026-07-27T12:00:30Z'),
					deltaToken: null,
					deltaFolgeLink: 'https://graph/next-2',
					rundeAbgeschlossen: false,
					lernfensterAbgeschlossen: false,
					intervallSekunden: 120
				},
				db
			);
			expect((await stand(id)).ingestionStandAm).toEqual(vorher);

			// Die Runde pagte zehn Minuten. Zugesagt wird trotzdem nur bis zu ihrem *Beginn* minus
			// Sicherheitsspanne — über die zehn Minuten weiß sie nichts.
			await vermerkeErfolg(
				{
					postfachId: id,
					jetzt: new Date('2026-07-27T12:10:00Z'),
					deltaToken: 'https://graph/delta-1',
					deltaFolgeLink: null,
					rundeAbgeschlossen: true,
					lernfensterAbgeschlossen: true,
					intervallSekunden: 120
				},
				db
			);

			expect((await stand(id)).ingestionStandAm).toEqual(new Date('2026-07-27T11:59:00Z'));
		});

		it('schiebt den Stand bei einem Fehlschlag nicht', async () => {
			const id = await neuesPostfach();
			await claimUndRunde(id, new Date('2026-07-27T12:00:00Z'));
			const vorher = (await stand(id)).ingestionStandAm;

			await vermerkeFehler(
				{
					postfachId: id,
					jetzt: new Date('2026-07-27T12:00:30Z'),
					fehler: { klasse: 'zugriff', code: 'ErrorAccessDenied', text: 'Access is denied.' },
					wartenMs: 120_000,
					deltaZuruecksetzen: false
				},
				db
			);

			expect((await stand(id)).ingestionStandAm).toEqual(vorher);
		});

		it('nimmt eine einmal gegebene Zusage nicht zurück', async () => {
			// Ein `410 Gone` wirft den Delta-Zustand weg; die folgende Runde beginnt früher als die
			// letzte zugesagte Grenze. Zurückwandern dürfte der Stand deshalb trotzdem nicht — sonst
			// würde eine Zusage widerrufen, auf die der Scheduler schon geurteilt hat.
			const id = await neuesPostfach();
			await claimUndRunde(id, new Date('2026-07-27T12:00:00Z'));
			await vermerkeErfolg(
				{
					postfachId: id,
					jetzt: new Date('2026-07-27T12:00:30Z'),
					deltaToken: 'https://graph/delta-1',
					deltaFolgeLink: null,
					rundeAbgeschlossen: true,
					lernfensterAbgeschlossen: true,
					intervallSekunden: 120
				},
				db
			);

			await db
				.update(schema.postfach)
				.set({ rundeBegonnenAm: new Date('2026-07-27T09:00:00Z') })
				.where(eq(schema.postfach.id, id));
			await vermerkeErfolg(
				{
					postfachId: id,
					jetzt: new Date('2026-07-27T12:30:00Z'),
					deltaToken: 'https://graph/delta-2',
					deltaFolgeLink: null,
					rundeAbgeschlossen: true,
					lernfensterAbgeschlossen: false,
					intervallSekunden: 120
				},
				db
			);

			expect((await stand(id)).ingestionStandAm).toEqual(new Date('2026-07-27T11:59:00Z'));
		});
	});

	describe('Löschen (SPEC §11)', () => {
		it('nimmt mit dem Postfach dessen Mails, behält aber den Selbst-Monitor', async () => {
			const id = await neuesPostfach();
			await speichereMails(id, erstelltAm, [mailZeile('m1', '2026-07-27T11:00:00Z')], db);

			await entfernePostfach(id, db);

			expect(await listePostfaecher(db)).toHaveLength(0);
			expect(await db.select().from(schema.mail)).toHaveLength(0);
			// Stillgelegt, nicht gelöscht: sonst verwaiste ein noch offenes PSA-Ticket.
			const [stillgelegt] = await db
				.select()
				.from(schema.selbstMonitor)
				.where(eq(schema.selbstMonitor.schluessel, `postfach:${id}`));
			expect(stillgelegt).toMatchObject({ art: 'postfach', postfachId: null });
		});
	});
});
