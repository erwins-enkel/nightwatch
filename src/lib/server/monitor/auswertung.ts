import type { Alarmgrund, ErholungsArt, Klassifikation, MonitorArt } from '../db/schema/enums';

/**
 * The Monitor-Art's reading of one matching mail (CONTEXT „Dreiklang-Vertrag", „Muster-Slots").
 *
 * One structure, four readings: the rule carries a bad and a good slot, and each kind interprets
 * them its own way — Heartbeat Fehler/OK, Ereignis —/Harmlos-Filter, Paar Auf/Zu, Zähler unused.
 * This module is that translation table and nothing else; it is pure, so every edge CONTEXT names
 * is assertable without a database.
 */

/** What a mail wants to do to the state. The state machine decides what actually happens. */
export type Wirkung =
	| { art: 'keine' }
	| { art: 'stoerung'; grund: Alarmgrund }
	/**
	 * Defaults to `beweis` — every recovery a *mail* causes is evidence based by definition
	 * (CONTEXT „Beweisbasierte Erholung"). The time scheduler (#26) is the one caller that says
	 * otherwise: Auto-Zurück recovers on a timer, and only `beweis` may close a ticket (#27).
	 */
	| { art: 'erholung'; erholungsArt?: ErholungsArt };

export interface MailWirkung {
	/** What is recorded on the mail row; `null` for the Zähler, whose slots are unused. */
	klassifikation: Klassifikation | null;
	wirkung: Wirkung;
	/** Paar bookkeeping, independent of whether the state moves. */
	paar: 'oeffnen' | 'schliessen' | null;
}

/** The monitor's parameters and the bit of its state the reading depends on. */
export interface MonitorSicht {
	art: MonitorArt;
	maxOffenzeitSekunden: number | null;
	zaehlerObergrenze: number | null;
	/** Whether a Paar monitor currently carries its one open state. */
	paarOffen: boolean;
}

/**
 * Whether this kind asks the classifier at all.
 *
 * „Die Muster-Slots sind bei dieser Art ungenutzt" (CONTEXT „Zähl-Monitor") — and asking anyway
 * would not merely be pointless: with an LLM in the slot it would be an expensive call per mail
 * whose answer nothing reads.
 */
export function nutztMusterSlots(art: MonitorArt): boolean {
	return art !== 'zaehler';
}

const KEINE: Wirkung = { art: 'keine' };

/**
 * What is recorded on the mail row, from the kind and the classifier's raw verdict.
 *
 * Its own function because the assignment writes the classification with the rest of the outcome,
 * while the state effect is decided later, under the monitor's lock — and the two must not drift
 * into two different readings of the same mail.
 */
export function klassifikationFuer(
	art: MonitorArt,
	urteil: Klassifikation | null
): Klassifikation | null {
	switch (art) {
		case 'zaehler':
			return null;
		// The event *is* the arrival, and there is no bad pattern that could have been missed — so a
		// non-harmless mail is a failure, not the „unklar" the raw verdict would report.
		case 'ereignis':
			return urteil === 'ok' ? 'ok' : 'fehler';
		default:
			return urteil;
	}
}

/**
 * Translates one matching mail into its effect.
 *
 * `urteil` is the classifier's raw verdict (`null` for the Zähler), `zaehlerStand` the number of
 * evaluable mails in the window that ends with this mail — the caller counts, this decides.
 */
export function deuteMail(
	monitor: MonitorSicht,
	urteil: Klassifikation | null,
	zaehlerStand = 0
): MailWirkung {
	const klassifikation = klassifikationFuer(monitor.art, urteil);

	switch (monitor.art) {
		/**
		 * Punctuality and content are two dimensions: *every* matching mail satisfies the Erwartung
		 * (the caller records that), the classification decides the state on its own.
		 */
		case 'heartbeat':
			switch (urteil) {
				case 'fehler':
					return { klassifikation, wirkung: stoerung('fehler_gemeldet'), paar: null };
				case 'ok':
					return { klassifikation, wirkung: { art: 'erholung' }, paar: null };
				default:
					return { klassifikation, wirkung: stoerung('unklar'), paar: null };
			}

		/**
		 * „Die Ankunft selbst ist das Ereignis, ein Fehler-Muster braucht diese Art nicht." The good
		 * slot is the Harmlos-Filter: it takes a mail out of triggering, but it does **not** recover —
		 * it is no counterpart, and if there were one this would be a Paar monitor.
		 *
		 * A non-harmless mail is therefore stored as `fehler`, not as the `unklar` the raw verdict
		 * would say: there is no bad pattern to miss, so nothing here is unclear.
		 */
		case 'ereignis':
			return urteil === 'ok'
				? { klassifikation, wirkung: KEINE, paar: null }
				: { klassifikation, wirkung: stoerung('ereignis_eingetroffen'), paar: null };

		/**
		 * Auf opens the one open state, Zu closes it — the evidence-based recovery. Two edges from
		 * CONTEXT: a Zu without an open state is **neutral** (no alarm, no Unklar, only "last seen"),
		 * and a matching mail that hits neither slot is Unklar like anywhere else.
		 *
		 * With the default max open time of 0 the Auf mail itself is the alarm; with a longer one the
		 * scheduler (#26) fires when the time is up.
		 */
		case 'paar':
			switch (urteil) {
				case 'fehler':
					return {
						klassifikation,
						wirkung: monitor.maxOffenzeitSekunden === 0 ? stoerung('paar_zu_lange_offen') : KEINE,
						paar: 'oeffnen'
					};
				case 'ok':
					return {
						klassifikation,
						wirkung: monitor.paarOffen ? { art: 'erholung' } : KEINE,
						paar: 'schliessen'
					};
				default:
					return { klassifikation, wirkung: stoerung('unklar'), paar: null };
			}

		/**
		 * „Feuert sofort mit der Mail, die sie reißt." The lower bound is the scheduler's (#26): it
		 * needs mails to *age out* of the window, which no arriving mail can cause.
		 */
		case 'zaehler': {
			const obergrenze = monitor.zaehlerObergrenze;
			const gerissen = obergrenze !== null && zaehlerStand > obergrenze;
			return {
				klassifikation,
				wirkung: gerissen ? stoerung('zaehler_ueber_obergrenze') : KEINE,
				paar: null
			};
		}
	}
}

function stoerung(grund: Alarmgrund): Wirkung {
	return { art: 'stoerung', grund };
}
