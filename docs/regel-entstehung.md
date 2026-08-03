# Regel-Entstehung

Implements [SPEC.md](../SPEC.md) §5 and §9. Binding terms: [CONTEXT.md](../CONTEXT.md) —
„Regel-Quelle", „Vorbefüllungs-Grad", „Takt", „Regel-Vorlage".

Rules are created in one place: a four-step wizard. Where a rule *comes from* — typed by hand,
taken from a template, or derived from an example mail — changes only how much of that wizard is
already filled in. There is one mental model, one confirmation gate, and one place where the
classifier seam sits.

> **No rule becomes active without a human confirming it.** A created monitor is a draft until
> someone activates it, and activation is also its epoch: a monitor never judges anything from
> before it (CONTEXT „Lernfenster").

## Takt: recognising a rhythm

The **Takt** of an unmonitored mail kind is what makes the difference between "these mails arrive"
and "these mails are *expected*". It is computed in `src/lib/server/regel/takt.ts`, written onto
`mail_sorte` by the assignment batch, and read from there by both the Sorten view and the wizard —
one number, one answer, no second calculation that could disagree.

| | |
|---|---|
| Recognised from | **3 occurrences** |
| Tolerance | spread ≤ **25 %** of the median gap, floor **15 min** |
| Missing occurrences | up to **25 %** of the expected slots may be absent |
| Evaluated | the newest **200** occurrences |
| Classes | interval · daily · every working day · weekly |
| Deliberately absent | monthly — a ~30-day learning window cannot evidence three occurrences |

Two edges are worth knowing, because a naive implementation gets both wrong:

- **The nightly report around midnight.** Measured against the real day boundary, two consecutive
  runs at 23:50 and 00:10 fall on day *N* and day *N+2*, and "daily" is never recognisable. The
  detection therefore rotates the day boundary onto the observed time of day first.
- **The weekend gap.** A working-day report has gaps of 1, 1, 1, 1, 3 days. Read as an interval
  that is a wild outlier and the whole series fails. The calendar classes are tried before the
  interval, so the gap is read as what it is. „Every working day" additionally requires that a
  weekend was actually *observed* — within a single working week it is indistinguishable from
  „daily", and guessing „working day" would silently stop watching Saturdays.

Every proposal carries its evidence: *„every working day ~05:40, from 10 occurrences"*.

## Derivation: two layers

**Layer 1 is automatic and fills in nothing but the temporal and the structural:**

| Filled in | From |
|---|---|
| Match criteria | sender + subject pattern of the example mail (the Sorten-Signatur, `#` → `.*`) |
| Kind guess | Takt recognised → Heartbeat, otherwise Event. **Never** Pair or Counter |
| Expectation | the Takt — calendar classes become a Kalenderplan, not a 24 h interval |
| Grace period | the observed spread plus the 15-minute floor, rounded to 5 minutes |
| Counter window/bounds | 24 h, half to double the median daily count from the learning window |
| Max open time | *afterwards*, from observed open→close durations, once the patterns exist |

**Layer 2 is by hand: the OK/error patterns.** In step 3 the example mail is shown; selecting a
passage and pressing "use as OK pattern" turns the selection into an escaped pattern. What a
sentence in a report *means* is not something the derivation guesses.

The **Classifier is deliberately not asked here**. It works at runtime, lowering the Unclear rate
of arriving mail; it does not propose patterns at creation time (CONTEXT „Klassifikator").

## Entering the wizard

`/monitore/neu` accepts four query parameters, all optional:

| Parameter | Effect |
|---|---|
| `?mail=<id>` | derive from this mail — the entry point from triage and mail search |
| `?sorte=<id>` | derive from the newest mail of this unmonitored kind |
| `?kunde=<id>` | preselect the customer |
| `?vorlage=<id>` | apply a rule template |

A mail without a Sorte (a triage mail has no customer yet, and therefore no kind) still derives:
sender and subject are filled, and the evidence says plainly that no rhythm was found.

The wizard is **server-driven** — every "next" is a POST carrying the previous input in hidden
fields — so it works without JavaScript. The only JavaScript-only affordance is the layer-2
marking; without it the pattern fields are ordinary text areas.

## Rule templates

Curated templates ship **inside the image** as versioned data (`src/lib/server/regel/kuratiert.ts`)
and are upserted on start, right after the migrations. A template is overwritten only when the
release brings a **higher `version`** *and* the stored row is itself curated — an operator's own
template with the same key is never touched.

Own templates come from an existing monitor ("create from monitor") or from an import, and are
managed under **Settings → Rule templates**.

### Exchange format

```json
{
  "format": 1,
  "vorlagen": [
    {
      "schluessel": "veeam-backup-report",
      "name": "Veeam Backup & Replication — Job report",
      "hersteller": "Veeam",
      "beschreibung": "The nightly job report.",
      "version": 1,
      "vorgeschlageneArt": "heartbeat",
      "absender": [],
      "betreffMuster": ["^\\[(Success|Warning|Failed)\\]"],
      "schluesselwoerter": [],
      "musterSchlecht": ["^\\[(Warning|Failed)\\]"],
      "musterGut": ["^\\[Success\\]"],
      "parameterDefaults": { "karenzSekunden": 3600 }
    }
  ]
}
```

- `schluessel` is the stable identifier an import recognises the template by: lower case, digits
  and hyphens. A key already held by a *curated* template is refused rather than renamed — a
  silently moved key would be a surprise at the next release.
- At least one match criterion is required; every pattern must compile.
- **A template can never carry a secret.** The reader builds a new object from the whitelist above
  and drops everything else, so SPEC §12's „Export/Import von Regel-Vorlagen enthält nie
  Credentials" is a property of the format, not a promise of the user interface.

Exporting "all" exports the **own** templates only: the curated ones arrive with every recipient's
image anyway, and importing copies of them would freeze them as own templates that no release
updates again.

### Adding a curated template

The bar is that **the subject format must be documented**. A curated template that matches nothing
is worse than none — it costs the operator their trust in all the others. The list is short on
purpose and grows per release; each entry names its source in its description, and
`vorlage.test.ts` pins it to a real subject line in both directions (the bad pattern must not match
the good subject, and vice versa).
