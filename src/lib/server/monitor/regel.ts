import { domain } from '../zuordnung/engine';

/**
 * A rule's detection logic as pure comparison (CONTEXT „Regel", „Match-Kriterien", „Muster-Slots").
 *
 * Two questions live here, and nothing else: *is this one of my mails?* (Match-Kriterien) and
 * *which of my two pattern slots does it hit?* — what those slot hits **mean** is the Monitor-Art's
 * business (`auswertung.ts`), and what they do to the state is the state machine's (`zustand.ts`).
 *
 * Deliberately free of I/O, like `zuordnung/engine.ts`: every rule CONTEXT states about matching can
 * therefore be asserted without a database.
 */

/** The parts of a mail a rule looks at. */
export interface RegelMail {
	absender: string;
	betreff: string;
	bodyText: string | null;
}

/** The rule's columns, as loaded from `regel` or from a `regel_vorlage`. */
export interface RegelZeile {
	absender: string[];
	betreffMuster: string[];
	schluesselwoerter: string[];
	musterSchlecht: string[];
	musterGut: string[];
}

export interface KompilierteRegel {
	/** Full addresses and bare domains, both lower-cased. */
	absender: Set<string>;
	betreffMuster: RegExp[];
	/** Lower-cased literals, matched against the flattened haystack. */
	schluesselwoerter: string[];
	musterSchlecht: RegExp[];
	musterGut: RegExp[];
}

/**
 * How much of a mail the patterns see.
 *
 * Report mails are text, not books — 100k characters is far more than any of them — while an
 * operator-supplied regex against a multi-megabyte body is the one place where backtracking could
 * stall the worker loop. Capping the haystack bounds that without ever truncating a real report.
 */
export const HEUHAUFEN_MAX_LAENGE = 100_000;

/** Longest pattern accepted; the same bound is enforced when a rule is saved (`parameter.ts`). */
export const MUSTER_MAX_LAENGE = 500;

export interface KompilierungsErgebnis {
	regel: KompilierteRegel;
	/** Patterns that did not compile. They simply never match; the loader logs them. */
	ungueltig: string[];
}

/**
 * Compiles one pattern, or returns `null` if it is not a usable regular expression.
 *
 * Case-insensitive because the same software writes „Backup completed" and „BACKUP COMPLETED"
 * depending on its version, and no operator should have to think about that. No `u` flag: it would
 * reject patterns that are perfectly valid without it, and every rule written before it was added
 * would break on the next release.
 */
export function kompiliereMuster(muster: string): RegExp | null {
	if (muster === '' || muster.length > MUSTER_MAX_LAENGE) return null;
	try {
		return new RegExp(muster, 'i');
	} catch {
		return null;
	}
}

function kompiliereListe(muster: string[], ungueltig: string[]): RegExp[] {
	const kompiliert: RegExp[] = [];
	for (const eintrag of muster) {
		const regex = kompiliereMuster(eintrag);
		if (regex) kompiliert.push(regex);
		else ungueltig.push(eintrag);
	}
	return kompiliert;
}

export function kompiliereRegel(zeile: RegelZeile): KompilierungsErgebnis {
	const ungueltig: string[] = [];

	return {
		regel: {
			absender: new Set(zeile.absender.map((wert) => wert.trim().toLowerCase())),
			betreffMuster: kompiliereListe(zeile.betreffMuster, ungueltig),
			schluesselwoerter: zeile.schluesselwoerter
				.map((wort) => wort.trim().toLowerCase())
				.filter((wort) => wort !== ''),
			musterSchlecht: kompiliereListe(zeile.musterSchlecht, ungueltig),
			musterGut: kompiliereListe(zeile.musterGut, ungueltig)
		},
		ungueltig
	};
}

/**
 * Subject and body as the patterns see them.
 *
 * Two readings of the same mail, built at most once each and only when something asks for them:
 * `roh` keeps the text as it arrived, because an operator's regex is written against real line
 * breaks; `flach` is lower-cased and whitespace-collapsed, so a keyword still matches when the body
 * wrapped it across two lines.
 */
export class Heuhaufen {
	#mail: RegelMail;
	#roh?: string;
	#flach?: string;

	constructor(mail: RegelMail) {
		this.#mail = mail;
	}

	get roh(): string {
		return (this.#roh ??= `${this.#mail.betreff}\n${this.#mail.bodyText ?? ''}`.slice(
			0,
			HEUHAUFEN_MAX_LAENGE
		));
	}

	get flach(): string {
		return (this.#flach ??= this.roh.replace(/\s+/g, ' ').trim().toLowerCase());
	}
}

/**
 * Whether a mail is one of this monitor's (CONTEXT „Match-Kriterien").
 *
 * **AND across the categories that are set, OR within each one.** The OR is what makes a rule
 * language independent — the same report arrives as „Backup completed" or „Sicherung erfolgreich"
 * depending on the customer's configuration, and both belong to the same monitor. The AND is what
 * lets a second criterion narrow an overly broad first one.
 *
 * A rule without any criterion matches nothing. That is deliberate and the opposite of the usual
 * "empty filter matches everything": such a rule would swallow every mail of its customer and
 * silently starve every other monitor. `parameter.ts` rejects it at the door; this is the backstop.
 */
export function trifftMatchKriterien(
	mail: RegelMail,
	regel: KompilierteRegel,
	heuhaufen = new Heuhaufen(mail)
): boolean {
	let geprueft = false;

	if (regel.absender.size > 0) {
		geprueft = true;
		if (!trifftAbsender(mail.absender, regel.absender)) return false;
	}

	if (regel.betreffMuster.length > 0) {
		geprueft = true;
		if (!regel.betreffMuster.some((muster) => muster.test(mail.betreff))) return false;
	}

	if (regel.schluesselwoerter.length > 0) {
		geprueft = true;
		if (!regel.schluesselwoerter.some((wort) => heuhaufen.flach.includes(wort))) return false;
	}

	return geprueft;
}

/** The sender matches by full address or by its bare domain — the same two shapes as a Stufe-③ trait. */
function trifftAbsender(absender: string, erlaubt: Set<string>): boolean {
	const adresse = absender.trim().toLowerCase();
	if (adresse === '') return false;
	if (erlaubt.has(adresse)) return true;

	const bereich = domain(adresse);
	return bereich !== null && erlaubt.has(bereich);
}

/** Which of the two generic slots a mail hits. Both, one or neither is possible. */
export interface SlotTreffer {
	schlecht: boolean;
	gut: boolean;
}

export function slotTreffer(
	mail: RegelMail,
	regel: KompilierteRegel,
	heuhaufen = new Heuhaufen(mail)
): SlotTreffer {
	return {
		schlecht: regel.musterSchlecht.some((muster) => muster.test(heuhaufen.roh)),
		gut: regel.musterGut.some((muster) => muster.test(heuhaufen.roh))
	};
}
