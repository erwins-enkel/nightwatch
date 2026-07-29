import type { AutotaskPort } from './client';

/**
 * The Autotask company directory, as far as the picker needs it (SPEC §7, Research-Doc §5).
 *
 * CONTEXT „Autotask-Verknüpfung": the customer stores a **stable company ID**, nothing else — no
 * continuous sync, no mirrored record, no bulk import. So this module only ever reads: once while
 * searching, and once more to put a name next to a stored ID.
 */

export interface CompanyTreffer {
	id: number;
	name: string;
	ort: string | null;
	aktiv: boolean;
}

/** Autotask caps a query at 500 records; a picker that shows more than this is not a picker. */
const TREFFER_MAX = 50;

interface CompanyZeile {
	id?: unknown;
	companyName?: unknown;
	city?: unknown;
	isActive?: unknown;
}

function alsTreffer(zeile: unknown): CompanyTreffer | null {
	const roh = zeile as CompanyZeile | null | undefined;
	const id = typeof roh?.id === 'number' ? roh.id : Number(roh?.id);
	if (!Number.isFinite(id)) return null;

	return {
		id,
		name: typeof roh?.companyName === 'string' ? roh.companyName : String(id),
		ort: typeof roh?.city === 'string' && roh.city.trim() !== '' ? roh.city.trim() : null,
		aktiv: roh?.isActive !== false
	};
}

function items(body: unknown): unknown[] {
	const liste = (body as { items?: unknown } | null | undefined)?.items;
	return Array.isArray(liste) ? liste : [];
}

/**
 * Searches by name fragment. `contains` rather than `eq`: the operator types what they remember,
 * and company names in a PSA are rarely spelled the way the customer record spells them.
 */
export async function sucheCompanies(
	port: AutotaskPort,
	begriff: string
): Promise<CompanyTreffer[]> {
	const antwort = await port.anfrage('POST', 'Companies/query', {
		filter: [{ op: 'contains', field: 'companyName', value: begriff }],
		includeFields: ['id', 'companyName', 'city', 'isActive']
	});

	if (antwort.status !== 200) {
		throw new Error(`Companies/query antwortete mit HTTP ${antwort.status}`);
	}

	return items(antwort.body)
		.map(alsTreffer)
		.filter((treffer): treffer is CompanyTreffer => treffer !== null)
		.slice(0, TREFFER_MAX);
}

/**
 * The name behind a stored ID, for display only.
 *
 * Resolved live on every page view rather than cached in a column: a mirrored name would be a sync,
 * and the glossary rules that out. Null when Autotask does not know the ID (any more) — the page
 * then shows the bare number, which is still the truth.
 */
export async function holeCompanyName(
	port: AutotaskPort,
	companyId: number
): Promise<string | null> {
	const antwort = await port.anfrage('GET', `Companies/${companyId}`);
	if (antwort.status !== 200) return null;

	const item = (antwort.body as { item?: unknown } | null | undefined)?.item;
	const name = (item as CompanyZeile | null | undefined)?.companyName;
	return typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
}
