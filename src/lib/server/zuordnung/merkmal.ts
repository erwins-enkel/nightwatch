import type { ZuordnungsStufe } from '../db/schema/enums';

/**
 * Normalising and validating a Zuordnungs-Merkmal's value (CONTEXT „Zuordnungs-Merkmal").
 *
 * Every value is stored in one canonical form — trimmed, inner whitespace collapsed, lower-cased —
 * which the `zuordnungs_merkmal` schema comment already promises. Three things depend on it and
 * would silently half-work otherwise: the `(stufe, wert)` lookup of the matching engine, the
 * `(kunde_id, stufe, wert)` unique key, and the Kollisionswarnung, which can only recognise "the
 * same trait at another customer" if both were written the same way.
 *
 * The price is that the configuration UI shows the canonical form rather than what was typed. That
 * is the honest thing to show: it is what the matcher actually compares against.
 */

/** The same address shape the mailbox form validates against, so both agree on what an address is. */
const ADRESSE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A bare domain: at least two labels, no `@`. `acme.com` and `mail.acme.co.uk` qualify. */
const DOMAIN = /^[^\s@.]+(?:\.[^\s@.]+)+$/;

/** Shortest useful content pattern. One or two characters would match nearly every mail. */
export const INHALTSMUSTER_MIN_LAENGE = 3;

/** Why a value was rejected. The UI maps these to messages; they are never shown raw. */
export type MerkmalFehler = 'leer' | 'plus_adresse' | 'zu_kurz' | 'absender';

export function normalisiereWert(stufe: ZuordnungsStufe, wert: string): string {
	const gemeinsam = wert.trim().replace(/\s+/g, ' ').toLowerCase();
	// Operators type the `@` out of habit when they mean a domain; dropping it here keeps
	// `@acme.com` and `acme.com` from becoming two traits that behave identically.
	return stufe === 'absender' ? gemeinsam.replace(/^@/, '') : gemeinsam;
}

/**
 * Validates a normalised value for its stage.
 *
 * The plus-address check is the load-bearing one: without the required `+`, an operator could enter
 * the shared NOC address as a Stufe-① trait and route *every* incoming mail to a single customer —
 * a default customer through the back door, which CONTEXT rules out on purpose.
 */
export function pruefeWert(stufe: ZuordnungsStufe, wert: string): MerkmalFehler | null {
	if (wert === '') return 'leer';

	switch (stufe) {
		case 'plus_adresse': {
			if (!ADRESSE.test(wert)) return 'plus_adresse';
			const lokal = wert.slice(0, wert.lastIndexOf('@'));
			// A `+` at either end carries no tag, so it would not distinguish anything.
			if (!lokal.includes('+') || lokal.startsWith('+') || lokal.endsWith('+')) {
				return 'plus_adresse';
			}
			return null;
		}
		case 'inhaltsmuster':
			return wert.length < INHALTSMUSTER_MIN_LAENGE ? 'zu_kurz' : null;
		case 'absender':
			return ADRESSE.test(wert) || DOMAIN.test(wert) ? null : 'absender';
	}
}
