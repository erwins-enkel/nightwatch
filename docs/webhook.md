# Webhook

Implements [SPEC.md](../SPEC.md) §7. Binding terms: [CONTEXT.md](../CONTEXT.md) — the field names
below are the glossary's, transliterated for JSON.

The generic webhook is Nightwatch's integration-agnostic alerting channel: a signed `POST` for
every alarm, escalation and all-clear. It is also how PSAs other than Autotask are reached, which
is why the payload carries the ticket semantics the lifecycle already decided.

Receivers are configured under **Settings → Webhooks**. Each one has its own URL and its own
signing secret; there can be as many as you like, and every active one gets every event.

## Events

| `ereignis` | When |
|---|---|
| `alarm` | A monitor went from healthy to disrupted — the episode opened. |
| `verschaerfung` | The disruption escalated: the reason switched to „Fehler gemeldet" mid-episode. |
| `entwarnung` | The recovery held for the stability window — the episode closed. |

All three events of one episode carry the **same `alert_id`**. Together with `ereignis` it is the
identity of a delivery: `(alert_id, ereignis)` is what you deduplicate on.

Self-monitor events — Nightwatch watching itself (SPEC §8) — travel the same channel and carry
`monitor.art = "selbst"` and `kunde = null`.

## Delivery

- **At-least-once.** A delivery is retried with exponential backoff and jitter until it succeeds or
  the budget (8 attempts, spread over roughly an hour) is spent. Plan for the same
  `(alert_id, ereignis)` arriving more than once.
- **Ordered per monitor.** The next instruction for a monitor is only handed over once the previous
  one reached you (or was given up on). An all-clear can therefore never overtake the alarm it
  closes.
- **Answer `2xx`.** Any 2xx status counts as delivered; the response body is ignored. Everything
  else — including a `3xx`, because redirects are **not** followed — counts as a failure and is
  retried. Answer fast and do the work asynchronously: a request that takes longer than 10 seconds
  is aborted and retried.
- **Giving up is visible.** Once the attempts are spent, the delivery is recorded as failed, and
  that record is what makes Nightwatch's own „Alarm-Zustellung gestört" self-monitor fire.

## Request

```
POST <your URL>
Content-Type: application/json
X-Nightwatch-Signature: sha256=<hex>
X-Nightwatch-Event: alarm | verschaerfung | entwarnung
User-Agent: Nightwatch/<version>
```

Only the **body** is signed. `X-Nightwatch-Event` is a routing convenience and carries no
authority — the same value stands in the signed body as `ereignis`, and that is the one to trust.

## Payload

| Field | Type | Meaning |
|---|---|---|
| `ereignis` | string | `alarm`, `verschaerfung` or `entwarnung`. |
| `alert_id` | uuid | Stable identity of the episode across all its events. |
| `vorgaenger_alert_id` | uuid \| null | The preceding episode of the same monitor, if there was one. |
| `gesendet_am` | ISO-8601 | When **this attempt** was made. A retry carries a fresh value. |
| `weisung` | string | What a ticket system should do: `eroeffnen`, `kommentieren`, `schliessen`. |
| `monitor.art` | string | `heartbeat`, `ereignis`, `paar`, `zaehler` — or `selbst` for a self-monitor. |
| `monitor.id` | uuid | The monitor. |
| `monitor.bezeichnung` | string | Its name, as configured. |
| `monitor.schluessel` | string | Self-monitors only: `kern` or `postfach:{uuid}`. |
| `kunde` | object \| null | `{ id, name }` — `null` for a self-monitor, which belongs to no customer. |
| `alarmgrund` | string | Why the episode opened: `ueberfaellig`, `fehler_gemeldet`, `unklar`, `ereignis_eingetroffen`, `paar_zu_lange_offen`, `zaehler_ueber_obergrenze`, `zaehler_unter_untergrenze`. |
| `erholungs_art` | string \| null | How it recovered: `beweis`, `erledigt`, `auto_zurueck`, `archiviert`. Null while it is still running. |
| `vorkommen.anzahl` | number | Occurrences counted during the episode. |
| `vorkommen.erste_am` | ISO-8601 | When the episode began. |
| `vorkommen.letzte_am` | ISO-8601 | The most recent occurrence. |
| `vorkommen.verschaerft_am` | ISO-8601 \| null | When it escalated, if it did. |
| `vorkommen.stoerungsdauer_sekunden` | number \| null | How long the disruption lasted. Null while it is still running. |
| `rueckverweis` | url | Deep link back into Nightwatch — the monitor's page, or `/system` for a self-monitor. |

Only `beweis` — evidence-based recovery — comes with `weisung: "schliessen"`. Every other recovery
comments and leaves a ticket open on purpose.

### Example

```json
{
  "ereignis": "alarm",
  "alert_id": "1e6f8a2c-0b7d-4d1e-9a3f-5c2b8e7d4a10",
  "vorgaenger_alert_id": null,
  "gesendet_am": "2026-07-28T06:11:00.000Z",
  "weisung": "eroeffnen",
  "monitor": {
    "art": "heartbeat",
    "id": "9b1c7f3a-2d54-4e88-b6c1-7a0d9e5f4321",
    "bezeichnung": "Veeam Nachtlauf"
  },
  "kunde": { "id": "4f2a6d90-8c31-4b77-9e05-1d6a3c8b2f45", "name": "Muster GmbH" },
  "alarmgrund": "ueberfaellig",
  "erholungs_art": null,
  "vorkommen": {
    "anzahl": 1,
    "erste_am": "2026-07-28T06:10:00.000Z",
    "letzte_am": "2026-07-28T06:10:00.000Z",
    "verschaerft_am": null,
    "stoerungsdauer_sekunden": null
  },
  "rueckverweis": "https://nightwatch.example/monitore/9b1c7f3a-2d54-4e88-b6c1-7a0d9e5f4321"
}
```

## Verifying the signature

`X-Nightwatch-Signature` is `sha256=` followed by the hex HMAC-SHA256 of the **raw request body**,
keyed with that receiver's secret.

Two rules decide whether your check works:

1. **Use the raw bytes.** Verify before parsing, and never re-serialise the parsed object — JSON
   round-trips do not preserve byte order or spacing, and the signature is over bytes.
2. **Compare in constant time.** `timingSafeEqual`, `hmac.compare_digest`, `hash_equals` — never
   `==`.

### Node

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

/** `rohkoerper` must be a Buffer/string of the body exactly as received. */
export function istEcht(rohkoerper, kopfzeile, secret) {
  const erwartet = 'sha256=' + createHmac('sha256', secret).update(rohkoerper).digest('hex');
  const a = Buffer.from(erwartet);
  const b = Buffer.from(kopfzeile ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}

// Express: app.post('/hooks/nightwatch', express.raw({ type: 'application/json' }), …)
// so that `req.body` is the raw Buffer rather than a parsed object.
```

### Python

```python
import hashlib
import hmac

def ist_echt(rohkoerper: bytes, kopfzeile: str, secret: str) -> bool:
    erwartet = "sha256=" + hmac.new(secret.encode(), rohkoerper, hashlib.sha256).hexdigest()
    return hmac.compare_digest(erwartet, kopfzeile or "")

# Flask: use `request.get_data()`, not `request.json`.
```

### Test vector

Secret `ein-geheimnis` and the example above, serialised exactly as Nightwatch sends it (one line,
no spaces):

```
{"ereignis":"alarm","alert_id":"1e6f8a2c-0b7d-4d1e-9a3f-5c2b8e7d4a10","vorgaenger_alert_id":null,"gesendet_am":"2026-07-28T06:11:00.000Z","weisung":"eroeffnen","monitor":{"art":"heartbeat","id":"9b1c7f3a-2d54-4e88-b6c1-7a0d9e5f4321","bezeichnung":"Veeam Nachtlauf"},"kunde":{"id":"4f2a6d90-8c31-4b77-9e05-1d6a3c8b2f45","name":"Muster GmbH"},"alarmgrund":"ueberfaellig","erholungs_art":null,"vorkommen":{"anzahl":1,"erste_am":"2026-07-28T06:10:00.000Z","letzte_am":"2026-07-28T06:10:00.000Z","verschaerft_am":null,"stoerungsdauer_sekunden":null},"rueckverweis":"https://nightwatch.example/monitore/9b1c7f3a-2d54-4e88-b6c1-7a0d9e5f4321"}
```

```
X-Nightwatch-Signature: sha256=41bc1efeac6c1439378bf9840ab3d22bb2e1dc0d4ce4bbc0e508180e5ecd464d
```

Both values are asserted in `src/lib/server/webhook/signatur.test.ts`, so they cannot drift away
from what the code actually sends.

### Replay window

`gesendet_am` is inside the signed body and is re-stamped on **every attempt**, so you can reject a
body that is older than, say, five minutes without also rejecting a legitimate retry — a retry
carries a current timestamp, not the original one. Combine that with deduplication on
`(alert_id, ereignis)` and a replayed call is both stale and already-seen.

## Transport

HTTPS only. Plain HTTP is refused unless the receiver was explicitly opted in — that switch exists
for a receiver inside your own network that has no certificate, and it is enforced by a database
constraint, not just by the form. Without TLS the payload and its signature travel readable on the
wire, and the signature proves origin but hides nothing.

Redirects are not followed. If a receiver moves, change its URL in the settings; a `301` is treated
as a failed delivery, because following one could silently downgrade the transport or hand the
payload to a different host.

## Secrets

The signing secret is stored AES-256-GCM-encrypted (SPEC §12) and never shown again — the settings
page only says whether one is stored. To rotate it, enter a new one; deliveries after the change
are signed with it. A receiver without a secret does not get unsigned calls: its deliveries fail
and eventually dead-letter, because an unsigned webhook is not a supported mode.
