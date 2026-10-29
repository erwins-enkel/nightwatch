/**
 * Die Einsatzbereitschaft und das Speichern des Zugangs.
 *
 * Beide Hälften halten dieselbe Zusage: was die Einstellungen als „bereit" ausweisen, muss eine
 * Alarm-Episode auch **zu Ende** bringen können — Ticket, Kommentar und Schließen. Ein Zustand, in
 * dem der Alarm ein Ticket öffnet und die Entwarnung daran scheitert, ist schlimmer als gar keine
 * Autotask-Anbindung.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { AutotaskTicketDefaults } from '../db/schema/system';
import { holeKonfig, istEinsatzbereit, speichereZugang, type AutotaskKonfig } from './db';

const databaseUrl = process.env.DATABASE_URL;

const VOLLSTAENDIG: AutotaskTicketDefaults = {
	statusId: 1,
	priorityId: 2,
	notizTypId: 1,
	notizPublishId: 1
};

function konfig(teile: Partial<AutotaskKonfig> = {}): AutotaskKonfig {
	return {
		aktiv: true,
		zoneUrl: 'https://webservices3.autotask.net/atservicesrest/',
		benutzer: 'api@msp.test',
		secretChiffre: 'chiffre',
		integrationCodeChiffre: 'chiffre',
		defaults: VOLLSTAENDIG,
		...teile
	};
}

describe('Einsatzbereitschaft', () => {
	it('ist bereit, wenn Zugang, Zone und alle Pflicht-IDs stehen', () => {
		expect(istEinsatzbereit(konfig())).toBe(true);
	});

	it('verlangt Zugang und Zone vollständig', () => {
		expect(istEinsatzbereit(konfig({ aktiv: false }))).toBe(false);
		expect(istEinsatzbereit(konfig({ zoneUrl: null }))).toBe(false);
		expect(istEinsatzbereit(konfig({ benutzer: null }))).toBe(false);
		expect(istEinsatzbereit(konfig({ secretChiffre: null }))).toBe(false);
		expect(istEinsatzbereit(konfig({ integrationCodeChiffre: null }))).toBe(false);
	});

	it('verlangt die Pflichtfelder des Tickets', () => {
		expect(istEinsatzbereit(konfig({ defaults: { ...VOLLSTAENDIG, statusId: undefined } }))).toBe(
			false
		);
		expect(istEinsatzbereit(konfig({ defaults: { ...VOLLSTAENDIG, priorityId: undefined } }))).toBe(
			false
		);
	});

	it('verlangt auch die Pflichtfelder der Notiz', () => {
		// Verschärfung und Entwarnung sind Notizen, und `noteType`/`publish` sind dort Pflicht. Ohne
		// sie stünde ein Ticket offen, dessen Entwarnung jedes Mal in den Dead-Letter liefe.
		expect(istEinsatzbereit(konfig({ defaults: { ...VOLLSTAENDIG, notizTypId: undefined } }))).toBe(
			false
		);
		expect(
			istEinsatzbereit(konfig({ defaults: { ...VOLLSTAENDIG, notizPublishId: undefined } }))
		).toBe(false);
	});

	it('bleibt ohne Abschluss-Status bereit', () => {
		// „Nie automatisch schließen" ist eine zulässige Wahl, keine kaputte Konfiguration.
		expect(istEinsatzbereit(konfig({ defaults: { ...VOLLSTAENDIG, abschlussStatusId: 5 } }))).toBe(
			true
		);
		expect(istEinsatzbereit(konfig())).toBe(true);
	});
});

describe.skipIf(!databaseUrl && !process.env.CI)('Zugang speichern', () => {
	let pool: pg.Pool;
	let db: ReturnType<typeof drizzle<typeof schema>>;

	const ZONE = 'https://webservices3.autotask.net/atservicesrest/';

	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: databaseUrl });
		db = drizzle(pool, { schema });
		await migrate(db, { migrationsFolder: 'drizzle' });
	});

	afterAll(async () => {
		await pool?.end();
	});

	beforeEach(async () => {
		await db
			.update(schema.einstellungen)
			.set({
				autotaskAktiv: true,
				autotaskZoneUrl: ZONE,
				autotaskBenutzer: 'api@msp.test',
				autotaskSecretChiffre: 'chiffre',
				autotaskIntegrationCodeChiffre: 'chiffre',
				autotaskTicketDefaults: VOLLSTAENDIG
			})
			.where(eq(schema.einstellungen.id, 1));
	});

	const speichere = (benutzer: string) =>
		speichereZugang(
			{ benutzer, secretChiffre: null, integrationCodeChiffre: null, aktiv: true },
			db
		);

	it('behält die Zone, solange der Benutzer derselbe bleibt', async () => {
		await speichere('api@msp.test');

		const gespeichert = await holeKonfig(db);
		expect(gespeichert.zoneUrl).toBe(ZONE);
		expect(istEinsatzbereit(gespeichert)).toBe(true);
	});

	it('verwirft die Zone, sobald der Benutzer wechselt', async () => {
		// Ein anderer API-User kann in einer anderen Autotask-Datenbank liegen. Bliebe die alte Zone
		// stehen, gingen alle authentifizierten Requests weiter an den vorigen Tenant — und die Seite
		// behauptete dabei „bereit".
		await speichere('neu@msp.test');

		const gespeichert = await holeKonfig(db);
		expect(gespeichert.benutzer).toBe('neu@msp.test');
		expect(gespeichert.zoneUrl).toBeNull();
		expect(istEinsatzbereit(gespeichert)).toBe(false);
	});

	it('lässt die vorhandenen Chiffren stehen, wenn die Felder leer bleiben', async () => {
		// Ein Credential wird nie durch den Browser zurückgereicht — ein leeres Feld heißt „behalten".
		await speichere('neu@msp.test');

		const gespeichert = await holeKonfig(db);
		expect(gespeichert.secretChiffre).toBe('chiffre');
		expect(gespeichert.integrationCodeChiffre).toBe('chiffre');
	});
});
