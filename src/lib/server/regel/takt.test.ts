/**
 * Takt-Erkennung ohne Datenbank (CONTEXT „Takt").
 *
 * Die Fälle sind nicht erfunden, sondern die, an denen eine naive Implementierung scheitert: die
 * Wochenend-Lücke (die als Intervall-Ausreißer aussieht), der nächtliche Report um Mitternacht (der
 * an der echten Tagesgrenze auf zwei Tage zerfällt), die Sommerzeit-Umstellung (die denselben Lauf
 * in UTC um eine Stunde verschiebt) und der eine ausgefallene Report in dreißig Tagen.
 */
import { describe, expect, it } from 'vitest';
import { alsInstant } from '../zeit/zeitzone';
import { TAKT_MAX_VORKOMMEN, erkenneTakt } from './takt';

const ZONE = 'Europe/Berlin';

/** Ein Wandzeit-Zeitpunkt in der Instanz-Zeitzone — `2026-03-02`, `05:40`. */
function berlin(datum: string, uhrzeit: string): Date {
	const [jahr, monat, tag] = datum.split('-').map(Number);
	const [stunde, minute] = uhrzeit.split(':').map(Number);
	return alsInstant({ jahr, monat, tag, stunde, minute, sekunde: 0 }, ZONE);
}

/** `anzahl` aufeinander folgende Kalendertage ab `start`, jeweils zur selben Uhrzeit. */
function taeglicheFolge(start: string, uhrzeit: string, anzahl: number): Date[] {
	const [jahr, monat, tag] = start.split('-').map(Number);
	return Array.from({ length: anzahl }, (_, i) => {
		const datum = new Date(Date.UTC(jahr, monat - 1, tag + i));
		return berlin(datum.toISOString().slice(0, 10), uhrzeit);
	});
}

/** Zeitpunkte aus Sekunden-Abständen ab einem Startpunkt. */
function ausAbstaenden(start: Date, abstaende: number[]): Date[] {
	const zeiten = [start];
	for (const abstand of abstaende) {
		zeiten.push(new Date(zeiten[zeiten.length - 1].getTime() + abstand * 1000));
	}
	return zeiten;
}

describe('erkenneTakt', () => {
	it('erkennt nichts unter drei Vorkommen', () => {
		const zeiten = taeglicheFolge('2026-03-02', '05:40', 2);

		expect(erkenneTakt(zeiten, ZONE)).toBeNull();
	});

	it('erkennt einen täglichen Report mit Uhrzeit und Vorkommens-Zahl', () => {
		const takt = erkenneTakt(taeglicheFolge('2026-03-02', '05:40', 12), ZONE);

		expect(takt).toMatchObject({ klasse: 'taeglich', uhrzeit: '05:40', vorkommen: 12 });
	});

	it('erkennt „alle 5 min ± 2 min" — der Boden von 15 Minuten trägt', () => {
		// 25 % von fünf Minuten wären 75 Sekunden; ohne den Boden fiele diese Folge durch.
		const zeiten = ausAbstaenden(berlin('2026-03-02', '08:00'), [300, 420, 180, 300, 420]);

		expect(erkenneTakt(zeiten, ZONE)).toMatchObject({
			klasse: 'intervall',
			intervallSekunden: 300,
			vorkommen: 6
		});
	});

	it('erkennt nichts, wenn die Streuung die Schwelle reißt', () => {
		// Median 4 h, Toleranz also 1 h — der letzte Abstand weicht um fast anderthalb Stunden ab.
		const zeiten = ausAbstaenden(berlin('2026-03-02', '08:00'), [14_400, 14_400, 19_400]);

		expect(erkenneTakt(zeiten, ZONE)).toBeNull();
	});

	it('liest die Wochenend-Lücke als werktäglich, nicht als Ausreißer', () => {
		// Mo–Fr über zwei Wochen. Als Intervall gelesen wäre der Montags-Abstand ein Ausreißer von
		// zwei Tagen und die Folge fiele komplett durch.
		const werktage = taeglicheFolge('2026-03-02', '05:40', 12).filter(
			(zeitpunkt) => ![6, 7].includes(isoTag(zeitpunkt))
		);

		expect(erkenneTakt(werktage, ZONE)).toMatchObject({
			klasse: 'werktaeglich',
			uhrzeit: '05:40',
			vorkommen: 10
		});
	});

	it('duldet einen ausgefallenen Werktag', () => {
		const werktage = taeglicheFolge('2026-03-02', '05:40', 12).filter(
			(zeitpunkt) => ![6, 7].includes(isoTag(zeitpunkt))
		);
		const mitLuecke = werktage.filter((_, i) => i !== 4);

		expect(erkenneTakt(mitLuecke, ZONE)).toMatchObject({ klasse: 'werktaeglich', vorkommen: 9 });
	});

	it('erkennt nichts mehr, wenn zu viele Werktage fehlen', () => {
		const zeiten = [
			berlin('2026-03-02', '05:40'),
			berlin('2026-03-05', '05:40'),
			berlin('2026-03-11', '05:40'),
			berlin('2026-03-17', '05:40')
		];

		expect(erkenneTakt(zeiten, ZONE)).toBeNull();
	});

	it('erkennt einen wöchentlichen Report samt Wochentag', () => {
		const zeiten = [
			berlin('2026-03-02', '07:15'),
			berlin('2026-03-09', '07:15'),
			berlin('2026-03-16', '07:20'),
			berlin('2026-03-23', '07:15')
		];

		expect(erkenneTakt(zeiten, ZONE)).toMatchObject({
			klasse: 'woechentlich',
			// 2026-03-02 ist ein Montag.
			wochentag: 1,
			vorkommen: 4
		});
	});

	it('hält einen nächtlichen Report um Mitternacht zusammen', () => {
		// An der echten Tagesgrenze gemessen fielen diese Läufe auf 03-02, 03-04, 03-05, 03-07 …
		// und „täglich" wäre nie erkennbar.
		const zeiten = [
			berlin('2026-03-02', '23:50'),
			berlin('2026-03-04', '00:10'),
			berlin('2026-03-04', '23:55'),
			berlin('2026-03-06', '00:05'),
			berlin('2026-03-06', '23:58')
		];

		const takt = erkenneTakt(zeiten, ZONE);

		expect(takt).toMatchObject({ klasse: 'taeglich', vorkommen: 5 });
		expect(takt?.uhrzeit).toBe('00:00');
	});

	it('übersteht die Sommerzeit-Umstellung', () => {
		// In Europe/Berlin springt die Uhr am 2026-03-29; derselbe 05:40-Lauf liegt davor auf
		// 04:40 UTC und danach auf 03:40 UTC.
		const zeiten = taeglicheFolge('2026-03-25', '05:40', 10);

		expect(erkenneTakt(zeiten, ZONE)).toMatchObject({
			klasse: 'taeglich',
			uhrzeit: '05:40',
			vorkommen: 10
		});
	});

	it('liest zwei Läufe am Tag als Intervall, nicht als Tagesrhythmus', () => {
		const zeiten = [
			berlin('2026-03-02', '06:00'),
			berlin('2026-03-02', '18:00'),
			berlin('2026-03-03', '06:00'),
			berlin('2026-03-03', '18:00'),
			berlin('2026-03-04', '06:00')
		];

		expect(erkenneTakt(zeiten, ZONE)).toMatchObject({
			klasse: 'intervall',
			intervallSekunden: 43_200
		});
	});

	/**
	 * CONTEXT „Takt": „Monatlich bewusst nicht … Monats-Reports legt der Mensch als Kalenderplan
	 * an." Ohne Obergrenze käme so ein Report als Intervall „alle ~30 Tage" durch — die
	 * schwankenden Monatslängen passen bequem in 25 % Toleranz —, und damit als gleitende
	 * Erwartung, die mit jedem verspäteten Lauf mitwandert.
	 */
	it('schlägt einen Monats-Report nicht als Intervall vor', () => {
		const zeiten = [
			berlin('2026-01-01', '06:00'),
			berlin('2026-02-01', '06:00'),
			berlin('2026-03-01', '06:00'),
			berlin('2026-04-01', '06:00'),
			berlin('2026-05-01', '06:00')
		];

		expect(erkenneTakt(zeiten, ZONE)).toBeNull();
	});

	it('schlägt auch alles andere jenseits einer Woche nicht vor', () => {
		const zeiten = ausAbstaenden(berlin('2026-03-02', '08:00'), [
			10 * 86_400,
			10 * 86_400,
			10 * 86_400
		]);

		expect(erkenneTakt(zeiten, ZONE)).toBeNull();
	});

	it('lässt eine Periode bis zu einer Woche zu', () => {
		// Sechs Tage: keiner Kalender-Klasse zuzuordnen (der Wochentag wandert), aber ein
		// belastbarer Rhythmus — und diesseits der Grenze.
		const zeiten = ausAbstaenden(berlin('2026-03-02', '08:00'), [
			6 * 86_400,
			6 * 86_400,
			6 * 86_400
		]);

		expect(erkenneTakt(zeiten, ZONE)).toMatchObject({
			klasse: 'intervall',
			intervallSekunden: 6 * 86_400
		});
	});

	it('erkennt in unregelmäßigen Eingängen nichts', () => {
		const zeiten = ausAbstaenden(berlin('2026-03-02', '08:00'), [600, 43_200, 3_600, 250_000]);

		expect(erkenneTakt(zeiten, ZONE)).toBeNull();
	});

	it('wertet höchstens die jüngsten 200 Vorkommen aus', () => {
		const takt = erkenneTakt(taeglicheFolge('2025-06-01', '05:40', 300), ZONE);

		expect(takt).toMatchObject({ klasse: 'taeglich', vorkommen: TAKT_MAX_VORKOMMEN });
	});

	it('nimmt die Eingabe unsortiert entgegen', () => {
		const zeiten = taeglicheFolge('2026-03-02', '05:40', 5);
		const gemischt = [zeiten[3], zeiten[0], zeiten[4], zeiten[1], zeiten[2]];

		expect(erkenneTakt(gemischt, ZONE)).toMatchObject({ klasse: 'taeglich', vorkommen: 5 });
	});

	it('reicht die beobachtete Streuung als Karenz-Grundlage heraus', () => {
		// Ein Lauf kommt zwanzig Minuten später als die übrigen.
		const zeiten = [
			berlin('2026-03-02', '05:40'),
			berlin('2026-03-03', '05:40'),
			berlin('2026-03-04', '06:00'),
			berlin('2026-03-05', '05:40')
		];

		const takt = erkenneTakt(zeiten, ZONE);

		expect(takt?.klasse).toBe('taeglich');
		expect(takt?.streuungSekunden).toBe(600);
	});
});

/** ISO-Wochentag eines Zeitpunkts in der Instanz-Zeitzone. */
function isoTag(zeitpunkt: Date): number {
	const tag = new Date(zeitpunkt.toLocaleString('en-US', { timeZone: ZONE })).getDay();
	return tag === 0 ? 7 : tag;
}
