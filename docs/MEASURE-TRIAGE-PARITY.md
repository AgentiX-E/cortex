# Measuring that the published numbers come from the shipped program

One command, no browser, no network:

```bash
pnpm guard:triage          # node tools/triage-parity.mjs
node tools/triage-parity.mjs --write      # after a deliberate rule change
```

## Why the instrument exists

The disclosure layer's published numbers — false-share **0/12**, coverage **31.7%** on 60 rows and
**29.2%** on 1,467 persona facts, leak **1/3,000** — were not produced by `packages/cortex-core`.
They were produced by `cortex-docs/poc/p04-triage-rules/rules.mjs`, a second implementation of the
same table, written so a probe could run without a build step.

Checked on 2026-10-31 the two had drifted in **eight** fields. The direction is the finding:

| field | probe | shipped | what it hid |
| ----- | ----- | ------- | ----------- |
| `health` | `\bALT\b` | `alt` under `/i` | the product called *"the alt attribute on the logo"* a health fact; the probe's table never matched that sentence, so the only instrument pointed at the published coverage could not see it |
| `credential` | no `retention` | `retention: 'never'` | every probe number described a layer that stored credentials privately |
| `strong-pii` | no IBAN clause | `\biban\b` + IBAN shape | the one leak in 3,000 was exactly an IBAN, and the probe could not have found it |
| `money` | no loan clause | `home/auto/… loan` | a "Home Loan Account" was neither an amount nor debt |
| `third-party` | `…\|landlord\|doctor` | `…\|landlord` | `doctor` is a role, not a third party |

Five of those eight ran in the direction that makes a probe **blind to a product defect**, which is
the only direction that matters: a probe that is broader than the product finds bugs the product
does not have, and a probe that is narrower finds nothing.

## The three comparisons

| comparison | catches | second checkout |
| ---------- | ------- | -------------- |
| shipped vs `tools/triage-table.json` | a rule change with no decision about the published numbers | no |
| mirror vs shipped | the drift above, when it appears | required; skipped **loudly** otherwise |
| `--write` | manual — the snapshot is a statement, not a side effect | — |

Fields compared, in order: `id`, `scope`, `policy`, pattern `source`, pattern `flags`, `retention`.
Order is a field because moving the one shared rule above a private rule leaves the *set* identical
while inverting the fail-closed boundary.

## What red means

| message | do this |
| ------- | ------- |
| `shipped vs snapshot: health.source` | a rule changed. Re-run the POC probes that quote its numbers, then `--write` and commit the snapshot with them |
| `mirror vs shipped: …` | reconcile `cortex-docs/poc/p04-triage-rules/rules.mjs`, re-run `p04`, `p05`, `p06-policy-scale`, and check the numbers replicate |
| `SKIPPED … mirror was not present` | not a failure, and not a pass: the summary refuses to say "tables agree" |
| `…is missing; run --write` | the snapshot was deleted. Restoring it is `--write` plus a review of the diff — a missing baseline is a lost measurement, not an empty one |

## The reading

Reconciled on 2026-10-31, every published number **replicated**, and one nearly did not:

- **29.2% → 29.1% → 29.2%.** The first run under the reconciled table lost one row — *"Shawn's liver
  enzyme levels (ALT/AST) have returned to normal"* — because the new value guard needs a number
  after the abbreviation and that row has none. The fix named the clinical phrase `liver enzyme`
  rather than loosening the guard, and coverage returned.
- **0/12 (upper 24.2%)** false-share on 60 rows: unchanged, and still four-tenths of the sample away
  from the ≤5% gate 3 asks for.
- **1/3,000 → 0/3,000 is owed, not claimed.** The corpus is behind a Hub the authoring host cannot
  reach. What is claimed is checkable offline: the one row the corpus ever published now classifies
  private on the text as recorded.

## What this does not do

- It does not measure false-share. It checks that the numbers *describing* false-share come from the
  program that ships. The ≤5% bound on workplace scope is still missing a corpus, and gate 3 stays
  open because of that, not because of this.
- It does not compare prose. The policy sentences are compared as strings; whether a policy sentence
  is *true* is what the corpora are for.
- It does not cover `cortex-docs` in CI. The mirror comparison runs only where both checkouts exist;
  the snapshot comparison is the half that runs on every push.
