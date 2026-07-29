import type { AlarmEreignis, ErholungsArt } from '../db/schema/enums';

/**
 * The alarm lifecycle as comparisons: Entwarnungs-Stabilität, ticket semantics and the occurrence
 * summary (CONTEXT „Alarm-Lebenszyklus").
 *
 * Pure like `monitor/zustand.ts` and `zeit/faelligkeit.ts` — this is where the rules that must
 * never drift live, and they are asserted without a database. Reading and writing rows is `db.ts`,
 * handing the result to the Alarmwege is `scheduler.ts`.
 */

/**
 * Last-resort default for the stability window, in seconds.
 *
 * The real default is `einstellungen.entwarnungs_stabilitaet_sekunden` (same value, `NOT NULL`).
 * This constant only closes the impossible case of a missing settings row, so a monitor whose
 * instance configuration vanished damps flutter rather than announcing every flap.
 */
export const STABILITAET_FALLBACK_SEKUNDEN = 900;

/**
 * The instant a recovery has held long enough to be announced.
 *
 * One function for both halves of the rule below, so „hielt die Erholung?" and „ist die Entwarnung
 * fällig?" can never answer against different arithmetic.
 */
export function stabilitaetEndeAm(beendetAm: Date, stabilitaetSekunden: number): Date {
	return new Date(beendetAm.getTime() + stabilitaetSekunden * 1000);
}

/**
 * Whether the recovery that ended an episode survived its stability window (CONTEXT
 * „Entwarnungs-Stabilität").
 *
 * Only a re-alarm **inside** the window voids the all-clear: the disruption never really stopped,
 * and announcing an Entwarnung just to alarm again seconds later is the ticket series the window
 * exists to prevent. A re-alarm *after* the window is a new disruption on top of a recovery that
 * did hold — that Entwarnung is owed and goes out, however late the publisher gets to it.
 *
 * Both timestamps are **event times** (mail arrival, deadline), never processing times, so a
 * backlog cannot turn a held recovery into a flapping one.
 */
export function erholungHielt(
	beendetAm: Date,
	stabilitaetSekunden: number,
	neueStoerungAm: Date
): boolean {
	return neueStoerungAm >= stabilitaetEndeAm(beendetAm, stabilitaetSekunden);
}

/**
 * Whether the Entwarnung may go out now.
 *
 * `bewertbarBis` is the Bewertungs-Schranke (#26), not the wall clock — deliberately. „No re-alarm
 * came" is a judgement about an *absence*, and while a backlog is draining, the mail that breaks
 * the monitor again may still be in the queue. Judged against the wall clock, the all-clear would
 * fire too early in exactly the situation Nightwatch is most likely to be in: the restart after a
 * standstill.
 */
export function entwarnungFaellig(
	beendetAm: Date,
	stabilitaetSekunden: number,
	bewertbarBis: Date
): boolean {
	return stabilitaetEndeAm(beendetAm, stabilitaetSekunden) <= bewertbarBis;
}

/**
 * What an event asks the ticket channel to do (SPEC §6, CONTEXT „Beweisbasierte Erholung").
 *
 * The lifecycle decides the **semantics**, the adapter the **state**: `eroeffnen` means „make sure
 * an open ticket exists for this monitor" — comment the open one, otherwise create a new one with
 * the predecessor reference. Whether a ticket is untouched enough to be closed (Anlage-Status, no
 * assignee) only Autotask can say, so `schliessen` is a permission, not an instruction.
 */
export type TicketWeisung = 'eroeffnen' | 'kommentieren' | 'schliessen';

export function weisungFuer(
	ereignis: AlarmEreignis,
	erholungsArt: ErholungsArt | null
): TicketWeisung {
	switch (ereignis) {
		case 'alarm':
			return 'eroeffnen';
		case 'verschaerfung':
			return 'kommentieren';
		case 'entwarnung':
			// „Nur beweisbasierte Erholung darf ein Ticket automatisch schließen; alles andere
			// kommentiert nur" — ein nach Zeitablauf stillgelegtes Ereignis-Ticket darf nicht
			// ungelesen zugehen (CONTEXT).
			return erholungsArt === 'beweis' ? 'schliessen' : 'kommentieren';
	}
}

/** The episode's internal tally, as it goes out with an event (SPEC §6). */
export interface VorkommensZusammenfassung {
	vorkommen: number;
	ersteAm: Date;
	letzteAm: Date;
	verschaerftAm: Date | null;
	/** Null while the disruption is still running. */
	stoerungsdauerSekunden: number | null;
}

export interface EpisodenTally {
	begonnenAm: Date;
	letztesVorkommenAm: Date;
	vorkommen: number;
	verschaerftAm: Date | null;
	beendetAm: Date | null;
}

/**
 * „Kommentiert ein Ticket immer — mit Anlass, Störungsdauer und Vorkommens-Zusammenfassung"
 * (CONTEXT „Entwarnung"). Every occurrence beyond the first was only counted internally, so this
 * is the one place where the count leaves the instance.
 */
export function zusammenfassung(episode: EpisodenTally): VorkommensZusammenfassung {
	return {
		vorkommen: episode.vorkommen,
		ersteAm: episode.begonnenAm,
		letzteAm: episode.letztesVorkommenAm,
		verschaerftAm: episode.verschaerftAm,
		stoerungsdauerSekunden: episode.beendetAm
			? Math.round((episode.beendetAm.getTime() - episode.begonnenAm.getTime()) / 1000)
			: null
	};
}
