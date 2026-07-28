/**
 * The Ingestion-Gate's seam (CONTEXT „Ingestion-Gate", SPEC §8).
 *
 * The gate suspends — never discards — the decisions that rest on a mail's *absence*, for as long
 * as the ingestion is demonstrably broken. Deciding *when* that is belongs to the self-monitors
 * (#30), which is why only the question lives here and not the answer.
 *
 * The safe default is already in place without #30: the Bewertungs-Schranke in `db.ts` refuses to
 * judge past the point ingestion has provably reached, so a broken mailbox stops the evaluation on
 * its own. What #30 adds on top is precision — narrowing the suspension to the affected mailbox
 * instead of stopping everything, and tying it to the self-monitor's state rather than to raw
 * timestamps.
 */
export interface Gate {
	/**
	 * Whether absence-based bad decisions may be taken for this monitor's mailbox.
	 *
	 * `null` is a monitor that has not seen a mail yet and therefore has no mailbox to ask about.
	 */
	offen(postfachId: string | null): boolean;
}

export const gateImmerOffen: Gate = { offen: () => true };

/** Built once per tick, so #30 can read its state with one query rather than one per monitor. */
export type GateFabrik = () => Promise<Gate>;

export const ohneGate: GateFabrik = () => Promise.resolve(gateImmerOffen);
