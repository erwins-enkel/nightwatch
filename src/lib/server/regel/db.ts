import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { mail, mailSorte, monitor, regel, regelVorlage } from '../db/schema';
import type { TaktKlasse } from '../db/schema/enums';
import type { MonitorParameter } from '../db/schema/monitor';
import { createLogger } from '../logger';
import type { Tx } from '../zuordnung/db';
import { KURATIERTE_VORLAGEN } from './kuratiert';
import type { Takt } from './takt';
import { liesVorlagenDatei, type VorlagenEintrag } from './vorlage';

/**
 * Die Datenbank-Seite der Regel-Entstehung: Vorlagen (kuratiert wie eigen) und das Material, aus
 * dem der Wizard eine Regel vorbefüllt.
 *
 * Die Takt-*Rechnung* steht in `takt.ts`, die Ableitung in `ableitung.ts`, das Schreiben des Takts
 * bei den übrigen `mail_sorte`-Schreibern in `zuordnung/db.ts`. Hier wird nur gelesen und
 * geschrieben.
 */

const log = createLogger('regel');

type Db = ReturnType<typeof getDb>;
type Ausfuehrer = Db | Tx;

// ---------------------------------------------------------------------------------------------
// Vorlagen
// ---------------------------------------------------------------------------------------------

const vorlagenFelder = {
	id: regelVorlage.id,
	schluessel: regelVorlage.schluessel,
	name: regelVorlage.name,
	hersteller: regelVorlage.hersteller,
	beschreibung: regelVorlage.beschreibung,
	herkunft: regelVorlage.herkunft,
	version: regelVorlage.version,
	vorgeschlageneArt: regelVorlage.vorgeschlageneArt,
	absender: regelVorlage.absender,
	betreffMuster: regelVorlage.betreffMuster,
	schluesselwoerter: regelVorlage.schluesselwoerter,
	musterSchlecht: regelVorlage.musterSchlecht,
	musterGut: regelVorlage.musterGut,
	parameterDefaults: regelVorlage.parameterDefaults
};

export type VorlagenZeile = Awaited<ReturnType<typeof listeVorlagen>>[number];

/** Kuratierte zuerst, dann eigene — beide alphabetisch. */
export function listeVorlagen(db: Ausfuehrer = getDb()) {
	return db
		.select(vorlagenFelder)
		.from(regelVorlage)
		.orderBy(asc(regelVorlage.herkunft), asc(regelVorlage.name));
}

export async function holeVorlage(id: string, db: Ausfuehrer = getDb()) {
	const [zeile] = await db.select(vorlagenFelder).from(regelVorlage).where(eq(regelVorlage.id, id));
	return zeile;
}

/** Eine gelesene Zeile im Austauschformat — die Spalten sind nullbar, die Felder optional. */
export function alsEintrag(zeile: VorlagenZeile): VorlagenEintrag {
	return {
		schluessel: zeile.schluessel,
		name: zeile.name,
		...(zeile.hersteller ? { hersteller: zeile.hersteller } : {}),
		...(zeile.beschreibung ? { beschreibung: zeile.beschreibung } : {}),
		version: zeile.version,
		...(zeile.vorgeschlageneArt ? { vorgeschlageneArt: zeile.vorgeschlageneArt } : {}),
		absender: zeile.absender,
		betreffMuster: zeile.betreffMuster,
		schluesselwoerter: zeile.schluesselwoerter,
		musterSchlecht: zeile.musterSchlecht,
		musterGut: zeile.musterGut,
		...(zeile.parameterDefaults ? { parameterDefaults: zeile.parameterDefaults } : {})
	};
}

function alsSpalten(vorlage: VorlagenEintrag) {
	return {
		schluessel: vorlage.schluessel,
		name: vorlage.name,
		hersteller: vorlage.hersteller ?? null,
		beschreibung: vorlage.beschreibung ?? null,
		version: vorlage.version,
		vorgeschlageneArt: vorlage.vorgeschlageneArt ?? null,
		absender: vorlage.absender,
		betreffMuster: vorlage.betreffMuster,
		schluesselwoerter: vorlage.schluesselwoerter,
		musterSchlecht: vorlage.musterSchlecht,
		musterGut: vorlage.musterGut,
		parameterDefaults: vorlage.parameterDefaults ?? null
	};
}

/** Die Spalten, die ein Update überschreibt — `schluessel` und `herkunft` bleiben, wie sie sind. */
const AUS_EXCLUDED = {
	name: sql`excluded.name`,
	hersteller: sql`excluded.hersteller`,
	beschreibung: sql`excluded.beschreibung`,
	version: sql`excluded.version`,
	vorgeschlageneArt: sql`excluded.vorgeschlagene_art`,
	absender: sql`excluded.absender`,
	betreffMuster: sql`excluded.betreff_muster`,
	schluesselwoerter: sql`excluded.schluesselwoerter`,
	musterSchlecht: sql`excluded.muster_schlecht`,
	musterGut: sql`excluded.muster_gut`,
	parameterDefaults: sql`excluded.parameter_defaults`
};

/**
 * Spielt die kuratierten Vorlagen aus dem Image ein (SPEC §5, CONTEXT „Regel-Vorlage").
 *
 * Läuft im Migrations-Skript, direkt nach den Migrationen: genau ein Prozess führt es aus (Rolle
 * `web`, siehe `docker/entrypoint.sh`), also braucht es keinen Lock — dieselbe Begründung, mit der
 * SPEC §14 die Migrationen dorthin legt.
 *
 * Zwei Bedingungen am Update, und beide sind wichtig:
 *
 * - **`herkunft = 'kuratiert'`** — eine eigene Vorlage des Betreibers wird nie überschrieben, auch
 *   wenn sie zufällig denselben Schlüssel trägt. Sein Fundus gehört ihm.
 * - **`version <` der neuen** — ein Downgrade des Images (oder ein zweiter Lauf) darf eine neuere
 *   Vorlage nicht durch eine ältere ersetzen; und ohne den Vergleich schriebe jeder Start alle
 *   Zeilen neu.
 *
 * Die Daten gehen durch denselben Prüfer wie ein Import. Ein kaputter Release-Datensatz fällt
 * dadurch schon in der CI auf — dort läuft `vorlage.test.ts` gegen genau diese Liste.
 */
export async function synchronisiereVorlagen(db: Db = getDb()): Promise<number> {
	const geprueft = liesVorlagenDatei({ format: 1, vorlagen: KURATIERTE_VORLAGEN });
	if (geprueft.art === 'ungueltig') {
		// Kein Abbruch des Starts: die Instanz läuft ohne kuratierte Vorlagen weiter, alles andere
		// funktioniert. Der Fehler gehört trotzdem laut ins Log — er ist ein Bug im Release.
		log.error('kuratierte Vorlagen sind ungültig', { fehler: geprueft.fehler });
		return 0;
	}

	const geschrieben = await db
		.insert(regelVorlage)
		.values(
			geprueft.vorlagen.map((vorlage) => ({
				...alsSpalten(vorlage),
				herkunft: 'kuratiert' as const
			}))
		)
		.onConflictDoUpdate({
			target: regelVorlage.schluessel,
			set: AUS_EXCLUDED,
			setWhere: and(
				eq(regelVorlage.herkunft, 'kuratiert'),
				lt(regelVorlage.version, sql`excluded.version`)
			)
		})
		.returning({ schluessel: regelVorlage.schluessel });

	if (geschrieben.length > 0) {
		log.info('Regel-Vorlagen aktualisiert', {
			anzahl: geschrieben.length,
			schluessel: geschrieben.map((zeile) => zeile.schluessel)
		});
	}

	return geschrieben.length;
}

export interface ImportErgebnis {
	geschrieben: number;
	/** Schlüssel, die eine kuratierte Vorlage tragen — die gehört dem Release, nicht dem Import. */
	abgelehnt: string[];
}

/**
 * Übernimmt importierte Vorlagen als **eigene**.
 *
 * Kollidiert ein Schlüssel mit einer kuratierten Vorlage, wird der Eintrag abgelehnt statt
 * umbenannt: ein stillschweigend verschobener Schlüssel wäre beim nächsten Release-Update eine
 * Überraschung, und der Betreiber kann ihn in einer Zeile selbst ändern.
 */
export async function importiereVorlagen(
	vorlagen: VorlagenEintrag[],
	db: Db = getDb()
): Promise<ImportErgebnis> {
	if (vorlagen.length === 0) return { geschrieben: 0, abgelehnt: [] };

	return db.transaction(async (tx) => {
		const schluessel = vorlagen.map((vorlage) => vorlage.schluessel);
		const vorhanden = await tx
			.select({ schluessel: regelVorlage.schluessel, herkunft: regelVorlage.herkunft })
			.from(regelVorlage)
			.where(inArray(regelVorlage.schluessel, schluessel));

		const kuratiert = new Set(
			vorhanden.filter((zeile) => zeile.herkunft === 'kuratiert').map((zeile) => zeile.schluessel)
		);
		const uebernehmbar = vorlagen.filter((vorlage) => !kuratiert.has(vorlage.schluessel));
		if (uebernehmbar.length === 0) return { geschrieben: 0, abgelehnt: [...kuratiert] };

		const geschrieben = await tx
			.insert(regelVorlage)
			.values(
				uebernehmbar.map((vorlage) => ({ ...alsSpalten(vorlage), herkunft: 'eigen' as const }))
			)
			.onConflictDoUpdate({
				target: regelVorlage.schluessel,
				set: AUS_EXCLUDED,
				// Anders als beim Release-Sync ohne Versions-Vergleich: wer eine Datei einspielt, will
				// genau deren Inhalt sehen, auch wenn er die Version nicht hochgezählt hat.
				setWhere: eq(regelVorlage.herkunft, 'eigen')
			})
			.returning({ id: regelVorlage.id });

		return { geschrieben: geschrieben.length, abgelehnt: [...kuratiert] };
	});
}

export type VorlagenLoeschErgebnis = 'geloescht' | 'kuratiert' | 'unbekannt';

/**
 * Löscht eine eigene Vorlage. Kuratierte bleiben — sie kämen beim nächsten Start ohnehin wieder.
 *
 * Die von ihr gesäten Regeln bleiben unberührt: `regel.vorlage_id` ist `on delete set null` und
 * reine Herkunft (CONTEXT „Regel-Vorlage"), keine Verknüpfung, aus der eine Regel etwas nachlädt.
 */
export async function loescheVorlage(
	id: string,
	db: Ausfuehrer = getDb()
): Promise<VorlagenLoeschErgebnis> {
	const geloescht = await db
		.delete(regelVorlage)
		.where(and(eq(regelVorlage.id, id), eq(regelVorlage.herkunft, 'eigen')))
		.returning({ id: regelVorlage.id });

	if (geloescht.length > 0) return 'geloescht';

	const [vorhanden] = await db
		.select({ id: regelVorlage.id })
		.from(regelVorlage)
		.where(eq(regelVorlage.id, id));
	return vorhanden ? 'kuratiert' : 'unbekannt';
}

/**
 * Macht aus einer bestehenden Regel eine eigene Vorlage — der Weg, auf dem CONTEXT den Betreiber
 * „sich einen eigenen Fundus bauen" lässt.
 *
 * Übernommen werden Regel *und* Parameter der Art; Zustand, Kunde und Historie des Monitors
 * bleiben selbstverständlich draußen. Der Umweg über `liesVorlagenDatei` ist Absicht: er ist die
 * eine Stelle, die entscheidet, was eine Vorlage tragen darf.
 */
export async function vorlageAusMonitor(
	monitorId: string,
	kopf: { schluessel: string; name: string; beschreibung?: string },
	db: Db = getDb()
): Promise<ImportErgebnis | { geschrieben: 0; ungueltig: true }> {
	const [zeile] = await db
		.select({
			art: monitor.art,
			erwartungModus: monitor.erwartungModus,
			erwartungIntervallSekunden: monitor.erwartungIntervallSekunden,
			erwartungPlan: monitor.erwartungPlan,
			karenzSekunden: monitor.karenzSekunden,
			autoZurueckSekunden: monitor.autoZurueckSekunden,
			maxOffenzeitSekunden: monitor.maxOffenzeitSekunden,
			zaehlerFensterSekunden: monitor.zaehlerFensterSekunden,
			zaehlerObergrenze: monitor.zaehlerObergrenze,
			zaehlerUntergrenze: monitor.zaehlerUntergrenze,
			absender: regel.absender,
			betreffMuster: regel.betreffMuster,
			schluesselwoerter: regel.schluesselwoerter,
			musterSchlecht: regel.musterSchlecht,
			musterGut: regel.musterGut
		})
		.from(monitor)
		.innerJoin(regel, eq(regel.monitorId, monitor.id))
		.where(eq(monitor.id, monitorId))
		.limit(1);

	if (!zeile) return { geschrieben: 0, ungueltig: true };

	const entwurf = {
		schluessel: kopf.schluessel,
		name: kopf.name,
		beschreibung: kopf.beschreibung,
		version: 1,
		vorgeschlageneArt: zeile.art,
		absender: zeile.absender,
		betreffMuster: zeile.betreffMuster,
		schluesselwoerter: zeile.schluesselwoerter,
		musterSchlecht: zeile.musterSchlecht,
		musterGut: zeile.musterGut,
		parameterDefaults: parameterAus(zeile)
	};

	const geprueft = liesVorlagenDatei({ format: 1, vorlagen: [entwurf] });
	if (geprueft.art === 'ungueltig') return { geschrieben: 0, ungueltig: true };

	return importiereVorlagen(geprueft.vorlagen, db);
}

/** Die gesetzten Parameter-Spalten als Objekt; die der anderen Arten sind null und fallen weg. */
function parameterAus(zeile: Record<string, unknown>): MonitorParameter {
	const parameter: MonitorParameter = {};
	for (const [feld, wert] of Object.entries(zeile)) {
		if (wert === null || wert === undefined) continue;
		if (feld in LEER_PARAMETER) Object.assign(parameter, { [feld]: wert });
	}
	return parameter;
}

/** Die Feldnamen von `MonitorParameter`, zur Laufzeit prüfbar. */
const LEER_PARAMETER: Record<keyof MonitorParameter, true> = {
	erwartungModus: true,
	erwartungIntervallSekunden: true,
	erwartungPlan: true,
	karenzSekunden: true,
	autoZurueckSekunden: true,
	maxOffenzeitSekunden: true,
	zaehlerFensterSekunden: true,
	zaehlerObergrenze: true,
	zaehlerUntergrenze: true
};

// ---------------------------------------------------------------------------------------------
// Material für die Ableitung
// ---------------------------------------------------------------------------------------------

/** Die Beispiel-Mail und die Statistik ihrer Sorte — alles, was Schicht 1 braucht. */
export interface AbleitungsQuelle {
	mailId: string;
	kundeId: string | null;
	sorteId: string | null;
	absender: string;
	betreff: string;
	/** Der Text, in dem die Schicht-2-Markierung stattfindet. */
	bodyText: string | null;
	ankunftszeit: Date;
	/**
	 * Der gespeicherte Takt der Sorte, nicht ein hier neu gerechneter: die Sorten-Ansicht zeigt
	 * denselben Wert (CONTEXT „Takt" — es gibt genau eine Schwelle und genau eine Aussage).
	 */
	takt: Takt | null;
	/** Vorkommen der Sorte insgesamt — der Beleg, wenn kein Takt erkannt wurde. */
	sortenAnzahl: number;
}

const quellenFelder = {
	mailId: mail.id,
	kundeId: mail.kundeId,
	sorteId: mail.sorteId,
	absender: mail.absender,
	betreff: mail.betreff,
	bodyText: mail.bodyText,
	ankunftszeit: mail.ankunftszeit,
	taktKlasse: mailSorte.taktKlasse,
	taktIntervallSekunden: mailSorte.taktIntervallSekunden,
	taktUhrzeit: mailSorte.taktUhrzeit,
	taktWochentag: mailSorte.taktWochentag,
	taktVorkommen: mailSorte.taktVorkommen,
	taktStreuungSekunden: mailSorte.taktStreuungSekunden,
	sortenAnzahl: mailSorte.anzahl
};

/**
 * Beide Abfragen unten liefern diese Form. Die Sorten-Spalten sind durchweg nullbar, weil der
 * `leftJoin` sie so zurückgibt — der `innerJoin` liefert engere Typen, die hier hineinpassen.
 */
interface QuellenZeile {
	mailId: string;
	kundeId: string | null;
	sorteId: string | null;
	absender: string;
	betreff: string;
	bodyText: string | null;
	ankunftszeit: Date;
	taktKlasse: TaktKlasse | null;
	taktIntervallSekunden: number | null;
	taktUhrzeit: string | null;
	taktWochentag: number | null;
	taktVorkommen: number | null;
	taktStreuungSekunden: number | null;
	sortenAnzahl: number | null;
}

/**
 * Die Beispiel-Mail zu einer Mail-Id — der Einstieg „aus Mail ableiten" aus Triage und Mail-Suche.
 *
 * `leftJoin`, weil eine Triage-Mail keine Sorte hat: ohne erkannten Kunden gibt es keine, an der
 * sich ein Rhythmus ablesen ließe. Die Ableitung läuft trotzdem — sie füllt dann Absender und
 * Betreff und sagt beim Takt ehrlich „nichts gefunden".
 */
export async function ladeQuelleAusMail(
	mailId: string,
	db: Ausfuehrer = getDb()
): Promise<AbleitungsQuelle | undefined> {
	const [zeile] = await db
		.select(quellenFelder)
		.from(mail)
		.leftJoin(mailSorte, eq(mailSorte.id, mail.sorteId))
		.where(eq(mail.id, mailId))
		.limit(1);

	return zeile && alsQuelle(zeile);
}

/**
 * Die jüngste Mail einer Sorte — der Einstieg aus den unüberwachten Mail-Sorten.
 *
 * Die jüngste und nicht die erste: sie zeigt das Format, das die Software *heute* verschickt, und
 * genau daran soll sich die Regel orientieren.
 */
export async function ladeQuelleAusSorte(
	sorteId: string,
	db: Ausfuehrer = getDb()
): Promise<AbleitungsQuelle | undefined> {
	const [zeile] = await db
		.select(quellenFelder)
		.from(mailSorte)
		.innerJoin(mail, eq(mail.sorteId, mailSorte.id))
		.where(eq(mailSorte.id, sorteId))
		.orderBy(desc(mail.ankunftszeit))
		.limit(1);

	return zeile && alsQuelle(zeile);
}

function alsQuelle(zeile: QuellenZeile): AbleitungsQuelle {
	return {
		mailId: zeile.mailId,
		kundeId: zeile.kundeId,
		sorteId: zeile.sorteId,
		absender: zeile.absender,
		betreff: zeile.betreff,
		bodyText: zeile.bodyText,
		ankunftszeit: zeile.ankunftszeit,
		takt: alsTakt(zeile),
		sortenAnzahl: zeile.sortenAnzahl ?? 0
	};
}

/** Die Takt-Spalten der Sorte als Objekt; `takt_klasse` entscheidet, ob es überhaupt eins gibt. */
function alsTakt(zeile: QuellenZeile): Takt | null {
	if (!zeile.taktKlasse) return null;

	return {
		klasse: zeile.taktKlasse,
		...(zeile.taktIntervallSekunden !== null
			? { intervallSekunden: zeile.taktIntervallSekunden }
			: {}),
		...(zeile.taktUhrzeit !== null ? { uhrzeit: zeile.taktUhrzeit } : {}),
		...(zeile.taktWochentag !== null ? { wochentag: zeile.taktWochentag } : {}),
		vorkommen: zeile.taktVorkommen ?? 0,
		streuungSekunden: zeile.taktStreuungSekunden ?? 0
	};
}

/**
 * Die Ankunftszeiten einer Sorte, jüngste zuerst — Grundlage des Zähler-Vorschlags.
 *
 * Weiter gefasst als `TAKT_MAX_VORKOMMEN`: der Zähler-Vorschlag mittelt über Tage, und mit nur
 * zweihundert Zeitpunkten sähe eine rege Sorte aus wie zwei Tage Betrieb. Nur die Zeitstempel, ohne
 * Bodies — das ist der Unterschied, der die Grenze bezahlbar macht.
 */
export async function ladeSortenAnkunftszeiten(
	sorteId: string,
	grenze = 5_000,
	db: Ausfuehrer = getDb()
): Promise<Date[]> {
	const zeilen = await db
		.select({ ankunftszeit: mail.ankunftszeit })
		.from(mail)
		.where(eq(mail.sorteId, sorteId))
		.orderBy(desc(mail.ankunftszeit))
		.limit(grenze);

	return zeilen.map((zeile) => zeile.ankunftszeit);
}

/**
 * Die Mails einer Sorte mit Text — für die nachgelagerte Paar-Offenzeit, die die markierten
 * Auf-/Zu-Muster auf den beobachteten Verlauf anwendet.
 *
 * Enger begrenzt als oben, weil hier die Bodies mitkommen; die längste Auf→Zu-Dauer braucht keine
 * Jahre Historie, sondern einen zusammenhängenden Ausschnitt.
 */
export async function ladeSortenVerlauf(
	sorteId: string,
	grenze = 500,
	db: Ausfuehrer = getDb()
): Promise<{ ankunftszeit: Date; absender: string; betreff: string; bodyText: string | null }[]> {
	const zeilen = await db
		.select({
			ankunftszeit: mail.ankunftszeit,
			absender: mail.absender,
			betreff: mail.betreff,
			bodyText: mail.bodyText
		})
		.from(mail)
		.where(eq(mail.sorteId, sorteId))
		.orderBy(desc(mail.ankunftszeit))
		.limit(grenze);

	return zeilen.reverse();
}
