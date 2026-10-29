# Nightwatch

**Self-hosted email-notification monitoring that also catches the alerts that _never arrive_.**

Nightwatch watches one or more mailboxes for the operational notifications your systems
send — backup reports, firmware-update notices, router "line down / line back" messages,
printer alerts, and the like. Its defining feature is detecting the notifications that
**stop coming**: when a monitored system goes silent, Nightwatch treats the missing mail as
an incident instead of assuming everything is fine.

> **Project status: design / specification phase — pre-implementation.**
> There is no runnable application yet. This repository currently holds the concept, the
> research findings, and the product/architecture decisions. See
> [Project status & roadmap](#project-status--roadmap). Everything under
> [Planned deployment](#planned-deployment) describes the intended experience, not something
> you can install today.

---

## The problem: silent failures hide in a full inbox

Most email-based monitoring only reacts to failure messages. That leaves a blind spot: if
the backup software (or router, or printer fleet) stops running entirely, it stops sending
mail — including its error mail. No message arrives, so nothing looks wrong.

Meanwhile the mailbox fills with "OK / completed successfully" notifications. A person
scrolling through hundreds of green mails will not notice the one report that quietly went
missing last Tuesday. That gap is exactly the outage you most need to know about.

Nightwatch closes this blind spot by monitoring for **absence** — an expected message that
does not arrive within its window is an alarm in its own right — alongside classic
error-message and event detection.

## Who it's for

IT-focused businesses that already receive machine notifications by email and need them
watched reliably: **managed service providers (MSPs)**, **IT system houses**, and
**print/device specialists**. Nightwatch v1 is a tool for the provider's own team.

## Self-hosted, running in your own environment

Nightwatch is designed to run entirely in **your** infrastructure — a Docker deployment on
your own network, a DigitalOcean droplet, or an Azure container. There is **no
Nightwatch-operated SaaS or vendor control-plane** it phones home to, and no per-seat
third-party service is required to operate it.

That independence is about *where it runs*, not about never talking to anything external.
To do its job, v1 connects to the systems you point it at and the integrations you opt into:

| External system | Role in v1 | Required? |
| --- | --- | --- |
| **Microsoft 365 / Microsoft Graph** | Reads the monitored mailboxes (ingestion) | **Required** for v1 — it is the only ingestion source |
| **Autotask (Kaseya PSA)** | Opens/updates tickets for the right customer | Opt-in alerting integration |
| **GitHub Releases API** | Powers the in-app "update available" check | Opt-in; can be ignored |

See [`docs/research/m365-graph-ingestion.md`](docs/research/m365-graph-ingestion.md),
[`docs/research/autotask-api.md`](docs/research/autotask-api.md), and
[`docs/research/distribution-updates.md`](docs/research/distribution-updates.md) for the
detailed findings behind each.

---

## Core concepts

The domain model (worked out in
[issue #5](https://github.com/erwins-enkel/nightwatch/issues/5)) keeps a small, deliberate
vocabulary. The design discussion is conducted in German; the terms below are the English
equivalents.

### Monitor and Rule

- A **Monitor** is the atomic unit of observation — one per monitored thing. It is created
  deliberately by a person, carries a health state, and raises an **Alarm** or an
  **All-clear** to the outside world when that state changes.
- Each Monitor has exactly one **Rule** — the detection logic (match criteria plus
  OK/error patterns). The Rule is the changeable, learnable part: "revise the rule"
  sharpens the patterns without rebuilding the Monitor. Rules can come from three sources:
  authored manually, learned, or shipped as a curated **Rule template** for a known
  vendor/product (planned detail in
  [issue #9](https://github.com/erwins-enkel/nightwatch/issues/9)).
- Rules are **language-independent**: the same software may report "Backup completed
  successfully", "Sicherung erfolgreich abgeschlossen", or "Sauvegarde terminée", so
  patterns may be multilingual. There is no separate language-detection step at the core of
  v1.

### Monitor kinds

Monitor kinds are an **open, extensible set** — new kinds can be added without changing the
state machine. Every kind honours the same three-part contract: **Trigger** (what starts an
evaluation), **Bad condition** (when it becomes impaired), and **Recovery condition** (what
brings it back to healthy).

| Kind | Bad when… | Example |
| --- | --- | --- |
| **Heartbeat** | an expected mail is **overdue**, or an arrived mail is classified as an error | nightly backup report |
| **Event** | a matching mail **arrives** (these mails only come in the failure case) | "firmware update available" |
| **Pair / State** | a paired "open" mail has stayed open too long (recovers on the "close" mail) | router "line down" … "line back"; job "started" … "finished" |
| **Threshold / Rate** | more than _N_ matching mails arrive within window _T_ (message storm, flapping) | alert flapping |
| **Volume / Deviation** | the mail volume deviates sharply from the learned normal | "normally ~100 OK/day, today only 3" |

### Expectation (for Heartbeat monitors)

A Heartbeat monitor's **Expectation** defines when a mail must arrive, as either an
**Interval** (a sliding "at least every X", reset by each arrival) or a **Calendar schedule**
(cron-like absolute times, e.g. "Mon–Fri by 06:00", which also covers weekends without an
extra concept). Every Expectation includes a **Grace** window (tolerance) before "overdue"
fires. In v1, holidays are handled by manually configured **Exception days**.

### Classification and the Classifier

Each mail matched to a monitor is judged three ways: **OK**, **Error** (takes precedence),
or **Unclear** (no pattern matched). The judging engine is a pluggable **Classifier**:

- v1 is **pattern-based** (regex / subject / sender), with a clean seam for **intelligent
  extraction** from unstructured report mails — a local model, or an LLM the operator
  optionally connects. Because it is optional and operator-configured, it stays
  self-hosting-compatible. This seam is the intended differentiator over rigid regex-only
  parsing.
- **Unclear** mail escalates like an error (it creates a customer ticket, the customer is
  known) but with its own reason and the recommended action "revise the rule" — so a new,
  unrecognised error text never slips through silently as "OK".
- **Unassigned** mail (matching no monitor) creates **no** customer ticket; it lands in a
  system **triage** view in the dashboard and feeds rule creation.

### Creating rules

Rules are created in a four-step wizard — **customer → kind → detection → parameters**. Where a
rule comes from only changes how much of that wizard is prefilled: nothing (by hand), kind plus
detection plus parameter defaults (a **rule template**), or detection plus a kind guess plus the
recognised rhythm (**derived from an example mail**). Details in
[`docs/regel-entstehung.md`](docs/regel-entstehung.md).

- **No rule becomes active without a human confirming it.** A new monitor is a draft until it is
  activated, and activation is also its epoch — it never judges anything from before it.
- The derivation fills in **only the temporal and the structural**: match criteria, the recognised
  **rhythm** turned into an expectation, a grace period from the observed spread, counter bounds
  from the learning window. Which sentence in a report means "all good" is marked by a person in
  the example text. Every proposal carries its evidence — *"every working day ~05:40, from 10
  occurrences"*.
- A **rhythm** is recognised from three occurrences at ≤ 25 % spread (floor 15 minutes), as one of
  interval, daily, every working day or weekly. Monthly is deliberately absent: a ~30-day learning
  window cannot evidence it.
- **Rule templates** for known products ship inside the image and are updated with releases; you
  can build your own from an existing monitor and export/import them. A template carries rule and
  parameter fields and nothing else — never credentials.

### Customer matching

A single mailbox typically carries notifications for many customers. Nightwatch attributes
each mail to a customer via mail characteristics — sender, recipient (including
plus-notation such as `noc+customera@systemhouse.example`), and customer identifiers in the
body. Conflict resolution when several monitors match is being specified in
[issue #6](https://github.com/erwins-enkel/nightwatch/issues/6).

### Health state machine

Every monitor kind shares one state machine: **Healthy ⇄ Impaired**, where an Impaired
monitor carries an **alarm reason**. Transitions fire outward — moving to Impaired raises an
**Alarm**; moving back to Healthy raises an **All-clear** (a first-class event that can, for
example, comment on or close a ticket). A **Paused** overlay covers maintenance windows:
paused is visible and deliberate, not the same as "off".

### Self-monitoring

A monitoring tool that fails silently is worse than useless, so Nightwatch applies its own
dead-man's-switch idea to itself. It separates two independent failure classes, each of
which must alarm on its own:

1. **Ingestion health** — can Nightwatch still read the mailbox at all? Revoked consent,
   expired secrets, removed permissions, or an invalid delta token surface as concrete
   OAuth/HTTP errors.
2. **Absence detection** — the core Nightwatch idea: a dead-man's switch per expected
   source.

The "Nightwatch itself is degraded" signal is delivered over a channel **independent of the
mail pipeline** (since the mail pipeline may be exactly what is broken).

Concretely, Nightwatch runs built-in system monitors — one per mailbox plus a global
"Nightwatch-Kern" — with the same state machine and alarm lifecycle as any customer monitor. The
`watchdog` service evaluates them and sends their alarms on its own path, without the worker or the
job queue, backed by a local encrypted cache so that a **database outage** can still be reported.
While a mailbox's ingestion is provably broken, overdue decisions for its monitors are *suspended
rather than taken*, so a Graph outage produces one self-alarm instead of a ticket per customer. And
an opt-in outgoing **heartbeat ping** covers the one failure no process of a dead instance could
report itself: the total outage.

See [`docs/self-monitoring.md`](docs/self-monitoring.md), plus
[issue #11](https://github.com/erwins-enkel/nightwatch/issues/11) and
[issue #12](https://github.com/erwins-enkel/nightwatch/issues/12).

---

## Alerting channels (v1)

When a monitor changes state, Nightwatch can alert through:

- **Dashboard** — the built-in web UI.
- **Autotask PSA ticket** — opened against the correct customer (Company). De-duplication
  uses a stable correlation key stored in the ticket's `externalID` (Autotask has no native
  idempotency), and alerts are buffered in a durable retry queue so no alert is lost when
  Autotask is unreachable.
- **Generic webhook** — an integration-agnostic escape hatch (this is also how PSAs other
  than Autotask, e.g. DocBee, are reached in v1).

Email alerts are intentionally **not** part of v1.

### Connecting Autotask

Two steps, one in Autotask and one in Nightwatch.

**In Autotask**, create a dedicated user with the security level **API User (API-only)** and a
**Custom (Internal Integration)** tracking identifier. API-only users cost no seat and have no UI
access; a copy of the system security level restricted to reading and writing tickets and reading
companies is enough.

**In Nightwatch**, open *Settings → Autotask*:

1. Save the API user name, its secret and the integration code. All three are stored AES-256-GCM
   encrypted, so `NIGHTWATCH_SECRET_KEY` has to be set (see [Connecting a
   mailbox](#connecting-a-mailbox)).
2. **Resolve the zone.** Autotask's API base URL differs per database; it is looked up once and
   stored, never per call.
3. **Pick the ticket defaults.** Status, priority, queue, work type and the note fields are
   numeric IDs *of your database* — Nightwatch reads them from your picklists and stores what you
   choose. Nothing is hardcoded, so no value is assumed to mean the same thing in your tenant as in
   anyone else's. Status and priority are mandatory; without them no ticket is ever attempted.
4. **Link your customers.** On each customer page, search the Autotask directory and pick the
   company. Only its stable ID is stored — there is no continuous sync and no bulk import, and a
   customer without a link keeps alerting through the dashboard and webhooks.

What then happens on an alarm: Nightwatch opens **one ticket per monitor**, carrying a correlation
key in `externalID`. Before creating anything it queries for that key, which is what makes a retry
after a crash idempotent. Escalations and all-clears are added as notes; the ticket is only closed
automatically when the recovery was evidence-based **and** the ticket is untouched — still in its
creation status, with nobody assigned. Deliveries run through a durable queue with exponential
backoff, serialized as Autotask asks; once the attempts are spent, the delivery is marked failed and
the alert delivery itself counts as disturbed.

## Email ingestion (v1): Microsoft 365 / Microsoft Graph

v1 ingests mail from **Microsoft 365 only**, via **Graph delta-query polling** (pull) rather
than change-notification webhooks. Polling is outbound-only, so it works from a container
behind NAT with no inbound port — webhooks would require a publicly reachable HTTPS endpoint
and are ruled out for the on-prem case.

- **App model:** a single **multi-tenant app registration**, activated per customer tenant
  via **admin consent**, using the **application** permission `Mail.Read` (app-only,
  client-credentials flow).
- **Mailbox scoping is mandatory:** rather than granting tenant-wide mail access, the app is
  scoped to just the monitored mailboxes — preferably via **RBAC for Applications in
  Exchange Online**, with the legacy **Application Access Policy** as a fallback.
- **Polling cadence:** 60–300 s per mailbox, comfortably within Graph's throttling limits.

Full rationale, PowerShell onboarding snippets, and error-handling details are in
[`docs/research/m365-graph-ingestion.md`](docs/research/m365-graph-ingestion.md).

### Connecting a mailbox

Set `NIGHTWATCH_SECRET_KEY` in your `.env` first — it encrypts every credential Nightwatch
stores (AES-256-GCM). The stack boots without it, but connecting a mailbox will fail:

```sh
openssl rand -base64 32
```

Then open **Settings → Mailboxes** (`/einstellungen/postfaecher`) and enter the customer's
tenant ID, your app registration's client ID and secret, and the mailbox address. The page then
shows the two things you hand to the customer's administrator:

1. an **admin consent link** for that tenant, and
2. a **PowerShell snippet** that scopes `Mail.Read` down to this one mailbox via RBAC for
   Applications in Exchange Online.

Register the redirect URI the page displays (`<your origin>/einstellungen/postfaecher/consent`)
in your app registration first — Microsoft Entra ID matches it character for character.

> **Do the scoping step.** Application `Mail.Read` is tenant-wide by default, so consent alone
> lets Nightwatch read *every* mailbox in the customer tenant. Note also that RBAC grants are
> **additive** to Entra grants: if the same app additionally holds an organisation-wide
> `Mail.Read` in Entra ID, that silently defeats the scope. Permission changes take 30 minutes
> to 2 hours to propagate.

### Learning window

Connecting a mailbox pulls a one-off backfill of past mail — 30 days by default, configurable
per mailbox. It feeds mail search, Takt recognition and rule derivation, and is marked as such
in the database: **history is learning material, never monitoring material.** Monitors only
ever evaluate forward from their own activation, so a freshly connected mailbox never produces
a burst of tickets for gaps that predate it.

### Ingestion status

Every mailbox records its last successful poll, its last error code, and how close its
credential is to expiring — visible on the same settings page. Throttling (`429`/`503`) is
honoured via `Retry-After`, an expired delta token (`410 Gone`) triggers an automatic resync,
and repeated failures back off exponentially up to 15 minutes. Turning that status into an
alarm is the job of the mailbox **self-monitor**, which arrives with the self-monitoring
milestone.

---

## Architecture & tech stack

The stack is aligned with [pulse](https://github.com/erwins-enkel/pulse) so Nightwatch can
later dock in as a pulse module, while deliberately **not** adopting pulse's serverless
deployment — Nightwatch's core is a continuous poller (a persistent process), which is not a
serverless workload.

| Layer | Choice |
| --- | --- |
| Language | TypeScript |
| Runtime | Bun (in the container) |
| Framework | SvelteKit 2 / Svelte 5, `adapter-node` (self-hosted, not Vercel) |
| ORM / DB | Drizzle + PostgreSQL (bundled Compose service + volume; `DATABASE_URL` override for bring-your-own) |
| Job queue | pg-boss (Postgres-backed, no Redis) — the durable retry queue for Autotask tickets and webhooks |
| UI kit | Tailwind 4, bits-ui, layerchart, lucide (mirrored from pulse) |
| i18n | Paraglide — English default plus German, extensible |
| Helpers | `date-holidays` (schedules/holidays), `limiter` (Graph/Autotask rate limits) |
| Graph client | `@microsoft/microsoft-graph-client` + `@azure/msal-node` |

### Container topology (four Compose services)

- **`web`** — the SvelteKit dashboard and configuration API.
- **`worker`** — the Graph delta poller, the absence/schedule checker (dead-man's switch,
  using `date-holidays`), and the pg-boss worker for Autotask tickets and webhooks.
- **`watchdog`** — deliberately tiny: it aggregates Postgres heartbeats for the UI health
  display and emits the out-of-band "Nightwatch itself is degraded" alarm. No Docker socket
  by default.
- **`postgres`** — the official image plus a named volume.

Running as a Compose stack (rather than a single container) is a conscious choice: separate
processes give better observability and self-healing.

### Self-healing / supervision

- **`restart: unless-stopped` is the supervisor** — the Docker daemon is the watcher. There
  is no mutual peer-restart, which avoids split-brain ("who watches the watcher").
- An **in-process watchdog timer (self-petting)** is the primary defence against a
  hung-but-alive process: if the main loop stops ticking, the process exits and Docker
  brings it back. No Docker socket and no elevated privileges are needed.
- **Postgres heartbeats** provide mutual visibility; a UI "restart" is a desired-state
  signal, not a direct peer kill.
- A socket-based active force-restart (for the rare total hang) is opt-in behind a
  socket-proxy and is **not** in v1.

> **Compose healthchecks do not restart anything.** Docker only restarts a container that
> *exits*; an `unhealthy` one is left alone (that is a Swarm feature). The healthchecks in
> `docker-compose.yml` exist to order startup via `depends_on` and to make `docker compose ps`
> tell the truth. Self-healing comes from the in-process watchdog exiting plus
> `restart: unless-stopped` — nothing else.

---

## Running it

The stack runs from the repository root. Everything below works today; what it *does* so far
is come up, report its own health and serve a placeholder page — the monitoring itself is
being built out issue by issue (see the roadmap).

### With Docker Compose

```bash
cp .env.example .env       # then edit POSTGRES_PASSWORD at least
docker compose up -d --build
curl localhost:3000/health
```

`web`, `worker` and `watchdog` all run from the **same image**, distinguished only by their
command — one tag to pull, one image to harden. Startup is ordered `postgres` (healthy) →
`web` → `worker` + `watchdog`: `web` applies the database migrations before it starts
serving, so it is the only migrator and no locking is needed.

`GET /health` is passive — it reports, it never acts, and it is safe to poll as often as you
like. It answers `200`/`ok` when the web service can reach the database, and `503`/`degraded`
when it cannot. The heartbeat freshness of the other services is reported in the body but
deliberately does not affect the status code: `worker` and `watchdog` wait for `web` to be
healthy, so folding their heartbeats into it would deadlock a cold start.

### For development

```bash
bun install
docker compose up -d postgres

# Point host-side processes at the published Postgres port. Put this in .env.local, not .env:
# Bun reads .env.local and Compose does not, so the containers keep using the `postgres` host.
echo 'DATABASE_URL=postgres://nightwatch:change-me@localhost:5432/nightwatch' > .env.local

bun run db:migrate
bun run dev            # dashboard on http://localhost:5175
bun run dev:worker     # in a second terminal
bun run dev:watchdog   # in a third
```

| Command | What it does |
| --- | --- |
| `bun run lint` | Prettier check plus ESLint |
| `bun run check` | Compiles the Paraglide messages, then `svelte-check` |
| `bun run test` | Vitest unit tests |
| `bun run db:generate` | Generates a migration from the Drizzle schema |

**One rule for shared server code:** anything under `src/lib/server/` is imported both by
SvelteKit *and* by the worker/watchdog entrypoints, which Bun runs on their own. It must
therefore read `process.env` and never import `$env/*` or `$app/*` — those only exist inside a
SvelteKit build.

---

## Planned deployment

> The Compose file and `.env.example` below exist and work. The published image, the Portainer
> template and the DO Marketplace channel do not exist yet.

Distribution is staged (details in
[`docs/research/distribution-updates.md`](docs/research/distribution-updates.md)):

1. **Docker Compose (base).** A single `docker-compose.yml` + `.env.example` at the repo
   root — the smallest common denominator that runs on any Docker host, DigitalOcean
   droplet, Portainer, or Synology. The published Compose will pin a minor version
   (`ghcr.io/erwins-enkel/nightwatch:1.x`) rather than `:latest`.
2. **Portainer App Template (v3).** A GitHub-hosted `templates.json` users add to Portainer
   for one-click deployment.
3. **DigitalOcean Marketplace 1-Click droplet.** A Packer-built snapshot submitted for DO's
   review — the highest-reach, highest-effort channel, planned for after the product is
   stable.

### Updates

Nightwatch will ship a **built-in update check**: the app periodically polls the GitHub
Releases API, compares the latest tag against its own `APP_VERSION`, and shows an "update
available" banner with a changelog link. It **does not update itself** — it points you at
`docker compose pull && docker compose up -d`, keeping change control in the operator's
hands. Fully automatic updates (e.g. Watchtower) are an optional, off-by-default,
notify-only add-on.

Releases will be **SemVer**-tagged, and CI will build multi-arch images
(`linux/amd64`, `linux/arm64`) to `ghcr.io`.

---

## Project status & roadmap

Nightwatch is being shaped through a "Wayfinder map",
[issue #1](https://github.com/erwins-enkel/nightwatch/issues/1), which is the source of
truth for product and architecture decisions.

**Done**

- Research: M365 / Graph ingestion ([#2](https://github.com/erwins-enkel/nightwatch/issues/2))
- Research: Autotask API for ticket creation ([#3](https://github.com/erwins-enkel/nightwatch/issues/3))
- Research: Distribution & updates ([#4](https://github.com/erwins-enkel/nightwatch/issues/4))
- Domain model / ubiquitous language ([#5](https://github.com/erwins-enkel/nightwatch/issues/5))
- Tech-stack decision ([#7](https://github.com/erwins-enkel/nightwatch/issues/7))

**In progress / open**

- Customer matching: rules & conflict resolution ([#6](https://github.com/erwins-enkel/nightwatch/issues/6))
- Prototype: dashboard & rule creation ([#8](https://github.com/erwins-enkel/nightwatch/issues/8))
- Rule creation: manual vs. pattern learning ([#9](https://github.com/erwins-enkel/nightwatch/issues/9))
- Self-monitoring: out-of-band alarm channel + alarm de-dup ([#11](https://github.com/erwins-enkel/nightwatch/issues/11))
- Alarm lifecycle: all-clear actions, escalation, acknowledge, de-dup ([#12](https://github.com/erwins-enkel/nightwatch/issues/12))

**Next**

- Consolidate all decisions into a build-ready `SPEC.md` and open the implementation epic
  ([#10](https://github.com/erwins-enkel/nightwatch/issues/10)) → then build v1.

## Repository layout

```
.
├── CLAUDE.md                       # Project concept and working notes
├── SPEC.md                         # Build-ready specification for v1
├── CONTEXT.md                      # Binding domain glossary
├── README.md                       # This file
├── docker-compose.yml              # The four services — single source of truth for deployment
├── .env.example                    # Copy to .env
├── Dockerfile                      # One image, three roles
├── docker/entrypoint.sh            # Role dispatch: web | worker | watchdog | migrate
├── drizzle/                        # Generated SQL migrations
├── messages/                       # Paraglide message catalogues (en, de)
├── src/
│   ├── routes/                     # SvelteKit dashboard, mailbox settings, /health
│   ├── lib/server/                 # Shared server code (env, logger, db, heartbeat, watchdog)
│   │   ├── graph/                  # Microsoft Graph: MSAL tokens, delta calls, error classes
│   │   ├── ingestion/              # Delta poll loop, backoff, mailbox persistence
│   │   ├── regel/                  # Rhythm detection, derivation, rule templates
│   │   └── selbst/                 # Self-monitors, watchdog path, ingestion gate, ping
│   ├── worker/                     # Worker entrypoint — Bun runs it straight from source
│   └── watchdog/                   # Watchdog entrypoint
└── docs/
    ├── datenmodell.md               # Entities, invariants and the decisions behind them
    ├── regel-entstehung.md          # Rhythm detection, derivation, wizard, rule templates
    ├── self-monitoring.md           # Self-monitors, watchdog send path, ingestion gate, ping
    ├── webhook.md                   # Webhook payload, HMAC signature, delivery semantics
    └── research/
        ├── m365-graph-ingestion.md # Ingestion: Graph delta-query, app model, scoping, self-monitoring
        ├── autotask-api.md         # Autotask PSA ticket creation, de-dup, retry queue
        └── distribution-updates.md # Compose → Portainer → DO Marketplace, update mechanic
```

The GitHub issues are the living design record; [`SPEC.md`](SPEC.md) consolidates the
decisions and [`CONTEXT.md`](CONTEXT.md) is the binding glossary.

## Scope

### In scope for v1

- Absence detection (heartbeat) plus classic error/event detection.
- Microsoft 365 / Graph ingestion.
- Alerting via dashboard, Autotask ticket, and generic webhook.
- Self-hosted Docker deployment with a built-in update system.

### Out of scope for v1

- Other ingestion paths (IMAP/POP3, inbound SMTP, etc.) — a separate, later effort.
- PSAs other than Autotask (reached via the generic webhook) and other alert channels
  (email, Teams, Slack, …).
- Multi-tenancy with customer logins/roles — v1 is a single tool for the MSP team.
- An auto-maintained regional holiday calendar — v2; v1 uses manual exception days.
- Crowd-learning across installations — v2, and in tension with the self-hosted principle.
- Pricing, go-to-market, and monetization.

## Contributing

The design discussion happens in **German** (GitHub issues and the domain glossary); code
and documentation trend toward **English**. The
[Wayfinder map (#1)](https://github.com/erwins-enkel/nightwatch/issues/1) is the reference
for decisions already made. Because the project is pre-implementation, the most useful
contributions right now are on the open specification issues listed above.

## License

Nightwatch is **intended to be open source**, but **no license has been chosen yet** and
this repository does not yet contain a `LICENSE` file. Until one is added, **no reuse rights
are granted** and all rights are reserved by default — reuse terms are pending license
selection. A license will be added before v1.
