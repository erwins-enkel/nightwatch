/** Form-field reading shared by the two customer routes. */

export function text(daten: FormData, feld: string): string {
	const wert = daten.get(feld);
	return typeof wert === 'string' ? wert.trim() : '';
}

/**
 * An optional positive whole number: `null` for an empty field, `undefined` for something that is
 * not one — so the caller can tell "not given" from "given and wrong" without a second check.
 */
export function ganzzahlOderNull(roh: string): number | null | undefined {
	if (roh === '') return null;
	const zahl = Number(roh);
	return Number.isInteger(zahl) && zahl > 0 ? zahl : undefined;
}
