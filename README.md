# Nightwatch

**Self-hosted email-notification monitoring that also catches the alerts that _never arrive_.**

English · [Deutsch](README.de.md)

---

## TL;DR

- **The blind spot.** Email-based monitoring only reacts to messages that *arrive*. When a
  backup job stops running altogether, it stops sending mail — including its error mail.
  Silence reads as "all good".
- **What Nightwatch does.** It monitors for **absence**: an expected notification that fails to
  show up is an alarm in its own right — a dead man's switch per monitored system — alongside
  classic error, event, pair and rate detection.
- **Who it's for.** MSPs, IT system houses and print/device specialists who already receive
  machine notifications by email and need them watched reliably.
- **How it runs.** One Docker Compose stack in **your** infrastructure. No Nightwatch cloud,
  no control plane, no licence fee per monitored customer.
- **Where it stands.** Specification complete, implementation under way — **nothing installable
  yet**. See [Roadmap](#roadmap--whats-coming).
- **Licence.** [AGPL-3.0](LICENSE) — run it, read it, fork it, keep your fork.
- **Want in?** → [Get involved](#get-involved). Pilot operators and rule templates are worth
  more to this project right now than anything else.

> **Status: specification complete — implementation under way.**
> There is no installable release yet: no published image, no `docker-compose.yml` in this
> repository. What *does* exist is a build-ready specification ([SPEC.md](SPEC.md)), a binding
> domain glossary ([CONTEXT.md](CONTEXT.md)), three research documents, and a fully planned
> implementation epic ([#37](https://github.com/erwins-enkel/nightwatch/issues/37)) whose first
> issue is in progress. Everything below under *How it works*, *Architecture* and *Deployment*
> describes the agreed target — not something you can run today.

---

## Why Nightwatch

Monitoring gets billed per seat, per endpoint, per mailbox — and the invoice grows every year.
The tooling you use to watch your customers' systems typically keeps those customers' data in a
cloud that isn't yours, under terms you don't set, and leaving costs more than joining did. For
a managed service provider that is a recurring cost line which scales with your own success,
plus a dependency you cannot audit and cannot fix when it breaks.

Nightwatch starts from the opposite assumption:

- **It runs in your infrastructure.** One Compose stack on your own hardware, a DigitalOcean
  droplet, an Azure VM — your choice. There is no Nightwatch-operated control plane, and no
  telemetry or usage reporting of any kind.
- **No per-customer licence.** Monitor three customers or three hundred; the cost is the box it
  runs on.
- **Your customers' data stays in your house.** Mail is read from the mailboxes you point it
  at, stored in your Postgres, and deleted on your schedule. In operation, Nightwatch talks
  only to the systems you configure.
- **AGPL-3.0.** Every line is readable, runnable and forkable. Nobody — including us — can
  close it back up and rent it out to you as a subscription.

That independence is about *where it runs*, not about never talking to anything external. To do
its job, v1 connects to the systems you point it at and the integrations you opt into:

| External system | Role in v1 | Required? |
| --- | --- | --- |
| **Microsoft 365 / Microsoft Graph** | Reads the monitored mailboxes (ingestion) | **Required** in v1 — it is the only ingestion source |
| **Autotask (Kaseya PSA)** | Opens and updates tickets for the right customer | Opt-in alerting integration |
| **GitHub Releases API** | Powers the in-app "update available" check | Opt-in; can be ignored |

Detailed findings behind each:
[`docs/research/m365-graph-ingestion.md`](docs/research/m365-graph-ingestion.md) ·
[`docs/research/autotask-api.md`](docs/research/autotask-api.md) ·
[`docs/research/distribution-updates.md`](docs/research/distribution-updates.md).

## The blind spot: silent failures hide in a full inbox

Most email-based monitoring only reacts to failure messages. That leaves a gap: if the backup
software (or router, or printer fleet) stops running entirely, it stops sending mail — including
its error mail. No message arrives, so nothing looks wrong.

Meanwhile the mailbox fills with "OK / completed successfully" notifications. Nobody scrolling
through hundreds of green mails notices the one report that quietly went missing last Tuesday.
That gap is exactly the outage you most need to know about.

Nightwatch closes it by treating an expected message that does not arrive within its window as
an alarm in its own right.

## Who it's for

IT-focused businesses that already receive machine notifications by email and need them watched
reliably: **managed service providers**, **IT system houses**, and **print/device specialists**.
Nightwatch v1 is a tool for the provider's own team — a single mailbox typically carries
notifications for many customers, and Nightwatch attributes each mail to the right one.

---

## How it works

The vocabulary is deliberately small and is fixed in [CONTEXT.md](CONTEXT.md) (German — it is
the binding glossary for the project). The terms below are the English equivalents.

### Monitor and Rule

- A **Monitor** is the atomic unit of observation — one per monitored thing. A person creates
  it deliberately. It belongs to exactly one customer, has exactly one **kind**, carries a
  health state, and raises an **Alarm** or an **All-clear** when that state changes.
- Each Monitor has exactly one **Rule** — the detection logic (match criteria plus two
  kind-interpreted pattern slots). The Rule is the changeable, learnable part: "revise the
  rule" sharpens the patterns without rebuilding the Monitor.
- Rules are **language-independent**: the same software may report "Backup completed
  successfully", "Sicherung erfolgreich abgeschlossen" or "Sauvegarde terminée", so patterns
  may be multilingual. There is no separate language-detection step.
- Rules come from three **sources** — authored manually, from a curated **rule template**, or
  derived from an example mail. These are only degrees of pre-fill on the same form: **no rule
  goes live without a human confirming it.**

### Monitor kinds

Monitor kinds are an **open, extensible set** — new kinds can be added without touching the
state machine. Every kind honours the same three-part contract: **Trigger**, **Bad condition**,
**Recovery condition**. v1 ships four:

| Kind | Trigger | Bad when… | Recovers when… | Example |
| --- | --- | --- | --- | --- |
| **Heartbeat** | mail + time | the expected mail is **overdue** (nothing arrived at all) **or** an arrived mail classifies as an error | a matching OK mail arrives | nightly backup report |
| **Event** | mail | a matching mail **arrives** — arrival *is* the event (an optional harmless-filter exempts benign siblings) | auto-reset (default 24 h) or manual resolve — never evidence-based | "firmware update available" |
| **Pair** | mail + time | a paired open state has stayed open longer than the **maximum open time** (default 0) | the closing mail arrives — evidence-based | router "line down" … "line back"; job "started" … "finished" |
| **Counter** | mail + time | the count in sliding window *T* crosses the **upper** bound (message storm) or drops below the **lower** bound (gone quiet) | the count is back inside the band — evidence-based | ">50 in 10 minutes"; "normally ~100 OK/day, today 3" |

Two edges worth knowing: for a Heartbeat, **any** matching mail satisfies the expectation —
punctuality and content are separate dimensions, and "overdue" means *nothing at all* arrived,
not "nothing good". For a Counter, the lower bound has a **start-up grace period** (it only goes
live once a full window has passed since activation), while the upper bound is sharp from second
one.

### Expectation (Heartbeat only)

A Heartbeat's **Expectation** defines when a mail must arrive, as either an **Interval** (a
sliding "at least every X", restarted by each arrival) or a **Calendar schedule** (cron-like
absolute times, e.g. "Mon–Fri by 06:00", which covers weekends without an extra concept). Every
Expectation carries a **Grace** window before "overdue" fires. A calendar target counts as
covered if a matching mail arrived since the previous effective target — the backup report at
23:40 covers the next morning's "by 06:00".

Holidays are handled by manually configured **Exception days** (bundleable into named,
reusable calendars). They suspend only the *time*-based targets — calendar targets and the
Counter's lower bound. The upper bound stays sharp: a message storm on a public holiday is all
the more a finding. For everything else there is **Paused**.

### Classification

Each mail matched to a monitor is judged three ways: **OK**, **Error** (takes precedence), or
**Unclear** (no pattern matched). The judging engine is a pluggable **Classifier**:

- v1 is **pattern-based** (regex / subject / sender), with a clean seam for **intelligent
  extraction** from unstructured report mails — a local model, or an LLM the operator
  optionally connects. Because it is optional and operator-configured, it stays
  self-hosting-compatible.
- **Unclear** escalates like an error, but with its own reason and the recommended action
  "revise the rule" — so a new, unrecognised error text never slips through silently as "OK".

### Customer matching

A single mailbox carries notifications for many customers, so attribution runs as a two-stage
pipeline — **mail → customer → monitor**. The customer is determined by matching
characteristics with a fixed global priority:

1. recipient plus-address (`noc+customera@systemhouse.example`)
2. customer number or content pattern
3. sender address or domain

**First match wins, no scoring.** There is no default customer. Several hits on the same level
mean *ambiguous*, and ambiguous or unattributable mail lands in a **system triage** view rather
than creating a ticket. Resolving a triage entry always creates a durable matching
characteristic — never a one-off assignment for that single mail.

Mail from a known customer that no monitor matches is grouped instead as an **unmonitored mail
sort** (by sender plus subject pattern, with count, last arrival and detected cadence). That
list is the onboarding entry point, and it can be driven to zero.

### Health state machine and alarm lifecycle

Every kind shares one state machine: **Healthy ⇄ Impaired**, where Impaired carries a current
**alarm reason**. A **Paused** overlay covers maintenance windows — paused is visible and
deliberate, not the same as "off".

- **One alarm per healthy → impaired transition.** There is no reminder system; the escalation
  surface is the PSA ticket, and there is **one open ticket per monitor**.
- **All-clear** always comments on the ticket (cause, outage duration, occurrence summary) but
  **closes** it only on evidence-based recovery *and* an untouched ticket.
- **All-clear stability** (~15 min, overridable per monitor) damps flapping: alarms take effect
  immediately, all-clears only once the recovery holds.
- **Acknowledge** is a pure dashboard marker with no outward effect; it expires with recovery.

### Self-monitoring

A monitoring tool that fails silently is worse than useless, so Nightwatch applies its own
dead-man's-switch idea to itself, using the same lifecycle machinery — not a second
implementation:

- **Self-monitors** are built in: one per mailbox ("ingestion for mailbox X") plus a global one
  ("Nightwatch core"). They cannot be created, deleted or paused.
- The **watchdog sends directly**, on its own path that does not involve the worker or the job
  queue, backed by a local encrypted config and dedup cache — so it survives a Postgres outage.
- **Root suppression:** if the core is impaired, the per-mailbox self-monitors stay quiet
  instead of piling on.
- **Ingestion gate:** while ingestion is demonstrably broken, overdue decisions are *suspended,
  not discarded*, per mailbox. Instead of a flood of wrong customer tickets you get exactly one
  self-alarm — and the backlog is worked off before the gate reopens.
- **Heartbeat ping** (opt-in): an outbound sign of life to a URL you choose, sent only while
  Nightwatch is internally healthy — this is what covers a total outage (host or network down).
  Without a configured receiver, total outage is unobserved, and the dashboard says so.

---

## Alerting channels (v1)

When a monitor changes state, Nightwatch can alert through:

- **Dashboard** — the built-in web UI, always on.
- **Autotask PSA ticket** — opened against the correct customer. De-duplication uses a stable
  correlation key in the ticket's `externalID` (Autotask has no native idempotency), so retries
  are safe, and alerts sit in a durable retry queue so none is lost while Autotask is
  unreachable.
- **Generic webhook** — an integration-agnostic escape hatch, and the way PSAs other than
  Autotask are reached in v1. Self-contained payload, stable `alert_id`, at-least-once delivery,
  **HMAC-SHA256** signature over the body.

Email alerts are intentionally **not** part of v1 — alerting through the channel you are
monitoring is a poor idea.

## Email ingestion (v1): Microsoft 365 / Microsoft Graph

v1 ingests from **Microsoft 365 only**, via **Graph delta-query polling** (pull) rather than
change-notification webhooks. Polling is outbound-only, so it works from a container behind NAT
with no inbound port — webhooks would need a publicly reachable HTTPS endpoint, which rules them
out for the on-prem case.

- **App model:** a single **multi-tenant app registration**, activated per customer tenant via
  **admin consent**, using the **application** permission `Mail.Read` (client-credentials flow).
- **Mailbox scoping is mandatory:** rather than tenant-wide mail access, the app is scoped to
  just the monitored mailboxes — preferably via **RBAC for Applications** in Exchange Online,
  with the legacy Application Access Policy as a documented fallback.
- **Polling cadence:** 60–300 s per mailbox, comfortably inside Graph's throttling limits.
- **Learning window:** on connecting a mailbox, roughly 30 days of history is backfilled once.
  It is learning material for mail search, cadence detection and rule derivation — **never**
  monitoring material. Monitors only ever evaluate forward from activation.

Full rationale, PowerShell onboarding snippets and error handling:
[`docs/research/m365-graph-ingestion.md`](docs/research/m365-graph-ingestion.md).

---

## Architecture & tech stack

The stack is aligned with [pulse](https://github.com/erwins-enkel/pulse) so Nightwatch can later
dock in as a pulse module, while deliberately **not** adopting pulse's serverless deployment —
Nightwatch's core is a continuous poller, which is not a serverless workload.

| Layer | Choice |
| --- | --- |
| Language / runtime | TypeScript on Bun (in the container) |
| Framework | SvelteKit 2 / Svelte 5, `adapter-node` |
| ORM / DB | Drizzle + PostgreSQL (bundled Compose service; `DATABASE_URL` override for bring-your-own) |
| Job queue | pg-boss (Postgres-backed, no Redis) — carries the durable retry queues |
| UI kit | Tailwind 4, bits-ui, layerchart, lucide (mirrored from pulse) |
| i18n | Paraglide — English default plus German, extensible |
| Graph client | `@microsoft/microsoft-graph-client` + `@azure/msal-node` |
| Helpers | `date-holidays` (schedules), `limiter` (rate limits) |

### Container topology (four Compose services)

- **`web`** — the SvelteKit dashboard and configuration API.
- **`worker`** — the Graph delta poller, the due-date/window scheduler, and the pg-boss worker
  for Autotask tickets and webhooks.
- **`watchdog`** — deliberately tiny: aggregates heartbeats, evaluates the self-monitors and
  sends self-alarms on its own path. **No Docker socket by default.**
- **`postgres`** — the official image plus a named volume.

### Self-healing

- **`restart: unless-stopped` is the supervisor** — the Docker daemon is the watcher. No mutual
  peer-restart, which avoids the "who watches the watcher" split-brain.
- An **in-process watchdog timer** is the primary defence against a hung-but-alive process: if
  the main loop stops ticking, the process exits and Docker brings it back. No Docker socket and
  no elevated privileges needed.
- **Postgres heartbeats** give the services mutual visibility.
- Migrations run on startup, after the database healthcheck.

Secrets (Graph credentials, Autotask credentials, webhook HMAC secrets) are stored
AES-256-GCM-encrypted at rest, keyed from an environment variable that lives only in your
`.env`. No external KMS or vault — that would be another third party.

---

## Deployment (planned)

> The channels below describe the **intended** deployment once v1 is built. They do not work
> yet — there is no published image or Compose file in this repository.

1. **Docker Compose (base).** A single `docker-compose.yml` + `.env.example` at the repo root —
   the smallest common denominator that runs on any Docker host, DigitalOcean droplet, Portainer
   or Synology. The published Compose pins a minor version rather than `:latest`.
2. **Portainer App Template (v3).** A GitHub-hosted `templates.json` you add to Portainer for
   one-click deployment.
3. **DigitalOcean Marketplace 1-Click droplet.** A Packer-built snapshot submitted for DO's
   review — highest reach, highest effort, planned once the product is stable.

Releases are **SemVer**-tagged, and CI builds multi-arch images (`linux/amd64`, `linux/arm64`)
to `ghcr.io`.

### Updates

Nightwatch ships a **built-in update check**: it polls the GitHub Releases API daily, compares
the latest tag against its own version, and shows an "update available" banner with a changelog
link. It **does not update itself** — it points you at
`docker compose pull && docker compose up -d`, keeping change control in your hands. A one-click
self-update would require Docker socket access, which the architecture deliberately refuses.

---

## Roadmap — what's coming

The design phase is **done**. Everything decided across research, domain modelling and the
prototype is consolidated in [SPEC.md](SPEC.md) (the build contract) and
[CONTEXT.md](CONTEXT.md) (the binding glossary).

Implementation runs as
**[Epic #37](https://github.com/erwins-enkel/nightwatch/issues/37)**, split into sixteen
deliberately PR-sized child issues — one issue, one session, one pull request. That sizing is
what makes it realistic for someone else to pick a piece up.

**Sequential spine** — each depends on the one before:

| # | Issue | What it delivers |
| --- | --- | --- |
| [#21](https://github.com/erwins-enkel/nightwatch/issues/21) | Scaffold | Bun + SvelteKit + Drizzle/Postgres + pg-boss, four-service Compose, CI — **in progress** |
| [#22](https://github.com/erwins-enkel/nightwatch/issues/22) | Data model | Core entities and migrations |
| [#23](https://github.com/erwins-enkel/nightwatch/issues/23) | M365/Graph ingestion | Onboarding, delta polling, learning window |
| [#24](https://github.com/erwins-enkel/nightwatch/issues/24) | Customers & matching | Characteristics, first-match, triage backend |
| [#25](https://github.com/erwins-enkel/nightwatch/issues/25) | Monitor core | Kind contract, rules, classification, state machine |
| [#26](https://github.com/erwins-enkel/nightwatch/issues/26) | Time scheduler | Expectation, grace, windows, open time, exception days |
| [#27](https://github.com/erwins-enkel/nightwatch/issues/27) | Alarm lifecycle | `alert_id`, all-clear stability, aggravation, acknowledge |

**Then it fans out** — these four run in parallel once the lifecycle exists:

| # | Issue | What it delivers |
| --- | --- | --- |
| [#28](https://github.com/erwins-enkel/nightwatch/issues/28) | Autotask integration | Ticket creation, de-dupe, retry queue, company picker |
| [#29](https://github.com/erwins-enkel/nightwatch/issues/29) | Webhook channel | Events, HMAC signature, at-least-once delivery |
| [#30](https://github.com/erwins-enkel/nightwatch/issues/30) | Self-monitoring | Self-monitors, watchdog direct send, ingestion gate, heartbeat ping |
| [#31](https://github.com/erwins-enkel/nightwatch/issues/31) | UI: customer board | Alarm bar, system banner, monitor drawer |

**Side strands** — these hang off earlier work, not off the fan-out:

| # | Issue | Depends on |
| --- | --- | --- |
| [#32](https://github.com/erwins-enkel/nightwatch/issues/32) | Rule creation: cadence detection, derivation, 4-step wizard, templates | #25 |
| [#33](https://github.com/erwins-enkel/nightwatch/issues/33) | UI: system triage, unmonitored mail sorts, mail search | #32 |
| [#34](https://github.com/erwins-enkel/nightwatch/issues/34) | Retention: deletion job, retention setting, GDPR documentation | #23 |

**Closing out:**

| # | Issue | Depends on |
| --- | --- | --- |
| [#35](https://github.com/erwins-enkel/nightwatch/issues/35) | Secrets hardening: encryption at rest, watchdog cache | #28, #30 |
| [#36](https://github.com/erwins-enkel/nightwatch/issues/36) | Update check, release pipeline & distribution (Compose, Portainer, ghcr) | #31 |

Beyond v1: other ingestion paths (IMAP/POP3, inbound SMTP), further PSA integrations, an
automatically maintained holiday calendar, and intelligent extraction in the classifier — the
seam for it is already part of v1's design.

---

## Get involved

Nightwatch is being built for the people who will run it, and it is at exactly the stage where
outside input still changes the outcome. **Four ways in**, roughly in order of how much they
help right now:

### 1. Run a pilot mailbox

The riskiest guesses in this product are about *your* mail: whether cadence detection survives
real backup reports, whether rule derivation proposes anything sensible, whether the customer
matching tiers hold up against a real shared NOC mailbox. Synthetic test data cannot answer any
of that. If you would connect one real mailbox once there is something to connect — and then
tell us what it got wrong — that is the single most valuable contribution available.

### 2. Contribute rule templates

A curated rule for a backup suite, a NAS, a printer fleet, a firewall, a router. Templates ship
versioned in the container image, and export/import is already specified. This is the
contribution that compounds: every template one MSP adds saves every other MSP the same
afternoon of pattern-wrangling. Mechanics are tracked in
[#32](https://github.com/erwins-enkel/nightwatch/issues/32).

### 3. Write code

The sixteen child issues of [Epic #37](https://github.com/erwins-enkel/nightwatch/issues/37) are
deliberately PR-sized and individually scoped, each with its own written brief. Pick one, say so
in the issue, open a pull request. `SPEC.md` and `CONTEXT.md` are the contract — read both first.

### 4. Shape the requirements

Which notifications actually hurt when they go missing? Which PSA do you run? What is missing
from v1's scope? Opinions from people who carry a pager are worth more than another round of
solo design.

### Where to reach us

- **[GitHub Issues](https://github.com/erwins-enkel/nightwatch/issues)** — bugs, concrete
  proposals, claiming a child issue.
- **[GitHub Discussions](https://github.com/erwins-enkel/nightwatch/discussions)** — open
  questions, pilot interest, "does it handle X?".
- **hallo@erwins-enkel.dev** — if you would rather not do it in public.

The design discussion happens in **German** (issues, pull requests, and the glossary in
`CONTEXT.md`); code and documentation are **English**. Write in whichever you are comfortable
with — both are read.

---

## Repository layout

```
.
├── README.md                       # This file (English)
├── README.de.md                    # German edition
├── SPEC.md                         # Build-ready v1 specification — the contract for the epic
├── CONTEXT.md                      # Binding domain glossary (German) — the ubiquitous language
├── CLAUDE.md                       # Project concept and working notes
├── LICENSE                         # AGPL-3.0
└── docs/
    └── research/
        ├── m365-graph-ingestion.md # Graph delta-query, app model, scoping, self-monitoring
        ├── autotask-api.md         # Autotask PSA ticket creation, de-dup, retry queue
        └── distribution-updates.md # Compose → Portainer → DO Marketplace, update mechanic
```

The GitHub issues remain the living design record; `SPEC.md` is the consolidated, build-ready
view of everything they settled.

## Scope

### In scope for v1

- Absence detection (heartbeat) plus classic error, event, pair and counter detection.
- Microsoft 365 / Graph ingestion, one or more mailboxes, many customers per mailbox.
- Alerting via dashboard, Autotask ticket and generic webhook.
- Self-monitoring with an out-of-band watchdog and optional heartbeat ping.
- Self-hosted Docker deployment with a built-in update check.

### Out of scope for v1

- Other ingestion paths (IMAP/POP3, inbound SMTP) — a separate, later effort.
- PSAs other than Autotask (reached via the generic webhook) and other alert channels
  (email, Teams, Slack, …).
- Multi-tenancy with customer logins and roles — v1 is a single tool for the provider's team.
- An automatically maintained regional holiday calendar — v1 uses manual exception days.
- Crowd-learning across installations — in tension with the self-hosted principle.
- Reminder and escalation tiers; per-customer collective tickets.
- Pricing, go-to-market and monetization.

## License

Nightwatch is licensed under the **GNU Affero General Public License v3.0** — full text in
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

In plain terms: you may run, study, modify and redistribute Nightwatch freely — including
commercially, and including inside your own MSP business. Running it to monitor mailboxes is
ordinary use and obliges you to publish nothing. If you *distribute* a modified version, or
offer one to users over a network, you must make your changes available under the same licence.

That is deliberate. It keeps every fork of Nightwatch open, so the tool you adopt today cannot
be closed up and rented back to you tomorrow. (This paragraph is a summary, not legal advice —
the licence text governs.)
