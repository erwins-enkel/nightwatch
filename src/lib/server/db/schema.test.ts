/**
 * The invariants of the data model, checked against a real Postgres.
 *
 * A schema PR's risk is not in the columns, it is in the constraints: they are the reason
 * follow-up sessions can trust "one open ticket per monitor" or "exactly one rule per monitor"
 * without re-implementing the check in every code path. Those only exist if the database really
 * enforces them, which nothing but a database can tell us.
 *
 * Runs only when `DATABASE_URL` points somewhere — CI provides a throwaway Postgres, a local
 * `bun run test` without one simply skips this file.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from './schema';

const databaseUrl = process.env.DATABASE_URL;

type Datenbank = ReturnType<typeof drizzle<typeof schema>>;
/** The transaction handle drizzle hands to a `transaction()` callback. */
type Transaktion = Parameters<Parameters<Datenbank['transaction']>[0]>[0];

// Skipping locally is a convenience; skipping in CI would mean every invariant below goes
// unchecked while the run stays green, so there the missing URL has to be an error.
describe.skipIf(!databaseUrl && !process.env.CI)('Datenmodell', () => {
	let pool: pg.Pool;
	let db: Datenbank;

	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: databaseUrl });
		db = drizzle(pool, { schema });
		// Idempotent, so this both prepares a fresh database and asserts that the migrations of an
		// already-migrated one still apply cleanly.
		await migrate(db, { migrationsFolder: 'drizzle' });
	});

	afterAll(async () => {
		await pool?.end();
	});

	/**
	 * Runs a test body in a transaction that is always rolled back, so the cases stay independent
	 * of each other and of their order, and the seeded rows survive.
	 */
	const imRollback = async (body: (tx: Transaktion) => Promise<void>) => {
		const zurueck = new Error('rollback');
		await db
			.transaction(async (tx) => {
				await body(tx);
				throw zurueck;
			})
			.catch((err) => {
				if (err !== zurueck) throw err;
			});
	};

	/**
	 * The constraint or unique index Postgres blamed, dug out of the cause chain — drizzle wraps
	 * the driver error, and only the `pg` error underneath carries the name.
	 */
	const verletzteRegel = (fehler: unknown): string | undefined => {
		for (let e: unknown = fehler; e instanceof Error; e = e.cause) {
			const { constraint } = e as { constraint?: unknown };
			if (typeof constraint === 'string') return constraint;
		}
		return undefined;
	};

	/**
	 * Asserts that a statement is rejected **by a named guard**. Naming it is what keeps these
	 * tests honest: a bare "it threw" would also pass when the statement failed over a typo, and
	 * the constraint under test could quietly be missing.
	 *
	 * The savepoint is what makes this usable inside `imRollback`: without it the failed statement
	 * would poison the surrounding transaction and every later statement in the same test would
	 * fail for the wrong reason.
	 */
	const wirdAbgelehnt = async (
		tx: Transaktion,
		verstoss: string,
		body: (sp: Transaktion) => Promise<unknown>
	) => {
		const fehler = await tx
			.transaction(async (sp) => void (await body(sp)))
			.then(
				() => undefined,
				(err: unknown) => err
			);

		expect(fehler, `erwartet: Verletzung von ${verstoss}, tatsächlich ging es durch`).toBeDefined();
		expect(verletzteRegel(fehler)).toBe(verstoss);
	};

	const neuerKunde = async (tx: Transaktion, name = 'Kunde A') =>
		(await tx.insert(schema.kunde).values({ name }).returning())[0];

	const neuesPostfach = async (tx: Transaktion, adresse = 'noc@example.test') =>
		(
			await tx
				.insert(schema.postfach)
				.values({ bezeichnung: 'NOC', adresse, tenantId: 'tenant', clientId: 'client' })
				.returning()
		)[0];

	/** A valid heartbeat monitor: interval expectation plus grace, no other kind's parameters. */
	const neuerMonitor = async (tx: Transaktion, kundeId: string) =>
		(
			await tx
				.insert(schema.monitor)
				.values({
					kundeId,
					bezeichnung: 'Backup-Report',
					art: 'heartbeat',
					erwartungModus: 'intervall',
					erwartungIntervallSekunden: 86_400,
					karenzSekunden: 3_600
				})
				.returning()
		)[0];

	describe('Seeds', () => {
		it('legt den globalen Selbst-Monitor „Nightwatch-Kern" an', async () => {
			const zeilen = await db
				.select()
				.from(schema.selbstMonitor)
				.where(eq(schema.selbstMonitor.art, 'kern'));

			expect(zeilen).toHaveLength(1);
			expect(zeilen[0]).toMatchObject({
				schluessel: schema.SELBST_MONITOR_KERN,
				bezeichnung: 'Nightwatch-Kern',
				zustand: 'gesund',
				postfachId: null
			});
		});

		it('legt genau eine Einstellungs-Zeile mit den Defaults aus SPEC §11 an', async () => {
			const zeilen = await db.select().from(schema.einstellungen);

			expect(zeilen).toHaveLength(1);
			expect(zeilen[0]).toMatchObject({
				id: 1,
				retentionTage: 90,
				entwarnungsStabilitaetSekunden: 900
			});
		});

		it('lässt keine zweite Einstellungs-Zeile zu', async () => {
			await imRollback(async (tx) => {
				await wirdAbgelehnt(tx, 'einstellungen_singleton', (sp) =>
					sp.insert(schema.einstellungen).values({ id: 2 })
				);
			});
		});
	});

	describe('Alarm-Lebenszyklus', () => {
		it('lässt je Monitor nur eine offene Störungs-Episode zu', async () => {
			await imRollback(async (tx) => {
				const kunde = await neuerKunde(tx);
				const monitor = await neuerMonitor(tx, kunde.id);

				await tx
					.insert(schema.uebergang)
					.values({ monitorId: monitor.id, alarmgrund: 'ueberfaellig' });

				await wirdAbgelehnt(tx, 'uebergang_offen_je_monitor_key', (sp) =>
					sp.insert(schema.uebergang).values({ monitorId: monitor.id, alarmgrund: 'unklar' })
				);
			});
		});

		it('lässt eine neue Episode zu, sobald die vorherige beendet ist', async () => {
			await imRollback(async (tx) => {
				const kunde = await neuerKunde(tx);
				const monitor = await neuerMonitor(tx, kunde.id);

				await tx
					.insert(schema.uebergang)
					.values({ monitorId: monitor.id, alarmgrund: 'ueberfaellig' });
				await tx
					.update(schema.uebergang)
					.set({ beendetAm: new Date(), erholungsArt: 'beweis' })
					.where(eq(schema.uebergang.monitorId, monitor.id));

				const [zweite] = await tx
					.insert(schema.uebergang)
					.values({ monitorId: monitor.id, alarmgrund: 'fehler_gemeldet' })
					.returning();

				expect(zweite.alertId).not.toBeNull();
			});
		});

		it('bindet eine Episode an genau einen Monitor — Kunden- oder Selbst-Monitor', async () => {
			await imRollback(async (tx) => {
				const kunde = await neuerKunde(tx);
				const monitor = await neuerMonitor(tx, kunde.id);
				const [kern] = await tx
					.select()
					.from(schema.selbstMonitor)
					.where(eq(schema.selbstMonitor.art, 'kern'));

				await wirdAbgelehnt(tx, 'uebergang_genau_ein_monitor', (sp) =>
					sp.insert(schema.uebergang).values({ alarmgrund: 'unklar' })
				);
				await wirdAbgelehnt(tx, 'uebergang_genau_ein_monitor', (sp) =>
					sp.insert(schema.uebergang).values({
						monitorId: monitor.id,
						selbstMonitorId: kern.id,
						alarmgrund: 'unklar'
					})
				);
			});
		});

		it('verlangt zu jeder beendeten Episode eine Erholungs-Art', async () => {
			await imRollback(async (tx) => {
				const kunde = await neuerKunde(tx);
				const monitor = await neuerMonitor(tx, kunde.id);

				await wirdAbgelehnt(tx, 'uebergang_erholung_vollstaendig', (sp) =>
					sp.insert(schema.uebergang).values({
						monitorId: monitor.id,
						alarmgrund: 'ueberfaellig',
						beendetAm: new Date()
					})
				);
			});
		});

		it('verlangt für eine Webhook-Zustellung ein Ziel und für Autotask keines', async () => {
			await imRollback(async (tx) => {
				const kunde = await neuerKunde(tx);
				const monitor = await neuerMonitor(tx, kunde.id);
				const [episode] = await tx
					.insert(schema.uebergang)
					.values({ monitorId: monitor.id, alarmgrund: 'ueberfaellig' })
					.returning();

				await wirdAbgelehnt(tx, 'zustellung_ziel_je_kanal', (sp) =>
					sp
						.insert(schema.zustellung)
						.values({ uebergangId: episode.id, ereignis: 'alarm', kanal: 'webhook' })
				);

				const [zustellung] = await tx
					.insert(schema.zustellung)
					.values({ uebergangId: episode.id, ereignis: 'alarm', kanal: 'autotask' })
					.returning();

				expect(zustellung.zustand).toBe('offen');
			});
		});
	});

	describe('Tickets', () => {
		it('lässt je Monitor nur ein offenes Ticket zu, über Episoden hinweg', async () => {
			await imRollback(async (tx) => {
				const kunde = await neuerKunde(tx);
				const monitor = await neuerMonitor(tx, kunde.id);

				await tx
					.insert(schema.ticketKorrelation)
					.values({ monitorId: monitor.id, korrelationsKey: `nw:${monitor.id}:1` });

				// Erledigen/Auto-Zurück kommentieren nur — das Ticket bleibt offen, ein Re-Alarm
				// hängt sich daran, statt ein zweites aufzumachen.
				await wirdAbgelehnt(tx, 'ticket_offen_je_monitor_key', (sp) =>
					sp
						.insert(schema.ticketKorrelation)
						.values({ monitorId: monitor.id, korrelationsKey: `nw:${monitor.id}:2` })
				);

				// Nach der Schließung ist ein neues Ticket erlaubt (SPEC §6, Re-Alarm).
				await tx
					.update(schema.ticketKorrelation)
					.set({ zustand: 'geschlossen', geschlossenAm: new Date() })
					.where(eq(schema.ticketKorrelation.monitorId, monitor.id));
				const [neu] = await tx
					.insert(schema.ticketKorrelation)
					.values({ monitorId: monitor.id, korrelationsKey: `nw:${monitor.id}:2` })
					.returning();

				expect(neu.zustand).toBe('offen');
			});
		});

		it('überlebt die Löschung des Postfachs, damit kein offenes Ticket verwaist', async () => {
			await imRollback(async (tx) => {
				const postfach = await neuesPostfach(tx);
				const [selbst] = await tx
					.insert(schema.selbstMonitor)
					.values({
						schluessel: `postfach:${postfach.id}`,
						art: 'postfach',
						postfachId: postfach.id,
						bezeichnung: 'Ingestion X'
					})
					.returning();
				const [episode] = await tx
					.insert(schema.uebergang)
					.values({ selbstMonitorId: selbst.id, alarmgrund: 'ueberfaellig' })
					.returning();
				await tx.insert(schema.ticketKorrelation).values({
					selbstMonitorId: selbst.id,
					uebergangId: episode.id,
					korrelationsKey: `self:${selbst.id}:1`,
					ticketId: 'T-3'
				});

				await tx.delete(schema.postfach).where(eq(schema.postfach.id, postfach.id));

				// SPEC §11: das Löschen eines Postfachs entfernt Mails und Delta-State — nicht die
				// Historie und ausdrücklich nicht die Ticket-Korrelationen.
				const tickets = await tx
					.select()
					.from(schema.ticketKorrelation)
					.where(eq(schema.ticketKorrelation.selbstMonitorId, selbst.id));
				const episoden = await tx
					.select()
					.from(schema.uebergang)
					.where(eq(schema.uebergang.selbstMonitorId, selbst.id));

				expect(tickets).toHaveLength(1);
				expect(tickets[0].ticketId).toBe('T-3');
				expect(episoden).toHaveLength(1);
			});
		});

		it('hält den Zustellungs-Beleg fest, statt ihn mit dem Webhook-Ziel zu löschen', async () => {
			await imRollback(async (tx) => {
				const kunde = await neuerKunde(tx);
				const monitor = await neuerMonitor(tx, kunde.id);
				const [episode] = await tx
					.insert(schema.uebergang)
					.values({ monitorId: monitor.id, alarmgrund: 'ueberfaellig' })
					.returning();
				const [ziel] = await tx
					.insert(schema.webhookZiel)
					.values({ bezeichnung: 'RMM', url: 'https://rmm.example.test/hook' })
					.returning();
				await tx.insert(schema.zustellung).values({
					uebergangId: episode.id,
					ereignis: 'alarm',
					kanal: 'webhook',
					webhookZielId: ziel.id,
					zustand: 'fehlgeschlagen',
					versuche: 5,
					letzterFehler: 'dead letter',
					// Ein Dead Letter trägt seinen Zeitpunkt; `zustellung_abschluss_zum_zustand` besteht
					// darauf, weil der globale Selbst-Monitor genau daran „gerade gestört?" entscheidet.
					aufgegebenAm: new Date('2026-01-01T06:00:00Z')
				});

				// Ein Ziel mit Zustellungs-Historie wird nicht hart gelöscht; dafür gibt es `aktiv`.
				await wirdAbgelehnt(tx, 'zustellung_webhook_ziel_id_webhook_ziel_id_fk', (sp) =>
					sp.delete(schema.webhookZiel).where(eq(schema.webhookZiel.id, ziel.id))
				);
			});
		});
	});

	describe('Selbst-Monitore', () => {
		it('gibt dem globalen Kern-Monitor kein Postfach', async () => {
			await imRollback(async (tx) => {
				const postfach = await neuesPostfach(tx);

				await wirdAbgelehnt(tx, 'selbst_monitor_kern_ohne_postfach', (sp) =>
					sp.insert(schema.selbstMonitor).values({
						schluessel: 'kern-zwei',
						art: 'kern',
						postfachId: postfach.id,
						bezeichnung: 'Kern mit Postfach'
					})
				);
			});
		});

		it('bleibt als stillgelegter Monitor bestehen, wenn sein Postfach gelöscht wird', async () => {
			await imRollback(async (tx) => {
				const postfach = await neuesPostfach(tx);
				const [selbst] = await tx
					.insert(schema.selbstMonitor)
					.values({
						schluessel: `postfach:${postfach.id}`,
						art: 'postfach',
						postfachId: postfach.id,
						bezeichnung: 'Ingestion X'
					})
					.returning();

				await tx.delete(schema.postfach).where(eq(schema.postfach.id, postfach.id));

				const [stillgelegt] = await tx
					.select()
					.from(schema.selbstMonitor)
					.where(eq(schema.selbstMonitor.id, selbst.id));
				expect(stillgelegt).toMatchObject({ art: 'postfach', postfachId: null });
			});
		});

		it('koppelt auch beim Selbst-Monitor den Alarmgrund an den Zustand', async () => {
			await imRollback(async (tx) => {
				await wirdAbgelehnt(tx, 'selbst_monitor_alarmgrund_zum_zustand', (sp) =>
					sp
						.update(schema.selbstMonitor)
						.set({ zustand: 'gestoert' })
						.where(eq(schema.selbstMonitor.art, 'kern'))
				);
			});
		});

		it('lässt keinen zweiten globalen Kern-Monitor zu', async () => {
			await imRollback(async (tx) => {
				await wirdAbgelehnt(tx, 'selbst_monitor_kern_key', (sp) =>
					sp
						.insert(schema.selbstMonitor)
						.values({ schluessel: 'kern-zwei', art: 'kern', bezeichnung: 'Zweiter Kern' })
				);
			});
		});
	});

	describe('Monitor & Regel', () => {
		it('lässt genau eine Regel je Monitor zu', async () => {
			await imRollback(async (tx) => {
				const kunde = await neuerKunde(tx);
				const monitor = await neuerMonitor(tx, kunde.id);

				await tx.insert(schema.regel).values({ monitorId: monitor.id, quelle: 'manuell' });

				await wirdAbgelehnt(tx, 'regel_monitor_id_unique', (sp) =>
					sp.insert(schema.regel).values({ monitorId: monitor.id, quelle: 'abgeleitet' })
				);
			});
		});

		it('verlangt zu jeder Art ihre eigenen Zeitparameter', async () => {
			await imRollback(async (tx) => {
				const kunde = await neuerKunde(tx);

				// Heartbeat ohne Erwartung.
				await wirdAbgelehnt(tx, 'monitor_parameter_je_art', (sp) =>
					sp
						.insert(schema.monitor)
						.values({ kundeId: kunde.id, bezeichnung: 'Ohne Erwartung', art: 'heartbeat' })
				);
				// Zähler ohne jede Grenze — mindestens eine ist Pflicht (CONTEXT „Zähl-Monitor").
				await wirdAbgelehnt(tx, 'monitor_parameter_je_art', (sp) =>
					sp.insert(schema.monitor).values({
						kundeId: kunde.id,
						bezeichnung: 'Ohne Grenze',
						art: 'zaehler',
						zaehlerFensterSekunden: 600
					})
				);
				// Paar mit den Parametern einer fremden Art.
				await wirdAbgelehnt(tx, 'monitor_parameter_je_art', (sp) =>
					sp.insert(schema.monitor).values({
						kundeId: kunde.id,
						bezeichnung: 'Paar mit Karenz',
						art: 'paar',
						maxOffenzeitSekunden: 0,
						karenzSekunden: 60
					})
				);
				// Offener Paar-Zustand an einer Art, die gar keinen führt — sonst überlebte er das
				// Umstellen von „paar" auf „heartbeat" und der Scheduler läse einen Geisterzustand.
				await wirdAbgelehnt(tx, 'monitor_parameter_je_art', (sp) =>
					sp.insert(schema.monitor).values({
						kundeId: kunde.id,
						bezeichnung: 'Heartbeat mit offenem Paar',
						art: 'heartbeat',
						erwartungModus: 'intervall',
						erwartungIntervallSekunden: 3_600,
						karenzSekunden: 600,
						paarOffenSeit: new Date()
					})
				);
			});
		});

		it('koppelt den Alarmgrund an den Zustand', async () => {
			await imRollback(async (tx) => {
				const kunde = await neuerKunde(tx);
				const monitor = await neuerMonitor(tx, kunde.id);

				// Gestört ohne Grund: das Dashboard hätte nichts anzuzeigen.
				await wirdAbgelehnt(tx, 'monitor_alarmgrund_zum_zustand', (sp) =>
					sp
						.update(schema.monitor)
						.set({ zustand: 'gestoert' })
						.where(eq(schema.monitor.id, monitor.id))
				);
				// Gesund mit Grund: ein Grund, der die Erholung überlebt hat.
				await wirdAbgelehnt(tx, 'monitor_alarmgrund_zum_zustand', (sp) =>
					sp
						.update(schema.monitor)
						.set({ alarmgrund: 'ueberfaellig' })
						.where(eq(schema.monitor.id, monitor.id))
				);

				await tx
					.update(schema.monitor)
					.set({ zustand: 'gestoert', alarmgrund: 'ueberfaellig' })
					.where(eq(schema.monitor.id, monitor.id));
				const [gestoert] = await tx
					.select()
					.from(schema.monitor)
					.where(eq(schema.monitor.id, monitor.id));

				expect(gestoert).toMatchObject({ zustand: 'gestoert', alarmgrund: 'ueberfaellig' });
			});
		});

		it('nimmt einen Zähl-Monitor mit nur einer Grenze an', async () => {
			await imRollback(async (tx) => {
				const kunde = await neuerKunde(tx);

				const [zaehler] = await tx
					.insert(schema.monitor)
					.values({
						kundeId: kunde.id,
						bezeichnung: 'Meldungssturm',
						art: 'zaehler',
						zaehlerFensterSekunden: 600,
						zaehlerObergrenze: 50
					})
					.returning();

				expect(zaehler).toMatchObject({ zustand: 'gesund', pausiert: false, aktiviertAm: null });
			});
		});

		it('lässt einen Kalenderplan nur ohne Intervall zu', async () => {
			await imRollback(async (tx) => {
				const kunde = await neuerKunde(tx);

				await wirdAbgelehnt(tx, 'monitor_erwartung_vollstaendig', (sp) =>
					sp.insert(schema.monitor).values({
						kundeId: kunde.id,
						bezeichnung: 'Beides',
						art: 'heartbeat',
						erwartungModus: 'kalenderplan',
						erwartungPlan: { wochentage: [1, 2, 3, 4, 5], uhrzeit: '06:00' },
						erwartungIntervallSekunden: 3_600,
						karenzSekunden: 600
					})
				);

				const [plan] = await tx
					.insert(schema.monitor)
					.values({
						kundeId: kunde.id,
						bezeichnung: 'Werktäglich bis 06:00',
						art: 'heartbeat',
						erwartungModus: 'kalenderplan',
						erwartungPlan: { wochentage: [1, 2, 3, 4, 5], uhrzeit: '06:00' },
						karenzSekunden: 600
					})
					.returning();

				expect(plan.erwartungPlan).toEqual({ wochentage: [1, 2, 3, 4, 5], uhrzeit: '06:00' });
			});
		});
	});

	describe('Zuordnungs-Merkmale', () => {
		it('erlaubt dasselbe Merkmal bei zwei Kunden — Kollision warnt, sie verbietet nicht', async () => {
			await imRollback(async (tx) => {
				const a = await neuerKunde(tx, 'Kunde A');
				const b = await neuerKunde(tx, 'Kunde B');

				await tx.insert(schema.zuordnungsMerkmal).values([
					{ kundeId: a.id, stufe: 'absender', wert: 'reports@hersteller.test' },
					{ kundeId: b.id, stufe: 'absender', wert: 'reports@hersteller.test' }
				]);

				const treffer = await tx
					.select()
					.from(schema.zuordnungsMerkmal)
					.where(
						and(
							eq(schema.zuordnungsMerkmal.stufe, 'absender'),
							eq(schema.zuordnungsMerkmal.wert, 'reports@hersteller.test')
						)
					);

				// Zwei Treffer auf derselben Stufe: genau der Fall, den die Pipeline „mehrdeutig" nennt.
				expect(treffer).toHaveLength(2);
			});
		});

		it('verbietet dasselbe Merkmal zweimal am selben Kunden', async () => {
			await imRollback(async (tx) => {
				const kunde = await neuerKunde(tx);
				const merkmal = {
					kundeId: kunde.id,
					stufe: 'plus_adresse' as const,
					wert: 'noc+kundea@example.test'
				};

				await tx.insert(schema.zuordnungsMerkmal).values(merkmal);

				await wirdAbgelehnt(tx, 'zuordnungs_merkmal_kunde_stufe_wert_key', (sp) =>
					sp.insert(schema.zuordnungsMerkmal).values(merkmal)
				);
			});
		});
	});

	describe('Löschen (SPEC §11)', () => {
		const neueMail = (postfachId: string, kundeId: string | null, graphMessageId: string) => ({
			postfachId,
			kundeId,
			graphMessageId,
			ankunftszeit: new Date(),
			absender: 'reports@hersteller.test',
			betreff: 'Backup completed'
		});

		it('entfernt mit einem Postfach dessen Mails und Delta-State', async () => {
			await imRollback(async (tx) => {
				const postfach = await neuesPostfach(tx);
				const kunde = await neuerKunde(tx);
				await tx.insert(schema.mail).values(neueMail(postfach.id, kunde.id, 'graph-1'));

				await tx.delete(schema.postfach).where(eq(schema.postfach.id, postfach.id));

				const verbleibend = await tx
					.select()
					.from(schema.mail)
					.where(eq(schema.mail.postfachId, postfach.id));
				expect(verbleibend).toHaveLength(0);
			});
		});

		it('entfernt mit einem Kunden dessen Mails, Monitore und Regeln', async () => {
			await imRollback(async (tx) => {
				const postfach = await neuesPostfach(tx);
				const kunde = await neuerKunde(tx);
				const monitor = await neuerMonitor(tx, kunde.id);
				await tx.insert(schema.regel).values({ monitorId: monitor.id, quelle: 'manuell' });
				await tx.insert(schema.mail).values(neueMail(postfach.id, kunde.id, 'graph-2'));

				await tx.delete(schema.kunde).where(eq(schema.kunde.id, kunde.id));

				const [{ mails, monitore, regeln }] = await tx
					.select({
						mails: sql<number>`(select count(*) from mail where kunde_id = ${kunde.id})`,
						monitore: sql<number>`(select count(*) from monitor where kunde_id = ${kunde.id})`,
						regeln: sql<number>`(select count(*) from regel where monitor_id = ${monitor.id})`
					})
					.from(sql`(select 1) as eins`);

				expect({
					mails: Number(mails),
					monitore: Number(monitore),
					regeln: Number(regeln)
				}).toEqual({ mails: 0, monitore: 0, regeln: 0 });
			});
		});
	});

	describe('Mails', () => {
		const neueMail = (postfachId: string, graphMessageId: string) => ({
			postfachId,
			graphMessageId,
			ankunftszeit: new Date(),
			absender: 'reports@hersteller.test',
			betreff: 'Backup completed'
		});

		it('trägt eine Triage-Mail ohne Kunden und ohne Monitor', async () => {
			await imRollback(async (tx) => {
				const postfach = await neuesPostfach(tx);
				await tx
					.insert(schema.mail)
					.values({ ...neueMail(postfach.id, 'graph-3'), triageGrund: 'kein_kunde' });

				// Die Abfrage der Triage-Ansicht: genau das Prädikat des Teil-Index.
				const triage = await tx
					.select()
					.from(schema.mail)
					.where(and(eq(schema.mail.postfachId, postfach.id), isNotNull(schema.mail.triageGrund)));

				expect(triage).toHaveLength(1);
				expect(triage[0]).toMatchObject({
					triageGrund: 'kein_kunde',
					kundeId: null,
					monitorId: null,
					klassifikation: null
				});
			});
		});

		it('nimmt dieselbe Graph-Nachricht je Postfach nur einmal an', async () => {
			await imRollback(async (tx) => {
				const postfach = await neuesPostfach(tx);
				const zweites = await neuesPostfach(tx, 'alerts@example.test');
				await tx.insert(schema.mail).values(neueMail(postfach.id, 'graph-4'));

				// Erneute Zustellung desselben Delta-Ergebnisses darf keine zweite Mail erzeugen.
				await wirdAbgelehnt(tx, 'mail_postfach_graph_message_key', (sp) =>
					sp.insert(schema.mail).values(neueMail(postfach.id, 'graph-4'))
				);

				// Dieselbe ID in einem anderen Postfach ist dagegen eine andere Mail.
				const [andere] = await tx
					.insert(schema.mail)
					.values(neueMail(zweites.id, 'graph-4'))
					.returning();
				expect(andere.postfachId).toBe(zweites.id);
			});
		});
	});
});
