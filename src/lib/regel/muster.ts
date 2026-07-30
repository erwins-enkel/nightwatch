/**
 * Text → Muster. Die schmale Schicht, die Server und Ansicht teilen.
 *
 * Eigenes Modul, weil `$lib/server` für Komponenten gesperrt ist: die **Schicht-2-Markierung**
 * läuft im Browser (jemand markiert einen Satz im Beispieltext und übernimmt ihn als OK- oder
 * Fehler-Muster), die Ableitung auf dem Server — und beide müssen daraus denselben Ausdruck machen.
 * Reine Funktionen, keine Daten.
 */

/** Dasselbe ohne `trim` — dort, wo der Abstand zum Nachbarn zum Muster gehört. */
function schuetze(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Ein wörtlicher Text als Muster.
 *
 * Was jemand im Beispiel markiert, ist Text, kein regulärer Ausdruck: „Backup completed (100%)"
 * enthält Klammern, und ungeschützt wäre das entweder ein Syntaxfehler oder — schlimmer — ein
 * Muster, das etwas anderes trifft als das Markierte.
 */
export function alsMuster(literal: string): string {
	return schuetze(literal.trim());
}

/**
 * Die Sorten-Signatur als Betreff-Muster.
 *
 * `betreffMuster()` ersetzt die veränderlichen Teile eines Betreffs durch `#` („Backup Job # vom #
 * erfolgreich"). Für die Regel wird daraus ein regulärer Ausdruck: alles Wörtliche geschützt, jedes
 * `#` zu `.*`. Ein literales `#` im Betreff ist von einem Platzhalter nicht mehr unterscheidbar und
 * wird deshalb ebenfalls weit gelesen — großzügig in die richtige Richtung, denn ein zu enges
 * Match-Kriterium ließe genau die Mail durchfallen, für die der Monitor angelegt wurde.
 */
export function alsBetreffMuster(signatur: string): string {
	return signatur.split('#').map(schuetze).join('.*');
}
