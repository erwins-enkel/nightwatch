/**
 * Die Ticket-Führung gegen echte Postgres, mit einem gefälschten Autotask.
 *
 * Was hier steht, beweist keine Textbausteine — die hängen in `ticket.test.ts` — sondern das
 * Zusammenspiel, das nur mit Datenbank sichtbar wird: dass ein Wiederholungslauf sein eigenes
 * Ticket wiederfindet, dass ein Monitor nie zwei offene Tickets hat, dass nur eine beweisbasierte
 * Erholung an einem unberührten Ticket schließt — und dass kein Fehler das Retry-Budget überspringt.
 *
 * Läuft nur, wenn `DATABASE_URL` irgendwohin zeigt — wie `alarm/db.test.ts`.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { PgBoss } from 'pg-boss';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { markiereFehlgeschlagen } from '../alarm/db';
import { werteAlarmeAus } from '../alarm/scheduler';
import { setzeAlarmwege } from '../alarm/wege';
import * as schema from '../db/schema';
import type { Alarmgrund, ErholungsArt } from '../db/schema/enums';
import type { AutotaskTicketDefaults } from '../db/schema/system';
import { legeMonitorAn, schreibeWirkung, setzeAktivierung, sperreMonitore } from '../monitor/db';
import type { MonitorEingabe } from '../monitor/db';
import { wendeAn } from '../monitor/zustand';
import { legeKundeAn } from '../zuordnung/db';
import { fuehreAus } from './ablauf';
import type { AutotaskAntwort, AutotaskMethode, AutotaskPort } from './client';
import { externId } from './ticket';
import { autotaskWeg } from './weg';

const databaseUrl = process.env.DATABASE_URL;
const BASIS = 'https://nightwatch.msp.example';

const KONFIG: AutotaskTicketDefaults = {
	statusId: 1,
	priorityId: 2,
	queueId: 8,
	abschlussStatusId: 5,
	notizTypId: 1,
	notizPublishId: 1,
	faelligkeitStunden: 24
};

interface FakeTicket {
	id: number;
	ticketNumber: string;
	externalID: string;
	status: number;
	assignedResourceID: number | null;
}

interface Anfrage {
	methode: AutotaskMethode;
	pfad: string;
	koerper?: unknown;
}

/**
 * Ein Autotask, das sich merkt, was es angelegt bekommt — und das stur auf Zeichengleichheit der
 * `externalID` sucht. Genau darauf ruht die De-Dupe: passte der Filterwert nicht buchstäblich zum
 * geschriebenen Feld, entstünde hier ein zweites Ticket.
 */
class FakeAutotask implements AutotaskPort {
	readonly tickets: FakeTicket[] = [];
	readonly notizen: { ticketId: string; koerper: unknown }[] = [];
	readonly anfragen: Anfrage[] = [];
	/** Jeder Wert, mit dem je nach `externalID` gesucht wurde. */
	readonly filterWerte: string[] = [];

	private naechsteId = 1000;

	/** Antwortet auf genau diesen Aufruf mit einem Fehler, statt ihn auszuführen. */
	fehler: { methode: AutotaskMethode; pfad: string; status: number; body?: unknown } | null = null;
	/** Stellt den Absturz **nach** der Anlage nach: das Ticket steht, die Antwort kommt nie an. */
	brichtNachAnlageAb = false;

	anfrage(methode: AutotaskMethode, pfad: string, koerper?: unknown): Promise<AutotaskAntwort> {
		this.anfragen.push({ methode, pfad, koerper });

		if (this.fehler && this.fehler.methode === methode && this.fehler.pfad === pfad) {
			return Promise.resolve({ status: this.fehler.status, body: this.fehler.body });
		}

		return Promise.resolve(this.beantworte(methode, pfad, koerper));
	}

	private beantworte(methode: AutotaskMethode, pfad: string, koerper?: unknown): AutotaskAntwort {
		const feld = (name: string) => (koerper as Record<string, unknown>)?.[name];

		if (methode === 'POST' && pfad === 'Tickets/query') {
			const filter = (koerper as { filter?: { field: string; value: string }[] })?.filter ?? [];
			const wert = filter.find((eintrag) => eintrag.field === 'externalID')?.value ?? '';
			this.filterWerte.push(wert);
			return { status: 200, body: { items: this.tickets.filter((t) => t.externalID === wert) } };
		}

		if (methode === 'POST' && pfad === 'Tickets') {
			const id = this.naechsteId++;
			this.tickets.push({
				id,
				ticketNumber: `T20260728.${id}`,
				externalID: String(feld('externalID')),
				status: Number(feld('status')),
				assignedResourceID: null
			});
			// Das Ticket existiert bereits — die Bestätigung geht verloren.
			if (this.brichtNachAnlageAb) return { status: 503, body: { errors: ['Verbindung weg'] } };
			return { status: 200, body: { itemId: id } };
		}

		if (methode === 'PATCH' && pfad === 'Tickets') {
			const ticket = this.tickets.find((t) => t.id === Number(feld('id')));
			if (ticket) ticket.status = Number(feld('status'));
			return { status: 200, body: { itemId: ticket?.id } };
		}

		const notiz = /^Tickets\/(\d+)\/Notes$/.exec(pfad);
		if (methode === 'POST' && notiz) {
			this.notizen.push({ ticketId: notiz[1], koerper });
			return { status: 200, body: { itemId: this.naechsteId++ } };
		}

		const einzeln = /^Tickets\/(\d+)$/.exec(pfad);
		if (methode === 'GET' && einzeln) {
			const ticket = this.tickets.find((t) => t.id === Number(einzeln[1]));
			return ticket
				? { status: 200, body: { item: ticket } }
				: { status: 404, body: { errors: ['Ticket not found'] } };
		}

		return { status: 404, body: { errors: [`Unbekannter Pfad ${methode} ${pfad}`] } };
	}
}

describe.skipIf(!databaseUrl && !process.env.CI)('Autotask-Ticketführung', () => {
	let pool: pg.Pool;
	let db: ReturnType<typeof drizzle<typeof schema>>;
	let kundeId: string;
	let postfachId: string;
	let port: FakeAutotask;
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
		await db.delete(schema.ticketKorrelation);
		await db.delete(schema.postfach);
		await db.delete(schema.selbstMonitor).where(eq(schema.selbstMonitor.art, 'postfach'));
		await db.delete(schema.kunde);

		await db
			.update(schema.einstellungen)
			.set({
				autotaskAktiv: true,
				autotaskZoneUrl: 'https://webservices3.autotask.net/atservicesrest/',
				autotaskBenutzer: 'api@msp.test',
				autotaskSecretChiffre: 'chiffre',
				autotaskIntegrationCodeChiffre: 'chiffre',
				autotaskTicketDefaults: KONFIG
			})
			.where(eq(schema.einstellungen.id, 1));

		const [zeile] = await db
			.insert(schema.postfach)
			.values({
				bezeichnung: 'NOC',
				adresse: `noc${laufendeNummer++}@msp.test`,
				tenantId: 'tenant',
				clientId: 'client',
				// Ohne Vollständigkeits-Zusage stünde die Bewertungs-Schranke auf der Epoche und keine
				// Entwarnung würde je fällig.
				ingestionStandAm: new Date('2026-12-31T00:00:00Z')
			})
			.returning({ id: schema.postfach.id });
		postfachId = zeile.id;

		kundeId = await legeKundeAn(
			{ name: 'Kunde A', kundennummer: null, notiz: null, autotaskCompanyId: 4711 },
			db
		);

		port = new FakeAutotask();
		// Der echte Weg, damit `plane()` mitgeprüft wird; die Queue selbst interessiert hier nicht.
		setzeAlarmwege([autotaskWeg({ send: () => Promise.resolve(null) } as unknown as PgBoss)]);
	});

	// -----------------------------------------------------------------------------------------
	// Aufbau
	// -----------------------------------------------------------------------------------------

	const T = (uhrzeit: string) => new Date(`2026-07-28T${uhrzeit}:00Z`);
	const AKTIVIERT = new Date('2026-07-28T00:00:00Z');

	async function legeAn(): Promise<string> {
		const eingabe: MonitorEingabe = {
			kundeId,
			bezeichnung: 'Veeam Nachtlauf',
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
			quelle: 'manuell'
		};

		const ergebnis = await legeMonitorAn(eingabe, db);
		if (ergebnis.art !== 'ok') throw new Error(`Anlage fehlgeschlagen: ${ergebnis.art}`);
		await setzeAktivierung(ergebnis.id, true, AKTIVIERT, db);
		await db.update(schema.monitor).set({ postfachId }).where(eq(schema.monitor.id, ergebnis.id));
		return ergebnis.id;
	}

	/** Treibt den Monitor über die echte Zustandsmaschine — was entsteht, ist eine echte Episode. */
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

	const stoere = (id: string, am: Date, grund: Alarmgrund = 'ueberfaellig') =>
		wirke(id, { art: 'stoerung', grund }, am);
	const erhole = (id: string, am: Date, erholungsArt: ErholungsArt = 'beweis') =>
		wirke(id, { art: 'erholung', erholungsArt }, am);

	const tick = (jetzt: Date) => werteAlarmeAus({ jetzt, db, basisUrl: BASIS });

	async function offeneZustellung(): Promise<{ id: string }> {
		const [zeile] = await db
			.select({ id: schema.zustellung.id })
			.from(schema.zustellung)
			.where(eq(schema.zustellung.zustand, 'offen'))
			.orderBy(schema.zustellung.erstelltAm);

		if (!zeile) throw new Error('Keine offene Zustellung');
		return zeile;
	}

	/** Veröffentlicht, was fällig ist, und stellt die älteste offene Zustellung zu. */
	async function stelleZu(jetzt: Date): Promise<void> {
		await tick(jetzt);
		const zustellung = await offeneZustellung();
		await fuehreAus({
			zustellungId: zustellung.id,
			port,
			konfig: KONFIG,
			jetzt,
			basisUrl: BASIS,
			db
		});
	}

	const korrelationen = () =>
		db.select().from(schema.ticketKorrelation).orderBy(schema.ticketKorrelation.angelegtAm);

	const zustellungen = () =>
		db.select().from(schema.zustellung).orderBy(schema.zustellung.erstelltAm);

	// -----------------------------------------------------------------------------------------
	describe('Anlegen', () => {
		it('legt beim Alarm ein Ticket an und merkt sich die Korrelation', async () => {
			const monitorId = await legeAn();
			await stoere(monitorId, T('06:00'));
			await stelleZu(T('06:01'));

			expect(port.tickets).toHaveLength(1);

			const [korrelation] = await korrelationen();
			// Der volle Key bleibt in der Zeile, das Ticket trägt die gekürzte Abbildung davon.
			expect(korrelation.korrelationsKey).toMatch(new RegExp(`^nw:${monitorId}:`));
			expect(port.tickets[0].externalID).toBe(externId(korrelation.korrelationsKey));
			expect(korrelation.monitorId).toBe(monitorId);
			expect(korrelation.ticketId).toBe(String(port.tickets[0].id));
			expect(korrelation.ticketNummer).toBe(port.tickets[0].ticketNumber);
			expect(korrelation.zustand).toBe('offen');

			const [zustellung] = await zustellungen();
			expect(zustellung.zustand).toBe('zugestellt');
			expect(zustellung.kanal).toBe('autotask');
		});

		it('legt nach einem Absturz zwischen Anlage und Vermerk kein zweites Ticket an', async () => {
			const monitorId = await legeAn();
			await stoere(monitorId, T('06:00'));
			await tick(T('06:01'));
			const zustellung = await offeneZustellung();

			// Erster Lauf: Autotask legt an, die Bestätigung geht verloren.
			port.brichtNachAnlageAb = true;
			await expect(
				fuehreAus({
					zustellungId: zustellung.id,
					port,
					konfig: KONFIG,
					jetzt: T('06:01'),
					basisUrl: BASIS,
					db
				})
			).rejects.toThrow();
			expect(port.tickets).toHaveLength(1);
			expect(await korrelationen()).toHaveLength(0);

			// Zweiter Lauf: findet das eigene Ticket über die `externalID` wieder.
			port.brichtNachAnlageAb = false;
			await fuehreAus({
				zustellungId: zustellung.id,
				port,
				konfig: KONFIG,
				jetzt: T('06:02'),
				basisUrl: BASIS,
				db
			});

			expect(port.tickets).toHaveLength(1);
			// Der Kern der Idempotenz: gesucht wird buchstäblich das, was geschrieben wurde.
			expect(port.filterWerte).toContain(port.tickets[0].externalID);
			expect(port.filterWerte.every((wert) => wert === port.tickets[0].externalID)).toBe(true);

			const [korrelation] = await korrelationen();
			expect(korrelation.ticketId).toBe(String(port.tickets[0].id));
		});

		it('kommentiert beim Re-Alarm das noch offene Ticket, statt ein zweites zu öffnen', async () => {
			const monitorId = await legeAn();
			await stoere(monitorId, T('06:00'));
			await stelleZu(T('06:01'));

			// Erledigen kommentiert nur — das Ticket bleibt offen (CONTEXT).
			await erhole(monitorId, T('06:30'), 'erledigt');
			await stelleZu(T('07:00'));
			await stoere(monitorId, T('07:30'));
			await stelleZu(T('07:31'));

			expect(port.tickets).toHaveLength(1);
			expect(await korrelationen()).toHaveLength(1);
			expect(port.notizen).toHaveLength(2);
			expect(String((port.notizen[1].koerper as { description: string }).description)).toContain(
				'no second ticket was opened'
			);
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Schließen', () => {
		it('kommentiert und schließt bei beweisbasierter Erholung am unberührten Ticket', async () => {
			const monitorId = await legeAn();
			await stoere(monitorId, T('06:00'));
			await stelleZu(T('06:01'));

			await erhole(monitorId, T('06:30'));
			await stelleZu(T('07:00'));

			expect(port.notizen).toHaveLength(1);
			expect(port.tickets[0].status).toBe(KONFIG.abschlussStatusId);

			const [korrelation] = await korrelationen();
			expect(korrelation.zustand).toBe('geschlossen');
			expect(korrelation.geschlossenAm).not.toBeNull();
		});

		it('lässt ein berührtes Ticket offen und kommentiert nur', async () => {
			const monitorId = await legeAn();
			await stoere(monitorId, T('06:00'));
			await stelleZu(T('06:01'));

			// Ein Mensch hat das Ticket übernommen — ein automatischer Schluss zöge ihm die Arbeit weg.
			port.tickets[0].assignedResourceID = 42;

			await erhole(monitorId, T('06:30'));
			await stelleZu(T('07:00'));

			expect(port.notizen).toHaveLength(1);
			expect(port.tickets[0].status).toBe(KONFIG.statusId);
			expect((await korrelationen())[0].zustand).toBe('offen');
		});

		it('schließt nie nach Erledigen oder Auto-Zurück', async () => {
			const monitorId = await legeAn();
			await stoere(monitorId, T('06:00'));
			await stelleZu(T('06:01'));

			await erhole(monitorId, T('06:30'), 'auto_zurueck');
			await stelleZu(T('07:00'));

			expect(port.notizen).toHaveLength(1);
			expect(port.tickets[0].status).toBe(KONFIG.statusId);
			expect((await korrelationen())[0].zustand).toBe('offen');
		});

		it('öffnet nach der Schließung ein neues Ticket mit Vorgänger-Verweis', async () => {
			const monitorId = await legeAn();
			await stoere(monitorId, T('06:00'));
			await stelleZu(T('06:01'));
			await erhole(monitorId, T('06:30'));
			await stelleZu(T('07:00'));

			await stoere(monitorId, T('08:00'));
			await stelleZu(T('08:01'));

			expect(port.tickets).toHaveLength(2);
			expect(await korrelationen()).toHaveLength(2);

			const zweiteAnlage = port.anfragen
				.filter((anfrage) => anfrage.methode === 'POST' && anfrage.pfad === 'Tickets')
				.at(-1)?.koerper as { description: string };

			expect(zweiteAnlage.description).toContain(
				`Previous ticket: ${port.tickets[0].ticketNumber}`
			);
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Fehlversuche', () => {
		it('wiederholt jeden Fehler und vermerkt die Diagnose ab dem ersten Versuch', async () => {
			const monitorId = await legeAn();
			await stoere(monitorId, T('06:00'));
			await tick(T('06:01'));
			const zustellung = await offeneZustellung();

			// Ein dauerhafter Fehler — er überspringt das Retry-Budget trotzdem nicht (SPEC §7).
			port.fehler = {
				methode: 'POST',
				pfad: 'Tickets',
				status: 400,
				body: { errors: ['Ticket: Status is required.'] }
			};

			await expect(
				fuehreAus({
					zustellungId: zustellung.id,
					port,
					konfig: KONFIG,
					jetzt: T('06:02'),
					basisUrl: BASIS,
					db
				})
			).rejects.toThrow();

			const [nachEins] = await zustellungen();
			expect(nachEins.zustand).toBe('offen');
			expect(nachEins.versuche).toBe(1);
			expect(nachEins.letzterFehler).toBe('400: Ticket: Status is required.');

			// Ein transienter Fehler wird genauso behandelt, nur lauter geloggt.
			port.fehler = { methode: 'POST', pfad: 'Tickets', status: 503 };
			await expect(
				fuehreAus({
					zustellungId: zustellung.id,
					port,
					konfig: KONFIG,
					jetzt: T('06:03'),
					basisUrl: BASIS,
					db
				})
			).rejects.toThrow();

			const [nachZwei] = await zustellungen();
			expect(nachZwei.zustand).toBe('offen');
			expect(nachZwei.versuche).toBe(2);
		});

		it('gibt erst der Dead-Letter-Vermerk auf — und behält die Diagnose', async () => {
			const monitorId = await legeAn();
			await stoere(monitorId, T('06:00'));
			await tick(T('06:01'));
			const zustellung = await offeneZustellung();

			port.fehler = { methode: 'POST', pfad: 'Tickets', status: 500, body: { errors: ['boom'] } };
			await expect(
				fuehreAus({
					zustellungId: zustellung.id,
					port,
					konfig: KONFIG,
					jetzt: T('06:02'),
					basisUrl: BASIS,
					db
				})
			).rejects.toThrow();

			await markiereFehlgeschlagen(zustellung.id, new Date(), db);

			const [zeile] = await zustellungen();
			expect(zeile.zustand).toBe('fehlgeschlagen');
			expect(zeile.letzterFehler).toBe('500: boom');
			// Kein neunter Versuch: der Vermerk ist kein Zustellversuch.
			expect(zeile.versuche).toBe(1);
		});

		it('überspringt die Zustellung, wenn die Verknüpfung inzwischen weg ist', async () => {
			const monitorId = await legeAn();
			await stoere(monitorId, T('06:00'));
			await tick(T('06:01'));
			const zustellung = await offeneZustellung();

			await db
				.update(schema.kunde)
				.set({ autotaskCompanyId: null })
				.where(eq(schema.kunde.id, kundeId));

			await fuehreAus({
				zustellungId: zustellung.id,
				port,
				konfig: KONFIG,
				jetzt: T('06:02'),
				basisUrl: BASIS,
				db
			});

			expect(port.tickets).toHaveLength(0);
			// Die Kette darf nicht hängen bleiben, nur weil niemand mehr zuständig ist.
			expect((await zustellungen())[0].zustand).toBe('zugestellt');
		});
	});
});
