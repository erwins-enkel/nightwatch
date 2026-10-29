import type { Alarmgrund, MonitorZustand } from '../db/schema/enums';
import type { FehlerKlasse } from '../graph/fehler';
import type { ServiceName } from '../health';
import type { Wirkung } from '../monitor/auswertung';

/**
 * What Nightwatch observes about **itself**, turned into the same `Wirkung` the mail path and the
 * time scheduler produce (SPEC §8, CONTEXT „Selbst-Monitor").
 *
 * Pure, like `zeit/faelligkeit.ts` next to it: every fact the decision needs is handed in already
 * queried, so each rule is a table row in the test rather than a database fixture. Nothing here
 * knows the state machine — `monitor/zustand.ts` → `wendeAn()` folds these onto the current state,
 * which is what „keine zweite Logik" (SPEC §8) means in practice.
 */

/** A `Wirkung` and the moment the condition actually became true — never the tick that noticed. */
export interface SelbstWirkung {
	wirkung: Wirkung;
	/**
	 * Dates the episode. „Ingestion Postfach X überfällig seit 06:30", not „seit der Watchdog um
	 * 09:15 zurückkam" — the same discipline as `zeit/faelligkeit.ts` → `ZeitWirkung.zeitpunkt`.
	 */
	zeitpunkt: Date;
}

/** The bit of a self-monitor's state the reading depends on. */
export interface SelbstSicht {
	zustand: MonitorZustand;
	alarmgrund: Alarmgrund | null;
}

/** One live cause: what is wrong, and since when. */
interface Ursache {
	grund: Alarmgrund;
	seitAm: Date;
}

/**
 * Whether the monitor already carries exactly this reason.
 *
 * The suppression that makes a *sustained* condition edge-triggered — the same one
 * `zeit/faelligkeit.ts` applies for the same reason. „Still stale" is not an event, and reporting it
 * every tick would let `uebergang.vorkommen` count ticks instead of occurrences.
 */
function traegtSchon(sicht: SelbstSicht, grund: Alarmgrund): boolean {
	return sicht.zustand === 'gestoert' && sicht.alarmgrund === grund;
}

/**
 * Turns the live causes into at most one `Wirkung`.
 *
 * **One reason at a time, the most severe one.** Both halves of a self-monitor can be true at once —
 * a mailbox that is stale *because* its consent was revoked, a core whose services are silent *and*
 * whose delivery is dead — and reporting both would make the two grundwechsel each other on every
 * tick, inflating the occurrence count and firing a Verschärfung over and over.
 * `fehler_gemeldet` outranks `ueberfaellig`, which is what makes the escalation to it the Verschärfung
 * CONTEXT describes, and the way back down an ordinary change of reason.
 *
 * Dated on the **earliest** live cause: the disruption began when the first symptom did, whatever it
 * is being reported as. After a long standstill that is the difference between „gestört seit 06:15"
 * and an alarm that quietly understates the outage by hours.
 */
function alsWirkungen(sicht: SelbstSicht, ursachen: Ursache[], jetzt: Date): SelbstWirkung[] {
	if (ursachen.length === 0) {
		// „Ein erfolgreicher Poll ist beweisbasierte Erholung" (CONTEXT). Offered on every healthy
		// pass; `wendeAn()` turns it into `keine` when the monitor was not disturbed in the first place.
		return [{ wirkung: { art: 'erholung', erholungsArt: 'beweis' }, zeitpunkt: jetzt }];
	}

	const gemeldet = ursachen.some((ursache) => ursache.grund === 'fehler_gemeldet')
		? 'fehler_gemeldet'
		: ursachen[0].grund;
	if (traegtSchon(sicht, gemeldet)) return [];

	const seitAm = ursachen.reduce(
		(frueheste, ursache) => (ursache.seitAm < frueheste ? ursache.seitAm : frueheste),
		ursachen[0].seitAm
	);

	return [{ wirkung: { art: 'stoerung', grund: gemeldet }, zeitpunkt: seitAm }];
}

/**
 * The Graph error classes a human has to fix, as opposed to the ones that pass by themselves
 * (`graph/fehler.ts`). SPEC §8: „harte Ursachen (Consent entzogen, `AADSTS*`, 403) beschleunigen
 * nur und liefern besseren Ticket-Text."
 */
const HARTE_URSACHEN: ReadonlySet<FehlerKlasse> = new Set<FehlerKlasse>([
	'zugriff',
	'nicht_gefunden'
]);

export function istHarteUrsache(klasse: FehlerKlasse | null): boolean {
	return klasse !== null && HARTE_URSACHEN.has(klasse);
}

// ---------------------------------------------------------------------------------------------
// Postfach
// ---------------------------------------------------------------------------------------------

/** One mailbox's ingestion, as its self-monitor reads it. */
export interface PostfachBeobachtung {
	postfachId: string;
	aktiv: boolean;
	/**
	 * The mailbox's own arrival axis: its last proven poll, or — while it has never polled — the
	 * moment it was connected. Never a wall clock borrowed from somewhere else, so a mailbox that is
	 * merely slow is judged against its own history.
	 */
	letzterErfolgAm: Date;
	letzterFehlerKlasse: FehlerKlasse | null;
	letzterFehlerAm: Date | null;
}

/**
 * The mailbox self-monitor's reading (SPEC §8).
 *
 * An inactive mailbox produces nothing at all: the operator switched its ingestion off, and a
 * monitor that alarms about a mailbox nobody is polling on purpose is noise. Ending its running
 * episode silently is the caller's job — see `selbst/db.ts` → `beendeSelbstStill()`.
 */
export function postfachWirkungen(
	sicht: SelbstSicht,
	beobachtung: PostfachBeobachtung,
	stalenessSekunden: number,
	jetzt: Date
): SelbstWirkung[] {
	if (!beobachtung.aktiv) return [];

	const ursachen: Ursache[] = [];

	const faellig = new Date(beobachtung.letzterErfolgAm.getTime() + stalenessSekunden * 1000);
	if (faellig <= jetzt) ursachen.push({ grund: 'ueberfaellig', seitAm: faellig });

	// A hard cause fires without waiting the staleness window out — that is the whole „beschleunigen".
	// `vermerkeErfolg` clears the error columns, so an error that is still recorded is one no
	// successful poll has overtaken; the comparison only guards against a row that predates that rule.
	const fehlerAm = beobachtung.letzterFehlerAm;
	if (
		istHarteUrsache(beobachtung.letzterFehlerKlasse) &&
		fehlerAm !== null &&
		fehlerAm > beobachtung.letzterErfolgAm
	) {
		ursachen.push({ grund: 'fehler_gemeldet', seitAm: fehlerAm });
	}

	return alsWirkungen(sicht, ursachen, jetzt);
}

// ---------------------------------------------------------------------------------------------
// Kern
// ---------------------------------------------------------------------------------------------

/** The services whose silence means Nightwatch has stopped working (SPEC §2). */
export interface DienstBeobachtung {
	dienst: ServiceName;
	/** Null when the service has never written a heartbeat at all. */
	zuletztGesehen: Date | null;
}

export interface KernBeobachtung {
	dienste: DienstBeobachtung[];
	/**
	 * Since when alarm delivery has been demonstrably broken — the oldest dead letter that no later
	 * success on the **same** target has overtaken (`selbst/db.ts` → `zustellStoerungSeit()`).
	 * Null means every target is either delivering or has simply never been used yet.
	 */
	zustellStoerungSeit: Date | null;
	/**
	 * Since when this watchdog has been watching. A service that has never written a heartbeat is
	 * judged from here, so a fresh start does not date a disruption back to the epoch — and does not
	 * declare one before it has had a chance to observe anything either.
	 */
	beobachtetSeit: Date;
}

/**
 * The `watchdog` heartbeat is deliberately not among the services this checks: whoever evaluates it
 * is the process that writes it, so it is always fresh and says nothing. The one thing that can
 * report a dead watchdog is the outgoing Heartbeat-Ping falling silent (`selbst/ping.ts`).
 */
export const KERN_DIENSTE: readonly ServiceName[] = ['web', 'worker'];

/**
 * The core self-monitor's reading: „Verarbeitung, Datenhaltung oder Alarm-Zustellung gestört"
 * (CONTEXT). Datenhaltung is the one cause that cannot be read from the database, so it lives in the
 * watchdog's Notfall path (`selbst/notfall.ts`) instead.
 */
export function kernWirkungen(
	sicht: SelbstSicht,
	beobachtung: KernBeobachtung,
	stalenessSekunden: number,
	jetzt: Date
): SelbstWirkung[] {
	const ursachen: Ursache[] = [];

	let stilleSeit: Date | null = null;
	// Iterating the **expected** services rather than the observed ones is what makes a missing row
	// count. A worker that never started at all writes no heartbeat, so it would otherwise be the one
	// dead service nobody notices — exactly the blind spot this monitor exists to close.
	for (const name of KERN_DIENSTE) {
		const gesehen =
			beobachtung.dienste.find((dienst) => dienst.dienst === name)?.zuletztGesehen ??
			beobachtung.beobachtetSeit;

		const faellig = new Date(gesehen.getTime() + stalenessSekunden * 1000);
		if (faellig > jetzt) continue;
		// The longest silence dates the episode: if both services stopped, the disruption began with
		// the first of them, not with the one that happened to be read last.
		if (stilleSeit === null || faellig < stilleSeit) stilleSeit = faellig;
	}

	if (stilleSeit !== null) ursachen.push({ grund: 'ueberfaellig', seitAm: stilleSeit });

	if (beobachtung.zustellStoerungSeit !== null) {
		ursachen.push({ grund: 'fehler_gemeldet', seitAm: beobachtung.zustellStoerungSeit });
	}

	return alsWirkungen(sicht, ursachen, jetzt);
}
