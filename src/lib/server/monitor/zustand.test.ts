import { describe, expect, it } from 'vitest';
import { alarmgrund, type Alarmgrund } from '../db/schema/enums';
import type { Wirkung } from './auswertung';
import { empfohleneAktion, istPausiert, wendeAn, type ZustandsSicht } from './zustand';

const JETZT = new Date('2026-07-28T06:00:00Z');

function sicht(teile: Partial<ZustandsSicht> = {}): ZustandsSicht {
	return { zustand: 'gesund', alarmgrund: null, pausiert: false, pausiertBis: null, ...teile };
}

const stoerung = (grund: Alarmgrund): Wirkung => ({ art: 'stoerung', grund });
const erholung: Wirkung = { art: 'erholung' };

describe('Zustandsmaschine', () => {
	it('eröffnet eine Episode beim Übergang gesund → gestört', () => {
		expect(wendeAn(sicht(), stoerung('fehler_gemeldet'), JETZT)).toEqual({
			art: 'eroeffnen',
			grund: 'fehler_gemeldet'
		});
	});

	/** „Ein Alarm pro Übergang" (SPEC §6) — weitere Vorkommen werden nur intern gezählt. */
	it('zählt weitere Vorkommen desselben Grunds nur', () => {
		const gestoert = sicht({ zustand: 'gestoert', alarmgrund: 'ereignis_eingetroffen' });
		expect(wendeAn(gestoert, stoerung('ereignis_eingetroffen'), JETZT)).toEqual({
			art: 'vorkommen'
		});
	});

	/** CONTEXT „Verschärfung": der Wechsel **zu** „Fehler gemeldet", und nur der. */
	it('erkennt die Verschärfung am Wechsel zu „Fehler gemeldet"', () => {
		const unklar = sicht({ zustand: 'gestoert', alarmgrund: 'unklar' });
		expect(wendeAn(unklar, stoerung('fehler_gemeldet'), JETZT)).toEqual({
			art: 'grundwechsel',
			grund: 'fehler_gemeldet',
			verschaerfung: true
		});

		const fehler = sicht({ zustand: 'gestoert', alarmgrund: 'fehler_gemeldet' });
		expect(wendeAn(fehler, stoerung('unklar'), JETZT)).toEqual({
			art: 'grundwechsel',
			grund: 'unklar',
			verschaerfung: false
		});
	});

	it('beendet die Episode bei beweisbasierter Erholung', () => {
		expect(wendeAn(sicht({ zustand: 'gestoert', alarmgrund: 'unklar' }), erholung, JETZT)).toEqual({
			art: 'beenden',
			erholungsArt: 'beweis'
		});
	});

	/**
	 * Auto-Zurück und Erledigen sind kein Beweis — sie kommentieren nur (CONTEXT). Reichte die
	 * Erholungs-Art nicht bis hierher durch, schlösse #27 ein ungelesenes Ereignis-Ticket.
	 */
	it('reicht eine nicht beweisbasierte Erholungs-Art durch', () => {
		expect(
			wendeAn(
				sicht({ zustand: 'gestoert', alarmgrund: 'ereignis_eingetroffen' }),
				{ art: 'erholung', erholungsArt: 'auto_zurueck' },
				JETZT
			)
		).toEqual({ art: 'beenden', erholungsArt: 'auto_zurueck' });
	});

	it('lässt eine Erholung im gesunden Zustand folgenlos', () => {
		expect(wendeAn(sicht(), erholung, JETZT)).toEqual({ art: 'keine' });
	});
});

describe('Pausiert', () => {
	it('unterdrückt die Schlecht-Richtung', () => {
		expect(wendeAn(sicht({ pausiert: true }), stoerung('unklar'), JETZT)).toEqual({ art: 'keine' });
	});

	/**
	 * „Während Pausiert feuert keine Schlecht-Bedingung und kein Alarm" — von der Erholung steht da
	 * nichts, und eine Wartung darf einen Monitor nicht dauerhaft gestört zurücklassen.
	 */
	it('lässt die Erholung durch', () => {
		const pausiertUndGestoert = sicht({
			zustand: 'gestoert',
			alarmgrund: 'fehler_gemeldet',
			pausiert: true
		});
		expect(wendeAn(pausiertUndGestoert, erholung, JETZT)).toEqual({
			art: 'beenden',
			erholungsArt: 'beweis'
		});
	});

	it('endet mit dem Auto-Ende, ohne dass jemand eine Spalte umlegt', () => {
		const bis = (versatz: number) =>
			sicht({ pausiert: true, pausiertBis: new Date(+JETZT + versatz) });

		expect(istPausiert(bis(60_000), JETZT)).toBe(true);
		expect(istPausiert(bis(-60_000), JETZT)).toBe(false);
		expect(istPausiert(sicht({ pausiert: true }), JETZT)).toBe(true);
		expect(istPausiert(sicht(), JETZT)).toBe(false);
	});
});

describe('Empfohlene Aktion', () => {
	/** CONTEXT „Unklar": Aktion „Regel überarbeiten" statt „Störung beheben". */
	it('schickt Unklar zur Regel und alles andere zur Störung', () => {
		expect(empfohleneAktion('unklar')).toBe('regel_ueberarbeiten');

		for (const grund of alarmgrund.enumValues.filter((wert) => wert !== 'unklar')) {
			expect(empfohleneAktion(grund)).toBe('stoerung_beheben');
		}
	});

	it('kennt jeden Alarmgrund', () => {
		for (const grund of alarmgrund.enumValues) {
			expect(empfohleneAktion(grund)).toBeDefined();
		}
	});
});
