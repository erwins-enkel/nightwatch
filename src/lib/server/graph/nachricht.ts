import type { Message } from '@microsoft/microsoft-graph-types';

/**
 * Graph `message` → a `mail` row (SPEC §3, §11).
 *
 * Data minimisation is the rule and it is enforced here, at the only place mails enter the system:
 * arrival time, sender, recipients, subject, body as text. Attachments are never requested and
 * never stored.
 */

/** A delta round also reports removals; they carry `@removed` instead of the usual fields. */
type DeltaEintrag = Message & { '@removed'?: { reason?: string } };

export interface MailZeile {
	graphMessageId: string;
	/** Postfach-Ankunftszeit — `receivedDateTime`, never the time we processed it (SPEC §3). */
	ankunftszeit: Date;
	absender: string;
	empfaenger: string[];
	betreff: string;
	bodyText: string | null;
}

/** Entities that survive `outlook.body-content-type="text"` and matter for pattern matching. */
const ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	'#39': "'",
	'#x27': "'"
};

/**
 * Reduces HTML to text (SPEC §11).
 *
 * The safety net, not the main path: `Prefer: outlook.body-content-type="text"` makes Graph do the
 * conversion server-side and far better than we could. This only runs when a mailbox hands back
 * HTML anyway, and it aims at "a pattern can still match", not at pretty rendering — which is why
 * it stays a regex chain instead of pulling in an HTML parser.
 */
export function htmlZuText(html: string): string {
	return (
		html
			// Script and style bodies are not text the operator ever wrote — dropping them first
			// keeps CSS rules out of the stored body and out of every rule match.
			.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
			.replace(/<!--[\s\S]*?-->/g, ' ')
			// Block boundaries become line breaks, so a table of backup jobs stays one job per line.
			.replace(/<\s*br\s*\/?\s*>/gi, '\n')
			.replace(/<\s*\/\s*(p|div|tr|li|h[1-6]|table|thead|tbody)\s*>/gi, '\n')
			// Only the closing cell tag, so `</td><td>` yields one separator instead of two that the
			// whitespace collapse below would then merge back into a single space.
			.replace(/<\s*\/\s*(td|th)\s*>/gi, '\t')
			.replace(/<[^>]*>/g, '')
			.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (treffer, name: string) => {
				const bekannt = ENTITIES[name.toLowerCase()];
				if (bekannt !== undefined) return bekannt;
				const ziffern = /^#x([0-9a-fA-F]+)$/i.exec(name) ?? /^#(\d+)$/.exec(name);
				if (!ziffern) return treffer;
				const punkt = Number.parseInt(ziffern[1], name.toLowerCase().startsWith('#x') ? 16 : 10);
				return Number.isFinite(punkt) && punkt > 0 && punkt <= 0x10ffff
					? String.fromCodePoint(punkt)
					: treffer;
			})
			// Collapse the whitespace HTML is generous with, but keep paragraph structure.
			.replace(/[^\S\n]*\n[^\S\n]*/g, '\n')
			.replace(/\n{3,}/g, '\n\n')
			.replace(/[^\S\n]{2,}/g, ' ')
			.trim()
	);
}

function adresse(quelle: { emailAddress?: { address?: string | null } | null } | null | undefined) {
	return quelle?.emailAddress?.address?.trim().toLowerCase() ?? undefined;
}

/**
 * Both recipient lists, lower-cased and de-duplicated.
 *
 * `to` and `cc` because the Plus-Adresse is priority ① of the customer assignment (#24) and can sit
 * in either. Known limit, worth stating: a plus address that only ever appeared in the SMTP
 * envelope (a BCC'd monitoring address) is not exposed by Graph at all, so #24 will have to fall
 * back to the lower-priority traits for those.
 */
function empfaengerAus(nachricht: Message): string[] {
	const alle = [...(nachricht.toRecipients ?? []), ...(nachricht.ccRecipients ?? [])]
		.map(adresse)
		.filter((wert): wert is string => wert !== undefined);
	return [...new Set(alle)];
}

function bodyAus(nachricht: Message): string | null {
	const inhalt = nachricht.body?.content;
	if (typeof inhalt !== 'string' || inhalt.trim() === '') {
		// `bodyPreview` is capped at 255 characters, so it is a fallback and not a substitute.
		const vorschau = nachricht.bodyPreview?.trim();
		return vorschau ? vorschau : null;
	}

	const text = nachricht.body?.contentType === 'html' ? htmlZuText(inhalt) : inhalt.trim();
	return text === '' ? null : text;
}

/**
 * Maps one delta entry, or returns `null` for entries that are not an ingestible mail.
 *
 * The documentation is explicit that a delta round emits events which do not match the initial
 * filter — `@removed` entries and read/unread changes — because tracking happens at collection
 * level. A removal is skipped rather than applied: that a mail *arrived* stays true even after
 * someone deletes it from the mailbox, and rewriting that history would falsify exactly the
 * evidence Nightwatch exists to keep.
 */
export function zuMailZeile(eintrag: DeltaEintrag): MailZeile | null {
	if (eintrag['@removed']) return null;

	const id = eintrag.id?.trim();
	if (!id) return null;

	const empfangen = eintrag.receivedDateTime ? new Date(eintrag.receivedDateTime) : undefined;
	// Without a usable arrival time the row would poison every due-date decision (CONTEXT
	// „Ingestion-Gate"), so such an entry is dropped rather than stamped with "now".
	if (!empfangen || Number.isNaN(empfangen.getTime())) return null;

	return {
		graphMessageId: id,
		ankunftszeit: empfangen,
		absender: adresse(eintrag.from) ?? adresse(eintrag.sender) ?? '',
		empfaenger: empfaengerAus(eintrag),
		betreff: eintrag.subject?.trim() ?? '',
		bodyText: bodyAus(eintrag)
	};
}
