import type { Alarmgrund, MonitorZustand } from '../db/schema/enums';
import type { Wirkung } from './auswertung';

/**
 * The state machine (CONTEXT „Zustandsmaschine"): two core states, `Gesund ⇄ Gestört`, plus the
 * orthogonal `Pausiert` overlay. „Alarmiert" and „erholt" are transitions, not states.
 *
 * Pure on purpose — this is where the rules that must never drift live, and they are asserted
 * without a database. Writing the result is `db.ts`, sending it is #27.
 */

/** The parts of a monitor the machine reads. */
export interface ZustandsSicht {
	zustand: MonitorZustand;
	alarmgrund: Alarmgrund | null;
	pausiert: boolean;
	pausiertBis: Date | null;
}

export type Zustandsaenderung =
	| { art: 'keine' }
	/** Gesund → Gestört: opens an episode. */
	| { art: 'eroeffnen'; grund: Alarmgrund }
	/** Gestört, same reason: counted internally, the summary goes out with the Entwarnung. */
	| { art: 'vorkommen' }
	/** Gestört, the reason changed. Only the switch *to* „Fehler gemeldet" is a Verschärfung. */
	| { art: 'grundwechsel'; grund: Alarmgrund; verschaerfung: boolean }
	/** Gestört → Gesund, evidence based. `entwarnt_am` stays untouched — that is #27. */
	| { art: 'beenden' };

/**
 * Whether the pause is currently in effect.
 *
 * Derived rather than materialised: an auto-ending pause would otherwise need a timer whose only job
 * is to flip a boolean, and until it ran the column would lie.
 */
export function istPausiert(sicht: ZustandsSicht, jetzt: Date): boolean {
	if (!sicht.pausiert) return false;
	return sicht.pausiertBis === null || sicht.pausiertBis > jetzt;
}

/**
 * Applies one mail's effect to the state.
 *
 * `Pausiert` suppresses the way **into** Gestört and nothing else (CONTEXT: „Während Pausiert feuert
 * keine Schlecht-Bedingung und kein Alarm"). Recovery still lands: a monitor that was already
 * disturbed when maintenance began must not stay disturbed because it healed at the wrong moment.
 */
export function wendeAn(sicht: ZustandsSicht, wirkung: Wirkung, jetzt: Date): Zustandsaenderung {
	switch (wirkung.art) {
		case 'keine':
			return { art: 'keine' };

		case 'stoerung': {
			if (istPausiert(sicht, jetzt)) return { art: 'keine' };
			if (sicht.zustand === 'gesund') return { art: 'eroeffnen', grund: wirkung.grund };
			if (sicht.alarmgrund === wirkung.grund) return { art: 'vorkommen' };
			return {
				art: 'grundwechsel',
				grund: wirkung.grund,
				// CONTEXT „Verschärfung" is by definition *the* switch to „Fehler gemeldet"; every other
				// change of reason (e.g. „nach Fehlermails verstummt") is only counted internally.
				verschaerfung: wirkung.grund === 'fehler_gemeldet'
			};
		}

		case 'erholung':
			return sicht.zustand === 'gestoert' ? { art: 'beenden' } : { art: 'keine' };
	}
}

/**
 * What the operator is supposed to do about an alarm (CONTEXT „Unklar").
 *
 * `unklar` is the one reason that points at the *rule* rather than at the fault — „Verhindert, dass
 * neue, unbekannte Fehlertexte still als OK durchrutschen". It lives next to the reason instead of
 * in a UI so that the ticket text (#27) and the board (#31) read the same source.
 *
 * Exhaustive on purpose: a new Alarmgrund has to decide here rather than silently inherit
 * „Störung beheben".
 */
export type EmpfohleneAktion = 'regel_ueberarbeiten' | 'stoerung_beheben';

export function empfohleneAktion(grund: Alarmgrund): EmpfohleneAktion {
	switch (grund) {
		case 'unklar':
			return 'regel_ueberarbeiten';
		case 'ueberfaellig':
		case 'fehler_gemeldet':
		case 'ereignis_eingetroffen':
		case 'paar_zu_lange_offen':
		case 'zaehler_ueber_obergrenze':
		case 'zaehler_unter_untergrenze':
			return 'stoerung_beheben';
	}
}
