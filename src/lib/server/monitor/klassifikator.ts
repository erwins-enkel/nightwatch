import type { Klassifikation, MonitorArt } from '../db/schema/enums';
import { slotTreffer, type Heuhaufen, type KompilierteRegel, type RegelMail } from './regel';

/**
 * The Klassifikator (CONTEXT): the exchangeable engine that judges an assigned mail as
 * OK / Fehler / Unklar.
 *
 * v1 is pattern based. The seam exists because CONTEXT names the successor explicitly — intelligent
 * extraction from unstructured report mails, a local model or an LLM the operator connects himself.
 * Two properties of this seam are load bearing:
 *
 * - It is asked at **runtime**, once per incoming mail, never when a rule is created. A smarter
 *   engine lowers the Unklar rate of mails as they arrive; it does not propose patterns in the
 *   wizard (CONTEXT „Klassifikator").
 * - It answers with the three-valued verdict and nothing else. What a verdict *means* is the
 *   Monitor-Art's reading of the two pattern slots (`auswertung.ts`), so a new engine never has to
 *   know that a `fehler` means „Auf" to a Paar monitor.
 */

export interface KlassifikationsAuftrag {
	mail: RegelMail;
	regel: KompilierteRegel;
	/** The kind is part of the question: „is this a failure report?" reads differently per kind. */
	art: MonitorArt;
	/** Memoised views of the mail. The pattern engine uses them, a smarter one may ignore them. */
	heuhaufen: Heuhaufen;
}

export interface Klassifikator {
	/** Recorded in logs so an operator can tell which engine judged their mails. */
	readonly name: string;
	beurteile(auftrag: KlassifikationsAuftrag): Klassifikation;
}

/**
 * v1: the two pattern slots decide.
 *
 * **Fehler hat Vorrang** (CONTEXT „Klassifikation"): a mail that hits both slots is a failure. Rules
 * are hand-written and mails are noisy, so the overlap is a question of when, not whether — and the
 * expensive mistake is the one where a failure passes as OK.
 */
export const musterKlassifikator: Klassifikator = {
	name: 'muster',
	beurteile({ mail, regel, heuhaufen }): Klassifikation {
		const treffer = slotTreffer(mail, regel, heuhaufen);
		if (treffer.schlecht) return 'fehler';
		if (treffer.gut) return 'ok';
		return 'unklar';
	}
};

let aktiv: Klassifikator = musterKlassifikator;

export function holeKlassifikator(): Klassifikator {
	return aktiv;
}

/**
 * Puts another engine in the slot. The one call site for a later local model or LLM adapter — and
 * what lets a test assert that the pipeline really asks the classifier per mail.
 */
export function setzeKlassifikator(klassifikator: Klassifikator): void {
	aktiv = klassifikator;
}
