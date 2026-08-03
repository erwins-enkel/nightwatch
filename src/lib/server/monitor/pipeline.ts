import type { Klassifikation } from '../db/schema/enums';
import type { AusgewerteteMail, MonitorStufe, MonitorTreffer } from '../zuordnung/verarbeitung';
import type { StapelMail, Tx } from '../zuordnung/db';
import { deuteMail, klassifikationFuer, nutztMusterSlots, type MonitorSicht } from './auswertung';
import { holeKlassifikator } from './klassifikator';
import {
	ladeMonitorIndex,
	schreibeWirkung,
	sperreMonitore,
	zaehlerFenster,
	type Beobachtung,
	type MonitorLaufzeit
} from './db';
import { Heuhaufen, trifftMatchKriterien } from './regel';
import { wendeAn } from './zustand';

/**
 * Stage 2 of the assignment pipeline: **Kunde → Monitor**, in the two phases `verarbeitung.ts`
 * asks for.
 *
 * `ordne` compares values only. `werteAus` runs after the batch's outcomes were written, inside the
 * same transaction — which is what lets the Zähler count its window with a query instead of a tally
 * over rows that do not exist yet.
 */

/** Built once per batch: the monitors and their compiled rules are loaded once, not per mail. */
export async function monitorStufe(tx: Tx): Promise<MonitorStufe> {
	const index = await ladeMonitorIndex(tx);
	const klassifikator = holeKlassifikator();
	/**
	 * The classifier's raw verdict per mail, carried from `ordne` to `werteAus`.
	 *
	 * The stored classification is not enough to recover it — an Ereignis stores `fehler` for both
	 * „unklar" and „fehler" — and asking the classifier twice would double the cost of the one
	 * component that is meant to become an LLM call.
	 */
	const urteile = new Map<string, Klassifikation | null>();

	return {
		ordne(mail: StapelMail, kundeId: string): MonitorTreffer | null {
			const monitore = index.get(kundeId);
			if (!monitore) return null;

			const heuhaufen = new Heuhaufen(mail);
			const treffer = monitore.find((eintrag) =>
				trifftMatchKriterien(mail, eintrag.regel, heuhaufen)
			);
			if (!treffer) return null;

			const urteil = nutztMusterSlots(treffer.art)
				? klassifikator.beurteile({ mail, regel: treffer.regel, art: treffer.art, heuhaufen })
				: null;
			urteile.set(mail.id, urteil);

			return {
				monitorId: treffer.id,
				klassifikation: klassifikationFuer(treffer.art, urteil)
			};
		},

		async werteAus(treffer: AusgewerteteMail[], jetzt: Date): Promise<void> {
			const jeMonitor = new Map<string, AusgewerteteMail[]>();
			for (const eintrag of treffer) {
				const vorhanden = jeMonitor.get(eintrag.monitorId);
				if (vorhanden) vorhanden.push(eintrag);
				else jeMonitor.set(eintrag.monitorId, [eintrag]);
			}

			const gesperrt = await sperreMonitore([...jeMonitor.keys()], tx);

			for (const [monitorId, mails] of jeMonitor) {
				const laufzeit = gesperrt.get(monitorId);
				if (!laufzeit) continue;

				// Arrival order, not claim order: „Zu" before its „Auf" would be neutral and leave the
				// pair open forever.
				const sortiert = [...mails].sort(
					(a, b) =>
						a.mail.ankunftszeit.getTime() - b.mail.ankunftszeit.getTime() ||
						a.mail.id.localeCompare(b.mail.id)
				);

				await werteMonitorAus(laufzeit, sortiert, urteile, jetzt, tx);
			}
		}
	};
}

/**
 * Whether a mail may move this monitor at all (CONTEXT „Lernfenster").
 *
 * *Historie ist Lernmaterial, nicht Überwachungsmaterial.* Both conditions are needed: a mailbox
 * connected later pulls a learning window whose mails can be **younger** than an existing monitor's
 * activation, and a backlog can deliver regular mails that predate it.
 */
function istAuswertbar(laufzeit: MonitorLaufzeit, mail: StapelMail): boolean {
	if (laufzeit.aktiviertAm === null) return false;
	if (mail.ausLernfenster) return false;
	return mail.ankunftszeit >= laufzeit.aktiviertAm;
}

async function werteMonitorAus(
	start: MonitorLaufzeit,
	mails: AusgewerteteMail[],
	urteile: Map<string, Klassifikation | null>,
	jetzt: Date,
	tx: Tx
): Promise<void> {
	let laufzeit = start;
	const fenster = await ladeFenster(start, mails, tx);

	for (const { mail } of mails) {
		if (!istAuswertbar(laufzeit, mail)) continue;

		// The ordering mark. A mail older than the last applied one keeps its assignment and its
		// classification but moves nothing: the state must never run backwards, or a late „Auf"
		// would reopen a pair that a newer „Zu" already closed.
		if (laufzeit.zuletztGesehenAm && mail.ankunftszeit < laufzeit.zuletztGesehenAm) continue;

		const sicht: MonitorSicht = {
			art: laufzeit.art,
			maxOffenzeitSekunden: laufzeit.maxOffenzeitSekunden,
			zaehlerObergrenze: laufzeit.zaehlerObergrenze,
			paarOffen: laufzeit.paarOffenSeit !== null
		};

		const wirkung = deuteMail(sicht, urteile.get(mail.id) ?? null, stand(fenster, mail, laufzeit));
		const aenderung = wendeAn(laufzeit, wirkung.wirkung, jetzt);

		const beobachtung: Beobachtung = {
			zuletztGesehenAm: mail.ankunftszeit,
			postfachId: mail.postfachId
		};

		// „Die Offenzeit läuft ab dem ersten Auf", and a Zu without an open state is neutral — in
		// both cases there is nothing to write.
		if (wirkung.paar === 'oeffnen' && laufzeit.paarOffenSeit === null) {
			beobachtung.paarOffenSeit = mail.ankunftszeit;
		} else if (wirkung.paar === 'schliessen' && laufzeit.paarOffenSeit !== null) {
			beobachtung.paarOffenSeit = null;
		}

		// The mail's arrival time is the event time, not the processing time — the same clock the
		// Ingestion-Gate judges against (SPEC §8).
		laufzeit = await schreibeWirkung(laufzeit, beobachtung, aenderung, mail.ankunftszeit, tx);
	}
}

/**
 * The Zähler's window, loaded once per monitor and batch.
 *
 * One query instead of one per mail: the window slides with every arrival, but the arrival times it
 * slides over are the same list.
 */
function ladeFenster(
	laufzeit: MonitorLaufzeit,
	mails: AusgewerteteMail[],
	tx: Tx
): Promise<Date[]> {
	const fenster = laufzeit.zaehlerFensterSekunden;
	if (laufzeit.art !== 'zaehler' || fenster === null || laufzeit.aktiviertAm === null) {
		return Promise.resolve([]);
	}

	const zeiten = mails.map((eintrag) => eintrag.mail.ankunftszeit.getTime());
	const frueheste = new Date(Math.min(...zeiten) - fenster * 1000);
	const spaeteste = new Date(Math.max(...zeiten));

	return zaehlerFenster(laufzeit.id, laufzeit.aktiviertAm, frueheste, spaeteste, tx);
}

/** How many countable mails fall into the window `(t − T, t]` that ends with this mail. */
function stand(fenster: Date[], mail: StapelMail, laufzeit: MonitorLaufzeit): number {
	if (laufzeit.zaehlerFensterSekunden === null) return 0;

	const bis = mail.ankunftszeit.getTime();
	const von = bis - laufzeit.zaehlerFensterSekunden * 1000;

	let anzahl = 0;
	for (const zeit of fenster) {
		const wert = zeit.getTime();
		if (wert > von && wert <= bis) anzahl++;
	}
	return anzahl;
}
