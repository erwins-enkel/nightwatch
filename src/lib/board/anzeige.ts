/**
 * Die Anzeige-Begriffe des Kundenboards — die schmale Schicht, die Server und Ansicht teilen.
 *
 * Eigenes Modul, weil `$lib/server` für Komponenten gesperrt ist und die Ampel trotzdem dieselben
 * vier Werte kennen muss wie die Aggregation. Reine Typen und eine reine Funktion, keine Daten.
 */

/**
 * Das eine Abzeichen, das ein Monitor auf dem Board trägt.
 *
 * Eine Partition, mit Absicht: die Zähler einer Kunden-Karte müssen die Zahl der Monitore ergeben,
 * und zwei sich überlappende Abzeichen machten aus sechs Monitoren „3 gestört · 5 gesund". Pausiert
 * ist im Datenmodell ein Overlay (CONTEXT „Pausiert"); hier wird daraus ein Wert — und er fällt
 * immer zur Störung hin, nie von ihr weg.
 */
export type AnzeigeZustand = 'gestoert' | 'pausiert' | 'entwurf' | 'gesund';

export interface Tagesspalte {
	/** `YYYY-MM-DD` in der Instanz-Zeitzone. */
	datum: string;
	/** ISO-8601: 1 = Montag … 7 = Sonntag. Die Beschriftung ist Sache der Ansicht. */
	wochentag: number;
	eingetroffen: number;
	/** Die schlechteste Klassifikation des Tages; null, wenn nichts eintraf. */
	klassifikation: 'ok' | 'fehler' | 'unklar' | null;
	/**
	 * Diskrete Soll-Zeitpunkte an diesem Tag.
	 *
	 * Nur der Kalenderplan hat welche. Eine Intervall-Erwartung sagt „nie länger als N ohne Mail"
	 * und kennt keine festen Zeitpunkte — dort bleibt dieser Zähler 0, und die eingetroffenen Mails
	 * *sind* die erfüllte Erwartung. Die übrigen Monitor-Arten erwarten von sich aus nichts.
	 */
	erwartet: number;
	/** Davon (bzw. bei Intervall: Fristen), die ungedeckt verstrichen sind. */
	verfehlt: number;
	ausnahmetag: boolean;
	/** Ganz vor der Aktivierung — hier wurde nie etwas beurteilt (CONTEXT „Lernfenster"). */
	vorAktivierung: boolean;
	/**
	 * Die Pause, soweit sie bekannt ist.
	 *
	 * `monitor` merkt sich nur, *dass* pausiert ist und bis wann — nicht, seit wann. Eine
	 * zurückliegende Pause ließe sich deshalb nicht rekonstruieren; markiert wird nur der laufende
	 * Tag.
	 */
	pausiert: boolean;
}

export type Tageslage =
	| 'unbewertet'
	| 'pausiert'
	| 'verfehlt'
	| 'fehler'
	| 'unklar'
	| 'ok'
	| 'ausnahmetag'
	| 'erwartet'
	| 'leer';

/**
 * Was eine Tagesspalte im Kern sagt — die eine Stelle, an der die Rangfolge entschieden wird.
 *
 * Ein verfehlter Soll schlägt eine eingetroffene Mail: dass an dem Tag *auch* etwas ankam, macht
 * den fehlenden Bericht nicht wett. Der Ausnahmetag steht unter den Ankünften, weil er die
 * *Abwesenheit* erklärt — kam etwas an, ist die Ankunft die Aussage.
 */
export function lage(spalte: Tagesspalte): Tageslage {
	if (spalte.vorAktivierung) return 'unbewertet';
	if (spalte.pausiert) return 'pausiert';
	if (spalte.verfehlt > 0) return 'verfehlt';
	if (spalte.klassifikation !== null) return spalte.klassifikation;
	if (spalte.ausnahmetag) return 'ausnahmetag';
	if (spalte.erwartet > 0) return 'erwartet';
	return 'leer';
}
