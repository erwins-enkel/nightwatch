import { monitorArt, type MonitorArt } from '../db/schema/enums';
import type { Kalenderplan, MonitorParameter } from '../db/schema/monitor';
import { kompiliereMuster, type RegelZeile } from '../monitor/regel';

/**
 * Das Austauschformat der Regel-Vorlagen (CONTEXT „Regel-Vorlage").
 *
 * Ein Format für zwei Wege: die **kuratierten** Vorlagen liegen als versionierte Daten im Image
 * (`kuratiert.ts`) und werden mit Releases aktualisiert, die **eigenen** kommen aus Export und
 * Import. Dass beide durch denselben Prüfer gehen, ist Absicht — ein kaputter Release-Datensatz
 * fällt so in der CI auf und nicht beim Betreiber.
 *
 * **Es gibt keinen Weg, über den ein Geheimnis in eine Vorlage geriete.** Der Prüfer baut aus der
 * Eingabe ein *neues* Objekt aus genau den Feldern unten; alles andere fällt weg, statt
 * mitgeschleppt zu werden. SPEC §12 verlangt das ausdrücklich („Export/Import von Regel-Vorlagen
 * enthält nie Credentials"), und eine Positivliste hält das ein, auch wenn dem Datenmodell später
 * ein Feld wächst, an das hier niemand gedacht hat.
 */

/** Version des Austauschformats — nicht zu verwechseln mit der `version` einer einzelnen Vorlage. */
export const VORLAGEN_FORMAT = 1;

export interface VorlagenEintrag {
	/** Stabiler Schlüssel, über den ein Release seine Vorlage wiederfindet, z. B. `veeam-report`. */
	schluessel: string;
	name: string;
	hersteller?: string;
	beschreibung?: string;
	/** Inhalts-Version; ein Release überschreibt nur nach oben. */
	version: number;
	vorgeschlageneArt?: MonitorArt;
	absender: string[];
	betreffMuster: string[];
	schluesselwoerter: string[];
	musterSchlecht: string[];
	musterGut: string[];
	parameterDefaults?: MonitorParameter;
}

export interface VorlagenDatei {
	format: number;
	vorlagen: VorlagenEintrag[];
}

export type VorlagenFehlerSchluessel =
	| 'kein_objekt'
	| 'format_unbekannt'
	| 'keine_vorlagen'
	| 'schluessel_fehlt'
	| 'schluessel_ungueltig'
	| 'schluessel_doppelt'
	| 'name_fehlt'
	| 'version_ungueltig'
	| 'art_unbekannt'
	| 'muster_ungueltig'
	| 'kein_match_kriterium'
	| 'parameter_ungueltig';

export interface VorlagenFehler {
	/** Index in `vorlagen`, oder `null` für die Datei als Ganzes. */
	eintrag: number | null;
	schluessel: VorlagenFehlerSchluessel;
}

export type VorlagenErgebnis =
	{ art: 'ok'; vorlagen: VorlagenEintrag[] } | { art: 'ungueltig'; fehler: VorlagenFehler[] };

/** Schlüssel sind URL- und dateinamentauglich, damit ein Export einen sinnvollen Namen bekommt. */
const SCHLUESSEL_FORM = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Liest und prüft eine Vorlagen-Datei — Import wie kuratierte Daten.
 *
 * Sammelt *alle* Fehler, nicht nur den ersten: wer eine Datei mit dreißig Vorlagen importiert, will
 * sie einmal reparieren und nicht dreißigmal hochladen.
 */
export function liesVorlagenDatei(roh: unknown): VorlagenErgebnis {
	if (typeof roh !== 'object' || roh === null || Array.isArray(roh)) {
		return { art: 'ungueltig', fehler: [{ eintrag: null, schluessel: 'kein_objekt' }] };
	}

	const datei = roh as Record<string, unknown>;
	if (datei.format !== VORLAGEN_FORMAT) {
		return { art: 'ungueltig', fehler: [{ eintrag: null, schluessel: 'format_unbekannt' }] };
	}

	if (!Array.isArray(datei.vorlagen) || datei.vorlagen.length === 0) {
		return { art: 'ungueltig', fehler: [{ eintrag: null, schluessel: 'keine_vorlagen' }] };
	}

	const fehler: VorlagenFehler[] = [];
	const vorlagen: VorlagenEintrag[] = [];
	const gesehen = new Set<string>();

	datei.vorlagen.forEach((roheVorlage, index) => {
		const ergebnis = liesEintrag(roheVorlage, index, gesehen);
		if (ergebnis.art === 'ok') {
			gesehen.add(ergebnis.vorlage.schluessel);
			vorlagen.push(ergebnis.vorlage);
		} else {
			fehler.push(...ergebnis.fehler);
		}
	});

	return fehler.length > 0 ? { art: 'ungueltig', fehler } : { art: 'ok', vorlagen };
}

type EintragErgebnis =
	{ art: 'ok'; vorlage: VorlagenEintrag } | { art: 'ungueltig'; fehler: VorlagenFehler[] };

function liesEintrag(roh: unknown, eintrag: number, gesehen: Set<string>): EintragErgebnis {
	if (typeof roh !== 'object' || roh === null) {
		return { art: 'ungueltig', fehler: [{ eintrag, schluessel: 'kein_objekt' }] };
	}

	const quelle = roh as Record<string, unknown>;
	const fehler: VorlagenFehler[] = [];
	const melde = (schluessel: VorlagenFehlerSchluessel) => fehler.push({ eintrag, schluessel });

	const schluessel = typeof quelle.schluessel === 'string' ? quelle.schluessel.trim() : '';
	if (schluessel === '') melde('schluessel_fehlt');
	else if (!SCHLUESSEL_FORM.test(schluessel)) melde('schluessel_ungueltig');
	else if (gesehen.has(schluessel)) melde('schluessel_doppelt');

	const name = typeof quelle.name === 'string' ? quelle.name.trim() : '';
	if (name === '') melde('name_fehlt');

	const version = quelle.version ?? 1;
	if (!Number.isInteger(version) || (version as number) < 1) melde('version_ungueltig');

	let art: MonitorArt | undefined;
	if (quelle.vorgeschlageneArt !== undefined && quelle.vorgeschlageneArt !== null) {
		if (istMonitorArt(quelle.vorgeschlageneArt)) art = quelle.vorgeschlageneArt;
		else melde('art_unbekannt');
	}

	const absender = alsTextListe(quelle.absender);
	const betreffMuster = alsTextListe(quelle.betreffMuster);
	const schluesselwoerter = alsTextListe(quelle.schluesselwoerter);
	const musterSchlecht = alsTextListe(quelle.musterSchlecht);
	const musterGut = alsTextListe(quelle.musterGut);

	// Dieselbe Untergrenze wie bei einer echten Regel: ohne Match-Kriterium erkennt sie nichts, und
	// eine Vorlage, die nichts vorbefüllt, ist keine (CONTEXT „Match-Kriterien").
	if (absender.length + betreffMuster.length + schluesselwoerter.length === 0) {
		melde('kein_match_kriterium');
	}

	const alleMuster = [...betreffMuster, ...musterSchlecht, ...musterGut];
	if (alleMuster.some((muster) => kompiliereMuster(muster) === null)) melde('muster_ungueltig');

	const parameterDefaults = liesParameter(quelle.parameterDefaults);
	if (parameterDefaults === 'ungueltig') melde('parameter_ungueltig');

	if (fehler.length > 0) return { art: 'ungueltig', fehler };

	return {
		art: 'ok',
		vorlage: {
			schluessel,
			name,
			...(typeof quelle.hersteller === 'string' && quelle.hersteller.trim() !== ''
				? { hersteller: quelle.hersteller.trim() }
				: {}),
			...(typeof quelle.beschreibung === 'string' && quelle.beschreibung.trim() !== ''
				? { beschreibung: quelle.beschreibung.trim() }
				: {}),
			version: version as number,
			...(art ? { vorgeschlageneArt: art } : {}),
			absender,
			betreffMuster,
			schluesselwoerter,
			musterSchlecht,
			musterGut,
			...(parameterDefaults === undefined || parameterDefaults === 'ungueltig'
				? {}
				: { parameterDefaults })
		}
	};
}

function istMonitorArt(wert: unknown): wert is MonitorArt {
	return typeof wert === 'string' && (monitorArt.enumValues as readonly string[]).includes(wert);
}

/** Nur nicht-leere Strings, getrimmt — dieselbe Reinigung wie `normalisiereRegel`. */
function alsTextListe(roh: unknown): string[] {
	if (!Array.isArray(roh)) return [];
	return roh
		.filter((wert): wert is string => typeof wert === 'string')
		.map((wert) => wert.trim())
		.filter((wert) => wert !== '');
}

/**
 * Die Parameter-Vorbefüllung, feldweise übernommen.
 *
 * Nur grobe Plausibilität — ob die Werte zur gewählten Art passen, entscheidet `pruefeMonitor`,
 * wenn der Monitor gespeichert wird. Hier geht es allein darum, dass kein Unrat in die Spalte
 * kommt, der später als Zahl gelesen würde.
 */
function liesParameter(roh: unknown): MonitorParameter | undefined | 'ungueltig' {
	if (roh === undefined || roh === null) return undefined;
	if (typeof roh !== 'object' || Array.isArray(roh)) return 'ungueltig';

	const quelle = roh as Record<string, unknown>;
	const parameter: MonitorParameter = {};

	if (quelle.erwartungModus !== undefined) {
		if (quelle.erwartungModus !== 'intervall' && quelle.erwartungModus !== 'kalenderplan') {
			return 'ungueltig';
		}
		parameter.erwartungModus = quelle.erwartungModus;
	}

	if (quelle.erwartungPlan !== undefined) {
		const plan = liesPlan(quelle.erwartungPlan);
		if (plan === 'ungueltig') return 'ungueltig';
		parameter.erwartungPlan = plan;
	}

	const zahlen = [
		'erwartungIntervallSekunden',
		'karenzSekunden',
		'autoZurueckSekunden',
		'maxOffenzeitSekunden',
		'zaehlerFensterSekunden',
		'zaehlerObergrenze',
		'zaehlerUntergrenze'
	] as const;

	for (const feld of zahlen) {
		const wert = quelle[feld];
		if (wert === undefined) continue;
		if (!Number.isInteger(wert) || (wert as number) < 0) return 'ungueltig';
		parameter[feld] = wert as number;
	}

	return parameter;
}

function liesPlan(roh: unknown): Kalenderplan | 'ungueltig' {
	if (typeof roh !== 'object' || roh === null || Array.isArray(roh)) return 'ungueltig';

	const quelle = roh as Record<string, unknown>;
	const tage = quelle.wochentage;
	if (
		!Array.isArray(tage) ||
		tage.length === 0 ||
		!tage.every((tag) => Number.isInteger(tag) && (tag as number) >= 1 && (tag as number) <= 7)
	) {
		return 'ungueltig';
	}

	if (typeof quelle.uhrzeit !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(quelle.uhrzeit)) {
		return 'ungueltig';
	}

	return { wochentage: tage as number[], uhrzeit: quelle.uhrzeit };
}

/**
 * Vorlagen als Datei — die Gegenrichtung, ebenfalls über die Positivliste.
 *
 * Die Eingabe darf aus der Datenbank kommen und mehr Spalten tragen (`id`, `herkunft`,
 * `erstellt_am`); nichts davon steht im Export. Eine exportierte Datei ist deshalb überall
 * einspielbar, und die Herkunft entscheidet die importierende Instanz selbst.
 */
export function alsDatei(vorlagen: VorlagenEintrag[]): VorlagenDatei {
	return {
		format: VORLAGEN_FORMAT,
		vorlagen: vorlagen.map((vorlage) => ({
			schluessel: vorlage.schluessel,
			name: vorlage.name,
			...(vorlage.hersteller ? { hersteller: vorlage.hersteller } : {}),
			...(vorlage.beschreibung ? { beschreibung: vorlage.beschreibung } : {}),
			version: vorlage.version,
			...(vorlage.vorgeschlageneArt ? { vorgeschlageneArt: vorlage.vorgeschlageneArt } : {}),
			absender: vorlage.absender,
			betreffMuster: vorlage.betreffMuster,
			schluesselwoerter: vorlage.schluesselwoerter,
			musterSchlecht: vorlage.musterSchlecht,
			musterGut: vorlage.musterGut,
			...(vorlage.parameterDefaults ? { parameterDefaults: vorlage.parameterDefaults } : {})
		}))
	};
}

/** Die Regel-Felder einer Vorlage, wie der Wizard sie in die Anlage-Fläche schreibt. */
export function vorlageAlsRegel(vorlage: VorlagenEintrag): RegelZeile {
	return {
		absender: vorlage.absender,
		betreffMuster: vorlage.betreffMuster,
		schluesselwoerter: vorlage.schluesselwoerter,
		musterSchlecht: vorlage.musterSchlecht,
		musterGut: vorlage.musterGut
	};
}
