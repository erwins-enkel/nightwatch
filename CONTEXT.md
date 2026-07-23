# Nightwatch

E-Mail-Monitoring für MSPs/IT-Systemhäuser. Kern ist das Erkennen **ausbleibender**
erwarteter Benachrichtigungsmails (Heartbeat) — plus klassische Fehler- und Ereignis-Erkennung.
Dieses Glossar ist die verbindliche Sprache des Efforts (Deutsch).

> Status: in Arbeit über Wayfinder-Map #1, Ticket #5 (Domänenmodell). Begriffe mit
> „(vorläufig)" sind inhaltlich geklärt, aber der Name ist noch nicht ratifiziert.

## Language

### Monitor & Arten

**Monitor**:
Die atomare Überwachungseinheit — eine pro überwachtem Ding: das **Was**. Führt einen
Gesundheitszustand und alarmiert bei Störung/Erholung nach außen. Hat genau eine **Monitor-Art**,
(bei Heartbeat) eine **Erwartung** und genau eine **Regel**. Der Mensch legt ihn bewusst an.
_Avoid_: Wächter, Überwachung, Check.

**Monitor-Art**:
Der Charakter eines Monitors. Ein **offenes, erweiterbares Set** (nicht zwei feste Fälle) —
neue Arten kommen später hinzu, ohne die Zustandsmaschine zu ändern. Jede Art erfüllt denselben
**Dreiklang-Vertrag**.

**Dreiklang-Vertrag**:
Der gemeinsame Vertrag jeder Monitor-Art, definiert durch drei Fragen:
1. **Auslöser** — was startet eine Auswertung? (eingehende Mail / Zeitablauf / beides)
2. **Schlecht-Bedingung** — wann kippt der Monitor in einen Störungs-Zustand?
3. **Erholungs-Bedingung** — was holt ihn in den gesunden Zustand zurück?

**Heartbeat-Monitor**:
Erwartet Mails in Regelmäßigkeit. Schlecht, wenn die erwartete Mail **ausbleibt** (überfällig)
**oder** eine eingetroffene Mail als Fehler klassifiziert wird. Beispiel: nächtlicher Backup-Report.

**Ereignis-Monitor**:
Mails kommen nur im Störungsfall und haben **kein** natürliches Gegenstück. Schlecht, sobald eine
passende Mail **kommt**. Beispiel: „Firmware-Update verfügbar".

**Paar-Monitor** _(auch: Zustands-Monitor)_:
Verfolgt einen **offenen Zustand** aus paarweisen Mails: eine „Auf"-Mail öffnet, eine „Zu"-Mail
schließt. Schlecht, wenn zu lange offen; erholt mit der „Zu"-Mail. Beispiel: Router „Leitung ab" …
„Leitung wieder da"; Job „gestartet" … „beendet".

**Schwellwert-Monitor** _(auch: Raten-Monitor)_:
Schlecht, wenn mehr als N passende Mails in Zeitfenster T eintreffen (Meldungssturm, Flapping);
erholt, wenn die Rate sich normalisiert.

**Volumen-Monitor** _(auch: Abweichungs-Monitor)_:
Schlecht, wenn die Mail-Menge stark vom erlernten Normalwert abweicht; erholt im Normalbereich.
Beispiel: „normal ~100 OK/Tag, heute nur 3".

### Erwartung (Heartbeat)

**Erwartung**:
Die Soll-Definition eines Heartbeat-Monitors, wann eine Mail eintreffen muss. Zwei Ausprägungen:
**Intervall** oder **Kalenderplan**. Immer mit **Karenz**.

**Intervall**:
Gleitendes „spätestens alle X". Die Uhr startet bei jeder eingetroffenen Mail neu; kennt keine
Uhrzeit/Wochentage. Für simple, gerätenahe Heartbeats („alle 5 min").

**Kalenderplan**:
Absolute Soll-Zeitpunkte, cron-artig („Mo–Fr bis 06:00"). Bildet Arbeitstage/Uhrzeiten direkt ab;
deckt Wochenenden ohne Zusatzkonzept mit ab. Für geplante Jobs (Backups, Reports).

**Karenz** _(Toleranzfenster)_:
Puffer nach dem Soll-Zeitpunkt, bevor `Gestört` mit Grund „überfällig" ausgelöst wird. Kein
eigener Zustand — Teil der Schlecht-Bedingung.

**Ausnahmetag**:
Ein manuell gesetztes Datum, an dem eine Kalenderplan-Erwartung ausgesetzt ist (kein „überfällig").
Deckt Feiertage ab, solange kein automatischer Feiertagskalender existiert (Folgeversion). Kann als
benannter, wiederverwendbarer Ausnahmekalender gebündelt werden.

### Klassifikation & Zuordnung

**Regel**:
Die Erkennungs-Logik innerhalb eines Monitors: Match-Kriterien + OK-/Fehler-Muster (das **Wie
erkenne ich's**). Der veränder- und lernbare Teil — „Regel überarbeiten" schärft die Muster nach,
ohne den Monitor neu zu bauen. Genau eine Regel pro Monitor. Herkunft einer Regel → Ticket #9.

**Regel-Vorlage**:
Eine mitgelieferte, kuratierte Regel für die Benachrichtigungen eines bekannten Herstellers/Produkts
(„Veeam-Report erkennen wir out of the box"). Dritte Regel-Quelle neben manuell und gelernt; Detail
→ Ticket #9.

**Match-Kriterien**:
Die Merkmale, mit denen ein Monitor „seine" Mails erkennt: Absender, Betreff-Muster, Empfänger inkl.
Plus-Notation (`noc+kundea@…`), Schlüsselwörter. Konfliktauflösung bei Mehrfach-Treffern → Ticket #6.

**Klassifikation**:
Dreiwertige Beurteilung einer zugeordneten Mail: **OK** (OK-Muster trifft) / **Fehler** (Fehler-Muster
trifft, hat **Vorrang**) / **Unklar** (keins trifft).

**Klassifikator**:
Die austauschbare Engine, die eine zugeordnete Mail als OK/Fehler/Unklar beurteilt. v1
muster-basiert (Regex/Betreff/Absender), mit sauberer **Naht für intelligente Extraktion** aus
unstrukturierten Berichts-Mails — lokales Modell **oder** ein vom Betreiber optional angebundener
LLM (bleibt selfhosted-konform, weil optional und selbst konfiguriert). Der Differenzierer gegenüber
starrem Regex-Parsing (Beta-Tester-Signal). Detail → Ticket #9, Tech-Naht → #7.

**Unklar**:
Eine zugeordnete, aber nicht eindeutig klassifizierbare Mail. **Eskaliert** wie ein Fehler (erzeugt
Kunden-Ticket, Kunde ist bekannt), aber mit eigenem Alarmgrund und empfohlener Aktion „Regel
überarbeiten" statt „Störung beheben". Verhindert, dass neue, unbekannte Fehlertexte still als OK
durchrutschen.

**Unzugeordnet**:
Eine Mail, die zu **keinem** Monitor passt. Erzeugt **kein** Kunden-Ticket (Kunde unbekannt), sondern
landet in einer **System-Triage** im Dashboard. Speist die Regel-Entstehung (Ticket #9).

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
klassifizierbar) / Ereignis eingetroffen / Rate überschritten / Paar zu lange offen.

**Pausiert**:
Eine Überlagerung der 2-Zustands-Maschine (orthogonal: aktiv/pausiert) für geplante Wartung.
Während `Pausiert` feuert keine Schlecht-Bedingung und kein Alarm; optional mit Auto-Ende. Fürs
Dashboard sichtbar verschieden von „aus" und von `Gestört`.

### Alarm-Lebenszyklus

**Alarm**:
Das nach außen wirkende Signal beim Übergang gesund → gestört. Trägt einen **Alarmgrund**
(überfällig / Fehler gemeldet / Ereignis eingetroffen / Rate überschritten / Paar zu lange offen).

**Entwarnung**:
Das nach außen wirkende Signal beim Übergang gestört → gesund (Erholung). Erstklassiges Ereignis,
kein stiller Wechsel: kann z. B. ein Autotask-Ticket kommentieren oder schließen.
_Avoid_: Recovery-Mail (Entwarnung ist ein internes Signal, keine Mail).

**Rückverweis**:
Deep-Link, den jeder Alarm bzw. jedes erzeugte Ticket zurück ins Nightwatch-UI trägt — direkt zum
auslösenden Monitor bzw. seiner Regel, um das Monitoring zu überarbeiten.
