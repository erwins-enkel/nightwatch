import { createHash } from 'node:crypto';

/**
 * The Sorten-Signatur of a mail — sender + subject pattern (CONTEXT „Unüberwachte Mail-Sorte").
 *
 * This is what turns triage reason ③ ("customer known, no monitor matches") from a flood of single
 * entries into a short list an operator can work through: the two hundred nightly backup reports of
 * one customer collapse into one row with a counter.
 */

/** Keeps one pathological subject from producing an unbounded pattern. */
export const MUSTER_MAX_LAENGE = 200;

/** Repeated reply/forward prefixes, German and English. */
const ANTWORT_PRAEFIX = /^(?:(?:re|aw|antw|wg|fwd|fw)\s*(?:\[\d+\])?\s*:\s*)+/i;

/**
 * The variable parts of an otherwise recurring subject, most specific first.
 *
 * Order is load-bearing: a GUID has to be recognised before the generic hex run swallows its first
 * block, and a timestamp before the bare digit run takes it apart into `#-#-#`.
 */
const VARIABLE_TEILE: RegExp[] = [
	/\d{4}-\d{2}-\d{2}(?:[ t]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?z?)?/gi,
	/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g,
	/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
	/\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
	/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
	/\b[0-9a-f]{8,}\b/gi,
	/\d+/g
];

/**
 * Reduces a subject to its recurring shape.
 *
 * "Backup Job 4711 completed 2026-07-27 05:40" and the same line the next night must yield the same
 * pattern, or every nightly report would be its own Sorte and the grouping would achieve nothing.
 *
 * Case is deliberately preserved. The senders of these mails are machines with a fixed template, so
 * case carries no variance worth normalising away — and the pattern is shown to the operator, where
 * a lower-cased subject reads like a defect.
 */
export function betreffMuster(betreff: string): string {
	let muster = betreff.trim().replace(ANTWORT_PRAEFIX, '');

	for (const teil of VARIABLE_TEILE) muster = muster.replace(teil, '#');

	return (
		muster
			// A timestamp that only partly matched above can leave `#:#` or `# #` behind; collapsing
			// neighbouring placeholders keeps those from splitting one Sorte into several.
			.replace(/#(?:[\s.:/_-]*#)+/g, '#')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, MUSTER_MAX_LAENGE)
	);
}

/**
 * The stable key of a Sorte.
 *
 * Hashed rather than stored as `absender|muster`: the value carries the `(kunde_id, signatur)`
 * unique index, and a long subject line plus a long sender address can approach the btree row
 * limit — at which point the insert fails instead of the mail being grouped. The two human-readable
 * columns sit right beside it in `mail_sorte`, so nothing is lost by hashing.
 */
export function sortenSignatur(absender: string, muster: string): string {
	return createHash('sha256').update(`${absender}\n${muster}`).digest('hex');
}
