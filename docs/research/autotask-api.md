# Research: Autotask-API für Ticket-Erstellung (#3)

**Frage:** Wie legt Nightwatch v1 Tickets in Autotask (Kaseya Autotask PSA) an — beim richtigen Kunden (Company)?

**Ergebnis in einem Satz:** Nightwatch nutzt die **Autotask REST API** (JSON) mit einem dedizierten **API-only-User** (Header-Auth), ermittelt zuerst die tenant-spezifische Zone via `zoneInformation`, legt Tickets per `POST /Tickets` an (Pflicht: `companyID`, `title`, `status`, `priority`, meist `queueID`), verhindert Duplikate über einen **eigenen Korrelations-Key in `externalID` oder einem UDF** (vor Anlage per Query prüfen — es gibt KEINE eingebaute Idempotenz), mappt Kunden über die `Companies`-Query, und puffert Alarme bei Nichterreichbarkeit in einer **persistenten Retry-Queue mit Backoff**.

---

## 1. Authentifizierung

Autotask REST nutzt **statische HTTP-Header** (kein OAuth, kein SSO). Alle Requests brauchen:

| Header | Wert |
|--------|------|
| `Username` | E-Mail-Adresse des API-Users |
| `Secret` | Passwort/Key des API-Users |
| `APIIntegrationcode` | Der **Tracking Identifier** (siehe unten) |
| `Content-Type` | `application/json` |

- Verbindung erfordert **TLS 1.2**. **Kein SSO** — API-Credentials sind komplett getrennt von UI-/SSO-Logins.
- Optional: **Impersonation** via Header `ImpersonationResourceId` (Ticket wird einem echten Resource zugeschrieben; beide brauchen die Berechtigung).

### API-User anlegen
- Der Auth-Account braucht das Security Level **„API User (API-only)"**. Es gibt **vollen System-Administrator-Zugriff über die REST-API, aber KEINEN UI-Zugriff**.
- **Keine Per-Seat-Kosten**, beliebig viele API-only-User möglich.
- Kopien des System-Security-Levels können eingeschränkt werden (Least Privilege → für Nightwatch reicht Tickets + Companies lesen/schreiben).

### Tracking Identifier (`APIIntegrationcode`)
Jeder API-only-User braucht einen Tracking Identifier:
- **Vendor Identifier**: für gelistete Integrationspartner (Menü-Auswahl).
- **Custom (Internal Integration)**: auto-generiert, beschränkt Zugriff auf die eigene DB — **für Nightwatch v1 die richtige Wahl** (self-hosted, kein gelisteter Vendor).

### Zonen-Ermittlung (IMMER erster Call)
Der Subdomain-Teil der Base-URL variiert pro Tenant. **Erster Call jeder Integration:**

```
GET http://webservices.autotask.net/atservicesrest/v1.0/zoneInformation?user=apiuser@kunde-domain.com
```

- **Keine Authentifizierung nötig**, **nicht thread-limitiert**.
- Antwort (JSON) liefert `url` = zonen-spezifische Base-URL für alle Folge-Calls:

```json
{
  "zoneName": "America East",
  "url": "https://webservices3.autotask.net/atservicesrest/",
  "webUrl": "https://ww3.autotask.net/",
  "ci": 20264
}
```

→ Nightwatch muss `url` beim Onboarding eines Kunden einmal ermitteln und persistieren (nicht hardcoden).

---

## 2. Rate Limits / Thresholds

- **10.000 externe Requests pro Stunde pro Datenbank** (zählt ALLE Integrationen dieses Tenants zusammen, gleitendes 60-Min-Fenster).
- **Progressive Latenz** statt hartem Block:
  - 0–49,99 % des Thresholds: keine Zusatzlatenz
  - 50–74,99 %: **+0,5 s** pro Request
  - ab 75 %: **+1 s** pro Request
- Bei Überschreitung: Fehlermeldung + **temporäre Sperre**; Benachrichtigung per E-Mail (Reihenfolge: „Unsuccessful Ticket Creation"-Adresse → Support-Adresse → primäre E-Mail des API-Users).
- Weitere Limits: max. **500 Records pro Query**, max. **500 OR-Bedingungen** pro Query, **5-Minuten-Timeout** pro Call.

**Bewertung für Nightwatch:** Das Limit ist für ein Alarm-Tool sehr großzügig — Nightwatch erzeugt nur bei Alarmen Traffic, nicht im Sekundentakt. Trotzdem: **Requests serialisieren**, Zonen-URL cachen, Company-Liste cachen statt bei jedem Alarm neu zu ziehen.

---

## 3. Ticket-Anlage (`POST /Tickets`)

Endpoint (zonen-spezifisch):
```
POST https://webservices{n}.autotask.net/atservicesrest/v1.0/Tickets
```

### Pflichtfelder
| Feld | Status | Hinweis |
|------|--------|---------|
| `companyID` | **Pflicht** | Ziel-Company (Kundenmapping, s. §5) |
| `title` | **Pflicht** | z. B. „[Nightwatch] Backup-Fehler / erwartete Mail ausgeblieben" |
| `status` | **Pflicht** | numerische Status-ID (z. B. 1 = „New") — IDs pro Tenant per GET auflösen |
| `priority` | **Pflicht** | muss eine **aktive** Priority-ID sein — pro Tenant auflösen |
| `dueDateTime` | i. d. R. Pflicht | außer die Ticket-Category liefert Due-Date+Time selbst |

### Bedingt erforderlich
- **`queueID`**: hängt von der Ticket-Category ab — Einstellung `Always` (immer nötig), `Never` (nicht nötig), `RequiredWhenPrimaryResourceIdBlank` (nötig wenn kein `assignedResourceID`). → Nightwatch sollte `queueID` **konfigurierbar** machen (z. B. „Triage").
- **`billingCodeID`** (Work Type): nur nötig, wenn das Tenant-Setting „Work Type auf Ticket erforderlich" aktiv ist.
- **`description`**: in der Feldtabelle **nicht als Pflicht** markiert, sollte aber immer gesetzt werden (Alarm-Details, Quell-Mailbox, Zeitstempel).

**Wichtig:** Alle ID-Felder (`status`, `priority`, `queueID`, `billingCodeID`) sind **tenant-spezifische numerische IDs**. Nightwatch muss sie pro Kunde per GET auf den jeweiligen Entities (bzw. `/Tickets/entityInformation/fields` bzw. Picklist-Endpoints) auflösen und in der Kunden-Konfiguration hinterlegen — **nicht hardcoden**.

---

## 4. Duplikat-Vermeidung bei wiederholten Alarmen

**Es gibt KEINE eingebaute Idempotenz** (kein Idempotency-Key-Header, `POST /Tickets` erzeugt bei jedem Call ein neues Ticket). Deshalb muss Nightwatch die Korrelation selbst bauen:

**Korrelations-Key-Feld — zwei Optionen:**
- **`externalID`** (String, max. 50 Zeichen) — Standard-Feld, ideal für einen stabilen Korrelations-Hash (z. B. `nw:{kundenId}:{monitorId}` oder Hash aus Mailbox+Regel).
- **UDF** (User Defined Field) — Tickets können bis zu **300 UDFs** haben; ein eigenes UDF „Nightwatch-AlertKey" ist die sauberere, aber Setup-aufwändigere Variante.

**Empfohlenes Muster (De-Dupe):**
1. Alarm feuert → Nightwatch berechnet stabilen `alertKey`.
2. **Vor Anlage** `POST /Tickets/query` mit Filter `externalID eq {alertKey}` **UND** Status = offen.
3. Treffer vorhanden → **kein neues Ticket**, stattdessen bestehendes Ticket per `PATCH` aktualisieren (z. B. Notiz/Zähler „X-tes Vorkommen") oder gar nichts tun.
4. Kein Treffer → neues Ticket mit `externalID = alertKey` anlegen.

→ Verhindert Ticket-Flut bei wiederkehrenden Fehlern und bildet den „erwartete-Mail-ausgeblieben"-Fall sauber ab (ein offenes Ticket pro Monitor bis Resolve).

---

## 5. Kundenmapping (Nightwatch-Kunde → Autotask Company)

`Companies`-Query lesen:
```
POST https://webservices{n}.autotask.net/atservicesrest/v1.0/Companies/query
```
Filter-Syntax (Body):
```json
{
  "filter": [ { "op": "eq", "field": "CompanyName", "value": "Sirius Cybernetics Corporation" } ],
  "includeFields": ["id", "companyName", "city", "state"]
}
```
Operatoren: `eq`, `beginsWith`, `contains` etc. GET-Query-Varianten sind ebenfalls möglich.

**Empfehlung:** Beim Kunden-Onboarding in Nightwatch die Company-Liste einmal ziehen, dem Nightwatch-Kunden **eine feste `companyID`** zuordnen und persistieren. Nicht bei jedem Alarm per Name suchen (Namen sind unzuverlässig/nicht eindeutig; spart Requests). Company-Liste ist paginiert (max. 500/Query).

---

## 6. Sandbox / Testmöglichkeiten

- Autotask bietet **Sandbox-Umgebungen** (getrennte Instanz für Integrationstests vor Produktion). Sandbox muss beim Autotask/Kaseya-Tenant angefordert werden.
- Für lokale Entwicklung: **Postman-Collection von Datto/Autotask**, plus Community-SDKs (NodeJS `apigrate/autotask-restapi`, PowerShell `KelvinTegelaar/AutotaskAPI`, Python `py-autotask`) als Referenz-Implementierungen der Auth-/Query-Mechanik.
- `zoneInformation` ist ohne Auth testbar — guter erster Konnektivitäts-Check.

**Empfehlung:** Für Nightwatch-Entwicklung gegen eine Autotask-Sandbox arbeiten; API-User + Custom Integration Code dort anlegen. Zusätzlich lokale Contract-Tests gegen ein Mock (aufgezeichnete Responses), damit CI nicht vom Live-Tenant abhängt.

---

## 7. Fehlerverhalten bei Nichterreichbarkeit

Da eine ausgebliebene Ticket-Anlage bei einem Monitoring-Tool **selbst ein Ausfall** ist, muss Nightwatch robust sein:

- **Persistente Retry-Queue**: Alarm-Ereignisse zuerst lokal/durabel persistieren (DB/Queue), Ticket-Anlage als eigener Worker-Job. So geht kein Alarm verloren, wenn Autotask down ist oder das Rate-Limit greift.
- **Exponential Backoff mit Jitter** bei 5xx / Timeout / Threshold-Sperre; Requests **serialisieren** (Autotask empfiehlt das explizit, minimiert Concurrency-Probleme).
- **Dead-Letter + Eskalation**: nach N Fehlversuchen alternativen Kanal (z. B. direkte Admin-Mail/Webhook), damit ein Autotask-Ausfall nicht die Alarmierung verschluckt.
- **Idempotenz auf Nightwatch-Seite**: dank `externalID`-Korrelation (§4) sind Retries sicher — ein doppelt zugestellter Request erzeugt kein Duplikat, weil vor Anlage geprüft wird.

---

## Quellen

- [The Autotask REST API (Home)](https://autotask.net/help/developerhelp/Content/APIs/REST/REST_API_Home.htm)
- [REST API security and authentication](https://www.autotask.net/help/developerhelp/Content/APIs/REST/General_Topics/REST_Security_Auth.htm)
- [Querying user zone information (zoneInformation)](https://www.autotask.net/help/Developerhelp/Content/APIs/REST/API_Calls/REST_ZoneInformation.htm)
- [REST API supportability, query thresholds, and latency](https://www.autotask.net/help/developerhelp/Content/APIs/REST/General_Topics/REST_Thresholds_Limits.htm)
- [REST API best practices](https://www.autotask.net/help/developerhelp/Content/APIs/REST/General_Topics/REST_BestPractices.htm)
- [Tickets entity](https://www.autotask.net/help/developerhelp/Content/APIs/REST/Entities/TicketsEntity.htm)
- [Making basic query calls to the REST API (Companies-Query)](https://www.autotask.net/help/developerhelp/Content/APIs/REST/API_Calls/REST_Basic_Query_Calls.htm)
- [Advanced query features of the REST API](https://www.autotask.net/help/developerhelp/Content/APIs/REST/API_Calls/REST_Advanced_Query_Features.htm)
- [Introduction to the Autotask REST API](https://psa.datto.com/help/DeveloperHelp/Content/APIs/REST/General_Topics/Intro_REST_API.htm)
