# Self-Monitoring

Implements [SPEC.md](../SPEC.md) §8. Binding terms: [CONTEXT.md](../CONTEXT.md) —
„Selbst-Monitor", „Wurzel-Unterdrückung", „Ingestion-Gate", „Heartbeat-Ping".

Nightwatch exists because a monitoring system that goes quiet looks exactly like a system with
nothing to report. That argument applies to Nightwatch itself, so it watches itself the same way it
watches everything else: with monitors, a state machine, and alarms that leave the instance.

## The monitors

Two kinds, both built in:

| Monitor | Watches | Disturbed when |
|---|---|---|
| `postfach:{uuid}` — „Ingestion Postfach X" | One mailbox's Graph polling | Its last successful poll is older than the Staleness window, or a **hard cause** was recorded (revoked consent, `AADSTS…`, 401/403, mailbox gone) |
| `kern` — „Nightwatch-Kern" | The instance itself | `web` or `worker` stopped writing heartbeats, alarm delivery is demonstrably broken, or (emergency path) Postgres is unreachable |

They are **not creatable, not deletable, not pausable** — their parameters are settable, their
existence is not. The core is seeded by a migration; a mailbox's monitor is created in the same
transaction as the mailbox. Neither belongs to a customer, so in the dashboard they are a system
banner rather than a customer card.

Everything else about them is ordinary: the same state machine (`monitor/zustand.ts`), the same
Entwarnungs-Stabilität, the same occurrence summary, the same webhook payload — with
`monitor.art = "selbst"` and `kunde = null`. There is deliberately no second lifecycle.

**Hard causes accelerate, they do not replace.** Staleness catches every cause there is; a
recognised hard cause simply fires without waiting the window out, and gives the ticket a sentence
worth reading. When both are true at once only the more severe one is reported — a monitor that
reported both would flip between them on every tick and count ticks as occurrences.

### Wurzel-Unterdrückung

A dead core makes every mailbox go quiet. That is **one** finding, not one per mailbox, so while
the core is disturbed the mailbox monitors do not fire in addition.

Mechanically this is not a special case: the mailbox monitors are evaluated with the `Pausiert`
overlay set to „core is disturbed", and `wendeAn()` already suppresses the way *into* Gestört while
letting recovery through — which is exactly what a root cause should do to its symptoms.

The order within a tick is what makes it work, and it is load-bearing: the core is evaluated **and
written** first, and the suppression reads the result of that transition rather than the row as it
looked when the tick began. In the first tick of an outage both become true at once — that is the
tick that would otherwise produce the storm.

## The watchdog's own send path

The `watchdog` service publishes and delivers self-monitor events itself, synchronously, without
pg-boss. Not for speed: pg-boss lives in the very database whose failure the watchdog has to be
able to report.

The channels are the existing ones. `webhook/ablauf.ts` and `autotask/ablauf.ts` are the same
functions the queue workers call; only the caller and the retry differ — the retry is the next
tick. Two consequences worth knowing:

- **Autotask needs a company.** A self-monitor belongs to no customer, so its ticket is filed under
  the company named in **Settings → Autotask → Company for self-monitors**. Without it, self-alarms
  travel by webhook only — the same way a customer without an Autotask link alerts.
- **A self-delivery whose episode is still open is never dead-lettered.** It keeps retrying, because
  it is the one recurring probe against a receiver that no customer event happens to be going to,
  and its eventual success is what proves the channel came back. Give up on it and the core could
  never learn it recovered. The way out of a permanently dead receiver is to deactivate it.

### The encrypted cache

`WATCHDOG_CACHE_FILE` (default `/var/lib/nightwatch/watchdog-cache.enc`, on the `watchdog-data`
volume) holds what the watchdog needs when Postgres is gone: the webhook receivers with their
signing secrets, the core monitor's identity and windows, and the record of the outage episode
currently in flight. AES-256-GCM with `NIGHTWATCH_SECRET_KEY`, mode `0600`, written atomically.

**It has to be on a volume.** Without one it lives in the container layer, and a restart would
re-announce an outage it had already reported.

### What a database outage looks like

1. The watchdog's queries start failing. Nothing is announced yet — a blip is not a disruption.
2. Once the outage outlasts the core's Staleness window, **one** alarm goes out from the cache.
   Any number of further ticks say nothing; the cache is the dedup marker.
3. When Postgres answers again, the recovery has to hold for the Entwarnungs-Stabilität before the
   all-clear goes out. A database that flaps produces one episode, not a series.
4. An outage that recovers before it ever alarmed leaves no trace: nothing was said, so there is
   nothing to take back.

**This path sends to webhook receivers only.** Autotask's idempotency and ticket state live in
`ticket_korrelation` — in the database that is by definition unreachable — so firing blind at it
would risk a fresh ticket on every restart. If you have neither a webhook receiver nor a heartbeat
ping, a database outage is unobserved, and the settings page says so.

## Ingestion-Gate

While a mailbox's ingestion is demonstrably broken, the decisions that rest on a mail's *absence*
are **suspended, not discarded**. The alternative is a flood of false customer tickets during a
Graph outage — tickets no arriving mail can take back, because the mail arrives as an all-clear
after the ticket already exists.

A mailbox's gate is closed while any of these holds:

- its self-monitor is disturbed;
- its recovery has not yet held for the Entwarnungs-Stabilität;
- `postfach.ingestion_stand_am` has not passed the moment it recovered — the backlog is not caught
  up. That promise only advances when a delta round *settles*, which makes it the existing proof
  that the mail which piled up has actually arrived.

On top of that, **every** gate closes when the core is disturbed *and* the `worker` heartbeat is
stale — a dead poller means nothing is being fetched for anyone. A core that is disturbed purely
because a webhook is dead does **not** close any gate: a broken receiver says nothing about mail.

Suspension is not a lost verdict. The Kalenderplan cursor stays where it is, so the same expected
mails are judged again once the mailbox has caught up.

## Heartbeat-Ping

Opt-in, outgoing, to a URL of the operator's choosing: their RMM, their own monitoring, whatever
they like. It fires **only while everything inside is healthy** — database reachable and no
self-monitor disturbed. A degraded instance goes quiet and the *receiver* raises the alarm.

It is the only mechanism that covers the total outage — host down, network gone, watchdog dead —
because no process of a dead instance can report anything at all. Nightwatch's own Dead-Man's-Switch
principle, applied to itself.

The URL is stored encrypted (it usually carries a token) and never shown again. Pick a grace period
at the receiver comfortably longer than the configured interval.

The passive `/health` endpoint remains available for probes that prefer to pull. It reports; it
does not act.

## Configuration

| Setting | Where | Default |
|---|---|---|
| Staleness per self-monitor | Settings → Self-monitoring | 900 s |
| All-clear stability per self-monitor | Settings → Self-monitoring | instance default (900 s) |
| Heartbeat ping URL and interval | Settings → Self-monitoring | off, 300 s |
| Company for self-monitor tickets | Settings → Autotask | unset (webhook only) |
| `SELBST_TICK_SECONDS` | `.env` | 30 |
| `WATCHDOG_CACHE_FILE` | `.env` | `/var/lib/nightwatch/watchdog-cache.enc` |
