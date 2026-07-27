# Nightwatch v1 — Spezifikation (build-ready)

> Konsolidiert aus der Wayfinder-Map [#1](https://github.com/erwins-enkel/nightwatch/issues/1)
> (Tickets #2–#15) im Zuge von [#10](https://github.com/erwins-enkel/nightwatch/issues/10).
> **Verbindliche Domänensprache: [CONTEXT.md](CONTEXT.md)** — dieses Dokument wiederholt das
> Glossar nicht, sondern ordnet es zu einer bau-fertigen Gesamtsicht.
> Research-Grundlagen: [M365/Graph](docs/research/m365-graph-ingestion.md) ·
> [Autotask](docs/research/autotask-api.md) · [Distribution & Updates](docs/research/distribution-updates.md).
>
> **Neu in dieser Konsolidierung entschieden** (kein eigenes Map-Ticket, im PR-Review kippbar):
> §11 Datenhaltung & Retention · §12 Sicherheit & Secrets · Azure-Einordnung in §14.

## 1. Zielbild & Scope

Nightwatch überwacht E-Mail-Postfächer von MSPs/IT-Systemhäusern auf Benachrichtigungsmails
(Backup-Reports, Router-Meldungen, Firmware-Hinweise). Das Alleinstellungsmerkmal ist das
Erkennen **ausbleibender** erwarteter Mails (Dead-Man's-Switch): Wenn die Backup-Software gar
nicht mehr läuft, kommt auch keine Fehlermail — genau das darf nicht unbemerkt bleiben.

**v1-Scope:**

- Selbstständig lauffähig: Docker Compose, keine Drittanbieter-Dienste im Betrieb.
- Eine Instanz, ein oder mehrere Postfächer; ein Postfach enthält Mails vieler Kunden.
- Ingestion ausschließlich **Microsoft 365 / Graph API** (Delta-Polling).
- Vier Monitor-Arten: **Heartbeat · Ereignis · Paar · Zähler** (offenes Set, Dreiklang-Vertrag).
- Alarmwege: **Dashboard · Autotask-Ticket · generischer Webhook**. Keine E-Mail-Alarme.
- Self-Monitoring mit Out-of-band-Watchdog und optionalem Heartbeat-Ping.
- Open Source: öffentliches Repo, Images auf ghcr.io, Update-Check eingebaut.

**Nicht in v1** (Details: Map #1, „Out of scope"): IMAP/POP3/SMTP-Inbound, weitere
PSA-Integrationen (DocBee → Webhook), weitere Alarmkanäle, Multi-Tenancy mit Kunden-Logins,
automatischer Feiertagskalender, Crowd-Learning, Pricing/GTM, Reminder-/Eskalationsstufen,
kundenweite Sammel-Tickets.

## 2. Architektur

Entschieden in [#7](https://github.com/erwins-enkel/nightwatch/issues/7): Stack an
[pulse](https://github.com/erwins-enkel/pulse) ausgerichtet (späteres Andocken als Modul),
Deployment bewusst nicht (Dauer-Poller ≠ Serverless).

| Schicht | Entscheidung |
|---|---|
| Sprache / Runtime | TypeScript auf **Bun** (im Container) |
| Framework | SvelteKit 2 / Svelte 5, **`adapter-node`** |
| ORM / DB | Drizzle + **Postgres** (gebündelter Compose-Service; `DATABASE_URL`-Override möglich) |
| Job-Queue | **pg-boss** (Postgres-backed, kein Redis) — trägt die durablen Retry-Queues |
| UI-Kit | Tailwind 4, bits-ui, layerchart, lucide (pulse-gespiegelt) |
| i18n | **Paraglide**, EN default + DE |
| Graph-SDK | `@microsoft/microsoft-graph-client` + `@azure/msal-node` |
| Hilfslibs | `date-holidays` (Zeitpläne), `limiter` (Rate-Limits) |

**Vier Compose-Services:**

- **`web`** — SvelteKit-Dashboard + Config-API.
- **`worker`** — Graph-Delta-Poller, Fälligkeits-/Fenster-Scheduler, pg-boss-Worker
  (Autotask-Tickets, Webhooks).
- **`watchdog`** — bewusst winzig: aggregiert Postgres-Heartbeats, wertet die Selbst-Monitore
  aus und sendet Selbst-Alarme **direkt** (eigener Sende-Pfad ohne worker/pg-boss, §8).
  **Kein Docker-Socket by default.**
- **`postgres`** — offizielles Image + Named Volume.

**Selbstheilung:** `restart: unless-stopped` (der Docker-Daemon ist der Supervisor, kein
Peer-Restart); In-Process-Watchdog-Timer in web/worker/watchdog gegen *hung-but-alive*
(Hauptschleife tickt N s nicht → `process.exit(1)`); Postgres-Heartbeats für gegenseitige
Sichtbarkeit; Migrate-on-Startup erst nach DB-Healthcheck (§14).

## 3. Ingestion: Microsoft 365 / Graph

Entschieden in [#2](https://github.com/erwins-enkel/nightwatch/issues/2)
([Research-Doc](docs/research/m365-graph-ingestion.md)):

- **Delta-Query-Polling (Pull)** pro Postfach-Posteingang, Intervall 60–300 s. Webhooks
  scheiden aus (Container hinter NAT braucht keine Inbound-Ports).
- **Multi-Tenant-App-Registrierung** + Admin-Consent pro Kunden-Tenant; **Application
  `Mail.Read`**, Client-Credentials-Flow (MSAL, Token-Cache). Postfach-Scoping zwingend via
  **RBAC for Applications** (PowerShell-Snippet wird im Onboarding-UI mitgeliefert;
  Application Access Policy nur als dokumentierter Legacy-Fallback).
- **Persistenter State pro Postfach:** `deltaToken`, `last_successful_poll`, letzter
  Fehlercode, Credential-Ablaufdatum (proaktive Warnung vor Ablauf).
- Fehlerbehandlung: `429/503` mit Backoff (`Retry-After`), `410 Gone` → Delta-Resync,
  `AADSTS*`/`403` → Ingestion-Störung (speist den Postfach-Selbst-Monitor, §8).
- **Lernfenster (Backfill):** beim Verbinden einmalig ~30 Tage Historie (konfigurierbar) —
  Lernmaterial für Mail-Suche, Takt-Erkennung und Ableitung, **nie** Überwachungsmaterial:
  Monitore werten ausschließlich ab Aktivierung vorwärts.
- Jede Mail wird mit **Postfach-Ankunftszeit** gespeichert (nicht Verarbeitungszeit) — die
  Grundlage des Ingestion-Gates (§8).

## 4. Kunden-Zuordnung

Entschieden in [#6](https://github.com/erwins-enkel/nightwatch/issues/6); Begriffe in
CONTEXT.md („Kunde & Zuordnung"). Zweistufige Pipeline **Mail → Kunde → Monitor**:

1. **Kunde bestimmen** über Zuordnungs-Merkmale mit fester globaler Priorität:
   ① Empfänger-Plus-Adresse (`noc+kundea@…`) → ② Kundennummer/Inhaltsmuster → ③ Absender
   (Adresse oder Domain). **First-Match, kein Scoring.** Mehrere Treffer auf derselben Stufe
   = **mehrdeutig** → System-Triage.
2. **Monitor matchen** nur innerhalb der Monitore dieses Kunden (Match-Kriterien der Regel).

Weitere Festlegungen: **kein Default-Kunde**; Kollisionswarnung beim Pflegen identischer
Merkmale (Speichern bleibt erlaubt); Systemhaus selbst = normaler Kunde; Lebenszyklus
aktiv ⇄ archiviert (Monitore mitarchiviert, Zuordnung bleibt an → stille Ablage), hartes
Löschen nur für Fehlanlagen ohne Historie; optionale **Autotask-Verknüpfung** als
Picker-Feld (stabile companyID, kein Dauer-Sync, kein Massen-Import).

**System-Triage:** führt einzeln nur „kein Kunde erkannt" und „mehrdeutig"; der dritte Grund
„Kunde erkannt, kein Monitor passt" wird gruppiert als **unüberwachte Mail-Sorte** (§5).
Das Auflösen eines Triage-Eintrags legt dauerhaft ein Zuordnungs-Merkmal an bzw. startet den
Wizard vorbefüllt — nie nur die eine Mail zuordnen.

## 5. Monitore, Regeln, Klassifikation

Entschieden in [#5](https://github.com/erwins-enkel/nightwatch/issues/5),
[#9](https://github.com/erwins-enkel/nightwatch/issues/9),
[#15](https://github.com/erwins-enkel/nightwatch/issues/15); vollständige Semantik in
CONTEXT.md. Kernpunkte:

**Monitor** (das *Was*) enthält genau eine **Regel** (das *Wie*), gehört genau einem Kunden,
hat genau eine **Monitor-Art**. Die Arten erfüllen den **Dreiklang-Vertrag**
(Auslöser / Schlecht-Bedingung / Erholungs-Bedingung):

| Art | Auslöser | Schlecht | Erholung | Zeitparameter |
|---|---|---|---|---|
| **Heartbeat** | Mail + Zeitablauf | überfällig (**gar nichts** kam) *oder* Fehler-Mail | passende OK-Mail | Erwartung (Intervall/Kalenderplan) + Karenz |
| **Ereignis** | Mail | passende Mail kommt (Harmlos-Filter nimmt aus) | Auto-Zurück (Default 24 h) oder Erledigen — nie beweisbasiert | Auto-Zurück-Zeit |
| **Paar** | Mail + Zeitablauf | offener Zustand länger als max. Offenzeit (Default 0) | Zu-Mail (beweisbasiert) | max. Offenzeit |
| **Zähler** | Mail + Zeitablauf | Zähler im gleitenden Fenster T über Ober- oder unter Untergrenze | Zähler wieder im Band (beweisbasiert) | Fenster T, Grenzen, **Anlauf** |

Wichtige Ränder (Details CONTEXT.md): beim Heartbeat erfüllt **jede** passende Mail die
Erwartung (Pünktlichkeit ≠ Inhalt); Kalenderplan-Solls gelten ab dem vorherigen wirksamen
Soll als abdeckbar; Paar führt genau **einen** offenen Zustand, Zu-ohne-Auf ist neutral;
Zähler-Untergrenze hat **Anlauf**-Schonzeit, Obergrenze gilt ab Sekunde 1, die Muster-Slots
sind beim Zähler ungenutzt.

**Regel** = Match-Kriterien + zwei art-gedeutete **Muster-Slots** (Heartbeat: Fehler/OK ·
Ereignis: —/Harmlos-Filter · Paar: Auf/Zu). **Klassifikation** dreiwertig OK/Fehler/**Unklar**
(Fehler hat Vorrang; Unklar eskaliert wie ein Fehler, mit Aktion „Regel überarbeiten").
Regeln sind **sprachunabhängig** (mehrsprachige Muster erlaubt). Der **Klassifikator** ist
eine austauschbare Engine: v1 muster-basiert, mit sauberer Naht für intelligente Extraktion
(lokales Modell oder optional vom Betreiber angebundener LLM) — wirkt zur **Laufzeit**, nicht
zur Anlagezeit.

**Regel-Entstehung:** drei **Regel-Quellen** (manuell · Regel-Vorlage · aus Mail abgeleitet)
als bloße **Vorbefüllungs-Grade** derselben Anlage-Fläche; keine Regel wird ohne menschliche
Bestätigung aktiv. Ableitung: **Schicht 1 automatisch** (Zeitliches/Strukturelles: Match,
Takt → Erwartung, Karenz aus Streuung, Zähler-Fenster/-Grenzen aus Lernfenster-Statistik,
Paar-Offenzeit nachgelagert), **Schicht 2 per Hand** (OK-/Fehler-Muster im Beispieltext
markieren); Art-Vermutung nur Heartbeat/Ereignis, jeder Vorschlag mit **Beleg**.
**Takt** erkannt ab 3 Vorkommen bei ≤ ~25 % Streuung (Boden 15 min); Klassen: Intervall ·
täglich · werktäglich · wöchentlich — monatlich bewusst nicht. **Regel-Vorlagen** liegen als
versionierte Daten im Container-Image (Updates mit Releases); Export/Import eigener Vorlagen.

**Unüberwachte Mail-Sorten:** wiederkehrende Sorten bekannter Kunden ohne Monitor, gruppiert
nach Sorten-Signatur (Absender + Betreff-Muster), mit Anzahl/letztem Eingang/Takt — der
Onboarding-Einstieg; eine Ansicht, die der Betreiber öffnet (kein Hintergrund-Scan).
**Ignorieren** wirkt pro Kunde + Sorte, umkehrbar (Ablage); die Liste ist auf null fahrbar.
**Mail-Suche** daneben als Rohzugriff auf alle ingestierten Mails, mit Wizard-Schnellstart
aus jedem Treffer.

**Ausnahmetage** (manuell, als benannte Kalender bündelbar) setzen nur die **Zeit-Solls**
aus: Kalenderplan-Solls und Zähler-Untergrenze; Obergrenze bleibt scharf. Für alles andere
gibt es **Pausiert**.

## 6. Zustandsmaschine & Alarm-Lebenszyklus

Entschieden in [#5](https://github.com/erwins-enkel/nightwatch/issues/5) und
[#12](https://github.com/erwins-enkel/nightwatch/issues/12):

- Zwei Kern-Zustände **Gesund ⇄ Gestört** (mit aktuellem **Alarmgrund**: überfällig · Fehler
  gemeldet · unklar · Ereignis eingetroffen · Paar zu lange offen · Zähler über Obergrenze ·
  Zähler unter Untergrenze) plus orthogonale Überlagerung **Pausiert**.
- **Ein Alarm pro Übergang** gesund → gestört; kein Reminder-System — die Eskalationsfläche
  ist das PSA-Ticket. **Ein offenes Ticket pro Monitor.**
- **Entwarnung** (gestört → gesund) kommentiert ein Ticket **immer** (Anlass, Störungsdauer,
  Vorkommens-Zusammenfassung), **schließt nur** bei beweisbasierter Erholung **und**
  unberührtem Ticket (Anlage-Status, kein Bearbeiter). Erledigen/Auto-Zurück kommentieren
  nur. Re-Alarm nach Schließung = neues Ticket mit Vorgänger-Verweis.
- **Entwarnungs-Stabilität** ~15 min (pro Monitor übersteuerbar): Alarm wirkt sofort,
  Entwarnung erst wenn die Erholung hält; intern wechselt der Zustand sofort (Dashboard live).
- **Verschärfung** = Grund-Wechsel zu „Fehler gemeldet" während Gestört — der einzige
  automatische Zwischen-Kommentar; alle anderen Vorkommen werden intern gezählt.
- **Quittieren** = reiner Dashboard-Marker ohne Außenwirkung, erlischt mit der Erholung.
- **Rückverweis:** jeder Alarm/jedes Ticket trägt einen Deep-Link zum auslösenden Monitor.

## 7. Alarmwege

**Dashboard** (§9) ist immer an. Zusätzlich pro Kunde/Instanz:

**Autotask** ([#3](https://github.com/erwins-enkel/nightwatch/issues/3),
[Research-Doc](docs/research/autotask-api.md)):

- REST API, dedizierter API-only-User (Header-Auth `Username`/`Secret`/`APIIntegrationcode`,
  Custom Internal Integration Code), Zone einmalig via `zoneInformation` ermitteln und
  persistieren.
- `POST /Tickets` mit `companyID` (aus der Autotask-Verknüpfung des Kunden), `title`,
  `description`, `status`, `priority`, ggf. `queueID`/`dueDateTime` — alle numerischen IDs
  tenant-spezifisch beim Einrichten aufgelöst und konfigurierbar hinterlegt, nie hardcoded.
- **De-Dupe:** stabiler Korrelations-Key in `externalID` (`nw:{monitorId}:{übergangsId}`,
  Selbst-Monitore `self:…`); vor Anlage Query auf offenes Ticket mit diesem Key — Retries
  sind dadurch idempotent.
- **Durable Retry-Queue** über pg-boss mit exponentiellem Backoff + Jitter; Requests
  serialisiert. Nach N erschöpften Versuchen gilt die Alarm-Zustellung als gestört → globaler
  Selbst-Monitor (§8) feuert über den Watchdog-Pfad.

**Webhook** ([#12](https://github.com/erwins-enkel/nightwatch/issues/12)): Events `alarm` ·
`entwarnung` · `verschaerfung`, Payload selbsttragend (Monitor, Kunde, Art, Alarmgrund,
Zeiten, Vorkommens-Zusammenfassung, Rückverweis-URL) mit stabiler `alert_id`; Zustellung
at-least-once mit Backoff; Signatur **HMAC-SHA256** über den Body
(`X-Nightwatch-Signature`), Secret pro Webhook-Ziel. Selbst-Monitor-Events tragen
`monitor.art = "selbst"`, `kunde = null`.

## 8. Self-Monitoring

Entschieden in [#11](https://github.com/erwins-enkel/nightwatch/issues/11):

- **Selbst-Monitore** als eingebaute System-Monitore mit der kompletten Mechanik aus §6
  (keine zweite Logik): einer **pro Postfach** („Ingestion Postfach X") + ein **globaler**
  („Nightwatch-Kern"). Nicht anlegbar/löschbar/pausierbar; Parameter einstellbar. Im
  Dashboard als System-Banner, nicht als Kunden-Karte.
- **Watchdog sendet direkt** an die bestehenden Alarmwege — eigener Sende-Pfad ohne
  worker/pg-boss; lokaler **Config- + Dedup-Cache** (Datei im Volume) übersteht einen
  Postgres-Ausfall.
- **Wurzel-Unterdrückung:** ist der Kern gestört, feuern die Postfach-Selbst-Monitore nicht
  zusätzlich. Symptome (Staleness) fangen jede Ursache; harte Ursachen (Consent entzogen,
  `AADSTS*`, 403) beschleunigen nur und liefern besseren Ticket-Text.
- **Ingestion-Gate:** solange die Ingestion nachweislich gestört ist, werden
  Überfällig-Entscheidungen **ausgesetzt (nicht verworfen)** — postfach-scharf, bewertet
  gegen die Postfach-Ankunftszeit; öffnet erst nach stabiler Erholung **und** aufgeholtem
  Rückstand. Statt einer Flut falscher Kunden-Tickets feuert genau ein Selbst-Alarm.
- **Heartbeat-Ping** (opt-in): ausgehendes Lebenszeichen an eine frei konfigurierbare URL,
  feuert **nur bei innerer Gesundheit** — deckt den Totalausfall ab (Host/Netz down).
  Passiver `/health`-Endpoint zusätzlich. Ohne konfigurierten Empfänger ist der Totalausfall
  unbeobachtet, und das Dashboard sagt das.

## 9. UI

Entschieden in [#8](https://github.com/erwins-enkel/nightwatch/issues/8) (Prototyp-Branch
[`prototype/dashboard-regel-anlage`](https://github.com/erwins-enkel/nightwatch/tree/prototype/dashboard-regel-anlage),
Variante **A „Kundenboard"**):

- **Kundenboard:** Kunden-Karten mit Ampel, Alarm-Leiste oben, System-Triage-Block darunter,
  System-Banner für Selbst-Monitore; Monitor-/Alarm-Detail im **Drawer**. Suche & Filter
  (Kunde/Monitor, Zustand, Art) sind v1-Pflicht.
- **Monitor-Detail (Drawer):** 7-Tage-Zeitachse „erwartet vs. eingetroffen", Zustand +
  Alarmgrund, Quittieren, letzte Mails, Regel-Zusammenfassung mit „Regel überarbeiten".
- **Regel-Anlage:** 4-Schritt-Wizard (Kunde → Art → Erkennung → Parameter) als Hauptweg;
  Einstieg **„aus Mail ableiten"** (vorbefüllt) aus Triage, Mail-Suche und unüberwachten
  Sorten. Der Wizard beschriftet die Muster-Slots je Art um.
- **Weitere Ansichten:** System-Triage (einzeln), unüberwachte Mail-Sorten (gruppiert, mit
  Ignorieren/Ablage), Mail-Suche, Kunden-Verwaltung (Merkmale, Autotask-Picker,
  Archivierung), Ausnahmekalender, Einstellungen (Postfächer, Autotask, Webhooks,
  Heartbeat-Ping, Retention, Update).
- Bewusst nicht in v1: eigene Alarm-Historie-Ansicht, prominente Selbst-Status-Kachel.

## 10. Datenmodell (Entitäten-Überblick)

Attribut-Detail gehört in die Implementierungs-Issues; die Entitäten und ihre Beziehungen:

- **postfach** — Graph-Anbindung (tenant_id, client-Credential-Verweis, Ziel-Adresse),
  Delta-State, Ingestion-Status, Lernfenster-Konfig.
- **kunde** — Stammdaten, Lebenszyklus (aktiv/archiviert), Autotask-companyID (optional).
- **zuordnungs_merkmal** — Kunde, Stufe (①②③), Wert; Kollisions-Check beim Pflegen.
- **monitor** — Kunde, Art, Zustand (+ Alarmgrund, Pausiert-Overlay), Parameter je Art
  (Erwartung/Karenz, Fenster/Grenzen/Anlauf, Offenzeit, Auto-Zurück-Zeit),
  Entwarnungs-Stabilität-Override, Postfach-Bezug (zuletzt zugeordnete Mails).
- **regel** — 1:1 zum Monitor: Match-Kriterien, Muster-Slots, Regel-Quelle.
- **regel_vorlage** — kuratiert (im Image, versioniert) + eigene (Export/Import).
- **mail** — Postfach, Ankunftszeit, Absender/Empfänger/Betreff, Body-Text,
  Zuordnungs-Ergebnis (Kunde/Monitor/Triage-Grund), Klassifikation.
- **mail_sorte** — Sorten-Signatur pro Kunde, Zähler/letzter Eingang/Takt, ignoriert-Flag.
- **uebergang / alarm** — Zustands-Übergänge mit Alarmgrund, `alert_id`,
  Vorkommens-Zähler, Quittiert-Marker.
- **ticket_korrelation** — Autotask-Ticket-ID ↔ Korrelations-Key, Status.
- **zustellung** — pg-boss-Jobs für Autotask/Webhook (Retry-Zustand, Dead-Letter).
- **ausnahmekalender / ausnahmetag** — benannt, wiederverwendbar, Monitor-Zuordnung.
- **selbst_monitor** — fest verdrahtet (pro Postfach + global), Parameter.
- **heartbeat** — Service-Heartbeats (web/worker/watchdog) für gegenseitige Sichtbarkeit.
- **einstellungen** — Instanz-Konfig (Webhook-Ziele, Heartbeat-Ping-URL, Retention, …).

## 11. Datenhaltung & Retention *(neu entschieden in #10)*

Leitsatz: **Datensparsamkeit vor Vollarchiv** — Nightwatch ist Monitoring, kein Mail-Archiv.

- **Gespeichert wird pro Mail:** Ankunftszeit, Absender, Empfänger, Betreff, Body als
  **Text** (für Muster-Matching, Beleg und Schicht-2-Markierung). **Anhänge werden nie
  gespeichert**; HTML wird zu Text reduziert.
- **Aufbewahrung:** konfigurierbar pro Instanz, **Default 90 Tage** ab Ankunftszeit; ein
  täglicher Löschjob entfernt ältere Mails hart (inkl. Volltext). Untergrenze = Lernfenster
  (~30 Tage), damit Ableitung und Mail-Suche funktionsfähig bleiben. Die stille Ablage
  archivierter Kunden rotiert mit derselben Frist.
- **Bleibt dauerhaft:** Monitore, Regeln, Übergangs-/Alarm-Historie, Sorten-Statistik
  (Zähler/Takt), Ticket-Korrelationen — sie tragen keine Mail-Bodies. In Ticket-Kommentaren
  und Webhook-Payloads werden Mail-Auszüge minimal gehalten (Betreff + getroffenes Muster).
- **Löschen auf Zuruf:** hartes Löschen eines Kunden entfernt dessen Mails, Monitore und
  Historie; das Löschen eines Postfachs entfernt dessen Mails und Delta-State.
- **DSGVO-Einordnung:** Der Betreiber (MSP) ist Verantwortlicher; Nightwatch läuft
  self-hosted, es fließen keine Daten an Dritte (Klassifikator-LLM nur, wenn der Betreiber
  ihn selbst anbindet — Hinweis im UI). README erhält einen Abschnitt zu
  Auftragsverarbeitung, Speicherfristen und der Empfehlung, `Mail.Read` per RBAC auf die
  nötigen Postfächer zu scopen (§3).

## 12. Sicherheit & Secrets *(neu entschieden in #10)*

- **Secrets at rest verschlüsselt:** Graph-Client-Secret/Zertifikat, Autotask-Credentials,
  Webhook-HMAC-Secrets und Heartbeat-Ping-URL liegen in Postgres **AES-256-GCM-verschlüsselt**;
  Schlüssel aus Umgebungsvariable `NIGHTWATCH_SECRET_KEY` (32 Byte, wird beim Setup generiert,
  steht nur in der `.env`). Schlüsselverlust ⇒ Credentials neu eingeben, keine Datenverlust-
  Kaskade. Kein externes KMS/Vault in v1 (kein Drittanbieter-Prinzip).
- **Watchdog-Config-Cache** (§8): dieselbe Verschlüsselung, Datei mit `0600` im Volume.
- **Keine Secrets in Logs, UI oder Webhook-Payloads;** das UI zeigt nur Fingerprints/letzte
  vier Zeichen; Export/Import von Regel-Vorlagen enthält nie Credentials.
- **Transport:** `web` spricht intern HTTP; TLS terminiert der Betreiber (Reverse-Proxy —
  dokumentiert im README). Ausgehend überall TLS (Graph, Autotask erzwingt TLS 1.2, Webhooks
  nur HTTPS-Ziele, HTTP nur mit explizitem Opt-in für interne Ziele).
- **Container-Härtung:** kein Docker-Socket, non-root User in den Images, `.env` nie im Image.

## 13. i18n

Paraglide mit **EN als Default** und vollständigem **DE** (erweiterbar). Regel-Muster und
Klassifikation sind sprachunabhängig (§5) — es braucht keine Sprach-Erkennungs-Library.
Domänenbegriffe im UI folgen CONTEXT.md; die EN-Übersetzungen der Begriffe werden bei der
Umsetzung als Glossar-Spalte ergänzt.

## 14. Distribution, Versionierung & Updates

Entschieden in [#4](https://github.com/erwins-enkel/nightwatch/issues/4)
([Research-Doc](docs/research/distribution-updates.md)):

- **Gestaffelte Kanäle:** ① `docker-compose.yml` + `.env.example` im Repo-Root (Single
  Source of Truth) → ② Portainer App-Template v3 (`templates.json` via Raw-URL,
  `repository`+`stackfile`) → ③ später DO-Marketplace-1-Click-Droplet (Packer, Vendor-Review)
  nach Produktreife.
- **Releases:** SemVer-Git-Tags als einziger Trigger; GitHub Actions baut Multi-Arch-Images
  (amd64/arm64) nach ghcr.io mit Tags `X.Y.Z`/`X.Y`/`X`/`latest`; veröffentlichtes Compose
  pinnt die **Minor-Version**; `APP_VERSION` im Image; `CHANGELOG.md` + Release Notes.
- **Update-Check (Update-UX):** der worker pollt täglich die GitHub-Releases-API; bei
  neuerem `tag_name` zeigt das Dashboard ein Banner + die Einstellungen-Seite Details
  (Version, Changelog-Link, Anleitung `docker compose pull && docker compose up -d`).
  **Kein Ein-Klick-Self-Update in v1** — das hieße Docker-Socket-Zugriff, den §2 bewusst
  ausschließt. Watchtower nur als dokumentiertes Opt-in (Notify-Modus, aktiver Fork).
- **DB-Migrationen:** Migrate-on-Startup (idempotent) nach DB-Healthcheck; vorwärts-
  kompatibel halten; Breaking-Migrationen im Changelog markieren.
- **Azure:** v1 liefert keine Azure-spezifischen Artefakte. Der Compose-Stack läuft auf jeder
  Docker-VM (auch Azure); ACI-/App-Service-Templates sind ein späterer, eigener Effort.

## 15. Implementierungs-Epic

Die Umsetzung ist als Epic mit PR-großen Kind-Issues ausgeplant (ein Issue ≙ eine
Session ≙ ein PR); Reihenfolge und Abhängigkeiten stehen im Epic-Issue
(`epic-dag`-Block). Grobe Route: Scaffold → Datenmodell → Ingestion → Zuordnung →
Monitor-Kern → Scheduler → Alarm-Lebenszyklus → Alarmwege (Autotask/Webhook) →
Self-Monitoring → UI (Board, Wizard, Triage/Suche) → Retention → Secrets-Härtung →
Update-Check & Distribution.
