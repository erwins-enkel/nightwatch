# Nightwatch

E-Mail-Monitoring für MSPs/IT-Systemhäuser. Kern ist das Erkennen **ausbleibender**
erwarteter Benachrichtigungsmails (Heartbeat) — plus klassische Fehler- und Ereignis-Erkennung.
Dieses Glossar ist die verbindliche Sprache des Efforts (Deutsch).

> Status: in Arbeit über Wayfinder-Map #1 (Domänenmodell #5, Kunden-Matching #6,
> Regel-Entstehung #9, Alarm-Lebenszyklus #12, Self-Monitoring #11, Parametrisierung #15).
> Begriffe mit „(vorläufig)" sind inhaltlich geklärt, aber der Name ist noch nicht ratifiziert.

## Language

### Monitor & Arten

**Monitor**:
Die atomare Überwachungseinheit — eine pro überwachtem Ding: das **Was**. Führt einen
Gesundheitszustand und alarmiert bei Störung/Erholung nach außen. Hat genau eine **Monitor-Art**,
(bei Heartbeat) eine **Erwartung** und genau eine **Regel**; gehört genau einem **Kunden**.
Der Mensch legt ihn bewusst an.
_Avoid_: Wächter, Überwachung, Check.

**Monitor-Art**:
Der Charakter eines Monitors. Ein **offenes, erweiterbares Set** (nicht zwei feste Fälle) —
neue Arten kommen später hinzu, ohne die Zustandsmaschine zu ändern. Jede Art erfüllt denselben
**Dreiklang-Vertrag** und deutet die **Muster-Slots** der Regel auf ihre Weise. Das v1-Set:
**Heartbeat · Ereignis · Paar · Zähler**.

**Dreiklang-Vertrag**:
Der gemeinsame Vertrag jeder Monitor-Art, definiert durch drei Fragen:
1. **Auslöser** — was startet eine Auswertung? (eingehende Mail / Zeitablauf / beides)
2. **Schlecht-Bedingung** — wann kippt der Monitor in einen Störungs-Zustand?
3. **Erholungs-Bedingung** — was holt ihn in den gesunden Zustand zurück?

**Heartbeat-Monitor**:
Erwartet Mails in Regelmäßigkeit. Schlecht, wenn die erwartete Mail **ausbleibt** (überfällig)
**oder** eine eingetroffene Mail als Fehler klassifiziert wird. Pünktlichkeit und Inhalt sind
zwei getrennte Dimensionen: **jede passende Mail** (OK, Fehler oder Unklar) erfüllt die
**Erwartung** — sie beweist, dass der Meldekanal lebt —, die **Klassifikation** bestimmt separat
den Zustand. Überfällig heißt exakt: es kam **gar nichts**, nicht „nichts Gutes". Beispiel:
nächtlicher Backup-Report.

**Ereignis-Monitor**:
Mails kommen nur im Störungsfall und haben **kein** natürliches Gegenstück. Schlecht, sobald eine
passende Mail **kommt** — die Ankunft selbst ist das Ereignis, ein Fehler-Muster braucht diese Art
nicht. Der optionale **Harmlos-Filter** nimmt unkritische Geschwister-Mails vom Auslösen aus.
Grenze zur Nachbar-Art: gibt es eine echte Entwarnungs-Mail, ist es per Definition ein
**Paar-Monitor**. Beispiel: „Firmware-Update verfügbar".

**Paar-Monitor** _(auch: Zustands-Monitor)_:
Verfolgt einen **offenen Zustand** aus paarweisen Mails: das **Auf-Muster** öffnet („Leitung ab",
„Job gestartet"), das **Zu-Muster** schließt — die beweisbasierte Erholung. Schlecht, wenn länger
offen als die **maximale Offenzeit** (Default 0 = sofort alarmieren; für Jobs die erlaubte
Laufzeit; Kurz-Flattern dämpft die Entwarnungs-Stabilität). Ränder: eine Zu-Mail ohne offenen
Zustand ist **neutral** (kein Alarm, kein Unklar, nur „zuletzt gesehen"); ein zweites Auf während
offen zählt als internes Vorkommen, die Offenzeit läuft ab dem **ersten** Auf. Ein Monitor führt
genau **einen** offenen Zustand — parallele Instanzen (mehrere gleichzeitige Jobs) sind getrennte
Monitore, keine Instanz-Korrelation. Beispiel: Router „Leitung ab" … „Leitung wieder da".

**Zähl-Monitor** _(vereint die früheren Schwellwert-/Raten- und Volumen-/Abweichungs-Monitore)_:
Zählt passende Mails in einem **gleitenden Fenster** T (Minuten bis Tage); die Muster-Slots sind
bei dieser Art ungenutzt. Schlecht, sobald der Zähler die **Obergrenze** überschreitet
(Meldungssturm — feuert sofort mit der Mail, die sie reißt) oder die **Untergrenze** unterschreitet
(Verstummen — feuert, sobald genug Mails herausgealtert sind, kein Warten aufs Tagesende);
mindestens eine Grenze ist gesetzt. Erholt beweisbasiert, wenn der Zähler wieder im Band liegt.
Der „erlernte Normalwert" ist **Vorbefüllung** der Grenzen aus dem Lernfenster, keine
Laufzeit-Baseline. Beispiele: „mehr als 50 in 10 Minuten" · „normal ~100 OK/Tag, heute nur 3".

**Anlauf**:
Schonzeit der Zähler-**Untergrenze**: sie wird erst scharf, wenn seit der Aktivierung — oder seit
dem Ende eines **Ausnahmetags** — ein volles Fenster T vergangen ist. Ohne Anlauf wäre jeder
frisch aktivierte Zähl-Monitor sofort gestört, denn der Zähler startet bei 0 und Historie wird
nie rückwirkend gewertet. Die **Obergrenze** gilt dagegen ab Sekunde 1. Derselbe Gedanke gilt beim
**Kalenderplan**: dort ist der Anlauf das erste Abdeckungs-Fenster, das vollständig nach der
Aktivierung liegt (siehe **Erwartung**).

### Erwartung (Heartbeat)

**Erwartung**:
Die Soll-Definition eines Heartbeat-Monitors, wann eine Mail eintreffen muss. Zwei Ausprägungen:
**Intervall** oder **Kalenderplan**. Immer mit **Karenz**. Erfüllt wird sie von **jeder passenden
Mail**, unabhängig von deren Klassifikation. Beim Kalenderplan gilt ein Soll-Zeitpunkt als
abgedeckt, wenn seit dem vorherigen **wirksamen** Soll eine passende Mail eintraf — der
Backup-Report von 23:40 deckt das „bis 06:00"-Soll des Folgetages (Jobs laufen oft früher als
die Deadline). Beurteilt wird ein Soll erst, wenn sein Abdeckungs-Fenster **vollständig nach der
Aktivierung** liegt — der **Anlauf** des Kalenderplans. Sonst reichte das Fenster in eine Zeit
zurück, in der der Monitor noch nicht lief und in der eingetroffene Mails deshalb nicht zählen:
ein um 05:59 aktivierter Monitor mit Soll 06:00 alarmierte sofort, obwohl der Report um 23:40
gekommen war.

**Intervall**:
Gleitendes „spätestens alle X". Die Uhr startet bei jeder eingetroffenen Mail neu; kennt keine
Uhrzeit/Wochentage. Für simple, gerätenahe Heartbeats („alle 5 min").

**Kalenderplan**:
Absolute Soll-Zeitpunkte, cron-artig („Mo–Fr bis 06:00"). Bildet Arbeitstage/Uhrzeiten direkt ab;
deckt Wochenenden ohne Zusatzkonzept mit ab. Für geplante Jobs (Backups, Reports).

**Karenz** _(Toleranzfenster)_:
Puffer nach dem Soll-Zeitpunkt, bevor `Gestört` mit Grund „überfällig" ausgelöst wird. Kein
eigener Zustand — Teil der Schlecht-Bedingung. Bleibt ein reiner **Heartbeat**-Begriff: Zähler
und Paar haben ihre eigenen Zeitparameter (Fenster, Offenzeit), keine zweite Karenz daneben.

**Ausnahmetag**:
Ein manuell gesetztes Datum, an dem die **Zeit-Solls** ausgesetzt sind — und nur die:
Kalenderplan-Soll-Zeitpunkte entfallen (kein „überfällig"; das Abdeckungs-Fenster des nächsten
Solls reicht bis zum letzten wirksamen Soll zurück), und die **Untergrenze** des Zähl-Monitors
wird nicht gewertet („normal 100/Tag, am Feiertag 0" darf nicht alarmieren; danach greift der
**Anlauf**). Die Obergrenze bleibt scharf — ein Meldungssturm am Feiertag ist erst recht ein
Befund. Intervall, Ereignis und Paar sind unberührt; für die gibt es **Pausiert**. Deckt
Feiertage ab, solange kein automatischer Feiertagskalender existiert (Folgeversion). Kann als
benannter, wiederverwendbarer Ausnahmekalender gebündelt werden.

### Kunde & Zuordnung

**Kunde**:
Eigene Entität: das Unternehmen, dessen Systeme überwacht werden. Träger der
**Zuordnungs-Merkmale** und der optionalen **Autotask-Verknüpfung**; jeder Monitor gehört genau
einem Kunden. Das Systemhaus selbst wird für die eigene Infrastruktur als ganz normaler Kunde
geführt — kein Sonderkonzept „intern". Lebenszyklus: aktiv ⇄ **archiviert**; hartes Löschen nur
für Fehlanlagen ohne Historie.

**Kunden-Zuordnung**:
Die zweistufige Pipeline **Mail → Kunde → Monitor**: erst bestimmt Nightwatch über die
Zuordnungs-Merkmale den Kunden, dann matchen nur noch die Monitore *dieses* Kunden. Der Kunde
steht damit auch dann fest, wenn kein Monitor passt — das wertvollste Triage-Signal.

**Zuordnungs-Merkmal**:
Ein Merkmal am Kunden, über das eingehende Mails ihm zugeordnet werden. Feste, globale Priorität:
1. **Empfänger-Plus-Adresse** (`noc+kundea@…`, vom MSP vergeben, deterministisch),
2. **Kundennummer/Inhaltsmuster**, 3. **Absender** (Adresse oder Domain). Die höchste treffende
Stufe gewinnt sofort — kein Scoring, denn „warum landete die Mail bei Kunde B?" muss auf einen
Blick beantwortbar sein. _Avoid_: Score, Gewichtung.

**Mehrdeutig**:
Mehrere Kunden treffen auf **derselben** Stufe. Nightwatch rät nicht: die Mail geht in die
**System-Triage**, mit sichtbaren Kandidaten. Ein Ticket beim falschen Kunden ist der teuerste
Fehler der Zuordnung.

**Kollisionswarnung**:
Hinweis beim Pflegen eines Zuordnungs-Merkmals, das identisch schon bei einem anderen — auch
archivierten — Kunden steht. Speichern bleibt erlaubt (Übergangsphasen), aber Mehrdeutigkeit wird
an der Quelle sichtbar gemacht: bei der Konfiguration, nicht erst in der Mail.

**System-Triage**:
Die eine Dashboard-Liste für alles, was die Zuordnung nicht abschließen konnte. Führt **einzeln**
die beiden Kunden-Gründe: **kein Kunde erkannt** · **mehrdeutig** — echte Ausnahmen, die einzeln
entschieden werden. Der dritte Grund, **Kunde erkannt, aber kein Monitor passt**, wird bewusst
*nicht* einzeln geführt, sondern gruppiert als **unüberwachte Mail-Sorte**; sonst schüttet ein frisch
verbundenes Postfach mit null Monitoren jede eingehende Mail in die Triage. Erzeugt kein
Kunden-Ticket. Es gibt bewusst **keinen Default-Kunden** als Auffangbecken — der würde
Konfigurationslücken unsichtbar machen, dieselbe Sorte blinder Fleck wie die ausgebliebene Mail, die
niemand vermisst. Das Auflösen eines Eintrags legt dauerhaft ein **Zuordnungs-Merkmal** an, statt nur
die eine Mail zuzuordnen — sonst läge dieselbe Mail morgen wieder hier.

**Autotask-Verknüpfung**:
Optionale Verknüpfung eines Kunden mit seiner Autotask-Company (per Suche gesetzt, die stabile
Company-ID wird gespeichert; kein Dauer-Sync). Ohne Verknüpfung alarmiert der Kunde nur über
Dashboard und Webhook — legitim, nicht jeder Betreiber nutzt Autotask.

**Archiviert** _(Kunde)_:
Lebenszyklus-Zustand nach dem Offboarding. Monitore werden mitarchiviert (keine Auswertung, keine
Alarme, keine Dashboard-Ampel); offene Gestört-Zustände enden still **ohne** Entwarnung. Die
Zuordnungs-Merkmale greifen aber **weiter**: Rest-Mails abgeklemmter Geräte werden dem archivierten
Kunden zugerechnet und still abgelegt statt die System-Triage zu fluten. Historie bleibt erhalten.

### Klassifikation & Zuordnung

**Regel**:
Die Erkennungs-Logik innerhalb eines Monitors: Match-Kriterien + OK-/Fehler-Muster (das **Wie
erkenne ich's**). Der veränder- und lernbare Teil — „Regel überarbeiten" schärft die Muster nach,
ohne den Monitor neu zu bauen. Genau eine Regel pro Monitor. **Sprachunabhängig**: dieselbe Software
meldet je nach Konfig „Backup completed" / „Sicherung erfolgreich" / „Sauvegarde terminée" — Muster
dürfen mehrsprachig sein, und der **Klassifikator** deckt ab, was starre Muster nicht treffen. Eine
dedizierte Sprach-Erkennungs-Library ist dafür **nicht** nötig: die automatisch abgeleitete Schicht
(Absender, Betreff-Signatur, Takt) ist sprachneutral, die per Hand markierte Schicht ist es
konstruktionsbedingt. Herkunft einer Regel → **Regel-Quelle**.

**Regel-Vorlage**:
Eine mitgelieferte, kuratierte Regel für die Benachrichtigungen eines bekannten Herstellers/Produkts
(„Veeam-Report erkennen wir out of the box"). Eine der drei **Regel-Quellen**. Liegt als
versionierte Daten-Datei **im Container-Image** und wird **mit Releases** aktualisiert — kein
eigener Nachlade-Kanal neben dem Releases-Check, keine Netzwerkabhängigkeit im Betrieb. Der
Betreiber kann eigene Regeln als Vorlage **exportieren und importieren** und sich so einen eigenen
Fundus bauen, ohne dass Daten das Haus verlassen.

**Match-Kriterien**:
Die Merkmale, mit denen ein Monitor „seine" Mails erkennt: Absender, Betreff-Muster, Schlüsselwörter.
Wirken erst **nach** der Kunden-Zuordnung, nur innerhalb der Monitore des erkannten Kunden — die
Unterscheidung der Kunden ist Sache der **Zuordnungs-Merkmale**, nicht der Match-Kriterien. Eine Mail
gehört **genau einem** Monitor; treffen mehrere Monitore desselben Kunden, gewinnt der **ältere** —
kein Scoring, dieselbe Haltung wie bei den Zuordnungs-Merkmalen. Eine Regel ohne jedes Kriterium ist
keine Regel: sie würde jede Mail ihres Kunden schlucken und alle anderen Monitore aushungern.

**Muster-Slots**:
Die zwei generischen Muster-Felder jeder Regel — ein Schlecht- und ein Gut-Signal —, die jede
**Monitor-Art** auf ihre Weise deutet: Heartbeat **Fehler-/OK-Muster** (Klassifikation), Ereignis
**— / Harmlos-Filter**, Paar **Auf-/Zu-Muster**; der Zähler nutzt sie nicht. Eine Struktur, vier
Lesarten — der Wizard beschriftet die Felder je Art um, der Klassifikator-Steckplatz sitzt an
einer Stelle. Eine passende Mail, die keinen Slot trifft, ist **Unklar** (Ausnahme: die Zu-Mail
ohne offenen Zustand beim Paar ist neutral).

**Harmlos-Filter**:
Der Gut-Slot des **Ereignis-Monitors**: ein optionales Muster, das passende, aber unkritische
Mails vom Auslösen ausnimmt („Update erfolgreich installiert" neben „Update verfügbar" vom selben
Absender). Eine harmlose Mail löst nicht aus, **erholt aber auch nicht** — sie ist kein
Gegenstück; gäbe es eins, wäre es ein **Paar-Monitor**.

**Klassifikation**:
Dreiwertige Beurteilung einer zugeordneten Mail: **OK** (OK-Muster trifft) / **Fehler** (Fehler-Muster
trifft, hat **Vorrang**) / **Unklar** (keins trifft).

**Klassifikator**:
Die austauschbare Engine, die eine zugeordnete Mail als OK/Fehler/Unklar beurteilt. v1
muster-basiert (Regex/Betreff/Absender), mit sauberer **Naht für intelligente Extraktion** aus
unstrukturierten Berichts-Mails — lokales Modell **oder** ein vom Betreiber optional angebundener
LLM (bleibt selfhosted-konform, weil optional und selbst konfiguriert). Der Differenzierer gegenüber
starrem Regex-Parsing (Beta-Tester-Signal). Wirkt zur **Laufzeit** — er beurteilt eingehende Mails
und senkt die **Unklar**-Quote —, **nicht** zur Anlagezeit: beim Anlegen einer Regel schlägt er
keine OK-/Fehler-Muster vor. Tech-Naht → #7.

**Unklar**:
Eine zugeordnete, aber nicht eindeutig klassifizierbare Mail. **Eskaliert** wie ein Fehler (erzeugt
Kunden-Ticket, Kunde ist bekannt), aber mit eigenem Alarmgrund und empfohlener Aktion „Regel
überarbeiten" statt „Störung beheben". Verhindert, dass neue, unbekannte Fehlertexte still als OK
durchrutschen.

**Unzugeordnet**:
Eine Mail, die die Kunden-Zuordnung nicht abschließen konnte — kein Kunde erkannt, mehrdeutig, oder
Kunde erkannt, aber kein Monitor passt. Erzeugt **kein** Kunden-Ticket. Die ersten beiden Gründe
landen einzeln in der **System-Triage**, der dritte gruppiert als **unüberwachte Mail-Sorte**. Beide
Wege speisen die **Regel-Entstehung**.

### Regel-Entstehung

**Regel-Quelle**:
Woher eine neue Regel stammt. Drei Quellen: **manuell** (der Mensch füllt alles) · **Regel-Vorlage**
(kuratiert mitgeliefert) · **aus Mail abgeleitet** (aus einer Beispiel-Mail gewonnen). Die Quelle ist
nur die Startrampe — alle drei münden in dieselbe Anlage-Fläche und unterscheiden sich allein im
**Vorbefüllungs-Grad**. Keine Regel wird ohne menschliche Bestätigung aktiv.

**Vorbefüllungs-Grad**:
Wie viel die **Regel-Quelle** in die Anlage-Fläche schreibt, bevor der Mensch bestätigt: nichts
(manuell) · Art + Erkennung + Parameter-Defaults (Vorlage) · Erkennung + Art-Vermutung + Takt
(aus Mail). Ein Begriff statt dreier getrennter Anlage-Wege — ein mentales Modell, ein
Bestätigungs-Gate, und der Klassifikator-Steckplatz sitzt an genau einer Stelle. Leitsatz der
Ableitung: **Schicht 1 befüllt Zeitliches und Strukturelles, nie Inhaltliches** — Match-Kriterien,
Takt → Erwartung, Karenz aus der beobachteten Streuung, Zähler-Fenster und -Grenzen aus der
Lernfenster-Statistik, Paar-Offenzeit nachgelagert aus beobachteten Auf→Zu-Dauern (sobald die
Muster markiert sind). Als Art vermutet die Automatik nur **Heartbeat** (Takt erkannt) oder
**Ereignis** (kein Takt) — Paar und Zähler wählt der Mensch bewusst. Muster (Schicht 2),
Auto-Zurück-Zeit und die finale Bestätigung sind immer Menschensache; jeder Vorschlag trägt
seinen **Beleg**.

**Lernfenster** _(Backfill)_:
Der begrenzte Vorrat vergangener Mails, den Nightwatch beim Verbinden eines Postfachs einmalig zieht
(Größenordnung 30 Tage, konfigurierbar). Er speist **Mail-Suche**, Ableitung aus Mail und
Takt-Erkennung — denn Delta-Polling liefert sonst nur Neues, und ohne Vorrat wäre die Ableitung an
Tag 1 zahnlos. Es gilt strikt:
> **Historie ist Lernmaterial, nicht Überwachungsmaterial.**

Ein Monitor wertet ausschließlich **ab seiner Aktivierung vorwärts**, nie rückwirkend. Kein Alarm
und kein Ticket für eine Lücke, die vor der Anlage lag — sonst wäre jedes frisch verbundene Postfach
eine Ticket-Lawine.

**Takt** _(Rhythmus)_:
Der erkannte Eingangs-Rhythmus einer Mail-Sorte. Gilt als **erkannt** ab **3 Vorkommen** im
Lernfenster, wenn die Streuung der Abstände höchstens ~25 % des Median-Abstands beträgt
(absoluter Boden 15 Minuten, damit „alle 5 min ± 2 min" nicht durchfällt). Es gibt genau **eine**
Schwelle: „**wiederkehrend**" (das Listungs-Kriterium der unüberwachten Mail-Sorten) und die
Takt-Vorbefüllung meinen dieselbe — Schwelle 3 statt 5, weil wöchentliche Reports im
~30-Tage-Lernfenster sonst nie erkannt würden. Takt-Klassen: **Intervall** („alle ~X") ·
**täglich** ~HH:MM · **werktäglich** ~HH:MM (systematische Wochenend-Lücke) · **wöchentlich** am
Wochentag ~HH:MM. **Monatlich bewusst nicht** — das Lernfenster gibt keine 3 Vorkommen her;
Monats-Reports legt der Mensch als Kalenderplan an. Ein Takt-Vorschlag erscheint immer **mit
Beleg** („werktäglich ~05:40, aus 12 Vorkommen").

**Unüberwachte Mail-Sorte**:
Eine wiederkehrende Mail-Sorte eines bekannten Kunden, für die es noch keinen Monitor gibt —
gruppiert nach **Sorten-Signatur**, mit Anzahl, letztem Eingang und erkanntem Takt. Ersetzt für den
Triage-Grund „Kunde erkannt, kein Monitor" die Einzel-Einträge und ist zugleich der
Onboarding-Einstieg und die Heimat der Vorschläge („diese Sorte kommt täglich — überwachen?"). Eine
Ansicht, die der Betreiber **öffnet** — kein Hintergrund-Scan, der ihm Kandidaten aufdrängt. Die
Gruppierung ist auch die ehrlichere Darstellung: nicht 400 Probleme, sondern 7 unüberwachte Sorten.

**Sorten-Signatur**:
Das Merkmal, nach dem gleichartige Mails zu einer **unüberwachten Mail-Sorte** zusammengefasst
werden (Absender + Betreff-Muster). Nicht zu verwechseln mit den **Match-Kriterien**: die Signatur
gruppiert *noch unüberwachte* Mails zur Ansicht, die Match-Kriterien binden Mails an einen
*bestehenden* Monitor.

**Ignorierte Sorte**:
Eine bewusst abgewählte **unüberwachte Mail-Sorte** („nicht überwachen") — Newsletter, Rechnungen,
Hersteller-Werbung. Verschwindet aus der Arbeitsliste in eine einsehbare **Ablage** und ist von dort
zurückholbar; neue Vorkommen tauchen nicht wieder auf. Wirkt **pro Kunde und Sorte**, nie global —
ein bei Kunde A abgewählter Absender darf dieselbe Sorte bei Kunde B nicht mit ausblenden. Zusammen
mit der Regel, dass nur Wiederkehrendes überhaupt gelistet wird, macht das die Liste **auf null
fahrbar**; „null" heißt dann: alles Wiederkehrende in diesem Postfach ist überwacht oder bewusst
abgewählt.

**Mail-Suche**:
Der freie Zugriff auf **alle** ingestierten Mails — auch ignorierte, einmalige und bereits
überwachte. Gegenstück zur kuratierten Liste der unüberwachten Sorten: diese sagt, was zu tun ist,
die Suche beantwortet alles andere („was hat der Monitor gestern gesehen?", „kam von diesem Absender
je etwas?"). Der Ausweg, wenn die Gruppierung danebenliegt. Aus einem Treffer startet die
Regel-Anlage vorbefüllt.

### Zustandsmaschine

**Gesund**:
Kern-Zustand ohne aktive Störung. Eine als OK eingetroffene Mail hält den Monitor gesund und
aktualisiert nur „zuletzt gesehen" — kein Zustandswechsel.

**Gestört**:
Kern-Zustand, sobald die Schlecht-Bedingung erfüllt ist. Trägt einen **Alarmgrund**. Es gibt nur
diese zwei Kern-Zustände; „überfällig" und „Fehler gemeldet" sind beide `Gestört`, nur mit
unterschiedlichem Alarmgrund. „Alarmiert" und „erholt" sind **Übergänge**, keine Zustände.

**Alarmgrund**:
Der Grund für den Übergang nach `Gestört`: überfällig / Fehler gemeldet / unklar (nicht
klassifizierbar) / Ereignis eingetroffen / Paar zu lange offen / Zähler über Obergrenze /
Zähler unter Untergrenze. Der Monitor trägt stets den **aktuellen** Grund (Dashboard live);
Grund-Wechsel während `Gestört` → **Verschärfung**.

**Pausiert**:
Eine Überlagerung der 2-Zustands-Maschine (orthogonal: aktiv/pausiert) für geplante Wartung.
Während `Pausiert` feuert keine Schlecht-Bedingung und kein Alarm; optional mit Auto-Ende. Fürs
Dashboard sichtbar verschieden von „aus" und von `Gestört`. Unterdrückt wird nur die
**Schlecht-Richtung**, nicht die Beobachtung: zuletzt gesehen, offener Paar-Zustand und
Klassifikation laufen weiter, und eine **Erholung** wirkt auch während der Pause — eine Wartung darf
einen Monitor nicht dauerhaft gestört zurücklassen.

### Alarm-Lebenszyklus

**Alarm**:
Das nach außen wirkende Signal beim Übergang gesund → gestört. Trägt einen **Alarmgrund**
(überfällig / Fehler gemeldet / unklar / Ereignis eingetroffen / Paar zu lange offen / Zähler
über Obergrenze / Zähler unter Untergrenze).

**Entwarnung**:
Das nach außen wirkende Signal beim Übergang gestört → gesund (Erholung). Erstklassiges Ereignis,
kein stiller Wechsel: kommentiert ein erzeugtes Ticket **immer** (mit Anlass, Störungsdauer und
Vorkommens-Zusammenfassung), **schließt** es aber nur bei **beweisbasierter Erholung** und wenn
noch niemand daran arbeitet. Nach außen wirkt sie erst nach der **Entwarnungs-Stabilität**.
_Avoid_: Recovery-Mail (Entwarnung ist ein internes Signal, keine Mail).

**Beweisbasierte Erholung**:
Erholung, die eine eingetroffene Mail belegt: Heartbeat-OK, „Zu"-Mail des Paars, normalisierte
Rate/Menge. Gegenstück zu Zeitablauf (**Auto-Zurück**) und Handgriff (**Erledigen**) — die sind
kein Beweis. Nur beweisbasierte Erholung darf ein Ticket automatisch schließen; alles andere
kommentiert nur. Ein nach Zeitablauf stillgelegtes Ereignis-Ticket darf nicht ungelesen zugehen.

**Entwarnungs-Stabilität**:
Stabilitätsfenster zwischen interner Erholung und Entwarnung nach außen (Größenordnung 15 Minuten,
pro Monitor übersteuerbar). Der Alarm wirkt sofort — Alarme müssen schnell sein —, die Entwarnung
wartet, bis die Erholung hält. Intern wechselt der Zustand sofort (Dashboard live). Ein flatternder
Monitor hält so genau ein offenes Ticket statt einer Ticket-Serie.

**Quittieren**:
Dashboard-Marker „gesehen/in Arbeit" an einem aktiven Alarm. Ändert weder den Zustand noch wirkt
es nach außen; erlischt mit der Erholung. Dahinter steht bewusst kein Reminder-System: es wird
genau einmal pro Übergang alarmiert, die Eskalationsfläche ist das PSA-Ticket.
_Avoid_: Acknowledge, Erledigen (das ist ein Zustandswechsel).

**Erledigen**:
Manuelle Erholung eines Ereignis-Monitors: der Mensch setzt gestört → gesund zurück, weil das
Ereignis behandelt ist. Löst eine Entwarnung aus, ist aber keine beweisbasierte Erholung —
kommentiert nur, schließt nie.
_Avoid_: Quittieren (das ist nur ein Marker ohne Zustandswechsel).

**Auto-Zurück**:
Zeitbasierte Erholung eines Ereignis-Monitors: bleibt ein neues Vorkommen für eine eingestellte
Zeit aus (Größenordnung 24 Stunden), kehrt er von selbst nach gesund zurück. Wie Erledigen keine
beweisbasierte Erholung — kommentiert nur, schließt nie.

**Verschärfung**:
Wechsel des Alarmgrunds **zu „Fehler gemeldet"**, während der Monitor gestört bleibt:
unklar → Fehler („aus Regel prüfen ist ein echter Vorfall geworden") ebenso wie
überfällig → Fehler („jetzt wissen wir, warum nichts kam"). Der einzige Anlass, zu dem ein
offenes Ticket zwischendurch automatisch kommentiert wird — alle anderen Grund-Wechsel (etwa
Fehler → überfällig: nach Fehlermails verstummt) und weitere Vorkommen desselben Grunds werden
nur intern gezählt (Zähler, „zuletzt gesehen"), die Zusammenfassung kommt mit der Entwarnung.

**Ingestion-Gate**:
Aussetzen (nicht Verwerfen) der Überfällig-Entscheidungen, solange die Ingestion selbst
nachweislich gestört ist (kein Polling, Auth-Fehler) — statt einer Flut falscher Kunden-Tickets
feuert genau ein Selbst-Alarm. Wirkt **postfach-scharf**: jeder Monitor kennt sein Postfach über
die zuletzt zugeordneten Mails; ist der globale **Selbst-Monitor** gestört, gilt das Gate für
alles. Fälligkeit wird gegen die **Postfach-Ankunftszeit** der Mail bewertet, nicht gegen den
Verarbeitungszeitpunkt — nach dem Aufholen des Rückstands steht fest, was wirklich fehlte
(alarmiert jetzt) und was nur spät verarbeitet wurde (bleibt gesund, feuert nie). Öffnet erst
nach stabiler Erholung des Selbst-Monitors **und** aufgeholtem Rückstand. Stopft die größte
Sturmquelle an der Wurzel.

**Rückverweis**:
Deep-Link, den jeder Alarm bzw. jedes erzeugte Ticket zurück ins Nightwatch-UI trägt — direkt zum
auslösenden Monitor bzw. seiner Regel, um das Monitoring zu überarbeiten.

**Alarmweg**:
Der Kanal, über den ein Ereignis des Alarm-Lebenszyklus nach außen wirkt. Das **Dashboard** ist
immer an und ist kein Weg im engeren Sinn: es liest den Zustand direkt, es wird ihm nichts
zugestellt. Zugestellt wird an **Autotask-Ticket** und **generischen Webhook** — beides
Zustell-**Ziele** mit eigener durabler Warteschlange. Der Lebenszyklus entscheidet dabei nur die
*Semantik* („Ticket eröffnen", „kommentieren", „schließen"), den *Zustand* prüft das Ziel:
schließen darf nur, wer eine beweisbasierte Erholung **und** ein unberührtes Ticket vorfindet.
Weisungen desselben Ziels werden **nacheinander** ausgeführt — ein Alarm, der einen Schließ-Auftrag
überholt, fände dessen Ticket noch offen und hinge sich an, statt ein neues aufzumachen.
_Avoid_: Alarmkanal, Benachrichtigungsweg.

### Self-Monitoring

**Selbst-Monitor**:
Eingebauter System-Monitor, mit dem Nightwatch sich selbst überwacht. Zwei Ausprägungen: einer
**pro Postfach** („Ingestion Postfach X" — Polling ausgefallen oder Zugriff entzogen) und ein
**globaler** („Nightwatch-Kern" — Verarbeitung, Datenhaltung oder Alarm-Zustellung gestört). Erbt
Zustandsmaschine und Alarm-Lebenszyklus vollständig: ein Alarm pro Übergang, ein offenes Ticket,
Entwarnungs-Stabilität; ein erfolgreicher Poll ist **beweisbasierte Erholung**. Sonderstellung:
wird außerhalb der normalen Alarm-Pipeline ausgewertet und gesendet — unabhängiger Absender,
gleiche Empfänger —, ist nicht anlegbar, nicht löschbar, nicht pausierbar (Parameter ja, Existenz
nein) und erscheint im Dashboard als System-Banner, nicht als Kunden-Karte. Gehört keinem Kunden;
wohin sein Ticket geht, ist reine Transport-Konfiguration.

**Wurzel-Unterdrückung**:
Ist der globale Selbst-Monitor gestört, feuern die Postfach-Selbst-Monitore nicht zusätzlich —
ein toter Kern macht zwangsläufig alle Postfächer still, das ist **ein** Befund, nicht viele.
Dasselbe Prinzip wie das **Ingestion-Gate**, eine Ebene tiefer angewendet. Generell gilt:
Symptome (Staleness) fangen jede Ursache, harte Ursachen (z. B. entzogener Zugriff) beschleunigen
nur und liefern besseren Ticket-Text.

**Heartbeat-Ping**:
Ausgehendes Lebenszeichen (opt-in) an eine frei konfigurierbare URL des Betreibers — sein RMM,
ein eigenes Monitoring, ein Dienst nach Wahl. Feuert **nur bei innerer Gesundheit**: eine
degradierte Instanz verstummt, und der *Empfänger* schlägt an. Deckt als einziger Mechanismus den
Totalausfall ab (Host/Netz down), den kein Prozess der Instanz selbst melden kann — Nightwatchs
Dead-Man's-Switch-Prinzip, auf sich selbst angewendet. Keine Drittanbieter-Abhängigkeit: ohne
konfigurierten Empfänger ist der Totalausfall schlicht unbeobachtet, und das Dashboard sagt das.
