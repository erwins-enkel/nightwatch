/**
 * Schicht 1 der Ableitung, ohne Datenbank.
 *
 * Die schärfste Zusage dieses Moduls ist eine Unterlassung: **die Muster-Slots bleiben leer.** Wer
 * sie hier befüllte, hätte aus einer Vorbefüllung eine Behauptung über den Inhalt gemacht — und
 * genau dafür gibt es Schicht 2 und den Menschen davor.
 */
import { describe, expect, it } from 'vitest';
import { AUTO_ZURUECK_DEFAULT_SEKUNDEN } from '../monitor/parameter';
import { kompiliereRegel, trifftMatchKriterien } from '../monitor/regel';
import { alsBetreffMuster, alsMuster } from '../../regel/muster';
import { alsInstant } from '../zeit/zeitzone';
import { erkenneTakt } from './takt';
import { beobachteteOffenzeit, karenzAusStreuung, leiteAb, zaehlerVorschlag } from './ableitung';

const ZONE = 'Europe/Berlin';

function berlin(datum: string, uhrzeit: string): Date {
	const [jahr, monat, tag] = datum.split('-').map(Number);
	const [stunde, minute] = uhrzeit.split(':').map(Number);
	return alsInstant({ jahr, monat, tag, stunde, minute, sekunde: 0 }, ZONE);
}

function taeglicheFolge(start: string, uhrzeit: string, anzahl: number): Date[] {
	const [jahr, monat, tag] = start.split('-').map(Number);
	return Array.from({ length: anzahl }, (_, i) => {
		const datum = new Date(Date.UTC(jahr, monat - 1, tag + i));
		return berlin(datum.toISOString().slice(0, 10), uhrzeit);
	});
}

/**
 * Der Takt kommt im Betrieb aus `mail_sorte`. Hier wird er aus denselben Ankunftszeiten gewonnen,
 * aus denen ihn die Zuordnungs-Pipeline gewinnt — die Fälle bleiben dadurch als Eingangsmuster
 * lesbar, statt als handgeschriebene Takt-Objekte.
 */
function ableitung(beispiel: { absender: string; betreff: string }, zeiten: Date[]) {
	return leiteAb(beispiel, erkenneTakt(zeiten, ZONE), zeiten.length);
}

const BEISPIEL = {
	absender: 'Backup@Veeam.msp.test',
	betreff: 'Backup Job 4711 completed 2026-03-02 05:40'
};

describe('leiteAb', () => {
	it('befüllt die Match-Kriterien aus Absender und Sorten-Signatur', () => {
		const vorbefuellung = ableitung(BEISPIEL, taeglicheFolge('2026-03-02', '05:40', 12));

		expect(vorbefuellung.regel.absender).toEqual(['backup@veeam.msp.test']);
		expect(vorbefuellung.regel.betreffMuster).toHaveLength(1);
		expect(vorbefuellung.belege).toContainEqual({
			grund: 'match',
			absender: 'backup@veeam.msp.test',
			betreffMuster: 'Backup Job # completed #'
		});
	});

	it('erzeugt ein Betreff-Muster, das die morgige Mail derselben Sorte trifft', () => {
		const vorbefuellung = ableitung(BEISPIEL, []);
		const { regel } = kompiliereRegel(vorbefuellung.regel);

		const morgen = {
			absender: 'backup@veeam.msp.test',
			betreff: 'Backup Job 4712 completed 2026-03-03 05:38',
			bodyText: null
		};

		expect(trifftMatchKriterien(morgen, regel)).toBe(true);
	});

	it('lässt die Muster-Slots leer — Inhaltliches ist Schicht 2', () => {
		const vorbefuellung = ableitung(BEISPIEL, taeglicheFolge('2026-03-02', '05:40', 12));

		expect(vorbefuellung.regel.musterSchlecht).toEqual([]);
		expect(vorbefuellung.regel.musterGut).toEqual([]);
	});

	it('vermutet Heartbeat, wenn ein Takt erkannt ist, und leitet die Erwartung ab', () => {
		const vorbefuellung = ableitung(BEISPIEL, taeglicheFolge('2026-03-02', '05:40', 12));

		expect(vorbefuellung.art).toBe('heartbeat');
		expect(vorbefuellung.parameter.erwartungModus).toBe('kalenderplan');
		expect(vorbefuellung.parameter.erwartungPlan).toEqual({
			wochentage: [1, 2, 3, 4, 5, 6, 7],
			uhrzeit: '05:40'
		});
		expect(vorbefuellung.belege).toContainEqual(
			expect.objectContaining({ grund: 'takt', takt: expect.objectContaining({ vorkommen: 12 }) })
		);
	});

	it('macht aus einem Intervall-Takt eine Intervall-Erwartung', () => {
		const zeiten = [0, 300, 600, 900, 1200].map(
			(versatz) => new Date(berlin('2026-03-02', '08:00').getTime() + versatz * 1000)
		);

		const vorbefuellung = ableitung(BEISPIEL, zeiten);

		expect(vorbefuellung.parameter).toMatchObject({
			erwartungModus: 'intervall',
			erwartungIntervallSekunden: 300
		});
		expect(vorbefuellung.parameter.erwartungPlan).toBeUndefined();
	});

	it('setzt beim Wochen-Takt genau den beobachteten Wochentag', () => {
		const zeiten = ['2026-03-02', '2026-03-09', '2026-03-16', '2026-03-23'].map((datum) =>
			berlin(datum, '07:15')
		);

		const vorbefuellung = ableitung(BEISPIEL, zeiten);

		expect(vorbefuellung.parameter.erwartungPlan).toEqual({ wochentage: [1], uhrzeit: '07:15' });
	});

	it('vermutet Ereignis, wenn kein Takt erkennbar ist', () => {
		const vorbefuellung = ableitung(BEISPIEL, [berlin('2026-03-02', '08:00')]);

		expect(vorbefuellung.art).toBe('ereignis');
		expect(vorbefuellung.parameter).toEqual({
			autoZurueckSekunden: AUTO_ZURUECK_DEFAULT_SEKUNDEN
		});
		expect(vorbefuellung.belege).toContainEqual({ grund: 'kein_takt', vorkommen: 1 });
	});

	it('vermutet nie Paar oder Zähler — die wählt der Mensch bewusst', () => {
		const mitTakt = ableitung(BEISPIEL, taeglicheFolge('2026-03-02', '05:40', 12));
		const ohneTakt = ableitung(BEISPIEL, []);

		expect([mitTakt.art, ohneTakt.art]).toEqual(['heartbeat', 'ereignis']);
	});

	it('trägt für jeden abgeleiteten Wert einen Beleg', () => {
		const vorbefuellung = ableitung(BEISPIEL, taeglicheFolge('2026-03-02', '05:40', 12));

		expect(vorbefuellung.belege.map((beleg) => beleg.grund)).toEqual(['match', 'takt', 'karenz']);
	});
});

describe('karenzAusStreuung', () => {
	it('setzt bei perfekter Pünktlichkeit den Boden', () => {
		expect(karenzAusStreuung(0)).toBe(900);
	});

	it('legt die beobachtete Streuung auf den Boden und rundet auf fünf Minuten', () => {
		// 20 min beobachtet + 15 min Boden = 35 min.
		expect(karenzAusStreuung(1200)).toBe(2100);
		// 22 min beobachtet + 15 min = 37 min, aufgerundet auf 40.
		expect(karenzAusStreuung(1320)).toBe(2400);
	});
});

describe('alsMuster', () => {
	it('schützt reguläre Sonderzeichen im markierten Text', () => {
		const muster = alsMuster('Backup completed (100%) [OK]');

		expect(new RegExp(muster, 'i').test('… Backup completed (100%) [OK] …')).toBe(true);
	});

	it('macht aus den Platzhaltern der Sorten-Signatur weite Stellen', () => {
		const muster = alsBetreffMuster('Backup Job # completed #');

		expect(muster).toBe('Backup Job .* completed .*');
	});
});

describe('zaehlerVorschlag', () => {
	it('schlägt ein Tagesfenster und ein Band um den Median vor', () => {
		// Sieben volle Tage à 10 Mails, plus zwei angeschnittene Randtage mit je einer.
		const zeiten = [
			berlin('2026-03-01', '23:50'),
			...Array.from({ length: 7 }, (_, tag) =>
				Array.from({ length: 10 }, (_, i) =>
					berlin(`2026-03-0${tag + 2}`, `0${Math.floor(i / 5) + 8}:${(i % 5) * 10 || '00'}`)
				)
			).flat(),
			berlin('2026-03-09', '00:10')
		];

		const vorschlag = zaehlerVorschlag(zeiten, ZONE);

		expect(vorschlag?.parameter).toEqual({
			zaehlerFensterSekunden: 86_400,
			zaehlerObergrenze: 20,
			zaehlerUntergrenze: 5
		});
		expect(vorschlag?.beleg).toMatchObject({ grund: 'zaehler', medianProTag: 10 });
	});

	it('lässt die Untergrenze weg, wenn sie nie unterschritten werden könnte', () => {
		const vorschlag = zaehlerVorschlag(taeglicheFolge('2026-03-02', '05:40', 9), ZONE);

		expect(vorschlag?.parameter.zaehlerUntergrenze).toBeUndefined();
		expect(vorschlag?.parameter.zaehlerObergrenze).toBe(2);
	});

	it('schlägt ohne Vorkommen nichts vor', () => {
		expect(zaehlerVorschlag([], ZONE)).toBeNull();
	});
});

describe('beobachteteOffenzeit', () => {
	const REGEL = {
		absender: [],
		betreffMuster: ['Leitung'],
		schluesselwoerter: [],
		musterSchlecht: ['Leitung ab'],
		musterGut: ['Leitung wieder da']
	};

	function mail(uhrzeit: string, betreff: string) {
		return {
			ankunftszeit: berlin('2026-03-02', uhrzeit),
			absender: 'router@kunde.test',
			betreff,
			bodyText: null
		};
	}

	it('misst die längste Auf→Zu-Dauer und schlägt sie mit Luft vor', () => {
		const vorschlag = beobachteteOffenzeit(
			[
				mail('08:00', 'Leitung ab'),
				mail('08:20', 'Leitung wieder da'),
				mail('12:00', 'Leitung ab'),
				mail('12:50', 'Leitung wieder da')
			],
			REGEL
		);

		expect(vorschlag?.beleg).toEqual({ grund: 'offenzeit', maxSekunden: 3000, paare: 2 });
		// 50 min beobachtet + 15 min Luft.
		expect(vorschlag?.maxOffenzeitSekunden).toBe(3900);
	});

	it('lässt die Offenzeit ab dem ersten Auf laufen', () => {
		const vorschlag = beobachteteOffenzeit(
			[
				mail('08:00', 'Leitung ab'),
				mail('08:10', 'Leitung ab'),
				mail('08:30', 'Leitung wieder da')
			],
			REGEL
		);

		expect(vorschlag?.beleg).toEqual({ grund: 'offenzeit', maxSekunden: 1800, paare: 1 });
	});

	it('ignoriert ein Zu ohne offenen Zustand', () => {
		const vorschlag = beobachteteOffenzeit(
			[
				mail('08:00', 'Leitung wieder da'),
				mail('09:00', 'Leitung ab'),
				mail('09:30', 'Leitung wieder da')
			],
			REGEL
		);

		expect(vorschlag?.beleg).toEqual({ grund: 'offenzeit', maxSekunden: 1800, paare: 1 });
	});

	it('schlägt nichts vor, solange kein Paar beobachtet wurde', () => {
		expect(beobachteteOffenzeit([mail('08:00', 'Leitung ab')], REGEL)).toBeNull();
	});
});
