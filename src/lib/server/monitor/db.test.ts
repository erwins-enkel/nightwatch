/**
 * Monitor-CRUD against a real Postgres.
 *
 * The validation rules themselves are asserted without a database in `parameter.test.ts`. What is
 * left here is what only the database enforces: that a monitor and its rule arrive together, that a
 * kind change cannot leave a parameter of the old kind behind (the table's CHECK would refuse), and
 * that the delete guard cannot be talked out of the alarm history.
 *
 * Runs only when `DATABASE_URL` points somewhere, exactly like `zuordnung/db.test.ts`.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { legeKundeAn } from '../zuordnung/db';
import {
	aktualisiereMonitor,
	holeMonitor,
	ladeMonitorIndex,
	legeMonitorAn,
	listeMonitore,
	loescheMonitor,
	setzeAktivierung,
	setzePause,
	type MonitorEingabe
} from './db';
import { trifftMatchKriterien } from './regel';

const databaseUrl = process.env.DATABASE_URL;
type Datenbank = ReturnType<typeof drizzle<typeof schema>>;

describe.skipIf(!databaseUrl && !process.env.CI)('Monitor-CRUD', () => {
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
		await db.delete(schema.kunde);
		// Die Vorlage, die der Herkunfts-Test anlegt, hängt an keinem Kunden und überlebt die beiden
		// Zeilen darüber. Sie trägt einen eindeutigen Schlüssel, also scheitert der zweite Lauf gegen
		// dieselbe Datenbank an ihr — je nachdem, ob eine andere Suite die Tabelle zwischendurch
		// geleert hat. Hier wegzuräumen ist billiger, als die Reihenfolge zu einer Zusicherung zu
		// machen.
		await db.delete(schema.regelVorlage);

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
	});

	const JETZT = new Date('2026-07-28T06:00:00Z');

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

	async function anlegen(teile: Partial<MonitorEingabe> = {}): Promise<string> {
		const ergebnis = await legeMonitorAn(eingabe(teile), db);
		if (ergebnis.art !== 'ok') throw new Error(`Anlage fehlgeschlagen: ${ergebnis.art}`);
		return ergebnis.id;
	}

	const holeZeile = async (id: string) => {
		const [zeile] = await db.select().from(schema.monitor).where(eq(schema.monitor.id, id));
		return zeile;
	};

	const holeVorlageId = async (monitorId: string) => {
		const [zeile] = await db
			.select({ vorlageId: schema.regel.vorlageId })
			.from(schema.regel)
			.where(eq(schema.regel.monitorId, monitorId));
		return zeile.vorlageId;
	};

	// -----------------------------------------------------------------------------------------
	describe('Anlegen', () => {
		it('legt Monitor und Regel zusammen an', async () => {
			const id = await anlegen();

			const zeile = await holeMonitor(id, db);
			expect(zeile.bezeichnung).toBe('Veeam Backup');
			expect(zeile.regelMusterSchlecht).toEqual(['failed']);
			expect(zeile.regelQuelle).toBe('manuell');
			expect(zeile.kundeName).toBe('Kunde A');
		});

		/** „Keine Regel wird ohne menschliche Bestätigung aktiv" (SPEC §5). */
		it('legt einen Entwurf an, keinen scharfen Monitor', async () => {
			expect((await holeZeile(await anlegen())).aktiviertAm).toBeNull();
		});

		it('weist unplausible Eingaben zurück, bevor ein CHECK zuschlägt', async () => {
			const ergebnis = await legeMonitorAn(
				eingabe({ art: 'zaehler', parameter: {}, bezeichnung: ' ' }),
				db
			);

			expect(ergebnis).toMatchObject({ art: 'ungueltig' });
			if (ergebnis.art === 'ungueltig') {
				expect(ergebnis.fehler).toContain('fenster_fehlt');
				expect(ergebnis.fehler).toContain('bezeichnung_leer');
			}
			expect(await db.select().from(schema.monitor)).toHaveLength(0);
		});

		it('füllt die dokumentierten Defaults, statt sie zu verlangen', async () => {
			const id = await anlegen({
				art: 'ereignis',
				parameter: {},
				regel: { ...eingabe().regel, musterSchlecht: [] }
			});
			expect((await holeZeile(id)).autoZurueckSekunden).toBe(86_400);
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Überarbeiten', () => {
		it('schreibt die Regel neu', async () => {
			const id = await anlegen();

			await aktualisiereMonitor(
				id,
				eingabe({ regel: { ...eingabe().regel, musterSchlecht: ['failed', 'error'] } }),
				db
			);

			expect((await holeMonitor(id, db)).regelMusterSchlecht).toEqual(['failed', 'error']);
		});

		/** Die Herkunft gehört zur Regel — sonst zeigt sie nach dem Überarbeiten auf eine Vorlage,
		 * aus der die Regel längst nicht mehr stammt. */
		it('schreibt die Vorlagen-Herkunft mit', async () => {
			const [vorlage] = await db
				.insert(schema.regelVorlage)
				.values({ schluessel: 'veeam-report', name: 'Veeam-Report', herkunft: 'kuratiert' })
				.returning({ id: schema.regelVorlage.id });
			const id = await anlegen({ quelle: 'vorlage', vorlageId: vorlage.id });
			expect(await holeVorlageId(id)).toBe(vorlage.id);

			await aktualisiereMonitor(id, eingabe({ quelle: 'manuell' }), db);

			expect(await holeVorlageId(id)).toBeNull();
		});

		/**
		 * Der Tabellen-CHECK `monitor_parameter_je_art` verlangt, dass jede Art nur ihre eigenen
		 * Parameter trägt — ein Art-Wechsel muss die alten also wirklich räumen.
		 */
		it('räumt beim Art-Wechsel die Parameter der alten Art weg', async () => {
			const id = await anlegen();

			const ergebnis = await aktualisiereMonitor(
				id,
				eingabe({
					art: 'zaehler',
					parameter: { zaehlerFensterSekunden: 600, zaehlerObergrenze: 50 },
					regel: { ...eingabe().regel, musterSchlecht: [], musterGut: [] }
				}),
				db
			);

			expect(ergebnis.art).toBe('ok');
			const zeile = await holeZeile(id);
			expect(zeile.erwartungModus).toBeNull();
			expect(zeile.karenzSekunden).toBeNull();
			expect(zeile.zaehlerFensterSekunden).toBe(600);
		});

		it('beendet beim Art-Wechsel eine laufende Störung still', async () => {
			const id = await anlegen({ art: 'paar', parameter: { maxOffenzeitSekunden: 0 } });
			await stoerungAnlegen(id, 'paar_zu_lange_offen');
			await db
				.update(schema.monitor)
				.set({ paarOffenSeit: JETZT })
				.where(eq(schema.monitor.id, id));

			const ergebnis = await aktualisiereMonitor(
				id,
				eingabe({
					art: 'ereignis',
					parameter: {},
					regel: { ...eingabe().regel, musterSchlecht: [] }
				}),
				db
			);

			expect(ergebnis.art).toBe('ok');
			const zeile = await holeZeile(id);
			expect(zeile.zustand).toBe('gesund');
			expect(zeile.alarmgrund).toBeNull();
			expect(zeile.paarOffenSeit).toBeNull();

			const [episode] = await db.select().from(schema.uebergang);
			expect(episode.erholungsArt).toBe('archiviert');
			expect(episode.entwarntAm).toBeNull();
		});

		it('meldet einen unbekannten Monitor, statt ins Leere zu schreiben', async () => {
			const ergebnis = await aktualisiereMonitor(
				'00000000-0000-0000-0000-000000000000',
				eingabe(),
				db
			);
			expect(ergebnis.art).toBe('unbekannt');
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Aktivierung und Pause', () => {
		/** „Ein Monitor wertet ausschließlich ab seiner Aktivierung vorwärts" (CONTEXT). */
		it('stempelt bei jeder Aktivierung neu und beendet beim Abschalten still', async () => {
			const id = await anlegen();
			await setzeAktivierung(id, true, JETZT, db);
			expect((await holeZeile(id)).aktiviertAm).toEqual(JETZT);

			await stoerungAnlegen(id, 'fehler_gemeldet');
			await setzeAktivierung(id, false, JETZT, db);

			const aus = await holeZeile(id);
			expect(aus.aktiviertAm).toBeNull();
			expect(aus.zustand).toBe('gesund');
			expect((await db.select().from(schema.uebergang))[0].erholungsArt).toBe('archiviert');

			const spaeter = new Date(+JETZT + 86_400_000);
			await setzeAktivierung(id, true, spaeter, db);
			expect((await holeZeile(id)).aktiviertAm).toEqual(spaeter);
		});

		it('setzt und räumt die Pause samt Auto-Ende', async () => {
			const id = await anlegen();
			const bis = new Date(+JETZT + 3_600_000);

			await setzePause(id, true, bis, db);
			expect(await holeZeile(id)).toMatchObject({ pausiert: true, pausiertBis: bis });

			await setzePause(id, false, bis, db);
			expect(await holeZeile(id)).toMatchObject({ pausiert: false, pausiertBis: null });
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Löschen', () => {
		it('löscht eine Fehlanlage ohne Historie samt Regel', async () => {
			const id = await anlegen();

			expect(await loescheMonitor(id, db)).toBe('geloescht');
			expect(await db.select().from(schema.monitor)).toHaveLength(0);
			expect(await db.select().from(schema.regel)).toHaveLength(0);
		});

		/** `uebergang` kaskadiert — ein freies DELETE nähme die Alarm-Historie mit. */
		it('verweigert das Löschen, sobald eine Episode existiert', async () => {
			const id = await anlegen();
			await stoerungAnlegen(id, 'fehler_gemeldet');

			expect(await loescheMonitor(id, db)).toBe('historie');
			expect(await holeZeile(id)).toBeDefined();
			expect(await db.select().from(schema.uebergang)).toHaveLength(1);
		});

		it('verweigert das Löschen, sobald eine Mail zugeordnet ist', async () => {
			const id = await anlegen();
			await db.insert(schema.mail).values({
				postfachId,
				graphMessageId: `msg-${laufendeNummer++}`,
				ankunftszeit: JETZT,
				absender: 'reports@veeam.test',
				betreff: 'Backup Report',
				monitorId: id
			});

			expect(await loescheMonitor(id, db)).toBe('historie');
			expect(await holeZeile(id)).toBeDefined();
		});

		it('meldet einen unbekannten Monitor', async () => {
			expect(await loescheMonitor('00000000-0000-0000-0000-000000000000', db)).toBe('unbekannt');
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Index', () => {
		it('lädt nur aktivierte Monitore, ältester zuerst', async () => {
			const aktiv = await anlegen();
			await setzeAktivierung(aktiv, true, JETZT, db);
			const zweiter = await anlegen({ bezeichnung: 'Zweiter' });
			await setzeAktivierung(zweiter, true, JETZT, db);
			await anlegen({ bezeichnung: 'Entwurf' });

			const index = await ladeMonitorIndex(db);

			expect(index.get(kundeId)?.map((eintrag) => eintrag.id)).toEqual([aktiv, zweiter]);
		});

		it('lässt ein kaputtes Muster die übrigen nicht mitreißen', async () => {
			const id = await anlegen();
			await setzeAktivierung(id, true, JETZT, db);
			// Am CRUD vorbei, so wie es nur ein Import oder eine ältere Version hinterlassen könnte.
			await db
				.update(schema.regel)
				.set({ musterSchlecht: ['(unbalanced'] })
				.where(eq(schema.regel.monitorId, id));

			const index = await ladeMonitorIndex(db);
			const eintrag = index.get(kundeId)?.[0];

			expect(eintrag?.regel.musterSchlecht).toHaveLength(0);
			// Die Match-Kriterien der Regel greifen weiter.
			expect(
				trifftMatchKriterien(
					{ absender: 'reports@veeam.test', betreff: 'Backup', bodyText: null },
					eintrag!.regel
				)
			).toBe(true);
		});

		it('listet die Monitore eines Kunden', async () => {
			await anlegen();
			const andererKunde = await legeKundeAn(
				{ name: 'Kunde B', kundennummer: null, notiz: null, autotaskCompanyId: null },
				db
			);
			await anlegen({ kundeId: andererKunde, bezeichnung: 'Fremd' });

			expect(await listeMonitore(kundeId, db)).toHaveLength(1);
			expect(await listeMonitore(undefined, db)).toHaveLength(2);
		});
	});

	/** Eine laufende Störung, wie sie die Auswertung hinterlässt. */
	async function stoerungAnlegen(monitorId: string, grund: schema.Alarmgrund): Promise<void> {
		await db
			.update(schema.monitor)
			.set({ zustand: 'gestoert', alarmgrund: grund, zustandSeit: JETZT })
			.where(eq(schema.monitor.id, monitorId));
		await db.insert(schema.uebergang).values({ monitorId, alarmgrund: grund, begonnenAm: JETZT });
	}
});
