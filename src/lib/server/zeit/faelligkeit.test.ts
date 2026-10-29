/**
 * Die vier Zeit-Entscheidungen als Tabelle — jede Kante, die CONTEXT für den Zeitablauf nennt, ist
 * hier eine Zeile.
 */
import { describe, expect, it } from 'vitest';
import { zeitWirkungen, type ZeitKontext, type ZeitSicht } from './faelligkeit';

const SCHRANKE = new Date('2026-07-27T12:00:00Z');
const AKTIV_SEIT = new Date('2026-07-01T00:00:00Z');

function sicht(teile: Partial<ZeitSicht> & Pick<ZeitSicht, 'art'>): ZeitSicht {
	return {
		zustand: 'gesund',
		alarmgrund: null,
		pausiert: false,
		pausiertBis: null,
		aktiviertAm: AKTIV_SEIT,
		zuletztGesehenAm: null,
		paarOffenSeit: null,
		erwartungModus: null,
		erwartungIntervallSekunden: null,
		karenzSekunden: null,
		autoZurueckSekunden: null,
		maxOffenzeitSekunden: null,
		zaehlerUntergrenze: null,
		zaehlerObergrenze: null,
		letztesVorkommenAm: null,
		...teile
	};
}

function kontext(teile: Partial<ZeitKontext> = {}): ZeitKontext {
	return {
		unabgedeckt: [],
		zaehlerStand: 0,
		anlaufVorbei: true,
		ausnahmetag: false,
		gateOffen: true,
		...teile
	};
}

/** Minus `minuten` vor der Schranke. */
function vor(minuten: number): Date {
	return new Date(SCHRANKE.getTime() - minuten * 60_000);
}

describe('Heartbeat mit Intervall', () => {
	const intervall = (teile: Partial<ZeitSicht> = {}) =>
		sicht({
			art: 'heartbeat',
			erwartungModus: 'intervall',
			erwartungIntervallSekunden: 3600,
			karenzSekunden: 600,
			...teile
		});

	it('schweigt, solange Intervall plus Karenz nicht abgelaufen sind', () => {
		expect(zeitWirkungen(intervall({ zuletztGesehenAm: vor(69) }), kontext(), SCHRANKE)).toEqual(
			[]
		);
	});

	it('eröffnet überfällig, sobald Intervall plus Karenz überschritten sind', () => {
		const gesehen = vor(71);

		expect(zeitWirkungen(intervall({ zuletztGesehenAm: gesehen }), kontext(), SCHRANKE)).toEqual([
			{
				wirkung: { art: 'stoerung', grund: 'ueberfaellig' },
				zeitpunkt: new Date(gesehen.getTime() + 4200 * 1000)
			}
		]);
	});

	/** Sonst zählte jeder Tick ein Vorkommen hoch, und die Zusammenfassung zählte Ticks. */
	it('meldet dieselbe Dauer-Bedingung kein zweites Mal', () => {
		expect(
			zeitWirkungen(
				intervall({
					zuletztGesehenAm: vor(500),
					zustand: 'gestoert',
					alarmgrund: 'ueberfaellig'
				}),
				kontext(),
				SCHRANKE
			)
		).toEqual([]);
	});

	/** CONTEXT „Verschärfung": „Fehler → überfällig" ist ein echter Grund-Wechsel. */
	it('meldet überfällig auch, wenn der Monitor aus anderem Grund gestört ist', () => {
		expect(
			zeitWirkungen(
				intervall({
					zuletztGesehenAm: vor(500),
					zustand: 'gestoert',
					alarmgrund: 'fehler_gemeldet'
				}),
				kontext(),
				SCHRANKE
			)
		).toHaveLength(1);
	});

	it('rechnet ohne gesehene Mail ab der Aktivierung', () => {
		expect(zeitWirkungen(intervall({ aktiviertAm: vor(71) }), kontext(), SCHRANKE)).toHaveLength(1);
		expect(zeitWirkungen(intervall({ aktiviertAm: vor(69) }), kontext(), SCHRANKE)).toEqual([]);
	});

	/**
	 * Reaktivierung stempelt `aktiviert_am` neu, ohne `zuletzt_gesehen_am` zu räumen. Ohne die
	 * Max-Bildung wäre ein gerade wieder eingeschalteter Monitor sofort überfällig — für eine Lücke,
	 * die entstand, während er aus war.
	 */
	it('alarmiert einen frisch reaktivierten Monitor nicht rückwirkend', () => {
		expect(
			zeitWirkungen(
				intervall({ zuletztGesehenAm: vor(5000), aktiviertAm: vor(10) }),
				kontext(),
				SCHRANKE
			)
		).toEqual([]);
	});

	it('schweigt bei geschlossenem Gate', () => {
		expect(
			zeitWirkungen(
				intervall({ zuletztGesehenAm: vor(500) }),
				kontext({ gateOffen: false }),
				SCHRANKE
			)
		).toEqual([]);
	});
});

describe('Heartbeat mit Kalenderplan', () => {
	const plan = (teile: Partial<ZeitSicht> = {}) =>
		sicht({ art: 'heartbeat', erwartungModus: 'kalenderplan', karenzSekunden: 600, ...teile });

	it('schweigt ohne unabgedecktes Soll', () => {
		expect(zeitWirkungen(plan(), kontext(), SCHRANKE)).toEqual([]);
	});

	it('datiert die Störung auf die Deadline des Solls, nicht auf den Tick', () => {
		const deadline = vor(330);

		expect(zeitWirkungen(plan(), kontext({ unabgedeckt: [deadline] }), SCHRANKE)).toEqual([
			{ wirkung: { art: 'stoerung', grund: 'ueberfaellig' }, zeitpunkt: deadline }
		]);
	});

	/**
	 * Der bewusste Unterschied zur Dauer-Bedingung: der Cursor bewertet jedes Soll genau einmal,
	 * also ist ein zweites verpasstes Soll ein zweites Vorkommen — auch während schon gestört.
	 */
	it('meldet jedes verpasste Soll einzeln, auch bei laufender Störung', () => {
		const solls = [vor(1800), vor(360)];

		expect(
			zeitWirkungen(
				plan({ zustand: 'gestoert', alarmgrund: 'ueberfaellig' }),
				kontext({ unabgedeckt: solls }),
				SCHRANKE
			).map((eintrag) => eintrag.zeitpunkt)
		).toEqual(solls);
	});

	it('schweigt bei geschlossenem Gate', () => {
		expect(
			zeitWirkungen(plan(), kontext({ unabgedeckt: [vor(330)], gateOffen: false }), SCHRANKE)
		).toEqual([]);
	});
});

describe('Paar', () => {
	const offen = (teile: Partial<ZeitSicht> = {}) =>
		sicht({ art: 'paar', maxOffenzeitSekunden: 900, ...teile });

	it('schweigt, solange die Offenzeit läuft', () => {
		expect(zeitWirkungen(offen({ paarOffenSeit: vor(14) }), kontext(), SCHRANKE)).toEqual([]);
	});

	it('alarmiert ab dem Ablauf der Offenzeit, datiert auf den Ablauf', () => {
		const seit = vor(16);

		expect(zeitWirkungen(offen({ paarOffenSeit: seit }), kontext(), SCHRANKE)).toEqual([
			{
				wirkung: { art: 'stoerung', grund: 'paar_zu_lange_offen' },
				zeitpunkt: new Date(seit.getTime() + 900_000)
			}
		]);
	});

	it('tut nichts ohne offenen Zustand', () => {
		expect(zeitWirkungen(offen(), kontext(), SCHRANKE)).toEqual([]);
	});

	/** Bei Offenzeit 0 hat der Mail-Pfad schon alarmiert (#25) — der Scheduler doppelt nicht nach. */
	it('doppelt den Sofort-Alarm des Mail-Pfads nicht', () => {
		expect(
			zeitWirkungen(
				offen({
					maxOffenzeitSekunden: 0,
					paarOffenSeit: vor(5),
					zustand: 'gestoert',
					alarmgrund: 'paar_zu_lange_offen'
				}),
				kontext(),
				SCHRANKE
			)
		).toEqual([]);
	});

	it('schweigt bei geschlossenem Gate', () => {
		expect(
			zeitWirkungen(offen({ paarOffenSeit: vor(60) }), kontext({ gateOffen: false }), SCHRANKE)
		).toEqual([]);
	});
});

describe('Zähler', () => {
	const zaehler = (teile: Partial<ZeitSicht> = {}) => sicht({ art: 'zaehler', ...teile });

	it('reißt die Untergrenze, sobald genug Mails herausgealtert sind', () => {
		expect(
			zeitWirkungen(zaehler({ zaehlerUntergrenze: 10 }), kontext({ zaehlerStand: 3 }), SCHRANKE)
		).toEqual([
			{ wirkung: { art: 'stoerung', grund: 'zaehler_unter_untergrenze' }, zeitpunkt: SCHRANKE }
		]);
	});

	it('schweigt im Band', () => {
		expect(
			zeitWirkungen(zaehler({ zaehlerUntergrenze: 10 }), kontext({ zaehlerStand: 10 }), SCHRANKE)
		).toEqual([]);
	});

	/** CONTEXT „Anlauf": die Untergrenze wird erst nach einem vollen Fenster scharf. */
	it('schweigt vor dem Ende des Anlaufs', () => {
		expect(
			zeitWirkungen(
				zaehler({ zaehlerUntergrenze: 10 }),
				kontext({ zaehlerStand: 0, anlaufVorbei: false }),
				SCHRANKE
			)
		).toEqual([]);
	});

	/** „normal 100/Tag, am Feiertag 0" darf nicht alarmieren (CONTEXT „Ausnahmetag"). */
	it('wertet die Untergrenze am Ausnahmetag nicht', () => {
		expect(
			zeitWirkungen(
				zaehler({ zaehlerUntergrenze: 10 }),
				kontext({ zaehlerStand: 0, ausnahmetag: true }),
				SCHRANKE
			)
		).toEqual([]);
	});

	it('erholt beweisbasiert, wenn der Zähler wieder im Band ist', () => {
		expect(
			zeitWirkungen(
				zaehler({
					zaehlerUntergrenze: 10,
					zustand: 'gestoert',
					alarmgrund: 'zaehler_unter_untergrenze'
				}),
				kontext({ zaehlerStand: 12 }),
				SCHRANKE
			)
		).toEqual([{ wirkung: { art: 'erholung' }, zeitpunkt: SCHRANKE }]);
	});

	/** Die Obergrenze reißt der Mail-Pfad; ins Band zurück kommt sie nur durch Herausaltern. */
	it('erholt die Obergrenze durch Herausaltern', () => {
		expect(
			zeitWirkungen(
				zaehler({
					zaehlerObergrenze: 50,
					zustand: 'gestoert',
					alarmgrund: 'zaehler_ueber_obergrenze'
				}),
				kontext({ zaehlerStand: 50 }),
				SCHRANKE
			)
		).toEqual([{ wirkung: { art: 'erholung' }, zeitpunkt: SCHRANKE }]);
	});

	it('erholt am Ausnahmetag trotzdem — ausgesetzt ist nur die Schlecht-Richtung', () => {
		expect(
			zeitWirkungen(
				zaehler({
					zaehlerUntergrenze: 10,
					zustand: 'gestoert',
					alarmgrund: 'zaehler_unter_untergrenze'
				}),
				kontext({ zaehlerStand: 12, ausnahmetag: true }),
				SCHRANKE
			)
		).toEqual([{ wirkung: { art: 'erholung' }, zeitpunkt: SCHRANKE }]);
	});

	it('meldet die gerissene Untergrenze kein zweites Mal', () => {
		expect(
			zeitWirkungen(
				zaehler({
					zaehlerUntergrenze: 10,
					zustand: 'gestoert',
					alarmgrund: 'zaehler_unter_untergrenze'
				}),
				kontext({ zaehlerStand: 3 }),
				SCHRANKE
			)
		).toEqual([]);
	});

	it('schweigt bei geschlossenem Gate', () => {
		expect(
			zeitWirkungen(
				zaehler({ zaehlerUntergrenze: 10 }),
				kontext({ zaehlerStand: 0, gateOffen: false }),
				SCHRANKE
			)
		).toEqual([]);
	});
});

describe('Ereignis mit Auto-Zurück', () => {
	const ereignis = (teile: Partial<ZeitSicht> = {}) =>
		sicht({ art: 'ereignis', autoZurueckSekunden: 86_400, ...teile });

	it('tut nichts, solange der Monitor gesund ist', () => {
		expect(zeitWirkungen(ereignis({ letztesVorkommenAm: vor(5000) }), kontext(), SCHRANKE)).toEqual(
			[]
		);
	});

	it('schweigt, solange die Auto-Zurück-Zeit läuft', () => {
		expect(
			zeitWirkungen(
				ereignis({
					zustand: 'gestoert',
					alarmgrund: 'ereignis_eingetroffen',
					letztesVorkommenAm: vor(1439)
				}),
				kontext(),
				SCHRANKE
			)
		).toEqual([]);
	});

	/** Nicht `beweis` — sonst schlösse #27 ein ungelesenes Ticket (CONTEXT „Auto-Zurück"). */
	it('erholt nach Ablauf mit der Erholungs-Art auto_zurueck', () => {
		const vorkommen = vor(1441);

		expect(
			zeitWirkungen(
				ereignis({
					zustand: 'gestoert',
					alarmgrund: 'ereignis_eingetroffen',
					letztesVorkommenAm: vorkommen
				}),
				kontext(),
				SCHRANKE
			)
		).toEqual([
			{
				wirkung: { art: 'erholung', erholungsArt: 'auto_zurueck' },
				zeitpunkt: new Date(vorkommen.getTime() + 86_400_000)
			}
		]);
	});

	/** Eine kaputte Ingestion darf keinen Monitor künstlich gestört halten. */
	it('erholt auch bei geschlossenem Gate', () => {
		expect(
			zeitWirkungen(
				ereignis({
					zustand: 'gestoert',
					alarmgrund: 'ereignis_eingetroffen',
					letztesVorkommenAm: vor(1441)
				}),
				kontext({ gateOffen: false }),
				SCHRANKE
			)
		).toHaveLength(1);
	});
});
