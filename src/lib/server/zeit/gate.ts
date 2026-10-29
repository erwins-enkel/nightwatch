/**
 * The Ingestion-Gate's seam (CONTEXT „Ingestion-Gate", SPEC §8).
 *
 * The gate suspends — never discards — the decisions that rest on a mail's *absence*, for as long
 * as the ingestion is demonstrably broken. Only the question lives here; the answer is
 * `selbst/gate.ts`, which reads it off the self-monitors.
 *
 * A safe default holds even with the gate wide open: the Bewertungs-Schranke in `db.ts` refuses to
 * judge past the point ingestion has provably reached, so a broken mailbox stops the evaluation on
 * its own. What the self-monitors add is precision — narrowing the suspension to the affected
 * mailbox instead of stopping everything.
 */
export interface Gate {
	/**
	 * Whether absence-based bad decisions may be taken for this monitor's mailbox.
	 *
	 * `null` is a monitor that has not seen a mail yet and therefore has no mailbox of its own to
	 * ask about — which does not make it unconditionally open: a disturbed Nightwatch-Kern is not
	 * fetching mail for it either, and that clause applies to every monitor.
	 */
	offen(postfachId: string | null): boolean;
}

export const gateImmerOffen: Gate = { offen: () => true };

/** Built once per tick, so #30 can read its state with one query rather than one per monitor. */
export type GateFabrik = () => Promise<Gate>;

export const ohneGate: GateFabrik = () => Promise.resolve(gateImmerOffen);
