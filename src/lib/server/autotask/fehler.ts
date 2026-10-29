/**
 * Turning a failed Autotask call into a diagnosis — and only into a diagnosis.
 *
 * Unlike the Graph classification (`graph/fehler.ts`), nothing here steers control flow: SPEC §7
 * asks for "Dead-Letter nach N Versuchen", so **every** failed delivery is retried until the
 * queue's retry budget is spent, whatever its cause. The class below decides the log level and
 * nothing else; the text is what lands in `zustellung.letzter_fehler` and, through it, in front of
 * the operator.
 */

/**
 * `dauerhaft` means "waiting will not help" — wrong credentials, an inactive priority ID, a deleted
 * company. It is worth an `error` in the log on the first attempt instead of the eighth, because
 * the operator has to act either way.
 */
export type FehlerKlasse = 'transient' | 'dauerhaft';

export interface AutotaskFehler {
	klasse: FehlerKlasse;
	/** Short and stable, safe to persist and to show: `400`, `429`, `TimeoutError`. */
	code: string;
	/** One line for the operator. Never carries a credential — see `beschreibeFehler`. */
	text: string;
}

/**
 * The error envelope of the REST API. Autotask answers a rejected write with a list of strings
 * (`{"errors":["Ticket: Status is required."]}`); some gateway responses use `message` instead.
 */
interface AutotaskFehlerBody {
	errors?: unknown;
	message?: unknown;
}

/**
 * `429` is the threshold lock and `408`/`5xx` are the ordinary transport failures — all of them
 * pass on their own. Everything else in the 4xx range is a statement about the request itself and
 * will read exactly the same on the next attempt.
 */
const TRANSIENTE_CODES = new Set([408, 425, 429]);

function textAus(body: unknown): string | undefined {
	const envelope = body as AutotaskFehlerBody | null | undefined;

	if (Array.isArray(envelope?.errors)) {
		const zeilen = envelope.errors.filter(
			(eintrag): eintrag is string => typeof eintrag === 'string'
		);
		if (zeilen.length > 0) return zeilen.join('; ');
	}

	return typeof envelope?.message === 'string' && envelope.message.trim() !== ''
		? envelope.message.trim()
		: undefined;
}

export interface KlassifiziereEingabe {
	status: number;
	body?: unknown;
}

/** Classifies a non-2xx Autotask response. */
export function klassifiziereAntwort(eingabe: KlassifiziereEingabe): AutotaskFehler {
	const { status, body } = eingabe;
	const text = beschreibeFehler(textAus(body) ?? `Autotask antwortete mit HTTP ${status}`);
	const dauerhaft = status >= 400 && status < 500 && !TRANSIENTE_CODES.has(status);

	return { klasse: dauerhaft ? 'dauerhaft' : 'transient', code: String(status), text };
}

/**
 * Classifies a thrown error — a dead socket, a DNS failure, the request timeout from `client.ts`.
 * None of those say anything about the request, so they are transient by construction.
 */
export function klassifiziereAusnahme(fehler: unknown): AutotaskFehler {
	const name = fehler instanceof Error ? fehler.name : 'Fehler';
	const text = fehler instanceof Error ? fehler.message : String(fehler);
	return { klasse: 'transient', code: name, text: beschreibeFehler(text) };
}

/**
 * The error a failed delivery throws, so the pg-boss handler stays a one-liner while the class and
 * code survive into the log.
 */
export class AutotaskZustellFehler extends Error {
	readonly klasse: FehlerKlasse;
	readonly code: string;

	constructor(fehler: AutotaskFehler) {
		super(fehler.text);
		this.name = 'AutotaskZustellFehler';
		this.klasse = fehler.klasse;
		this.code = fehler.code;
	}
}

/** Trims a message to its first line and a sane length before it is persisted or shown. */
export function beschreibeFehler(text: string): string {
	const ersteZeile = text.split(/[\r\n]/, 1)[0].trim();
	return ersteZeile.length > 300 ? `${ersteZeile.slice(0, 299)}…` : ersteZeile;
}
