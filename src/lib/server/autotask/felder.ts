/**
 * Reading a tenant's picklists out of `GET /{Entity}/entityInformation/fields` (Research-Doc §3).
 *
 * SPEC §7: "alle numerischen IDs tenant-spezifisch beim Einrichten aufgelöst und konfigurierbar
 * hinterlegt, nie hardcoded". This module is the resolving half — it turns Autotask's field
 * description into the options the settings form offers, and it is pure so every edge case is
 * assertable without a tenant.
 */

export interface PicklistWert {
	wert: number;
	label: string;
	/** Autotask's own default for the field; the settings form pre-selects it. */
	standard: boolean;
}

/** The slice of the `entityInformation/fields` envelope this module relies on. */
interface FeldBeschreibung {
	name?: unknown;
	isPickList?: unknown;
	picklistValues?: unknown;
}

interface PicklistZeile {
	value?: unknown;
	label?: unknown;
	isActive?: unknown;
	isDefaultValue?: unknown;
	sortOrder?: unknown;
}

function zahl(wert: unknown): number | null {
	if (typeof wert === 'number' && Number.isFinite(wert)) return wert;
	// Autotask sends picklist values as strings ("1"), even for integer fields.
	if (typeof wert === 'string' && wert.trim() !== '' && Number.isFinite(Number(wert))) {
		return Number(wert);
	}
	return null;
}

/**
 * The active values of one picklist field, in the tenant's own display order.
 *
 * Inactive entries are dropped rather than shown greyed out: Autotask rejects a *new* inactive
 * value on write, so offering one would only produce a ticket creation that fails later, far away
 * from the form that caused it.
 */
export function lesePicklist(body: unknown, feldName: string): PicklistWert[] {
	const felder = (body as { fields?: unknown } | null | undefined)?.fields;
	if (!Array.isArray(felder)) return [];

	const gesucht = feldName.toLowerCase();
	const feld = felder.find((eintrag) => {
		const name = (eintrag as FeldBeschreibung | null)?.name;
		return typeof name === 'string' && name.toLowerCase() === gesucht;
	}) as FeldBeschreibung | undefined;

	const werte = feld?.picklistValues;
	if (!Array.isArray(werte)) return [];

	return werte
		.map((zeile) => zeile as PicklistZeile)
		.filter((zeile) => zeile.isActive !== false)
		.map((zeile) => ({
			wert: zahl(zeile.value),
			label: typeof zeile.label === 'string' ? zeile.label : '',
			standard: zeile.isDefaultValue === true,
			sortierung: zahl(zeile.sortOrder) ?? Number.MAX_SAFE_INTEGER
		}))
		.filter((zeile): zeile is typeof zeile & { wert: number } => zeile.wert !== null)
		.sort((a, b) => a.sortierung - b.sortierung || a.label.localeCompare(b.label))
		.map(({ wert, label, standard }) => ({ wert, label: label || String(wert), standard }));
}
