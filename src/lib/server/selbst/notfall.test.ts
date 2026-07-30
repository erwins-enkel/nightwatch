/**
 * Der Postgres-Ausfall — die eine Störung, die Nightwatch nicht in `uebergang` schreiben kann.
 *
 * Geprüft wird, was ein Betreiber davon merkt: genau ein Alarm, egal über wie viele Ticks, und
 * genau eine Entwarnung, erst nachdem die Erholung gehalten hat. Ohne Datenbank, weil die ganze
 * Entscheidung aus dem Cache-Zustand folgt.
 */
import { describe, expect, it } from 'vitest';
import type { NotfallEpisode } from './cache';
import { notfallEreignis, notfallSchritt, sendeNotfall } from './notfall';
import type { WebhookPort, WebhookAntwort } from '../webhook/client';

const T = (hhmm: string) => new Date(`2026-07-29T${hhmm}:00Z`);
const FRISTEN = { stalenessSekunden: 900, stabilitaetSekunden: 600 };
const ALERT = '11111111-2222-3333-4444-555555555555';

const KERN = {
	id: 'kern-id',
	schluessel: 'kern',
	bezeichnung: 'Nightwatch-Kern',
	stalenessSekunden: 900,
	stabilitaetSekunden: 600
};

describe('Notfall-Pfad', () => {
	describe('Schritt', () => {
		it('merkt sich den Ausfall, alarmiert aber noch nicht', () => {
			const schritt = notfallSchritt(null, false, FRISTEN, ALERT, T('06:00'));

			expect(schritt.aktion).toBe('nichts');
			expect(schritt.episode).toEqual({
				alertId: ALERT,
				seitAm: T('06:00').toISOString(),
				alarmiertAm: null,
				beendetAm: null
			});
		});

		it('alarmiert genau einmal, sobald die Staleness-Frist abgelaufen ist', () => {
			const offen: NotfallEpisode = {
				alertId: ALERT,
				seitAm: T('06:00').toISOString(),
				alarmiertAm: null,
				beendetAm: null
			};

			expect(notfallSchritt(offen, false, FRISTEN, ALERT, T('06:14')).aktion).toBe('nichts');

			const alarm = notfallSchritt(offen, false, FRISTEN, ALERT, T('06:15'));
			expect(alarm.aktion).toBe('alarm');
			expect(alarm.meldung?.alertId).toBe(ALERT);

			// Der Dedup-Marker: beliebig viele weitere Ticks sagen nichts mehr.
			expect(notfallSchritt(alarm.episode, false, FRISTEN, ALERT, T('06:20')).aktion).toBe(
				'nichts'
			);
			expect(notfallSchritt(alarm.episode, false, FRISTEN, ALERT, T('08:00')).aktion).toBe(
				'nichts'
			);
		});

		/** Ein Aussetzer unterhalb der Frist hat nie etwas gesagt — also gibt es nichts zurückzunehmen. */
		it('verwirft eine Episode, die es nie bis zum Alarm geschafft hat', () => {
			const kurz: NotfallEpisode = {
				alertId: ALERT,
				seitAm: T('06:00').toISOString(),
				alarmiertAm: null,
				beendetAm: null
			};

			const schritt = notfallSchritt(kurz, true, FRISTEN, ALERT, T('06:05'));
			expect(schritt).toEqual({ episode: null, aktion: 'nichts', meldung: null });
		});

		it('entwarnt erst, nachdem die Erholung das Stabilitätsfenster überstanden hat', () => {
			const alarmiert: NotfallEpisode = {
				alertId: ALERT,
				seitAm: T('06:00').toISOString(),
				alarmiertAm: T('06:15').toISOString(),
				beendetAm: null
			};

			const erholt = notfallSchritt(alarmiert, true, FRISTEN, ALERT, T('07:00'));
			expect(erholt.aktion).toBe('nichts');
			expect(erholt.episode?.beendetAm).toBe(T('07:00').toISOString());

			expect(notfallSchritt(erholt.episode, true, FRISTEN, ALERT, T('07:09')).aktion).toBe(
				'nichts'
			);

			const entwarnung = notfallSchritt(erholt.episode, true, FRISTEN, ALERT, T('07:10'));
			expect(entwarnung.aktion).toBe('entwarnung');
			expect(entwarnung.meldung?.alertId).toBe(ALERT);
			expect(entwarnung.episode).toBeNull();
		});

		/**
		 * CONTEXT „Entwarnungs-Stabilität", eine Ebene tiefer: eine Datenbank, die im Fenster wieder
		 * wegbricht, hat sich nie erholt. Dieselbe Episode läuft weiter, kein zweiter Alarm.
		 */
		it('setzt die Erholung zurück, wenn die Datenbank im Fenster erneut ausfällt', () => {
			const erholt: NotfallEpisode = {
				alertId: ALERT,
				seitAm: T('06:00').toISOString(),
				alarmiertAm: T('06:15').toISOString(),
				beendetAm: T('07:00').toISOString()
			};

			const rueckfall = notfallSchritt(erholt, false, FRISTEN, 'andere-id', T('07:05'));
			expect(rueckfall.aktion).toBe('nichts');
			expect(rueckfall.episode).toEqual({ ...erholt, beendetAm: null });

			// Und auch danach bleibt es bei dem einen Alarm, den es schon gab.
			expect(
				notfallSchritt(rueckfall.episode, false, FRISTEN, 'andere-id', T('09:00')).aktion
			).toBe('nichts');
		});

		it('tut ohne laufende Episode nichts, solange die Datenbank antwortet', () => {
			expect(notfallSchritt(null, true, FRISTEN, ALERT, T('06:00'))).toEqual({
				episode: null,
				aktion: 'nichts',
				meldung: null
			});
		});
	});

	describe('Nutzlast', () => {
		const episode: NotfallEpisode = {
			alertId: ALERT,
			seitAm: T('06:00').toISOString(),
			alarmiertAm: T('06:15').toISOString(),
			beendetAm: null
		};

		it('sieht aus wie jeder andere Selbst-Alarm', () => {
			const daten = notfallEreignis(KERN, episode, 'alarm', 'https://nightwatch.msp.test');

			expect(daten.monitor).toEqual({
				art: 'selbst',
				id: 'kern-id',
				bezeichnung: 'Nightwatch-Kern',
				schluessel: 'kern'
			});
			expect(daten.kunde).toBeNull();
			expect(daten.alarmgrund).toBe('fehler_gemeldet');
			expect(daten.weisung).toBe('eroeffnen');
			expect(daten.korrelationsKey).toBe(`self:kern:${ALERT}`);
			expect(daten.rueckverweis).toBe('https://nightwatch.msp.test/system');
		});

		/** Nur beweisbasierte Erholung darf ein Ticket schließen — die Datenbank antwortet ja wieder. */
		it('darf mit der Entwarnung das Ticket schließen', () => {
			const daten = notfallEreignis(
				KERN,
				{ ...episode, beendetAm: T('07:00').toISOString() },
				'entwarnung',
				'https://nightwatch.msp.test'
			);

			expect(daten.weisung).toBe('schliessen');
			expect(daten.erholungsArt).toBe('beweis');
			expect(daten.zusammenfassung.stoerungsdauerSekunden).toBe(3600);
		});
	});

	describe('Versand', () => {
		class TestPort implements WebhookPort {
			readonly aufrufe: { url: string; koerper: string; kopfzeilen: Record<string, string> }[] = [];
			constructor(private readonly antwort: WebhookAntwort | Error) {}

			sende(url: string, koerper: string, kopfzeilen: Record<string, string>) {
				this.aufrufe.push({ url, koerper, kopfzeilen });
				return this.antwort instanceof Error
					? Promise.reject(this.antwort)
					: Promise.resolve(this.antwort);
			}
		}

		const daten = notfallEreignis(KERN, episodeAlarmiert(), 'alarm', 'https://nightwatch.msp.test');

		function episodeAlarmiert(): NotfallEpisode {
			return {
				alertId: ALERT,
				seitAm: T('06:00').toISOString(),
				alarmiertAm: T('06:15').toISOString(),
				beendetAm: null
			};
		}

		it('signiert den Rumpf, den es auch sendet', async () => {
			const port = new TestPort({ status: 200, text: '' });

			const zugestellt = await sendeNotfall(
				[{ id: 'z1', url: 'https://rmm.msp.test/hook', secret: 'geheim' }],
				daten,
				port,
				T('06:15')
			);

			expect(zugestellt).toBe(1);
			const aufruf = port.aufrufe[0];
			expect(JSON.parse(aufruf.koerper).alert_id).toBe(ALERT);
			expect(aufruf.kopfzeilen['X-Nightwatch-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
		});

		/** Ein Empfänger, der nicht mag, darf den nächsten nicht mitreißen — und nicht werfen. */
		it('zählt nur die Empfänger, die es angenommen haben', async () => {
			const abgelehnt = new TestPort({ status: 500, text: 'kaputt' });
			const geworfen = new TestPort(new Error('DNS weg'));

			const ziele = [{ id: 'z1', url: 'https://rmm.msp.test/hook', secret: 'geheim' }];

			await expect(sendeNotfall(ziele, daten, abgelehnt, T('06:15'))).resolves.toBe(0);
			await expect(sendeNotfall(ziele, daten, geworfen, T('06:15'))).resolves.toBe(0);
		});
	});
});
