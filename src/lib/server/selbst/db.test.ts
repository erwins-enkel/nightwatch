/**
 * Die Selbst-Monitor-Schreibseite und die Zustell-Störung gegen eine echte Postgres.
 *
 * Die Regeln hängen ohne Datenbank in `beobachtung.test.ts`. Hier steht, was allein Postgres
 * beweist: dass eine Episode je Selbst-Monitor entsteht und nicht zwei, dass die Verschärfung genau
 * einmal gesetzt wird — und vor allem die Zustell-Störung, deren ganze Schärfe in einer
 * Gruppierung über `kanal × webhook_ziel_id` steckt.
 *
 * Läuft nur, wenn `DATABASE_URL` irgendwohin zeigt — wie `alarm/db.test.ts`.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { wendeAn } from '../monitor/zustand';
import {
	beendeSelbstStill,
	schreibeSelbstWirkung,
	sperreSelbstMonitore,
	systemStatus,
	zustellStoerungSeit,
	type SelbstLaufzeit
} from './db';

const databaseUrl = process.env.DATABASE_URL;
type Datenbank = ReturnType<typeof drizzle<typeof schema>>;

const T = (hhmm: string) => new Date(`2026-07-29T${hhmm}:00Z`);

describe.skipIf(!databaseUrl && !process.env.CI)('Selbst-Monitor-Datenbank', () => {
	let pool: pg.Pool;
	let db: Datenbank;
	let laufendeNummer = 0;

	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: databaseUrl });
		db = drizzle(pool, { schema });
		await migrate(db, { migrationsFolder: 'drizzle' });
	});

	/**
	 * Aufräumen — auch am Ende, nicht nur am Anfang.
	 *
	 * Die Datenbank-Suiten teilen sich eine Postgres, und diese hier hinterlässt Episoden am
	 * *Kern*-Selbst-Monitor. Der hängt an keinem Monitor, den eine andere Suite löschen würde, also
	 * überlebt er jedes `delete from monitor` — und ließe eine fremde Zählung „genau eine Episode"
	 * scheitern, ohne dass irgendetwas an ihr kaputt wäre.
	 */
	async function raeumeAuf() {
		await db.delete(schema.zustellung);
		await db.delete(schema.uebergang);
		await db.delete(schema.webhookZiel);
		await db.delete(schema.selbstMonitor).where(eq(schema.selbstMonitor.art, 'postfach'));
		await db.delete(schema.postfach);
		await db.delete(schema.monitor);
		await db.delete(schema.kunde);
		// Den Kern auf gesund zurücksetzen: er wird geseedet, nicht gelöscht.
		await db
			.update(schema.selbstMonitor)
			.set({ zustand: 'gesund', alarmgrund: null, stalenessSekunden: 900 })
			.where(eq(schema.selbstMonitor.art, 'kern'));
	}

	afterAll(async () => {
		await raeumeAuf();
		await pool?.end();
	});

	beforeEach(raeumeAuf);

	/** Ein Postfach samt seinem Selbst-Monitor, wie `legePostfachAn()` sie anlegt. */
	async function neuesPostfach(): Promise<{ postfachId: string; selbstId: string }> {
		const nummer = laufendeNummer++;
		const [zeile] = await db
			.insert(schema.postfach)
			.values({
				bezeichnung: `NOC ${nummer}`,
				adresse: `noc${nummer}@msp.test`,
				tenantId: 'tenant',
				clientId: 'client'
			})
			.returning({ id: schema.postfach.id });

		const [selbst] = await db
			.insert(schema.selbstMonitor)
			.values({
				schluessel: `postfach:${zeile.id}`,
				art: 'postfach',
				postfachId: zeile.id,
				bezeichnung: `Ingestion NOC ${nummer}`
			})
			.returning({ id: schema.selbstMonitor.id });

		return { postfachId: zeile.id, selbstId: selbst.id };
	}

	async function laufzeit(selbstId: string): Promise<SelbstLaufzeit> {
		const alle = await db.transaction((tx) => sperreSelbstMonitore(tx));
		const gefunden = alle.find((eintrag) => eintrag.id === selbstId);
		if (!gefunden) throw new Error('Selbst-Monitor nicht gefunden');
		return gefunden;
	}

	// -----------------------------------------------------------------------------------------
	describe('Zustandsschreiben', () => {
		it('eröffnet genau eine Episode und schreibt den Zustand mit', async () => {
			const { selbstId } = await neuesPostfach();
			const vorher = await laufzeit(selbstId);

			const nachher = await db.transaction((tx) =>
				schreibeSelbstWirkung(
					vorher,
					wendeAn(
						{ zustand: 'gesund', alarmgrund: null, pausiert: false, pausiertBis: null },
						{ art: 'stoerung', grund: 'ueberfaellig' },
						T('06:15')
					),
					T('06:15'),
					tx
				)
			);

			expect(nachher.zustand).toBe('gestoert');
			expect(nachher.alarmgrund).toBe('ueberfaellig');

			const episoden = await db
				.select()
				.from(schema.uebergang)
				.where(eq(schema.uebergang.selbstMonitorId, selbstId));
			expect(episoden.length).toBe(1);
			expect(episoden[0].begonnenAm).toEqual(T('06:15'));
		});

		/** Der Wechsel nach „Fehler gemeldet" ist per Definition die Verschärfung — und nur einmal. */
		it('setzt die Verschärfung genau einmal', async () => {
			const { selbstId } = await neuesPostfach();

			let aktuell = await laufzeit(selbstId);
			aktuell = await db.transaction((tx) =>
				schreibeSelbstWirkung(aktuell, { art: 'eroeffnen', grund: 'ueberfaellig' }, T('06:15'), tx)
			);
			aktuell = await db.transaction((tx) =>
				schreibeSelbstWirkung(
					aktuell,
					{ art: 'grundwechsel', grund: 'fehler_gemeldet', verschaerfung: true },
					T('06:20'),
					tx
				)
			);
			const verschaerftAm = aktuell.verschaerftAm;

			aktuell = await db.transaction((tx) =>
				schreibeSelbstWirkung(
					aktuell,
					{ art: 'grundwechsel', grund: 'fehler_gemeldet', verschaerfung: true },
					T('06:30'),
					tx
				)
			);

			expect(verschaerftAm).toEqual(T('06:20'));
			expect(aktuell.verschaerftAm).toEqual(T('06:20'));
		});

		/**
		 * Dieselbe Entwarnungs-Stabilität wie beim Kunden-Monitor: eine Erholung, die im Fenster
		 * reißt, verliert ihre Entwarnung dauerhaft.
		 */
		it('entwertet die Entwarnung einer Erholung, die nicht gehalten hat', async () => {
			const { selbstId } = await neuesPostfach();
			await db
				.update(schema.selbstMonitor)
				.set({ entwarnungsStabilitaetSekunden: 900 })
				.where(eq(schema.selbstMonitor.id, selbstId));

			let aktuell = await laufzeit(selbstId);
			aktuell = await db.transaction((tx) =>
				schreibeSelbstWirkung(aktuell, { art: 'eroeffnen', grund: 'ueberfaellig' }, T('06:00'), tx)
			);
			aktuell = await db.transaction((tx) =>
				schreibeSelbstWirkung(aktuell, { art: 'beenden', erholungsArt: 'beweis' }, T('06:10'), tx)
			);
			await db.transaction((tx) =>
				schreibeSelbstWirkung(aktuell, { art: 'eroeffnen', grund: 'ueberfaellig' }, T('06:12'), tx)
			);

			const [erste] = await db
				.select({ entfaellt: schema.uebergang.entwarnungEntfaelltAm })
				.from(schema.uebergang)
				.where(eq(schema.uebergang.beendetAm, T('06:10')));
			expect(erste.entfaellt).toEqual(T('06:12'));
		});

		/** Ein abgeschaltetes Postfach schuldet niemandem eine Entwarnung. */
		it('beendet still, ohne eine Entwarnung zu schulden', async () => {
			const { selbstId } = await neuesPostfach();

			let aktuell = await laufzeit(selbstId);
			aktuell = await db.transaction((tx) =>
				schreibeSelbstWirkung(aktuell, { art: 'eroeffnen', grund: 'ueberfaellig' }, T('06:00'), tx)
			);
			await db.transaction((tx) => beendeSelbstStill(aktuell, T('07:00'), tx));

			const [episode] = await db
				.select({ art: schema.uebergang.erholungsArt })
				.from(schema.uebergang)
				.where(eq(schema.uebergang.selbstMonitorId, selbstId));
			expect(episode.art).toBe('archiviert');
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('Zustell-Störung', () => {
		async function neuesZiel(bezeichnung: string, aktiv = true): Promise<string> {
			const [zeile] = await db
				.insert(schema.webhookZiel)
				.values({
					bezeichnung,
					url: `https://${bezeichnung}.msp.test/hook`,
					aktiv
				})
				.returning({ id: schema.webhookZiel.id });
			return zeile.id;
		}

		/** Eine Kunden-Episode, an der Kunden-Zustellungen hängen können. */
		async function kundenEpisode(): Promise<string> {
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
				.values({ monitorId: monitor.id, alarmgrund: 'ueberfaellig' })
				.returning({ id: schema.uebergang.id });
			return episode.id;
		}

		async function selbstEpisode(): Promise<string> {
			const { selbstId } = await neuesPostfach();
			const [episode] = await db
				.insert(schema.uebergang)
				.values({ selbstMonitorId: selbstId, alarmgrund: 'fehler_gemeldet' })
				.returning({ id: schema.uebergang.id });
			return episode.id;
		}

		async function zustellung(
			uebergangId: string,
			zielId: string | null,
			teile: Partial<typeof schema.zustellung.$inferInsert>
		): Promise<void> {
			await db.insert(schema.zustellung).values({
				uebergangId,
				ereignis: 'alarm',
				kanal: zielId === null ? 'autotask' : 'webhook',
				webhookZielId: zielId,
				...teile
			});
		}

		/**
		 * Der Ruhezustand, der kein Alarm sein darf: ein eben erst eingetragenes Webhook-Ziel und ein
		 * aktiver Autotask-Zugang ohne `selbstCompanyId` haben schlicht noch nichts zugestellt.
		 */
		it('meldet nichts, solange kein Kunden-Dead-Letter existiert', async () => {
			await neuesZiel('frisch');

			await expect(zustellStoerungSeit(db)).resolves.toBeNull();
		});

		it('meldet eine Störung ab dem Dead Letter einer Kunden-Zustellung', async () => {
			const zielId = await neuesZiel('rmm');
			await zustellung(await kundenEpisode(), zielId, {
				zustand: 'fehlgeschlagen',
				aufgegebenAm: T('06:00')
			});

			await expect(zustellStoerungSeit(db)).resolves.toEqual(T('06:00'));
		});

		/**
		 * Der Kern der ziel-scharfen Auswertung: Webhook B liefert fröhlich weiter, während A tot ist.
		 * Über einen instanzweiten „letzten Erfolg" wäre A unsichtbar.
		 */
		it('lässt einen Erfolg auf Ziel B die Störung auf Ziel A nicht verdecken', async () => {
			const a = await neuesZiel('a');
			const b = await neuesZiel('b');
			const episode = await kundenEpisode();

			await zustellung(episode, a, { zustand: 'fehlgeschlagen', aufgegebenAm: T('06:00') });
			await zustellung(episode, b, { zustand: 'zugestellt', zugestelltAm: T('07:00') });

			await expect(zustellStoerungSeit(db)).resolves.toEqual(T('06:00'));
		});

		it('gilt erst als erholt, wenn dasselbe Ziel wieder zustellt', async () => {
			const zielId = await neuesZiel('rmm');
			const episode = await kundenEpisode();

			await zustellung(episode, zielId, { zustand: 'fehlgeschlagen', aufgegebenAm: T('06:00') });
			await expect(zustellStoerungSeit(db)).resolves.toEqual(T('06:00'));

			await zustellung(episode, zielId, { zustand: 'zugestellt', zugestelltAm: T('08:00') });
			await expect(zustellStoerungSeit(db)).resolves.toBeNull();
		});

		/**
		 * Die Asymmetrie, an der die Regel hängt: ein gescheiterter Selbst-Alarm darf keine neue
		 * Kern-Störung erzeugen — sonst meldete ein Kanal sein eigenes Scheitern über sich selbst.
		 */
		it('zählt einen gescheiterten Selbst-Alarm nicht als Störung', async () => {
			const zielId = await neuesZiel('rmm');
			await zustellung(await selbstEpisode(), zielId, {
				zustand: 'fehlgeschlagen',
				aufgegebenAm: T('06:00')
			});

			await expect(zustellStoerungSeit(db)).resolves.toBeNull();
		});

		/**
		 * Die andere Hälfte derselben Asymmetrie: ein *durchgekommener* Selbst-Alarm zählt sehr wohl.
		 * Ohne ihn erholte sich ein Ziel nie, an das danach kein Kunden-Ereignis mehr geht — der Kern
		 * bliebe für immer gestört und schuldete seine Entwarnung ewig.
		 */
		it('lässt eine erfolgreiche Selbst-Zustellung die Erholung beweisen', async () => {
			const zielId = await neuesZiel('rmm');

			await zustellung(await kundenEpisode(), zielId, {
				zustand: 'fehlgeschlagen',
				aufgegebenAm: T('06:00')
			});
			await expect(zustellStoerungSeit(db)).resolves.toEqual(T('06:00'));

			await zustellung(await selbstEpisode(), zielId, {
				zustand: 'zugestellt',
				zugestelltAm: T('08:00')
			});

			await expect(zustellStoerungSeit(db)).resolves.toBeNull();
		});

		/** Ein stillgelegtes Ziel kann keinen Erfolg mehr liefern und hielte den Kern sonst ewig fest. */
		it('ignoriert stillgelegte Webhook-Ziele', async () => {
			const zielId = await neuesZiel('alt', false);
			await zustellung(await kundenEpisode(), zielId, {
				zustand: 'fehlgeschlagen',
				aufgegebenAm: T('06:00')
			});

			await expect(zustellStoerungSeit(db)).resolves.toBeNull();
		});

		/** Die Episode datiert auf den Beginn der Störung, nicht auf ihren letzten Rückschlag. */
		it('nimmt den ältesten überlebenden Beleg', async () => {
			const a = await neuesZiel('a');
			const b = await neuesZiel('b');
			const episode = await kundenEpisode();

			await zustellung(episode, a, { zustand: 'fehlgeschlagen', aufgegebenAm: T('09:00') });
			await zustellung(episode, b, { zustand: 'fehlgeschlagen', aufgegebenAm: T('06:00') });

			await expect(zustellStoerungSeit(db)).resolves.toEqual(T('06:00'));
		});
	});

	// -----------------------------------------------------------------------------------------
	describe('System-Status', () => {
		it('sagt, wenn der Totalausfall unbeobachtet wäre', async () => {
			await neuesPostfach();

			const status = await systemStatus(db);

			expect(status.monitore.some((eintrag) => eintrag.schluessel === 'kern')).toBe(true);
			expect(status.heartbeatPingKonfiguriert).toBe(false);
			expect(status.webhookZielVorhanden).toBe(false);
		});

		it('nennt das Postfach beim Namen', async () => {
			await neuesPostfach();

			const status = await systemStatus(db);
			const postfachMonitor = status.monitore.find((eintrag) => eintrag.art === 'postfach');

			expect(postfachMonitor?.postfachBezeichnung).toMatch(/^NOC /);
		});
	});
});
