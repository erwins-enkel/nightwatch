import { describe, expect, it } from 'vitest';
import { lage, type Tagesspalte } from '../../board/anzeige';
import {
	ACHSE_TAGE,
	baueZeitachse,
	type AchsenKontext,
	type AchsenSicht,
	type Ankunft
} from './zeitachse';

/** Donnerstag, 30.07.2026, 08:00 Ortszeit Europe/Berlin (= 06:00 UTC). */
const JETZT = new Date('2026-07-30T06:00:00Z');
const ZONE = 'Europe/Berlin';
/** Weit vor dem Fenster, damit die Aktivierung keine Rolle spielt, wo sie nicht gemeint ist. */
const AKTIV = new Date('2026-06-01T00:00:00Z');

function sicht(teile: Partial<AchsenSicht> = {}): AchsenSicht {
	return {
		art: 'heartbeat',
		zustand: 'gesund',
		alarmgrund: null,
		pausiert: false,
		pausiertBis: null,
		aktiviertAm: AKTIV,
		erwartungModus: 'kalenderplan',
		erwartungIntervallSekunden: null,
		erwartungPlan: { wochentage: [1, 2, 3, 4, 5], uhrzeit: '06:00' },
		karenzSekunden: 45 * 60,
		...teile
	};
}

function kontext(teile: Partial<AchsenKontext> = {}): AchsenKontext {
	return { zone: ZONE, ausnahmetage: new Set(), ankuenfte: [], ...teile };
}

/** `HH:MM` Ortszeit am gegebenen Tag — im Juli ist Europe/Berlin UTC+2. */
function ortszeit(datum: string, uhrzeit: string): Date {
	return new Date(`${datum}T${uhrzeit}:00+02:00`);
}

function ankunft(datum: string, uhrzeit: string, klassifikation: Ankunft['klassifikation'] = 'ok') {
	return { ankunftszeit: ortszeit(datum, uhrzeit), klassifikation };
}

function spalte(achse: Tagesspalte[], datum: string): Tagesspalte {
	const treffer = achse.find((eintrag) => eintrag.datum === datum);
	if (treffer === undefined) throw new Error(`keine Spalte für ${datum}`);
	return treffer;
}

describe('Fenster', () => {
	it('spannt sieben Tage in der Instanz-Zeitzone, ältester zuerst, heute zuletzt', () => {
		const achse = baueZeitachse(sicht(), kontext(), JETZT);

		expect(achse).toHaveLength(ACHSE_TAGE);
		expect(achse[0].datum).toBe('2026-07-24');
		expect(achse[ACHSE_TAGE - 1].datum).toBe('2026-07-30');
		expect(achse[ACHSE_TAGE - 1].wochentag).toBe(4);
	});

	/**
	 * Die Zone entscheidet, welchem Tag eine Mail gehört: 23:30 UTC ist in Berlin schon der nächste
	 * Tag. Nach UTC gebucht stünde der Bericht in der falschen Spalte.
	 */
	it('bucht eine Ankunft nach der Ortszeit, nicht nach UTC', () => {
		const achse = baueZeitachse(
			sicht(),
			kontext({
				ankuenfte: [{ ankunftszeit: new Date('2026-07-27T23:30:00Z'), klassifikation: 'ok' }]
			}),
			JETZT
		);

		expect(spalte(achse, '2026-07-28').eingetroffen).toBe(1);
		expect(spalte(achse, '2026-07-27').eingetroffen).toBe(0);
	});

	it('nimmt die schlechteste Klassifikation des Tages', () => {
		const achse = baueZeitachse(
			sicht(),
			kontext({
				ankuenfte: [
					ankunft('2026-07-28', '05:40', 'ok'),
					ankunft('2026-07-28', '05:50', 'fehler'),
					ankunft('2026-07-28', '05:55', 'unklar')
				]
			}),
			JETZT
		);

		expect(spalte(achse, '2026-07-28').klassifikation).toBe('fehler');
		expect(spalte(achse, '2026-07-28').eingetroffen).toBe(3);
	});

	it('ignoriert die Ankünfte aus dem Vorlauf für die Spalten', () => {
		const achse = baueZeitachse(
			sicht(),
			kontext({ ankuenfte: [ankunft('2026-07-01', '05:40')] }),
			JETZT
		);

		expect(achse.every((eintrag) => eintrag.eingetroffen === 0)).toBe(true);
	});
});

describe('Kalenderplan', () => {
	/** Mo–Fr 06:00: im Fenster 24.07. (Fr) bis 30.07. (Do) sind das fünf Werktage. */
	it('zählt die Soll-Zeitpunkte auf ihre Tage', () => {
		const achse = baueZeitachse(sicht(), kontext(), JETZT);

		expect(achse.map((eintrag) => eintrag.erwartet)).toEqual([1, 0, 0, 1, 1, 1, 1]);
	});

	it('deckt einen Soll mit einer Mail aus seinem Fenster', () => {
		const gedeckt = baueZeitachse(
			sicht(),
			kontext({ ankuenfte: [ankunft('2026-07-28', '05:40')] }),
			JETZT
		);

		expect(spalte(gedeckt, '2026-07-28').verfehlt).toBe(0);
		expect(spalte(gedeckt, '2026-07-29').verfehlt).toBe(1);
	});

	/**
	 * Der noch nicht fällige Soll ist eine Erwartung, keine Lücke: um 08:00 ist der Soll von 06:00
	 * plus 45 min Karenz zwar vorbei — der von morgen aber nicht.
	 */
	it('meldet einen Soll erst nach Ablauf der Karenz als verfehlt', () => {
		const kurzVorFrist = new Date('2026-07-30T04:30:00Z'); // 06:30 Ortszeit, Karenz bis 06:45
		const achse = baueZeitachse(sicht(), kontext(), kurzVorFrist);

		const heute = spalte(achse, '2026-07-30');
		expect(heute.erwartet).toBe(1);
		expect(heute.verfehlt).toBe(0);
		expect(lage(heute)).toBe('erwartet');
	});

	/** CONTEXT „Ausnahmetag": an ihm gibt es den Soll schlicht nicht. */
	it('lässt den Soll eines Ausnahmetags entfallen', () => {
		const achse = baueZeitachse(sicht(), kontext({ ausnahmetage: new Set(['2026-07-29']) }), JETZT);

		const feiertag = spalte(achse, '2026-07-29');
		expect(feiertag.erwartet).toBe(0);
		expect(feiertag.verfehlt).toBe(0);
		expect(feiertag.ausnahmetag).toBe(true);
	});

	/**
	 * Das Deckungsfenster reicht bis zum vorherigen Soll zurück — hier über den Fensterrand hinaus.
	 * Ohne die mitgelieferten älteren Ankünfte hielte die Achse den ersten Soll für ungedeckt.
	 */
	it('deckt den ersten Soll des Fensters mit einer Mail von davor', () => {
		const achse = baueZeitachse(
			sicht(),
			kontext({ ankuenfte: [ankunft('2026-07-23', '20:00')] }),
			JETZT
		);

		expect(spalte(achse, '2026-07-24').verfehlt).toBe(0);
	});

	/** CONTEXT „Lernfenster": vor der Aktivierung wird nichts beurteilt. */
	it('beurteilt nichts vor der Aktivierung', () => {
		const achse = baueZeitachse(
			sicht({ aktiviertAm: ortszeit('2026-07-29', '00:00') }),
			kontext(),
			JETZT
		);

		expect(spalte(achse, '2026-07-27').vorAktivierung).toBe(true);
		expect(spalte(achse, '2026-07-27').erwartet).toBe(0);
		expect(spalte(achse, '2026-07-29').vorAktivierung).toBe(false);
	});

	it('lässt beim Entwurf die ganze Achse unbewertet', () => {
		const achse = baueZeitachse(sicht({ aktiviertAm: null }), kontext(), JETZT);

		expect(achse.every((eintrag) => eintrag.vorAktivierung)).toBe(true);
		expect(achse.every((eintrag) => eintrag.erwartet === 0)).toBe(true);
		expect(lage(achse[0])).toBe('unbewertet');
	});
});

describe('Intervall', () => {
	function intervallSicht() {
		return sicht({
			erwartungModus: 'intervall',
			erwartungIntervallSekunden: 3600,
			erwartungPlan: null,
			karenzSekunden: 600
		});
	}

	/**
	 * Eine Lücke ist ein Vorkommen, nicht eines je verstrichenem Intervall — und die Frist fällt
	 * dorthin, wo sie verstreicht: eine Stunde plus zehn Minuten nach der *letzten* Mail. Die zweite
	 * Lücke reicht hier über anderthalb Tage, ihre Frist liegt trotzdem noch am 28.
	 */
	it('markiert je Lücke genau eine verfehlte Frist, am Tag ihres Ablaufs', () => {
		const achse = baueZeitachse(
			intervallSicht(),
			kontext({
				ankuenfte: [
					ankunft('2026-07-28', '08:00'),
					ankunft('2026-07-28', '20:00'),
					ankunft('2026-07-30', '07:30')
				]
			}),
			JETZT
		);

		expect(spalte(achse, '2026-07-28').verfehlt).toBe(2);
		expect(spalte(achse, '2026-07-29').verfehlt).toBe(0);
		expect(spalte(achse, '2026-07-30').verfehlt).toBe(0);
	});

	it('setzt die Frist einer Lücke auf den Folgetag, wenn sie dort abläuft', () => {
		const achse = baueZeitachse(
			intervallSicht(),
			kontext({ ankuenfte: [ankunft('2026-07-28', '23:30'), ankunft('2026-07-30', '07:30')] }),
			JETZT
		);

		expect(spalte(achse, '2026-07-28').verfehlt).toBe(0);
		expect(spalte(achse, '2026-07-29').verfehlt).toBe(1);
	});

	it('rechnet die laufende Lücke bis jetzt mit', () => {
		const achse = baueZeitachse(
			intervallSicht(),
			kontext({ ankuenfte: [ankunft('2026-07-30', '04:00')] }),
			JETZT
		);

		expect(spalte(achse, '2026-07-30').verfehlt).toBe(1);
	});

	it('kennt keine diskreten Soll-Zeitpunkte', () => {
		const achse = baueZeitachse(intervallSicht(), kontext(), JETZT);

		expect(achse.every((eintrag) => eintrag.erwartet === 0)).toBe(true);
	});
});

describe('Arten ohne Erwartung', () => {
	it('zeigt bei Ereignis, Paar und Zähler nur Eingetroffenes', () => {
		for (const art of ['ereignis', 'paar', 'zaehler'] as const) {
			const achse = baueZeitachse(
				sicht({ art, erwartungModus: null, erwartungPlan: null, karenzSekunden: null }),
				kontext({ ankuenfte: [ankunft('2026-07-29', '12:00', 'fehler')] }),
				JETZT
			);

			expect(achse.every((eintrag) => eintrag.erwartet === 0 && eintrag.verfehlt === 0)).toBe(true);
			expect(lage(spalte(achse, '2026-07-29'))).toBe('fehler');
		}
	});
});

describe('Tageslage', () => {
	it('setzt die Pause auf den laufenden Tag und nur dorthin', () => {
		const achse = baueZeitachse(sicht({ pausiert: true }), kontext(), JETZT);

		expect(spalte(achse, '2026-07-30').pausiert).toBe(true);
		expect(spalte(achse, '2026-07-29').pausiert).toBe(false);
	});

	it('ignoriert eine abgelaufene Pause', () => {
		const achse = baueZeitachse(
			sicht({ pausiert: true, pausiertBis: new Date('2026-07-30T05:00:00Z') }),
			kontext(),
			JETZT
		);

		expect(spalte(achse, '2026-07-30').pausiert).toBe(false);
	});

	/** Während der Pause feuert keine Schlecht-Bedingung — dann sagt die Spalte auch nichts anderes. */
	it('stellt die Pause über die verfehlte Frist', () => {
		const achse = baueZeitachse(sicht({ pausiert: true }), kontext(), JETZT);

		expect(spalte(achse, '2026-07-30').verfehlt).toBe(1);
		expect(lage(spalte(achse, '2026-07-30'))).toBe('pausiert');
	});

	it('stellt die verfehlte Frist über eine Mail desselben Tages', () => {
		expect(
			lage({
				datum: '2026-07-29',
				wochentag: 3,
				eingetroffen: 1,
				klassifikation: 'ok',
				erwartet: 2,
				verfehlt: 1,
				ausnahmetag: false,
				vorAktivierung: false,
				pausiert: false
			})
		).toBe('verfehlt');
	});

	/** Der Ausnahmetag erklärt die Abwesenheit — kam etwas an, ist die Ankunft die Aussage. */
	it('stellt eine Ankunft über den Ausnahmetag', () => {
		const achse = baueZeitachse(
			sicht(),
			kontext({
				ausnahmetage: new Set(['2026-07-29']),
				ankuenfte: [ankunft('2026-07-29', '05:40', 'ok')]
			}),
			JETZT
		);

		expect(lage(spalte(achse, '2026-07-29'))).toBe('ok');

		const ohneMail = baueZeitachse(
			sicht(),
			kontext({ ausnahmetage: new Set(['2026-07-29']) }),
			JETZT
		);
		expect(lage(spalte(ohneMail, '2026-07-29'))).toBe('ausnahmetag');
	});

	it('nennt einen Tag ohne Erwartung und ohne Ankunft leer', () => {
		const achse = baueZeitachse(sicht(), kontext(), JETZT);

		expect(lage(spalte(achse, '2026-07-25'))).toBe('leer');
	});
});
