import { zuordnungsStufe, type ZuordnungsStufe } from '../db/schema/enums';

/**
 * Stage 1 of the assignment pipeline: **Mail → Kunde** (SPEC §4, CONTEXT „Kunden-Zuordnung").
 *
 * Deliberately free of I/O. Every rule CONTEXT states about assignment — the fixed priority, first
 * match, "no scoring", what counts as ambiguous — is decided here and can therefore be asserted
 * without a database. The caller supplies the traits; this module only compares.
 */

/** The parts of a mail the assignment looks at. */
export interface ZuordnungsMail {
	absender: string;
	/** `to` + `cc`, already lower-cased and de-duplicated by the ingestion. */
	empfaenger: string[];
	betreff: string;
	bodyText: string | null;
}

/** One `zuordnungs_merkmal` row plus the bits of its customer the outcome depends on. */
export interface MerkmalZeile {
	id: string;
	kundeId: string;
	kundeName: string;
	kundeArchiviert: boolean;
	stufe: ZuordnungsStufe;
	wert: string;
}

export type KundenErgebnis =
	| { art: 'kunde'; stufe: ZuordnungsStufe; merkmal: MerkmalZeile }
	/** Several *customers* on one stage. Nightwatch does not guess (CONTEXT „Mehrdeutig"). */
	| { art: 'mehrdeutig'; stufe: ZuordnungsStufe; kandidaten: MerkmalZeile[] }
	| { art: 'kein_kunde' };

/**
 * The traits in the shape the matcher needs them.
 *
 * Built once per batch rather than per mail: the number of traits is a property of the
 * configuration (a handful per customer), while the number of mails is not.
 */
export interface MerkmalIndex {
	plusAdresse: Map<string, MerkmalZeile[]>;
	/** Keyed by both the full address and the bare domain, since Stufe ③ accepts either. */
	absender: Map<string, MerkmalZeile[]>;
	/** Content patterns cannot be looked up by key, so they are tested one by one. */
	inhaltsmuster: { merkmal: MerkmalZeile; muster: RegExp }[];
}

function haenge(karte: Map<string, MerkmalZeile[]>, schluessel: string, zeile: MerkmalZeile): void {
	const vorhanden = karte.get(schluessel);
	if (vorhanden) vorhanden.push(zeile);
	else karte.set(schluessel, [zeile]);
}

function maskiere(wert: string): string {
	return wert.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compiles a Stufe-② value into a literal, case-insensitive, token-bounded matcher.
 *
 * Not a regular expression from the operator, and not a plain `includes` either:
 *
 * - **Not a regex**, because „warum landete die Mail bei Kunde B?" has to be answerable at a glance
 *   (CONTEXT) — and because an operator-supplied pattern would run against every ingested mail,
 *   which is where a catastrophically backtracking one would hurt most.
 * - **Not a plain substring**, because customer number `k-1234` would then match a mail about
 *   `k-12345`, and "ein Ticket beim falschen Kunden ist der teuerste Fehler der Zuordnung".
 *
 * The boundary uses Unicode letter/number classes rather than `\b`, whose idea of a word character
 * stops at ASCII — with `\b` a trait like `müller` would fail to match `müller gmbh`.
 */
function alsInhaltsmuster(wert: string): RegExp {
	return new RegExp(`(?<![\\p{L}\\p{N}])${maskiere(wert)}(?![\\p{L}\\p{N}])`, 'u');
}

/**
 * The domain of an address, or `null` for something that is not one.
 *
 * Exported because a monitor's Absender-Match-Kriterium accepts the same two shapes as a Stufe-③
 * trait (CONTEXT), and both must agree on what counts as a domain.
 */
export function domain(adresse: string): string | null {
	const trenner = adresse.lastIndexOf('@');
	if (trenner < 1 || trenner === adresse.length - 1) return null;
	return adresse.slice(trenner + 1);
}

export function baueMerkmalIndex(merkmale: MerkmalZeile[]): MerkmalIndex {
	const index: MerkmalIndex = {
		plusAdresse: new Map(),
		absender: new Map(),
		inhaltsmuster: []
	};

	for (const merkmal of merkmale) {
		switch (merkmal.stufe) {
			case 'plus_adresse':
				haenge(index.plusAdresse, merkmal.wert, merkmal);
				break;
			case 'absender':
				haenge(index.absender, merkmal.wert, merkmal);
				break;
			case 'inhaltsmuster':
				index.inhaltsmuster.push({ merkmal, muster: alsInhaltsmuster(merkmal.wert) });
				break;
		}
	}

	return index;
}

/**
 * Subject and body as one lower-cased, whitespace-collapsed string.
 *
 * Collapsing matters for real mails: a content pattern like `kunde a gmbh` must still match when
 * the body wrapped it across two lines. Built once per mail and reused for every Stufe-② trait.
 */
export function inhaltHeuhaufen(mail: ZuordnungsMail): string {
	return `${mail.betreff}\n${mail.bodyText ?? ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
}

function trefferAufStufe(
	stufe: ZuordnungsStufe,
	mail: ZuordnungsMail,
	index: MerkmalIndex,
	heuhaufen: () => string
): MerkmalZeile[] {
	switch (stufe) {
		case 'plus_adresse':
			return mail.empfaenger.flatMap((adresse) => index.plusAdresse.get(adresse) ?? []);
		case 'inhaltsmuster': {
			if (index.inhaltsmuster.length === 0) return [];
			const inhalt = heuhaufen();
			return index.inhaltsmuster
				.filter((eintrag) => eintrag.muster.test(inhalt))
				.map((eintrag) => eintrag.merkmal);
		}
		case 'absender': {
			if (mail.absender === '') return [];
			const bereich = domain(mail.absender);
			return [
				...(index.absender.get(mail.absender) ?? []),
				...(bereich ? (index.absender.get(bereich) ?? []) : [])
			];
		}
	}
}

/**
 * Reduces the hits of one stage to one candidate per customer.
 *
 * Two traits of the *same* customer are not an ambiguity — the customer is unambiguous, only the
 * reason is doubled. The lowest trait id wins so that the recorded "why did this mail land here?"
 * is reproducible instead of depending on row order.
 */
function jeKunde(treffer: MerkmalZeile[]): MerkmalZeile[] {
	const kunden = new Map<string, MerkmalZeile>();
	for (const merkmal of treffer) {
		const bisher = kunden.get(merkmal.kundeId);
		if (!bisher || merkmal.id < bisher.id) kunden.set(merkmal.kundeId, merkmal);
	}
	return [...kunden.values()].sort((a, b) => a.kundeName.localeCompare(b.kundeName));
}

/**
 * Determines the customer of a mail.
 *
 * The priority is the declaration order of the `zuordnungs_stufe` enum — ① Plus-Adresse,
 * ② Kundennummer/Inhaltsmuster, ③ Absender — and it is read from there rather than restated, so
 * the enum stays the single place that defines it.
 *
 * A stage that produced hits **ends the search**, whatever it produced: one customer means
 * assigned, several mean ambiguous. Falling through to a lower stage after an ambiguity would
 * quietly turn "several customers claim this mail" into "some lower-priority customer gets it" —
 * exactly the guess CONTEXT forbids.
 *
 * Archived customers match like any other (CONTEXT „Archiviert": „Die Zuordnungs-Merkmale greifen
 * aber weiter"). What follows from an archived hit is the caller's decision, not the matcher's.
 */
export function bestimmeKunde(mail: ZuordnungsMail, index: MerkmalIndex): KundenErgebnis {
	// Computed at most once per mail, and not at all when no Stufe-② trait exists.
	let inhalt: string | undefined;
	const heuhaufen = () => (inhalt ??= inhaltHeuhaufen(mail));

	for (const stufe of zuordnungsStufe.enumValues) {
		const kandidaten = jeKunde(trefferAufStufe(stufe, mail, index, heuhaufen));
		if (kandidaten.length === 0) continue;
		if (kandidaten.length === 1) return { art: 'kunde', stufe, merkmal: kandidaten[0] };
		return { art: 'mehrdeutig', stufe, kandidaten };
	}

	return { art: 'kein_kunde' };
}
