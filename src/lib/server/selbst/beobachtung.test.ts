/**
 * Was Nightwatch über sich selbst liest — ohne Datenbank, wie `zeit/faelligkeit.test.ts`.
 *
 * Zwei Zusagen tragen den Rest: eine Störung wird **kantengetriggert** gemeldet (sonst zählt
 * `uebergang.vorkommen` Ticks statt Vorkommen), und es wird immer nur **ein** Grund gemeldet, der
 * schwerste. Beide Selbst-Monitor-Arten können zwei Ursachen gleichzeitig haben; würden beide
 * gemeldet, wechselten sie sich pro Tick gegenseitig ab und feuerten endlos Verschärfungen.
 */
import { describe, expect, it } from 'vitest';
import {
	istHarteUrsache,
	kernWirkungen,
	postfachWirkungen,
	type KernBeobachtung,
	type PostfachBeobachtung,
	type SelbstSicht
} from './beobachtung';

const T = (hhmm: string) => new Date(`2026-07-29T${hhmm}:00Z`);
const STALENESS = 900;

const GESUND: SelbstSicht = { zustand: 'gesund', alarmgrund: null };
const gestoert = (alarmgrund: SelbstSicht['alarmgrund']): SelbstSicht => ({
	zustand: 'gestoert',
	alarmgrund
});

function postfach(teile: Partial<PostfachBeobachtung> = {}): PostfachBeobachtung {
	return {
		postfachId: 'p1',
		aktiv: true,
		letzterErfolgAm: T('06:00'),
		letzterFehlerKlasse: null,
		letzterFehlerAm: null,
		...teile
	};
}

function kern(teile: Partial<KernBeobachtung> = {}): KernBeobachtung {
	return {
		dienste: [
			{ dienst: 'web', zuletztGesehen: T('06:00') },
			{ dienst: 'worker', zuletztGesehen: T('06:00') }
		],
		zustellStoerungSeit: null,
		beobachtetSeit: T('05:00'),
		...teile
	};
}

describe('Selbst-Beobachtung', () => {
	describe('Postfach', () => {
		it('meldet nichts als Störung, solange die Staleness-Frist läuft', () => {
			const wirkungen = postfachWirkungen(GESUND, postfach(), STALENESS, T('06:14'));

			expect(wirkungen).toEqual([
				{ wirkung: { art: 'erholung', erholungsArt: 'beweis' }, zeitpunkt: T('06:14') }
			]);
		});

		/** Der Alarm datiert auf den Fristablauf, nicht auf den Tick, der ihn bemerkt hat. */
		it('wird überfällig und datiert auf den Fristablauf', () => {
			const wirkungen = postfachWirkungen(GESUND, postfach(), STALENESS, T('09:30'));

			expect(wirkungen).toEqual([
				{ wirkung: { art: 'stoerung', grund: 'ueberfaellig' }, zeitpunkt: T('06:15') }
			]);
		});

		/** Kantengetriggert: „immer noch überfällig" ist kein Vorkommen. */
		it('schweigt, solange der Monitor denselben Grund schon trägt', () => {
			expect(
				postfachWirkungen(gestoert('ueberfaellig'), postfach(), STALENESS, T('09:30'))
			).toEqual([]);
		});

		/**
		 * SPEC §8: „harte Ursachen beschleunigen nur". Der Zugriffsfehler feuert sofort — die
		 * Staleness-Frist ist noch lange nicht abgelaufen.
		 */
		it('lässt eine harte Ursache die Frist überspringen', () => {
			const wirkungen = postfachWirkungen(
				GESUND,
				postfach({ letzterFehlerKlasse: 'zugriff', letzterFehlerAm: T('06:02') }),
				STALENESS,
				T('06:03')
			);

			expect(wirkungen).toEqual([
				{ wirkung: { art: 'stoerung', grund: 'fehler_gemeldet' }, zeitpunkt: T('06:02') }
			]);
		});

		/**
		 * Zwei lebende Ursachen: gemeldet wird die schwerere, datiert auf die frühere. Für einen
		 * Monitor, der schon „überfällig" trägt, ist das genau der Wechsel, den CONTEXT Verschärfung
		 * nennt.
		 */
		it('meldet nur den schwersten Grund, datiert auf die früheste Ursache', () => {
			const beide = postfach({ letzterFehlerKlasse: 'zugriff', letzterFehlerAm: T('09:00') });

			expect(postfachWirkungen(gestoert('ueberfaellig'), beide, STALENESS, T('09:30'))).toEqual([
				{ wirkung: { art: 'stoerung', grund: 'fehler_gemeldet' }, zeitpunkt: T('06:15') }
			]);
		});

		/** Und danach ist Ruhe — sonst wechselten die beiden Gründe einander pro Tick ab. */
		it('schweigt, sobald der schwerere Grund schon getragen wird', () => {
			const beide = postfach({ letzterFehlerKlasse: 'zugriff', letzterFehlerAm: T('09:00') });

			expect(postfachWirkungen(gestoert('fehler_gemeldet'), beide, STALENESS, T('09:30'))).toEqual(
				[]
			);
		});

		/** Ein Throttling ist keine harte Ursache: es geht von selbst vorbei. */
		it('behandelt vorübergehende Fehler nicht als harte Ursache', () => {
			const wirkungen = postfachWirkungen(
				GESUND,
				postfach({ letzterFehlerKlasse: 'throttling', letzterFehlerAm: T('06:02') }),
				STALENESS,
				T('06:03')
			);

			expect(wirkungen.map((eintrag) => eintrag.wirkung.art)).toEqual(['erholung']);
		});

		/** Ein Fehler, den ein erfolgreicher Poll überholt hat, ist Geschichte. */
		it('ignoriert eine harte Ursache, die älter ist als der letzte Erfolg', () => {
			const wirkungen = postfachWirkungen(
				GESUND,
				postfach({
					letzterErfolgAm: T('06:10'),
					letzterFehlerKlasse: 'zugriff',
					letzterFehlerAm: T('06:05')
				}),
				STALENESS,
				T('06:12')
			);

			expect(wirkungen.map((eintrag) => eintrag.wirkung.art)).toEqual(['erholung']);
		});

		/** Abgeschaltet heißt abgeschaltet — ein Monitor über ein bewusst stilles Postfach ist Lärm. */
		it('bewertet ein deaktiviertes Postfach gar nicht', () => {
			expect(postfachWirkungen(GESUND, postfach({ aktiv: false }), STALENESS, T('23:00'))).toEqual(
				[]
			);
		});

		it('erkennt genau die beiden harten Ursachen', () => {
			expect(istHarteUrsache('zugriff')).toBe(true);
			expect(istHarteUrsache('nicht_gefunden')).toBe(true);
			expect(istHarteUrsache('throttling')).toBe(false);
			expect(istHarteUrsache('resync')).toBe(false);
			expect(istHarteUrsache('transient')).toBe(false);
			expect(istHarteUrsache(null)).toBe(false);
		});
	});

	describe('Kern', () => {
		it('bleibt gesund, solange die Dienste melden und nichts totgelaufen ist', () => {
			const wirkungen = kernWirkungen(GESUND, kern(), STALENESS, T('06:10'));

			expect(wirkungen.map((eintrag) => eintrag.wirkung.art)).toEqual(['erholung']);
		});

		it('wird überfällig, wenn ein Dienst verstummt', () => {
			const wirkungen = kernWirkungen(
				GESUND,
				kern({
					dienste: [
						{ dienst: 'web', zuletztGesehen: T('09:00') },
						{ dienst: 'worker', zuletztGesehen: T('06:00') }
					]
				}),
				STALENESS,
				T('09:30')
			);

			expect(wirkungen).toEqual([
				{ wirkung: { art: 'stoerung', grund: 'ueberfaellig' }, zeitpunkt: T('06:15') }
			]);
		});

		/** Wer den eigenen Herzschlag prüft, schreibt ihn gerade — das beweist nichts. */
		it('prüft den eigenen watchdog-Heartbeat nicht', () => {
			const wirkungen = kernWirkungen(
				GESUND,
				kern({
					dienste: [
						{ dienst: 'web', zuletztGesehen: T('06:00') },
						{ dienst: 'worker', zuletztGesehen: T('06:00') },
						{ dienst: 'watchdog', zuletztGesehen: T('01:00') }
					]
				}),
				STALENESS,
				T('06:10')
			);

			expect(wirkungen.map((eintrag) => eintrag.wirkung.art)).toEqual(['erholung']);
		});

		/** Ein Dienst ohne Zeile wird ab dem Start dieses Watchdogs gemessen, nicht ab der Epoche. */
		it('misst einen nie gesehenen Dienst ab dem Beobachtungsbeginn', () => {
			const ohneWorker = kern({ dienste: [{ dienst: 'web', zuletztGesehen: T('06:00') }] });

			expect(
				kernWirkungen(GESUND, ohneWorker, STALENESS, T('05:10')).map((e) => e.wirkung.art)
			).toEqual(['erholung']);
			expect(kernWirkungen(GESUND, ohneWorker, STALENESS, T('05:20'))).toEqual([
				{ wirkung: { art: 'stoerung', grund: 'ueberfaellig' }, zeitpunkt: T('05:15') }
			]);
		});

		it('meldet eine Zustell-Störung als „Fehler gemeldet", datiert auf ihren Beginn', () => {
			const wirkungen = kernWirkungen(
				GESUND,
				kern({ zustellStoerungSeit: T('04:30') }),
				STALENESS,
				T('06:10')
			);

			expect(wirkungen).toEqual([
				{ wirkung: { art: 'stoerung', grund: 'fehler_gemeldet' }, zeitpunkt: T('04:30') }
			]);
		});

		/**
		 * Der Fall, der die Episode sonst pro Tick zwischen beiden Gründen hin- und herwirft: stille
		 * Dienste **und** tote Zustellung. Gemeldet wird „Fehler gemeldet", und beim nächsten Tick
		 * nichts mehr.
		 */
		it('wechselt bei zwei Ursachen nicht pro Tick den Grund', () => {
			const beide = kern({
				dienste: [
					{ dienst: 'web', zuletztGesehen: T('06:00') },
					{ dienst: 'worker', zuletztGesehen: T('06:00') }
				],
				zustellStoerungSeit: T('08:00')
			});

			expect(kernWirkungen(gestoert('ueberfaellig'), beide, STALENESS, T('09:30'))).toEqual([
				{ wirkung: { art: 'stoerung', grund: 'fehler_gemeldet' }, zeitpunkt: T('06:15') }
			]);
			expect(kernWirkungen(gestoert('fehler_gemeldet'), beide, STALENESS, T('09:30'))).toEqual([]);
		});
	});
});
