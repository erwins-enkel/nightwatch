# Research: M365/Graph-Postfach-Anbindung (Ingestion v1)

> Ticket: [#2](https://github.com/kai-osthoff/nightwatch/issues/2) · Teil der Wayfinder-Map [#1](https://github.com/kai-osthoff/nightwatch/issues/1)
> Stand: 2026-07-23 · Alle Fakten gegen Primärquellen auf learn.microsoft.com verifiziert.

## TL;DR / Empfehlung

**Nightwatch v1 zieht M365-Mails per Delta-Query-Polling (Pull), nicht per Change Notifications (Webhooks).**
Begründung: Der Container läuft ggf. on-prem hinter NAT und ist von außen nicht erreichbar — Graph-Webhooks brauchen aber eine **öffentlich erreichbare HTTPS-Notification-URL** und würden deshalb ausscheiden. Delta-Query ist reines Outbound-Polling und funktioniert hinter NAT ohne Inbound-Port.

**App-Modell:** Eine **Multi-Tenant-App-Registrierung** (im Nightwatch-Herausgeber-Tenant registriert), pro Kunden-Tenant per **Admin-Consent** aktiviert. **Application-Permission `Mail.Read`** (app-only, kein angemeldeter Nutzer), Auth per **Client-Credentials-Flow** (Secret oder besser Zertifikat/Federated Credential).

**Scoping auf einzelne Postfächer:** zwingend, sonst kann Nightwatch *alle* Postfächer des Kunden-Tenants lesen. Bevorzugt **RBAC for Applications in Exchange Online** (`New-ManagementRoleAssignment -Role "Application Mail.Read" -CustomResourceScope ...`); die ältere **Application Access Policy** ist die Legacy-Alternative und wird von RBAC abgelöst.

**Poll-Intervall:** 1–5 Minuten pro Postfach ist unkritisch. Outlook-Limit sind **10.000 Requests / 10 Min. pro App+Postfach** und **max. 4 gleichzeitige Requests pro Postfach** — beides wird bei Monitoring-Polling nie annähernd erreicht.

**Selbstüberwachung (Kernfeature):** Zwei getrennte Ebenen — (a) *Ingestion-Health* = kann Nightwatch überhaupt noch pollen (Token/Consent), erkennbar an konkreten OAuth-/HTTP-Fehlern; (b) *Absence-Detection* = die eigentliche Nightwatch-Idee, ein Dead-Man's-Switch pro erwarteter Mail-Quelle. Beide müssen unabhängig alarmieren.

---

## 1. Polling (Delta-Query) vs. Change Notifications (Webhooks)

### Warum Webhooks hier ausscheiden
Change Notifications liefern Ereignisse per HTTP-POST an eine von dir betriebene URL. Voraussetzung laut Doku:

> "To use webhooks, you need to define a publicly accessible HTTPS-secured endpoint that receives the notifications."

Zusätzlich validiert Graph diese URL schon bei der Subscription-Erstellung (POST mit Validation-Token, der synchron beantwortet werden muss) und **reautorisiert regelmäßig** — die Subscription für Outlook-`message`-Ressourcen ist kurzlebig und muss laufend erneuert werden. Für einen Container hinter NAT ohne eingehenden Port ist das nicht praktikabel (man müsste Reverse-Tunnel/Relay bauen — zusätzliche Abhängigkeit, genau das, was Nightwatch vermeiden will). Weiterer Stolperstein: **max. 1000 aktive Subscriptions pro Postfach** über alle Apps.

### Warum Delta-Query passt
Delta-Query ist reines Pull über ausgehende HTTPS-Requests:

> "Using delta query helps you avoid constantly polling Microsoft Graph … the app requests only data that changed since the last request."

Ablauf pro Ordner (typisch `Inbox`):
1. Initial: `GET /v1.0/users/{id}/mailFolders/{folderId}/messages/delta`
2. Antwort paginiert via `@odata.nextLink` (mit `skipToken`); am Ende kommt ein `@odata.deltaLink` (mit `deltaToken`).
3. `deltaToken` (bzw. den ganzen deltaLink) persistieren. Beim nächsten Poll diesen Link aufrufen → man bekommt nur seit dem letzten Mal neu eingegangene/geänderte/gelöschte Nachrichten.

Wichtig:
- **Delta ist pro Ordner** — Ordnerhierarchie muss einzeln getrackt werden. Für Nightwatch reicht i.d.R. der Posteingang (bzw. ein per Regel gefüllter Zielordner).
- Mit `changeType=created` lässt sich auf neu eingegangene Mails filtern.
- Der `deltaToken` ist der State — er ist die einzige Zustandsgröße, die Nightwatch pro Postfach persistent halten muss (plus Metadaten für die Absence-Detection).

**Quellen:**
- [Use delta query to track changes in Microsoft Graph data](https://learn.microsoft.com/en-us/graph/delta-query-overview)
- [Get incremental changes to messages in a folder](https://learn.microsoft.com/en-us/graph/delta-query-messages)
- [message: delta (v1.0)](https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0)
- [Change notifications for Outlook resources](https://learn.microsoft.com/en-us/graph/outlook-change-notifications-overview)
- [Receive change notifications through webhooks](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks)

---

## 2. App-Registrierung: Single- vs. Multi-Tenant + Admin-Consent (MSP-Szenario)

Im MSP-Szenario liegen die zu überwachenden Postfächer in **fremden Kunden-Tenants**. Deshalb:

- **Multi-Tenant-App-Registrierung** einmalig im Nightwatch-Publisher-Tenant. Jeder Kunde bekommt so **dieselbe** `client_id`, muss aber selbst konsentieren.
- **Admin-Consent pro Kunden-Tenant** über den Admin-Consent-Endpunkt:
  `GET https://login.microsoftonline.com/{tenant}/adminconsent?client_id={id}&state=...&redirect_uri=...`
  Nur ein autorisierter Admin des Ziel-Tenants kann das abschließen. Nach Consent erscheint die App als **Enterprise Application** (Service Principal) im Kunden-Tenant mit den gewährten App-Permissions.
- Application-Permissions **erfordern immer Admin-Consent** (kein User-Consent möglich).
- Alternative pro Tenant: dedizierte Single-Tenant-Registrierung je Kunde — mehr Verwaltungsaufwand, aber maximale Isolation. **Empfehlung: Multi-Tenant** als Default, Single-Tenant nur wenn ein Kunde keine Fremd-App im Tenant zulässt.

Nightwatch braucht pro Kunde also: `tenant_id` (des Kunden), die eigene `client_id` + Credential, und die Liste der Ziel-Postfach-Adressen/IDs.

**Quellen:**
- [Get access without a user (app-only)](https://learn.microsoft.com/en-us/graph/auth-v2-service)
- [Microsoft identity platform admin consent protocols](https://learn.microsoft.com/en-us/entra/identity-platform/v2-admin-consent)
- [Grant tenant-wide admin consent to an application](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent)
- [Convert single-tenant app to multitenant](https://learn.microsoft.com/en-us/entra/identity-platform/howto-convert-app-to-be-multi-tenant)

---

## 3. Permissions: Application vs. Delegated + Scoping auf einzelne Postfächer

### Application statt Delegated
- **Delegated `Mail.Read`** braucht einen interaktiv angemeldeten Nutzer und Refresh-Tokens — passt nicht zu einem unbeaufsichtigten Daemon, der dauerhaft läuft.
- **Application `Mail.Read`** (app-only) ist richtig: "Allows the app to read email in all mailboxes without a signed-in user." → deshalb ist Scoping Pflicht.

### Problem: Application `Mail.Read` gilt tenant-weit
Ohne Einschränkung darf die App **jedes** Postfach im Kunden-Tenant lesen. Für ein Monitoring-Tool, das nur 1–n definierte Postfächer braucht, ist das ein unnötiges Risiko und für Kunden-Admins ein Consent-Blocker. Zwei Mechanismen schränken ein:

#### (a) RBAC for Applications in Exchange Online — **empfohlen** (modern)
Ersetzt laut Microsoft die Application Access Policies. Man weist der App eine Exchange-Application-Rolle mit **Resource-Scope** zu:

```powershell
# Service-Principal-Pointer in Exchange anlegen (verweist auf Entra-SP)
New-ServicePrincipal -AppId <client-id> -ObjectId <sp-object-id> -DisplayName "Nightwatch"

# Scope über Management-Scope (Recipient-Filter) ODER Admin Unit
New-ManagementScope -Name "Nightwatch-Mailboxes" -RecipientRestrictionFilter "MemberOfGroup -eq '<DN der Gruppe>'"

# Rolle Application Mail.Read auf diesen Scope binden
New-ManagementRoleAssignment -App <sp-object-id> -Role "Application Mail.Read" -CustomResourceScope "Nightwatch-Mailboxes"
```

Wichtige Details:
- Rolle heißt exakt **`Application Mail.Read`** (Graph-Permission `Mail.Read`). Es gibt auch `Application Mail.ReadBasic` (ohne Body/Attachments) — für reine Betreff-/Absender-Überwachung ggf. datensparsamer.
- Scope entweder **Management Scope** (Recipient-Filter, z.B. `MemberOfGroup`, `CustomAttribute…`) oder **Administrative Unit** (`-RecipientAdministrativeUnitScope`).
- **Fallstrick (Union-Semantik):** RBAC-Grants sind **additiv** zu Entra-Grants. Wenn dieselbe App zusätzlich ein *ungescopetes* `Mail.Read` in Entra ID konsentiert hat, hebt das die Scope-Beschränkung effektiv auf. → In Entra ID darf die App **kein** organisationsweites `Mail.Read` haben, wenn Scoping über RBAC greifen soll.
- Änderungen an App-Permissions greifen mit **Cache-Latenz 30 Min – 2 h** (aktive App bis 2 h). Nur `Test-ServicePrincipalAuthorization` umgeht den Cache.
- Grenzen: bis 10.000 Apps/Org; nur **direkte** Gruppenmitgliedschaft zählt (keine verschachtelten Gruppen).

#### (b) Application Access Policy — Legacy-Fallback
Älterer Mechanismus, schränkt **die in Entra ID vergebenen** App-Permissions über eine **mail-enabled Security Group** ein:

```powershell
New-ApplicationAccessPolicy -AppId <client-id> -PolicyScopeGroupId <group> -AccessRight RestrictAccess
```
`RestrictAccess` = nur Postfächer der Gruppe; `DenyAccess` = alle außer der Gruppe (Deny gewinnt vor Restrict). Unterstützt `Mail.Read`, `Mail.ReadWrite`, `Mail.Send`. Wird von RBAC abgelöst → für Neubau **RBAC bevorzugen**, App Access Policy nur dokumentieren, falls ein Ziel-Tenant RBAC noch nicht nutzt.

**Empfehlung für Nightwatch-Onboarding:** Kunden-Admin legt eine Security-/M365-Gruppe mit genau den zu überwachenden Postfächern an; Nightwatch liefert ein PowerShell-Snippet (RBAC-Variante) mit. So bleibt der Consent minimal-invasiv und auditierbar.

**Quellen:**
- [RBAC for Applications in Exchange Online](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)
- [Application Access Policies (legacy)](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-access-policies)
- [New-ApplicationAccessPolicy](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/new-applicationaccesspolicy?view=exchange-ps)
- [Microsoft Graph permissions reference (Mail.Read)](https://learn.microsoft.com/en-us/graph/permissions-reference)

---

## 4. Token-Handling / Refresh / sichere Ablage

- **Flow:** OAuth 2.0 **Client Credentials** gegen `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` mit `scope=https://graph.microsoft.com/.default`, `grant_type=client_credentials`.
- **Keine Refresh-Tokens:** "Refresh tokens will never be granted with this flow" — man holt bei Bedarf einfach mit `client_id`+Credential einen frischen Access-Token. Kein Refresh-Token-Store, kein Rotationsproblem auf Token-Ebene.
- **Access-Token-Lebensdauer:** ca. 1 h. Token cachen bis kurz vor Ablauf, dann neu holen (MSAL macht das automatisch inkl. In-Memory-Cache).
- **Credential-Ablage:** Client-Secret oder — sicherer — **Zertifikat** bzw. **Federated Identity Credential**. Docs empfehlen Zertifikat/Federated für höheren Assurance-Level. Für den self-hosted Container: Secret/Zertifikat nur aus ENV/Secret-Mount lesen, nie im Image/Repo; pro Kunde separat verschlüsselt ablegen.
- **MSAL** (Microsoft Authentication Library) als Client übernimmt Token-Erwerb + Caching und ist der empfohlene Weg statt manuellem HTTP.

**Quellen:**
- [OAuth 2.0 client credentials flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow)
- [Get access without a user](https://learn.microsoft.com/en-us/graph/auth-v2-service)

---

## 5. Throttling-Limits & sinnvolle Poll-Intervalle

Outlook wendet Limits **pro App-ID + Postfach** an (ein Postfach über Limit blockt nicht die anderen):

| Limit | Wert |
|---|---|
| API-Requests | **10.000 / 10 Minuten** pro App+Postfach |
| Gleichzeitige Requests | **max. 4** pro Postfach |
| Upload | 150 MB / 5 Min (für Nightwatch irrelevant) |

Diese Per-Mailbox-Limits sind **feste Service-Limits, nicht anhebbar**. Bei Überschreitung liefert Graph **HTTP 429** mit `Retry-After`-Header — den zwingend respektieren (Backoff).

**Poll-Intervall-Empfehlung:** 60–300 s pro Postfach. Rechnung: 1 Delta-Request/Minute = 10 Requests / 10 Min ≪ 10.000. Selbst hunderte Postfächer bleiben weit unter den Limits, weil jedes Postfach ein eigenes Budget hat. Skalierung über viele Postfächer parallelisieren, aber pro Postfach ≤ 4 concurrent + eigene Queue. `429` + `503` immer mit exponential Backoff behandeln.

**Quellen:**
- [Microsoft Graph service-specific throttling limits](https://learn.microsoft.com/en-us/graph/throttling-limits)
- [Microsoft Graph throttling guidance](https://learn.microsoft.com/en-us/graph/throttling)

---

## 6. "Monitoring des Monitors" — wie merkt Nightwatch, dass die eigene Ingestion tot ist?

Zwei **unabhängige** Ausfallklassen, beide müssen eskalieren:

### (a) Ingestion-Health — kann Nightwatch überhaupt noch lesen?
Fehlersignale beim Poll:
- **Token nicht mehr erhältlich / Consent widerrufen:** Client-Credentials-Request scheitert mit `AADSTS`-Fehlern (z.B. `AADSTS7000215` ungültiges Secret, `AADSTS700016` App im Tenant nicht (mehr) vorhanden, `AADSTS65001` kein Consent). → App wurde im Kunden-Tenant deaktiviert/Consent entzogen.
- **Secret/Zertifikat abgelaufen:** ebenfalls `AADSTS`-Auth-Fehler → proaktiv Ablaufdatum des Credentials tracken und *vor* Ablauf warnen.
- **Permission/Scope entfernt oder RBAC-Assignment gelöscht:** Graph-Call liefert **HTTP 403** (`ErrorAccessDenied`). Cache-Latenz (30 Min–2 h) beachten.
- **Postfach/Ordner weg, Delta-Token ungültig:** `410 Gone` (`resyncRequired`) → Delta-State verwerfen und neu initialisieren; `404` → Postfach existiert nicht mehr.
- **Dauerhaftes `429`/`503`:** Throttling/Dienststörung.

Umsetzung: Nightwatch führt pro (Tenant, Postfach) einen **Ingestion-Status** mit `last_successful_poll`-Zeitstempel. Bleibt ein erfolgreicher Poll länger als N Intervalle aus **oder** tritt einer der Auth-/403-/410-Fehler auf → eigener Alarm ("Nightwatch kann Postfach X nicht mehr lesen"). Dieser Alarm muss über einen **von der Mail-Ingestion unabhängigen Kanal** rausgehen (die Mail-Pipeline ist ja evtl. genau das Kaputte).

### (b) Absence-Detection — die eigentliche Nightwatch-Idee
Das ist **kein** Graph-Feature, sondern Nightwatch-Kernlogik: Pro erwarteter Mail-Quelle (z.B. tägliche Backup-OK-Mail) definiert der Nutzer ein Erwartungsfenster (Cron/Intervall + Toleranz + Matching-Regel auf Absender/Betreff). Nightwatch führt je Quelle einen **Dead-Man's-Switch**: Kommt innerhalb des Fensters **keine** passende Mail, wird alarmiert — genau der Fall "Backup-Software läuft gar nicht mehr, also kommt keine Fehlermeldung".

Wichtig: (a) und (b) sauber trennen. Sonst maskiert ein toter Ingest (a) fälschlich als "keine Mail = Alarm" (b) oder umgekehrt. Ein toter Ingest darf **nicht** stumm bleiben und darf auch nicht alle Absence-Timer fälschlich auslösen — bei bekanntem Ingestion-Ausfall werden Absence-Alarme sinnvollerweise pausiert/als "unbekannt" markiert, während der Ingestion-Alarm feuert.

**Quellen:**
- [Microsoft Graph throttling (429/Retry-After, 503)](https://learn.microsoft.com/en-us/graph/throttling)
- [delta query overview — resync/`@odata.deltaLink` state](https://learn.microsoft.com/en-us/graph/delta-query-overview)
- [OAuth 2.0 client credentials flow (AADSTS-Fehler)](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow)

---

## Konsequenzen für die Architektur (Zusammenfassung)

1. **Ingestion-Worker pro Postfach**: Client-Credentials-Token (MSAL, gecacht) → `messages/delta` auf Posteingang → `deltaToken` persistieren. Intervall 60–300 s.
2. **Onboarding-Artefakt**: Multi-Tenant-App, Admin-Consent-Link + RBAC-PowerShell-Snippet (Gruppe mit Ziel-Postfächern, `Application Mail.Read`, Management Scope). Legacy: Application Access Policy.
3. **Persistenter State pro Postfach**: `deltaToken`, `last_successful_poll`, Credential-Ablaufdatum, letzter Fehlercode.
4. **Zwei Alarm-Ebenen**: Ingestion-Health (Auth/403/410/Timeout) und Absence-Detection (Dead-Man's-Switch), über ingestion-unabhängigen Ausgangskanal.
5. **Keine öffentlich erreichbaren Ports nötig** — Container läuft rein outbound, NAT-tauglich.
