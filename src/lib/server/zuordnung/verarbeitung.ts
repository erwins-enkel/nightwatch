import { getDb } from '../db/client';
import type { Klassifikation } from '../db/schema/enums';
import { bestimmeKunde, type MerkmalZeile } from './engine';
import { betreffMuster, sortenSignatur } from './sorte';
import {
	claimUnverarbeitete,
	ladeMerkmalIndex,
	schreibeErgebnisse,
	sortenSchluessel,
	upsertSorten,
	type MailErgebnis,
	type SortenGruppe,
	type StapelMail,
	type Tx
} from './db';

/**
 * One batch of the assignment pipeline: claim, decide, write — all inside one transaction.
 *
 * The transaction is not decoration. `claimUnverarbeitete` leases its rows with
 * `FOR UPDATE SKIP LOCKED`, so the lock has to survive until the outcomes are written; and a batch
 * that dies halfway must leave *nothing* behind, or a mail would be counted into its `mail_sorte`
 * without ever being marked processed and would be counted again on the next tick.
 */

/** Mails per batch. Small enough that the bodies of one batch comfortably fit in memory. */
export const STAPEL_GROESSE = 100;

/** What stage 2 decided about one mail: which monitor claims it, and how its rule reads it. */
export interface MonitorTreffer {
	monitorId: string;
	klassifikation: Klassifikation | null;
}

/** A mail that found its monitor, handed to the evaluation once the batch is written. */
export interface AusgewerteteMail extends MonitorTreffer {
	mail: StapelMail;
}

/**
 * Stage 2 of the pipeline — **Kunde → Monitor** (#25) — in two phases.
 *
 * `ordne` runs while the batch is being decided and only compares values: only the monitors of the
 * recognised customer are eligible (CONTEXT „Match-Kriterien": they act *after* the customer
 * assignment), and `null` means "none does", which is what makes triage reason ③ observable.
 *
 * `werteAus` runs **after** the outcomes were written, inside the same transaction. That order is
 * what the Zähler needs: its window counts the monitor's mails, including the ones this batch just
 * assigned, so the count is a query rather than a tally over rows that do not exist yet.
 */
export interface MonitorStufe {
	ordne(mail: StapelMail, kundeId: string): MonitorTreffer | null;
	werteAus(treffer: AusgewerteteMail[], jetzt: Date): Promise<void>;
}

/**
 * Built once per batch, so the monitors and their compiled rules are loaded once — the number of
 * monitors follows the configuration, the number of mails does not.
 */
export type MonitorStufeFabrik = (tx: Tx) => Promise<MonitorStufe>;

/** The default for callers that only want the customer stage (and for the tests of it). */
export const ohneMonitore: MonitorStufeFabrik = () =>
	Promise.resolve({
		ordne: () => null,
		werteAus: () => Promise.resolve()
	});

export interface StapelOptionen {
	jetzt?: Date;
	groesse?: number;
	monitorStufe?: MonitorStufeFabrik;
	db?: ReturnType<typeof getDb>;
}

/**
 * Runs one batch and reports how many mails it processed.
 *
 * A count below `groesse` means the backlog is (as far as this worker can see) drained — the
 * scheduler uses that to stop looping.
 */
export async function verarbeiteStapel(optionen: StapelOptionen = {}): Promise<number> {
	const db = optionen.db ?? getDb();
	const jetzt = optionen.jetzt ?? new Date();
	const groesse = optionen.groesse ?? STAPEL_GROESSE;
	const monitorStufe = optionen.monitorStufe ?? ohneMonitore;

	return db.transaction(async (tx) => {
		const mails = await claimUnverarbeitete(groesse, tx);
		if (mails.length === 0) return 0;

		const index = await ladeMerkmalIndex(tx);
		const stufe = await monitorStufe(tx);
		const ergebnisse: MailErgebnis[] = [];
		const sorten = new Map<string, SortenGruppe>();
		const ausgewertet: AusgewerteteMail[] = [];

		for (const mail of mails) {
			const ergebnis = bestimmeKunde(mail, index);

			if (ergebnis.art === 'kein_kunde') {
				ergebnisse.push(leer(mail.id, 'kein_kunde'));
				continue;
			}

			if (ergebnis.art === 'mehrdeutig') {
				// No trait is recorded: naming one of several claimants as "the reason" would suggest a
				// decision that was deliberately not taken. The candidates are recomputed for display.
				ergebnisse.push(leer(mail.id, 'mehrdeutig'));
				continue;
			}

			const merkmal = ergebnis.merkmal;

			if (merkmal.kundeArchiviert) {
				// „stille Ablage" (CONTEXT „Archiviert"): the customer and the reason are recorded so the
				// mail stays explainable, but nothing downstream happens — no monitor stage, no triage
				// entry, and no Sorte, because an archived customer needs no new monitors.
				ergebnisse.push(zugeordnet(mail.id, merkmal, null, null, null, null));
				continue;
			}

			const treffer = stufe.ordne(mail, merkmal.kundeId);
			if (treffer !== null) {
				ergebnisse.push(
					zugeordnet(mail.id, merkmal, treffer.monitorId, null, null, treffer.klassifikation)
				);
				ausgewertet.push({ ...treffer, mail });
				continue;
			}

			const schluessel = zaehleSorte(sorten, mail, merkmal.kundeId);
			ergebnisse.push(zugeordnet(mail.id, merkmal, null, schluessel, 'kein_monitor', null));
		}

		const sorteIds = await upsertSorten([...sorten.values()], tx);
		await schreibeErgebnisse(
			ergebnisse.map((ergebnis) => ({
				...ergebnis,
				sorteId: ergebnis.sorteId === null ? null : (sorteIds.get(ergebnis.sorteId) ?? null)
			})),
			jetzt,
			tx
		);

		// After the write, so the Zähler's window sees this batch's mails as rows.
		if (ausgewertet.length > 0) await stufe.werteAus(ausgewertet, jetzt);

		return mails.length;
	});
}

function leer(mailId: string, triageGrund: MailErgebnis['triageGrund']): MailErgebnis {
	return {
		mailId,
		kundeId: null,
		merkmalId: null,
		monitorId: null,
		sorteId: null,
		triageGrund,
		klassifikation: null
	};
}

function zugeordnet(
	mailId: string,
	merkmal: MerkmalZeile,
	monitorId: string | null,
	/** Carries the Sorten key until `upsertSorten` has turned it into a row id. */
	sorteId: string | null,
	triageGrund: MailErgebnis['triageGrund'],
	klassifikation: MailErgebnis['klassifikation']
): MailErgebnis {
	return {
		mailId,
		kundeId: merkmal.kundeId,
		merkmalId: merkmal.id,
		monitorId,
		sorteId,
		triageGrund,
		klassifikation
	};
}

/**
 * Adds one mail to its Sorte's tally for this batch.
 *
 * Aggregated in memory first: several mails of one batch usually share a signature, and a single
 * `INSERT … ON CONFLICT` may not touch the same conflicting row twice.
 */
function zaehleSorte(sorten: Map<string, SortenGruppe>, mail: StapelMail, kundeId: string): string {
	const muster = betreffMuster(mail.betreff);
	const signatur = sortenSignatur(mail.absender, muster);
	const schluessel = sortenSchluessel(kundeId, signatur);
	const vorhanden = sorten.get(schluessel);

	if (!vorhanden) {
		sorten.set(schluessel, {
			kundeId,
			signatur,
			absender: mail.absender,
			betreffMuster: muster,
			anzahl: 1,
			ersterEingang: mail.ankunftszeit,
			letzterEingang: mail.ankunftszeit
		});
		return schluessel;
	}

	vorhanden.anzahl += 1;
	// The batch is claimed oldest first, but a re-queued mail can arrive out of order.
	if (mail.ankunftszeit < vorhanden.ersterEingang) vorhanden.ersterEingang = mail.ankunftszeit;
	if (mail.ankunftszeit > vorhanden.letzterEingang) vorhanden.letzterEingang = mail.ankunftszeit;

	return schluessel;
}
