# Nightwatch

**Self-hosted E-Mail-Monitoring, das auch die Meldungen bemerkt, die _nie ankommen_.**

[English](README.md) · Deutsch

---

## TL;DR

- **Der blinde Fleck.** E-Mail-Monitoring reagiert nur auf Nachrichten, die *ankommen*. Läuft
  die Backup-Software gar nicht mehr, verschickt sie auch keine Fehlermail. Stille liest sich
  wie „alles in Ordnung".
- **Was Nightwatch macht.** Es überwacht **Ausbleiben**: Eine erwartete Benachrichtigung, die
  nicht eintrifft, ist selbst der Alarm — ein Dead-Man's-Switch pro überwachtem System, neben
  klassischer Fehler-, Ereignis-, Paar- und Zähler-Erkennung.
- **Für wen.** MSPs, IT-Systemhäuser und Drucker-/Device-Spezialisten, die Maschinenmeldungen
  ohnehin per E-Mail bekommen und sie zuverlässig überwacht brauchen.
- **Wie es läuft.** Ein Docker-Compose-Stack in **eurer** Infrastruktur. Keine
  Nightwatch-Cloud, kein Control-Plane, keine Lizenzgebühr pro überwachtem Kunden.
- **Wo es steht.** Spezifikation fertig, Umsetzung läuft — **noch nichts installierbar**. Siehe
  [Roadmap](#roadmap--was-kommt).
- **Lizenz.** [AGPL-3.0](LICENSE) — betreiben, lesen, forken, den Fork behalten.
- **Mitmachen?** → [Mitmachen](#mitmachen). Pilot-Betreiber und Regel-Vorlagen sind diesem
  Projekt gerade mehr wert als alles andere.

> **Status: Spezifikation abgeschlossen — Umsetzung läuft.**
> Es gibt noch kein installierbares Release: kein veröffentlichtes Image, keine
> `docker-compose.yml` in diesem Repository. Was es *gibt*, ist eine bau-fertige Spezifikation
> ([SPEC.md](SPEC.md)), ein verbindliches Domänen-Glossar ([CONTEXT.md](CONTEXT.md)), drei
> Research-Dokumente und ein vollständig ausgeplantes Umsetzungs-Epic
> ([#37](https://github.com/erwins-enkel/nightwatch/issues/37)), dessen erstes Issue in Arbeit
> ist. Alles unter *Wie es funktioniert*, *Architektur* und *Deployment* beschreibt das
> vereinbarte Ziel — nicht etwas, das ihr heute starten könnt.

---

## Warum Nightwatch

Monitoring wird pro Seat, pro Endpoint, pro Postfach abgerechnet — und die Rechnung wächst
jedes Jahr. Die Werkzeuge, mit denen ihr die Systeme eurer Kunden überwacht, halten deren Daten
meist in einer Cloud, die euch nicht gehört, zu Bedingungen, die ihr nicht setzt; und der
Ausstieg kostet mehr als der Einstieg. Für einen Managed Service Provider ist das eine
wiederkehrende Kostenposition, die mit dem eigenen Erfolg mitwächst — plus eine Abhängigkeit,
die ihr weder prüfen noch selbst reparieren könnt.

Nightwatch setzt an der Gegenannahme an:

- **Es läuft in eurer Infrastruktur.** Ein Compose-Stack auf eigener Hardware, einem
  DigitalOcean-Droplet, einer Azure-VM — eure Wahl. Es gibt kein von Nightwatch betriebenes
  Control-Plane und keinerlei Telemetrie oder Nutzungsmeldung.
- **Keine Lizenz pro Kunde.** Ob ihr drei Kunden überwacht oder dreihundert: Die Kosten sind die
  Kiste, auf der es läuft.
- **Die Daten eurer Kunden bleiben im Haus.** Mails werden aus den Postfächern gelesen, auf die
  ihr Nightwatch richtet, liegen in eurem Postgres und werden nach eurer Frist gelöscht. Im
  Betrieb spricht Nightwatch nur mit den Systemen, die ihr konfiguriert.
- **AGPL-3.0.** Jede Zeile ist lesbar, lauffähig und forkbar. Niemand — wir eingeschlossen —
  kann es wieder zumachen und euch als Abo vermieten.

Diese Unabhängigkeit betrifft den *Betriebsort*, nicht ein Schweigegelübde nach außen: Um seine
Arbeit zu tun, spricht v1 mit den Systemen, auf die ihr es richtet, und mit den Integrationen,
die ihr aktiviert:

| Fremdsystem | Rolle in v1 | Pflicht? |
| --- | --- | --- |
| **Microsoft 365 / Microsoft Graph** | Liest die überwachten Postfächer (Ingestion) | **Pflicht** in v1 — die einzige Ingestion-Quelle |
| **Autotask (Kaseya PSA)** | Legt Tickets beim richtigen Kunden an und aktualisiert sie | Opt-in-Alarmweg |
| **GitHub-Releases-API** | Speist den eingebauten „Update verfügbar"-Check | Opt-in; ignorierbar |

Die ausführlichen Grundlagen dazu:
[`docs/research/m365-graph-ingestion.md`](docs/research/m365-graph-ingestion.md) ·
[`docs/research/autotask-api.md`](docs/research/autotask-api.md) ·
[`docs/research/distribution-updates.md`](docs/research/distribution-updates.md).

## Der blinde Fleck: stille Ausfälle verstecken sich im vollen Postfach

Die meisten E-Mail-Überwachungen reagieren nur auf Fehlermeldungen. Das lässt eine Lücke: Wenn
die Backup-Software (oder der Router, oder die Druckerflotte) gar nicht mehr läuft, verschickt
sie auch nichts mehr — auch keine Fehlermail. Es kommt keine Nachricht, also sieht nichts falsch
aus.

Gleichzeitig füllt sich das Postfach mit „OK / erfolgreich abgeschlossen"-Meldungen. Wer sich
durch hunderte grüne Mails scrollt, bemerkt nicht den einen Report, der letzten Dienstag still
ausgeblieben ist. Genau diese Lücke ist der Ausfall, von dem ihr am dringendsten wissen müsstet.

Nightwatch schließt sie, indem eine erwartete Nachricht, die nicht in ihrem Zeitfenster
eintrifft, selbst zum Alarm wird.

## Für wen

IT-nahe Unternehmen, die Maschinenmeldungen ohnehin per E-Mail bekommen und sie zuverlässig
überwacht brauchen: **Managed Service Provider**, **IT-Systemhäuser** und
**Drucker-/Device-Spezialisten**. Nightwatch v1 ist ein Werkzeug für das eigene Team des
Dienstleisters — ein einzelnes Postfach trägt typischerweise Meldungen vieler Kunden, und
Nightwatch ordnet jede Mail dem richtigen zu.

---

## Wie es funktioniert

Das Vokabular ist bewusst klein und in [CONTEXT.md](CONTEXT.md) verbindlich festgelegt.

### Monitor und Regel

- Ein **Monitor** ist die atomare Überwachungseinheit — einer pro überwachtem Ding. Ein Mensch
  legt ihn bewusst an. Er gehört genau einem Kunden, hat genau eine **Monitor-Art**, führt einen
  Gesundheitszustand und löst bei Zustandswechsel einen **Alarm** oder eine **Entwarnung** aus.
- Jeder Monitor enthält genau eine **Regel** — die Erkennungslogik (Match-Kriterien plus zwei
  art-gedeutete Muster-Slots). Die Regel ist der lernbare, änderbare Teil: „Regel überarbeiten"
  schärft die Muster, ohne den Monitor neu zu bauen.
- Regeln sind **sprachunabhängig**: Dieselbe Software meldet vielleicht „Backup completed
  successfully", „Sicherung erfolgreich abgeschlossen" oder „Sauvegarde terminée" — Muster
  dürfen also mehrsprachig sein. Es gibt keinen separaten Spracherkennungs-Schritt.
- Regeln haben drei **Quellen** — von Hand geschrieben, aus einer kuratierten **Regel-Vorlage**,
  oder aus einer Beispiel-Mail abgeleitet. Das sind nur Vorbefüllungs-Grade derselben Fläche:
  **keine Regel wird ohne menschliche Bestätigung aktiv.**

### Monitor-Arten

Die Monitor-Arten sind ein **offenes, erweiterbares Set** — neue Arten kommen hinzu, ohne die
Zustandsmaschine zu ändern. Jede Art erfüllt denselben Dreiklang-Vertrag: **Auslöser**,
**Schlecht-Bedingung**, **Erholungs-Bedingung**. v1 liefert vier:

| Art | Auslöser | Schlecht, wenn… | Erholt sich, wenn… | Beispiel |
| --- | --- | --- | --- | --- |
| **Heartbeat** | Mail + Zeit | die erwartete Mail **überfällig** ist (es kam gar nichts) **oder** eine eingetroffene Mail als Fehler klassifiziert wird | eine passende OK-Mail eintrifft | nächtlicher Backup-Report |
| **Ereignis** | Mail | eine passende Mail **kommt** — die Ankunft *ist* das Ereignis (ein optionaler Harmlos-Filter nimmt unkritische Geschwister aus) | Auto-Zurück (Default 24 h) oder Erledigen — nie beweisbasiert | „Firmware-Update verfügbar" |
| **Paar** | Mail + Zeit | ein offener Zustand länger offen steht als die **maximale Offenzeit** (Default 0) | die Zu-Mail eintrifft — beweisbasiert | Router „Leitung ab" … „Leitung wieder da"; Job „gestartet" … „beendet" |
| **Zähler** | Mail + Zeit | der Zähler im gleitenden Fenster *T* die **Obergrenze** reißt (Meldungssturm) oder unter die **Untergrenze** fällt (Verstummen) | der Zähler wieder im Band liegt — beweisbasiert | „mehr als 50 in 10 Minuten"; „normal ~100 OK/Tag, heute 3" |

Zwei Ränder, die man kennen sollte: Beim Heartbeat erfüllt **jede** passende Mail die Erwartung
— Pünktlichkeit und Inhalt sind getrennte Dimensionen, und „überfällig" heißt exakt *es kam gar
nichts*, nicht „nichts Gutes". Beim Zähler hat die Untergrenze einen **Anlauf** (sie wird erst
scharf, wenn seit der Aktivierung ein volles Fenster vergangen ist), die Obergrenze dagegen gilt
ab Sekunde 1.

### Erwartung (nur Heartbeat)

Die **Erwartung** eines Heartbeat-Monitors definiert, wann eine Mail eintreffen muss — entweder
als **Intervall** (gleitendes „spätestens alle X", das jede Ankunft neu startet) oder als
**Kalenderplan** (cron-artige absolute Zeiten, z. B. „Mo–Fr bis 06:00", was Wochenenden ohne
Zusatzkonzept mit abdeckt). Jede Erwartung trägt eine **Karenz**, bevor „überfällig" auslöst.
Ein Kalenderplan-Soll gilt als abgedeckt, wenn seit dem vorherigen wirksamen Soll eine passende
Mail eintraf — der Backup-Report um 23:40 deckt das „bis 06:00"-Soll des Folgetages.

Feiertage laufen über manuell gepflegte **Ausnahmetage** (als benannte, wiederverwendbare
Kalender bündelbar). Sie setzen nur die *Zeit*-Solls aus — Kalenderplan-Solls und die
Zähler-Untergrenze. Die Obergrenze bleibt scharf: Ein Meldungssturm am Feiertag ist erst recht
ein Befund. Für alles andere gibt es **Pausiert**.

### Klassifikation

Jede einem Monitor zugeordnete Mail wird dreiwertig beurteilt: **OK**, **Fehler** (hat Vorrang)
oder **Unklar** (kein Muster traf). Die beurteilende Engine ist ein austauschbarer
**Klassifikator**:

- v1 ist **muster-basiert** (Regex / Betreff / Absender), mit einer sauberen Naht für
  **intelligente Extraktion** aus unstrukturierten Report-Mails — ein lokales Modell, oder ein
  LLM, das der Betreiber optional anbindet. Weil das optional und selbst konfiguriert ist,
  bleibt es self-hosting-kompatibel.
- **Unklar** eskaliert wie ein Fehler, aber mit eigenem Grund und der empfohlenen Aktion „Regel
  überarbeiten" — damit ein neuer, unbekannter Fehlertext nie still als „OK" durchrutscht.

### Kunden-Zuordnung

Ein Postfach trägt Meldungen vieler Kunden, deshalb läuft die Zuordnung als zweistufige
Pipeline — **Mail → Kunde → Monitor**. Der Kunde wird über Zuordnungs-Merkmale mit fester
globaler Priorität bestimmt:

1. Empfänger-Plus-Adresse (`noc+kundea@systemhaus.example`)
2. Kundennummer oder Inhaltsmuster
3. Absender-Adresse oder -Domain

**First-Match, kein Scoring.** Es gibt keinen Default-Kunden. Mehrere Treffer auf derselben
Stufe bedeuten *mehrdeutig*; mehrdeutige und nicht zuordenbare Mails landen in einer
**System-Triage**, statt ein Ticket zu erzeugen. Das Auflösen eines Triage-Eintrags legt immer
ein dauerhaftes Zuordnungs-Merkmal an — nie nur die eine Mail.

Mail eines bekannten Kunden, auf die kein Monitor passt, wird stattdessen als **unüberwachte
Mail-Sorte** gruppiert (nach Absender und Betreff-Muster, mit Anzahl, letztem Eingang und
erkanntem Takt). Diese Liste ist der Onboarding-Einstieg — und sie ist auf null fahrbar.

### Zustandsmaschine und Alarm-Lebenszyklus

Alle Arten teilen sich eine Zustandsmaschine: **Gesund ⇄ Gestört**, wobei Gestört einen
aktuellen **Alarmgrund** trägt. Eine orthogonale Überlagerung **Pausiert** deckt
Wartungsfenster ab — pausiert ist sichtbar und gewollt, nicht dasselbe wie „aus".

- **Ein Alarm pro Übergang** gesund → gestört. Es gibt kein Reminder-System; die
  Eskalationsfläche ist das PSA-Ticket, und es gilt **ein offenes Ticket pro Monitor**.
- **Entwarnung** kommentiert das Ticket **immer** (Anlass, Störungsdauer,
  Vorkommens-Zusammenfassung), **schließt** es aber nur bei beweisbasierter Erholung *und*
  unberührtem Ticket.
- **Entwarnungs-Stabilität** (~15 min, pro Monitor übersteuerbar) dämpft Flattern: Alarme wirken
  sofort, Entwarnungen erst, wenn die Erholung hält.
- **Quittieren** ist ein reiner Dashboard-Marker ohne Außenwirkung; es erlischt mit der Erholung.

### Self-Monitoring

Ein Überwachungswerkzeug, das still ausfällt, ist schlimmer als keins. Deshalb wendet Nightwatch
die eigene Dead-Man's-Switch-Idee auf sich selbst an — mit derselben Lebenszyklus-Mechanik,
nicht mit einer zweiten Implementierung:

- **Selbst-Monitore** sind eingebaut: einer pro Postfach („Ingestion Postfach X") plus ein
  globaler („Nightwatch-Kern"). Sie sind nicht anlegbar, nicht löschbar, nicht pausierbar.
- Der **Watchdog sendet direkt**, auf einem eigenen Pfad ohne Worker und Job-Queue, gestützt auf
  einen lokalen verschlüsselten Config- und Dedup-Cache — er übersteht damit einen
  Postgres-Ausfall.
- **Wurzel-Unterdrückung:** Ist der Kern gestört, feuern die Postfach-Selbst-Monitore nicht
  zusätzlich.
- **Ingestion-Gate:** Solange die Ingestion nachweislich gestört ist, werden
  Überfällig-Entscheidungen *ausgesetzt, nicht verworfen* — postfach-scharf. Statt einer Flut
  falscher Kundentickets feuert genau ein Selbst-Alarm, und der Rückstand wird aufgeholt, bevor
  das Gate wieder öffnet.
- **Heartbeat-Ping** (opt-in): ein ausgehendes Lebenszeichen an eine URL eurer Wahl, das nur bei
  innerer Gesundheit gesendet wird — genau das deckt den Totalausfall ab (Host oder Netz down).
  Ohne konfigurierten Empfänger ist der Totalausfall unbeobachtet, und das Dashboard sagt das.

---

## Alarmwege (v1)

Wechselt ein Monitor den Zustand, kann Nightwatch über diese Wege alarmieren:

- **Dashboard** — die eingebaute Weboberfläche, immer an.
- **Autotask-PSA-Ticket** — beim richtigen Kunden angelegt. Die De-Duplizierung nutzt einen
  stabilen Korrelations-Key im `externalID` des Tickets (Autotask hat keine native Idempotenz),
  Retries sind dadurch sicher; Alarme liegen in einer durablen Retry-Queue, damit keiner
  verlorengeht, während Autotask nicht erreichbar ist.
- **Generischer Webhook** — die integrations-agnostische Ausweichklappe und in v1 der Weg zu
  anderen PSAs als Autotask. Selbsttragender Payload, stabile `alert_id`,
  At-least-once-Zustellung, **HMAC-SHA256**-Signatur über den Body.

E-Mail-Alarme sind bewusst **nicht** Teil von v1 — über den Kanal zu alarmieren, den man
überwacht, ist keine gute Idee.

## E-Mail-Ingestion (v1): Microsoft 365 / Microsoft Graph

v1 liest ausschließlich aus **Microsoft 365**, über **Graph-Delta-Query-Polling** (Pull) statt
über Änderungsbenachrichtigungs-Webhooks. Polling ist rein ausgehend und funktioniert deshalb
aus einem Container hinter NAT ohne eingehenden Port — Webhooks bräuchten einen öffentlich
erreichbaren HTTPS-Endpoint und scheiden für den On-Prem-Fall aus.

- **App-Modell:** eine einzelne **Multi-Tenant-App-Registrierung**, pro Kunden-Tenant per
  **Admin-Consent** freigeschaltet, mit der **Application**-Berechtigung `Mail.Read`
  (Client-Credentials-Flow).
- **Postfach-Scoping ist Pflicht:** statt tenant-weitem Mail-Zugriff wird die App auf genau die
  überwachten Postfächer eingegrenzt — bevorzugt über **RBAC for Applications** in Exchange
  Online, mit der alten Application Access Policy als dokumentiertem Fallback.
- **Poll-Takt:** 60–300 s pro Postfach, mit Abstand innerhalb der Graph-Drosselgrenzen.
- **Lernfenster:** Beim Verbinden eines Postfachs werden einmalig rund 30 Tage Historie
  nachgeladen. Das ist Lernmaterial für Mail-Suche, Takt-Erkennung und Ableitung — **nie**
  Überwachungsmaterial. Monitore werten ausschließlich ab Aktivierung vorwärts.

Vollständige Begründung, PowerShell-Onboarding-Snippets und Fehlerbehandlung:
[`docs/research/m365-graph-ingestion.md`](docs/research/m365-graph-ingestion.md).

---

## Architektur & Tech-Stack

Der Stack ist an [pulse](https://github.com/erwins-enkel/pulse) ausgerichtet, damit Nightwatch
später als pulse-Modul andocken kann — das Deployment bewusst **nicht**: Der Kern von Nightwatch
ist ein Dauer-Poller, und das ist keine Serverless-Last.

| Schicht | Entscheidung |
| --- | --- |
| Sprache / Runtime | TypeScript auf Bun (im Container) |
| Framework | SvelteKit 2 / Svelte 5, `adapter-node` |
| ORM / DB | Drizzle + PostgreSQL (gebündelter Compose-Service; `DATABASE_URL`-Override möglich) |
| Job-Queue | pg-boss (Postgres-backed, kein Redis) — trägt die durablen Retry-Queues |
| UI-Kit | Tailwind 4, bits-ui, layerchart, lucide (pulse-gespiegelt) |
| i18n | Paraglide — Englisch als Default plus Deutsch, erweiterbar |
| Graph-SDK | `@microsoft/microsoft-graph-client` + `@azure/msal-node` |
| Hilfslibs | `date-holidays` (Zeitpläne), `limiter` (Rate-Limits) |

### Container-Topologie (vier Compose-Services)

- **`web`** — das SvelteKit-Dashboard und die Config-API.
- **`worker`** — der Graph-Delta-Poller, der Fälligkeits- und Fenster-Scheduler und der
  pg-boss-Worker für Autotask-Tickets und Webhooks.
- **`watchdog`** — bewusst winzig: aggregiert Heartbeats, wertet die Selbst-Monitore aus und
  sendet Selbst-Alarme über einen eigenen Pfad. **Kein Docker-Socket by default.**
- **`postgres`** — das offizielle Image plus Named Volume.

### Selbstheilung

- **`restart: unless-stopped` ist der Supervisor** — der Docker-Daemon ist der Wächter. Kein
  gegenseitiger Peer-Restart, das vermeidet das „Wer bewacht den Wächter"-Split-Brain.
- Ein **In-Process-Watchdog-Timer** ist die primäre Verteidigung gegen *hung-but-alive*: Tickt
  die Hauptschleife nicht mehr, beendet sich der Prozess und Docker startet ihn neu. Ohne
  Docker-Socket, ohne erhöhte Rechte.
- **Postgres-Heartbeats** geben den Services gegenseitige Sichtbarkeit.
- Migrationen laufen beim Start, nach dem Datenbank-Healthcheck.

Secrets (Graph-Credentials, Autotask-Credentials, Webhook-HMAC-Secrets) liegen
AES-256-GCM-verschlüsselt at rest, mit einem Schlüssel aus einer Umgebungsvariable, die nur in
eurer `.env` steht. Kein externes KMS, kein Vault — das wäre der nächste Drittanbieter.

---

## Deployment (geplant)

> Die folgenden Kanäle beschreiben das **beabsichtigte** Deployment, sobald v1 gebaut ist. Sie
> funktionieren noch nicht — es gibt in diesem Repository weder ein veröffentlichtes Image noch
> eine Compose-Datei.

1. **Docker Compose (Basis).** Eine einzelne `docker-compose.yml` + `.env.example` im Repo-Root
   — der kleinste gemeinsame Nenner, der auf jedem Docker-Host läuft, auf einem
   DigitalOcean-Droplet, in Portainer oder auf einer Synology. Das veröffentlichte Compose pinnt
   die Minor-Version statt `:latest`.
2. **Portainer-App-Template (v3).** Eine auf GitHub gehostete `templates.json`, die ihr in
   Portainer hinterlegt — Ein-Klick-Deployment.
3. **DigitalOcean-Marketplace-1-Click-Droplet.** Ein mit Packer gebauter Snapshot, bei DO zum
   Review eingereicht — die größte Reichweite, der größte Aufwand, geplant für die Zeit nach der
   Produktreife.

Releases sind **SemVer**-getaggt, CI baut Multi-Arch-Images (`linux/amd64`, `linux/arm64`) nach
`ghcr.io`.

### Updates

Nightwatch bringt einen **eingebauten Update-Check** mit: Es pollt täglich die
GitHub-Releases-API, vergleicht das neueste Tag mit der eigenen Version und zeigt ein „Update
verfügbar"-Banner mit Changelog-Link. Es **aktualisiert sich nicht selbst** — es verweist auf
`docker compose pull && docker compose up -d` und lässt die Änderungskontrolle bei euch. Ein
Ein-Klick-Self-Update bräuchte Zugriff auf den Docker-Socket, den die Architektur bewusst
ausschließt.

---

## Roadmap — was kommt

Die Design-Phase ist **abgeschlossen**. Alles, was in Research, Domänenmodellierung und Prototyp
entschieden wurde, ist konsolidiert in [SPEC.md](SPEC.md) (dem Bau-Vertrag) und
[CONTEXT.md](CONTEXT.md) (dem verbindlichen Glossar).

Die Umsetzung läuft als
**[Epic #37](https://github.com/erwins-enkel/nightwatch/issues/37)**, aufgeteilt in sechzehn
bewusst PR-große Kind-Issues — ein Issue, eine Session, ein Pull Request. Genau dieser
Zuschnitt macht es realistisch, dass jemand anders ein Stück übernimmt.

**Sequenzieller Strang** — jedes hängt am vorherigen:

| # | Issue | Was es liefert |
| --- | --- | --- |
| [#21](https://github.com/erwins-enkel/nightwatch/issues/21) | Scaffold | Bun + SvelteKit + Drizzle/Postgres + pg-boss, Vier-Service-Compose, CI — **in Arbeit** |
| [#22](https://github.com/erwins-enkel/nightwatch/issues/22) | Datenmodell | Kern-Entitäten und Migrations |
| [#23](https://github.com/erwins-enkel/nightwatch/issues/23) | M365/Graph-Ingestion | Onboarding, Delta-Polling, Lernfenster |
| [#24](https://github.com/erwins-enkel/nightwatch/issues/24) | Kunden & Zuordnung | Merkmale, First-Match, Triage-Backend |
| [#25](https://github.com/erwins-enkel/nightwatch/issues/25) | Monitor-Kern | Arten-Vertrag, Regeln, Klassifikation, Zustandsmaschine |
| [#26](https://github.com/erwins-enkel/nightwatch/issues/26) | Zeit-Scheduler | Erwartung, Karenz, Fenster, Offenzeit, Ausnahmetage |
| [#27](https://github.com/erwins-enkel/nightwatch/issues/27) | Alarm-Lebenszyklus | `alert_id`, Entwarnungs-Stabilität, Verschärfung, Quittieren |

**Dann fächert es auf** — diese vier laufen parallel, sobald der Lebenszyklus steht:

| # | Issue | Was es liefert |
| --- | --- | --- |
| [#28](https://github.com/erwins-enkel/nightwatch/issues/28) | Autotask-Integration | Ticket-Anlage, De-Dupe, Retry-Queue, Company-Picker |
| [#29](https://github.com/erwins-enkel/nightwatch/issues/29) | Webhook-Kanal | Events, HMAC-Signatur, At-least-once-Zustellung |
| [#30](https://github.com/erwins-enkel/nightwatch/issues/30) | Self-Monitoring | Selbst-Monitore, Watchdog-Direktversand, Ingestion-Gate, Heartbeat-Ping |
| [#31](https://github.com/erwins-enkel/nightwatch/issues/31) | UI: Kundenboard | Alarm-Leiste, System-Banner, Monitor-Drawer |

**Nebenstränge** — die hängen an früherer Arbeit, nicht am Auffächern:

| # | Issue | Hängt an |
| --- | --- | --- |
| [#32](https://github.com/erwins-enkel/nightwatch/issues/32) | Regel-Entstehung: Takt-Erkennung, Ableitung, 4-Schritt-Wizard, Vorlagen | #25 |
| [#33](https://github.com/erwins-enkel/nightwatch/issues/33) | UI: System-Triage, unüberwachte Mail-Sorten, Mail-Suche | #32 |
| [#34](https://github.com/erwins-enkel/nightwatch/issues/34) | Retention: Löschjob, Aufbewahrungs-Einstellung, DSGVO-Doku | #23 |

**Zum Abschluss:**

| # | Issue | Hängt an |
| --- | --- | --- |
| [#35](https://github.com/erwins-enkel/nightwatch/issues/35) | Secrets-Härtung: Verschlüsselung at rest, Watchdog-Cache | #28, #30 |
| [#36](https://github.com/erwins-enkel/nightwatch/issues/36) | Update-Check, Release-Pipeline & Distribution (Compose, Portainer, ghcr) | #31 |

Jenseits von v1: weitere Ingestion-Wege (IMAP/POP3, Inbound-SMTP), weitere PSA-Integrationen,
ein automatisch gepflegter Feiertagskalender und intelligente Extraktion im Klassifikator — die
Naht dafür ist bereits Teil des v1-Entwurfs.

---

## Mitmachen

Nightwatch wird für die Leute gebaut, die es betreiben werden — und es ist genau an dem Punkt,
an dem Input von außen das Ergebnis noch verändert. **Vier Wege hinein**, grob sortiert danach,
wie sehr sie gerade helfen:

### 1. Ein echtes Postfach als Pilot fahren

Die riskantesten Annahmen in diesem Produkt betreffen *eure* Mails: ob die Takt-Erkennung echte
Backup-Reports übersteht, ob die Ableitung etwas Sinnvolles vorschlägt, ob die
Zuordnungs-Stufen einem echten geteilten NOC-Postfach standhalten. Synthetische Testdaten
beantworten davon nichts. Wenn ihr bereit seid, ein echtes Postfach anzubinden, sobald es etwas
anzubinden gibt — und danach zu sagen, was schiefging —, ist das der wertvollste Beitrag
überhaupt.

### 2. Regel-Vorlagen beisteuern

Eine kuratierte Regel für eine Backup-Suite, ein NAS, eine Druckerflotte, eine Firewall, einen
Router. Vorlagen liegen versioniert im Container-Image, Export und Import sind bereits
spezifiziert. Das ist der Beitrag mit Zinseszins: Jede Vorlage, die ein MSP beisteuert, spart
jedem anderen MSP denselben Nachmittag Muster-Fummelei. Die Mechanik dazu steckt in
[#32](https://github.com/erwins-enkel/nightwatch/issues/32).

### 3. Code beitragen

Die sechzehn Kind-Issues von
[Epic #37](https://github.com/erwins-enkel/nightwatch/issues/37) sind bewusst PR-groß und
einzeln abgegrenzt, jedes mit eigenem schriftlichem Auftrag. Sucht euch eines aus, sagt im Issue
Bescheid, öffnet einen Pull Request. `SPEC.md` und `CONTEXT.md` sind der Vertrag — beide vorher
lesen.

### 4. An den Anforderungen mitreden

Welche Meldungen tun wirklich weh, wenn sie ausbleiben? Welches PSA fahrt ihr? Was fehlt im
Umfang von v1? Meinungen von Leuten, die einen Pager tragen, sind mehr wert als eine weitere
Runde Alleingang-Design.

### Wo ihr uns erreicht

- **[GitHub Issues](https://github.com/erwins-enkel/nightwatch/issues)** — Fehler, konkrete
  Vorschläge, ein Kind-Issue übernehmen.
- **[GitHub Discussions](https://github.com/erwins-enkel/nightwatch/discussions)** — offene
  Fragen, Pilot-Interesse, „macht es auch X?".
- **hallo@erwins-enkel.dev** — wenn ihr es lieber nicht öffentlich machen wollt.

Die Design-Diskussion läuft auf **Deutsch** (Issues, Pull Requests und das Glossar in
`CONTEXT.md`), Code und Dokumentation auf **Englisch**. Schreibt in der Sprache, die euch
liegt — beide werden gelesen.

---

## Repository-Aufbau

```
.
├── README.md                       # Englische Fassung
├── README.de.md                    # Diese Datei (Deutsch)
├── SPEC.md                         # Bau-fertige v1-Spezifikation — der Vertrag für das Epic
├── CONTEXT.md                      # Verbindliches Domänen-Glossar — die Projektsprache
├── CLAUDE.md                       # Projekt-Idee und Arbeitsnotizen
├── LICENSE                         # AGPL-3.0
└── docs/
    └── research/
        ├── m365-graph-ingestion.md # Graph-Delta-Query, App-Modell, Scoping, Self-Monitoring
        ├── autotask-api.md         # Autotask-PSA-Ticket-Anlage, De-Dup, Retry-Queue
        └── distribution-updates.md # Compose → Portainer → DO-Marketplace, Update-Mechanik
```

Die GitHub-Issues bleiben das lebende Entscheidungs-Protokoll; `SPEC.md` ist die konsolidierte,
bau-fertige Sicht auf alles, was dort geklärt wurde.

## Umfang

### In v1 enthalten

- Ausbleiben-Erkennung (Heartbeat) plus klassische Fehler-, Ereignis-, Paar- und
  Zähler-Erkennung.
- Microsoft 365 / Graph-Ingestion, ein oder mehrere Postfächer, viele Kunden pro Postfach.
- Alarmierung über Dashboard, Autotask-Ticket und generischen Webhook.
- Self-Monitoring mit Out-of-band-Watchdog und optionalem Heartbeat-Ping.
- Self-hosted Docker-Deployment mit eingebautem Update-Check.

### Nicht in v1

- Andere Ingestion-Wege (IMAP/POP3, Inbound-SMTP) — ein eigener, späterer Effort.
- Andere PSAs als Autotask (erreichbar über den generischen Webhook) und weitere Alarmkanäle
  (E-Mail, Teams, Slack, …).
- Multi-Tenancy mit Kunden-Logins und -Rollen — v1 ist ein Werkzeug für das Team des
  Dienstleisters.
- Ein automatisch gepflegter regionaler Feiertagskalender — v1 nutzt manuelle Ausnahmetage.
- Crowd-Learning über Installationen hinweg — steht im Spannungsverhältnis zum
  Self-Hosted-Prinzip.
- Reminder- und Eskalationsstufen; kundenweite Sammel-Tickets.
- Pricing, Go-to-Market und Monetarisierung.

## Lizenz

Nightwatch steht unter der **GNU Affero General Public License v3.0** — Volltext in
[LICENSE](LICENSE).

```
Copyright (C) 2026 erwins-enkel

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License along
with this program. If not, see <https://www.gnu.org/licenses/>.
```

Im Klartext: Ihr dürft Nightwatch frei betreiben, studieren, ändern und weitergeben — auch
kommerziell und auch innerhalb eures eigenen MSP-Geschäfts. Es zu betreiben, um Postfächer zu
überwachen, ist gewöhnliche Nutzung und verpflichtet euch zu keiner Veröffentlichung. Wenn ihr
eine geänderte Fassung *weitergebt* oder sie Nutzern über ein Netzwerk anbietet, müsst ihr eure
Änderungen unter derselben Lizenz verfügbar machen.

Das ist so gewollt. Es hält jeden Fork von Nightwatch offen — damit das Werkzeug, das ihr heute
einsetzt, morgen nicht zugemacht und euch zurückvermietet werden kann. (Dieser Absatz ist eine
Zusammenfassung, keine Rechtsberatung — maßgeblich ist der Lizenztext.)
