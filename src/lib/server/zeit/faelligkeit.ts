import type { Alarmgrund, ErwartungModus, MonitorArt } from '../db/schema/enums';
import type { Wirkung } from '../monitor/auswertung';
import type { ZustandsSicht } from '../monitor/zustand';

/**
 * The Monitor-Art's reading of **time passing** — the other half of the Dreiklang-Vertrag, next to
 * `monitor/auswertung.ts`, which reads an arriving mail.
 *
 * Pure, like its sibling: every input the decision needs is handed in already computed, so each
 * edge CONTEXT names is a table row in the test rather than a database fixture.
 *
 * Note what this function does **not** take: a `jetzt`. Every comparison is against `bewertbarBis`,
 * the point up to which ingestion and assignment have provably caught up. Judging against the wall
 * clock instead would alarm on mail that is merely still in flight, and the signature is what keeps
 * that from creeping back in.
 */

/** What a time condition wants to do, and when it actually became true. */
export interface ZeitWirkung {
	wirkung: Wirkung;
	/**
	 * The moment the condition came about — a deadline, not the tick that noticed it.
	 *
	 * This is what dates the episode. After a standstill an alarm has to say „overdue since 06:30",
	 * not „overdue since the worker came back at 09:15".
	 */
	zeitpunkt: Date;
}

/** The monitor's state and time parameters, as the evaluation reads them. */
export interface ZeitSicht extends ZustandsSicht {
	art: MonitorArt;
	aktiviertAm: Date;
	zuletztGesehenAm: Date | null;
	paarOffenSeit: Date | null;
	erwartungModus: ErwartungModus | null;
	erwartungIntervallSekunden: number | null;
	karenzSekunden: number | null;
	autoZurueckSekunden: number | null;
	maxOffenzeitSekunden: number | null;
	zaehlerUntergrenze: number | null;
	zaehlerObergrenze: number | null;
	/** `letztes_vorkommen_am` of the open episode — what Auto-Zurück counts from. */
	letztesVorkommenAm: Date | null;
}

/** The facts the caller had to query for, so the decision itself stays a comparison. */
export interface ZeitKontext {
	/**
	 * Kalenderplan: the deadlines (`Soll + Karenz`) of the Solls judged in this tick and found
	 * uncovered. One entry is one missed Soll, so a catch-up counts one occurrence each.
	 */
	unabgedeckt: Date[];
	/** Zähler: countable mails in the window ending at `bewertbarBis`. */
	zaehlerStand: number;
	/** Zähler: whether a full window has passed since activation or the last Ausnahmetag. */
	anlaufVorbei: boolean;
	/** Whether the day `bewertbarBis` falls on is an Ausnahmetag of this monitor. */
	ausnahmetag: boolean;
	/** Ingestion-Gate: may absence-based bad decisions be taken at all? */
	gateOffen: boolean;
}

function stoerung(grund: Alarmgrund): Wirkung {
	return { art: 'stoerung', grund };
}

/**
 * Whether the monitor is already disturbed for exactly this reason.
 *
 * The suppression that makes a *sustained* condition edge-triggered. „Still overdue" is not an
 * event, and reporting it every tick would let `uebergang.vorkommen` count ticks rather than
 * occurrences. The Kalenderplan is the deliberate exception: its cursor judges each Soll exactly
 * once, so a second missed Soll really is a second occurrence.
 */
function traegtSchon(sicht: ZeitSicht, grund: Alarmgrund): boolean {
	return sicht.zustand === 'gestoert' && sicht.alarmgrund === grund;
}

/**
 * „Ein Monitor wertet ausschließlich ab seiner Aktivierung vorwärts" (CONTEXT „Lernfenster").
 *
 * Re-activating stamps `aktiviert_am` anew without clearing `zuletzt_gesehen_am`, so the older of
 * the two would otherwise make a monitor overdue the instant it is switched back on — for a gap
 * that happened while it was off, and that is not its.
 */
function laufendSeit(sicht: ZeitSicht): Date {
	const gesehen = sicht.zuletztGesehenAm;
	return gesehen && gesehen > sicht.aktiviertAm ? gesehen : sicht.aktiviertAm;
}

function heartbeat(sicht: ZeitSicht, kontext: ZeitKontext, bewertbarBis: Date): ZeitWirkung[] {
	if (!kontext.gateOffen) return [];

	if (sicht.erwartungModus === 'kalenderplan') {
		return kontext.unabgedeckt.map((zeitpunkt) => ({
			wirkung: stoerung('ueberfaellig'),
			zeitpunkt
		}));
	}

	const intervall = sicht.erwartungIntervallSekunden;
	const karenz = sicht.karenzSekunden;
	if (intervall === null || karenz === null) return [];
	if (traegtSchon(sicht, 'ueberfaellig')) return [];

	// „Die Uhr startet bei jeder eingetroffenen Mail neu" (CONTEXT „Intervall").
	const faellig = new Date(laufendSeit(sicht).getTime() + (intervall + karenz) * 1000);
	return faellig <= bewertbarBis ? [{ wirkung: stoerung('ueberfaellig'), zeitpunkt: faellig }] : [];
}

/**
 * „Schlecht, wenn länger offen als die maximale Offenzeit" (CONTEXT „Paar-Monitor").
 *
 * With the default of 0 the Auf mail itself already alarmed (#25), so `traegtSchon` finds the
 * episode and this stays quiet. What is left for the scheduler are the configured run times — and
 * the catch-up after a restart, where the deadline passed while nobody was looking.
 */
function paar(sicht: ZeitSicht, kontext: ZeitKontext, bewertbarBis: Date): ZeitWirkung[] {
	const offenSeit = sicht.paarOffenSeit;
	const offenzeit = sicht.maxOffenzeitSekunden;
	if (offenSeit === null || offenzeit === null) return [];
	if (!kontext.gateOffen || traegtSchon(sicht, 'paar_zu_lange_offen')) return [];

	// „Die Offenzeit läuft ab dem ersten Auf" — `paar_offen_seit` already is that first one.
	const faellig = new Date(offenSeit.getTime() + offenzeit * 1000);
	return faellig <= bewertbarBis
		? [{ wirkung: stoerung('paar_zu_lange_offen'), zeitpunkt: faellig }]
		: [];
}

/**
 * The counter's time-driven half: falling below the lower bound as mails age out, and returning
 * into the band from either side.
 *
 * Bursting the **upper** bound is the mail's job (#25) — no passage of time can raise a count.
 * Recovery is the scheduler's for both bounds: above, the mails have to age out; below, the count
 * only becomes visible when someone looks.
 */
function zaehler(sicht: ZeitSicht, kontext: ZeitKontext, bewertbarBis: Date): ZeitWirkung[] {
	const unten = sicht.zaehlerUntergrenze;
	const oben = sicht.zaehlerObergrenze;
	const stand = kontext.zaehlerStand;

	const imBand = (unten === null || stand >= unten) && (oben === null || stand <= oben);
	const zaehlerGestoert =
		sicht.zustand === 'gestoert' &&
		(sicht.alarmgrund === 'zaehler_unter_untergrenze' ||
			sicht.alarmgrund === 'zaehler_ueber_obergrenze');

	/**
	 * „Erholt beweisbasiert, wenn der Zähler wieder im Band liegt" (CONTEXT „Zähl-Monitor") — the
	 * count is the evidence, whichever bound was breached. Deliberately not gated by the
	 * Ausnahmetag: exception days suspend the way *into* Gestört, never the way out, exactly as
	 * `Pausiert` does.
	 */
	if (zaehlerGestoert && imBand) {
		return [{ wirkung: { art: 'erholung' }, zeitpunkt: bewertbarBis }];
	}

	if (unten === null || stand >= unten) return [];
	// „Die Untergrenze wird nicht gewertet" (CONTEXT „Ausnahmetag") — „normal 100/Tag, am Feiertag 0"
	// darf nicht alarmieren. Die Obergrenze bleibt scharf, die entscheidet aber der Mail-Pfad.
	if (kontext.ausnahmetag || !kontext.anlaufVorbei) return [];
	if (!kontext.gateOffen || traegtSchon(sicht, 'zaehler_unter_untergrenze')) return [];

	return [{ wirkung: stoerung('zaehler_unter_untergrenze'), zeitpunkt: bewertbarBis }];
}

/**
 * Auto-Zurück (CONTEXT): „bleibt ein neues Vorkommen für eine eingestellte Zeit aus, kehrt er von
 * selbst nach gesund zurück".
 *
 * Not gated by the Ingestion-Gate: a suspended ingestion must not hold a monitor artificially
 * disturbed, and a recovery creates no false customer ticket. It carries `auto_zurueck`, not
 * `beweis` — „ein nach Zeitablauf stillgelegtes Ereignis-Ticket darf nicht ungelesen zugehen".
 */
function ereignis(sicht: ZeitSicht, bewertbarBis: Date): ZeitWirkung[] {
	const seit = sicht.letztesVorkommenAm;
	const autoZurueck = sicht.autoZurueckSekunden;
	if (sicht.zustand !== 'gestoert' || seit === null || autoZurueck === null) return [];

	const faellig = new Date(seit.getTime() + autoZurueck * 1000);
	return faellig <= bewertbarBis
		? [{ wirkung: { art: 'erholung', erholungsArt: 'auto_zurueck' }, zeitpunkt: faellig }]
		: [];
}

export function zeitWirkungen(
	sicht: ZeitSicht,
	kontext: ZeitKontext,
	bewertbarBis: Date
): ZeitWirkung[] {
	switch (sicht.art) {
		case 'heartbeat':
			return heartbeat(sicht, kontext, bewertbarBis);
		case 'paar':
			return paar(sicht, kontext, bewertbarBis);
		case 'zaehler':
			return zaehler(sicht, kontext, bewertbarBis);
		case 'ereignis':
			return ereignis(sicht, bewertbarBis);
	}
}
