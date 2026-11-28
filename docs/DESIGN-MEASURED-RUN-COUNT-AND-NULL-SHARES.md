# The measurement, not the declaration, owns the number

**Status:** implemented — `packages/cortex-eval/src/cost-per-capability.ts`,
`packages/cortex-eval/src/report.ts`, `tools/cache-credit-arithmetic.mjs`,
`tools/reader-cost-census.mjs`, `tools/cost-ledger.py`.
**Supersedes:** nothing. **Amends:** `DESIGN-RUN-COUNT-INTEGER-GUARD.md`,
`DESIGN-SUMMARY-MALFORMED-COUNTS.md`.

## 1. The one rule behind all six fixes

A report carries two kinds of number: **declarations** the caller wrote, and **measurements** the
sole producer wrote. When they disagree, the measurement wins; when a measurement is absent, the
reader must say so instead of substituting a plausible-looking number. Six defects across the
cost and reporting layer were instances of that one rule being broken.

| # | Reader | What it did | What it does now |
| --- | --- | --- | --- |
| 1 | `costPerCapability` | `runs = ablation.runs ?? report.runs ?? 1` | `mask.length` first; declaration only when no mask |
| 2 | `attachCostEfficiency` | refused when `report.runs === undefined` | derives `runs` from the mask, refuses only when both absent |
| 3 | `costPerCapability` ranking | sorted `null as number`, so `0 - 0` kept the first row | filters unpriced rows; empty ranking prints `''` |
| 4 | `cache-credit-arithmetic` | `mean([]) = 0/0 = NaN` → `NaN%` in Markdown, `null` in JSON | `mean([]) = null`, rendered as `n/a` in both |
| 5 | `reader-cost-census` | `null * 100 = 0` → `cache 0.0%` | a `pct()` helper renders an uncomputed share as `n/a` |
| 6 | `cost-ledger` | required `state === 'measured'`, a field the writer never emits | validates the ratio and accuracy fields the writer does emit |

## 2. Why the mask is the authoritative repetition count

`runAblation` has one producer. When `runs > 1` it writes `featureCorrectByRun`: one string per
repetition, one character per question. That vector is a measurement — its length *is* the number
of repetitions that were actually graded. The top-level `runs` field, by contrast, is written only
when a caller explicitly configured one (`runAblationReport` spreads `{ runs }` only when
`options.runs !== undefined`). A default run therefore has four mask rows and **no** `runs` field.

Both consumers read the declaration and paid for it twice:

- `costPerCapability` defaulted to `runs = 1` while a four-row mask was present. `correctPerRun`
  is divided by the mask length (correctly), then multiplied back by `runs` (wrongly) to
  reconstruct the total across all runs. With `runs = 1`, a four-run token ledger was divided by
  one run's correct answers — a 4× overcharge on both `promptTokensPerCorrect` and
  `promptTokensPerQuestionRun`.
- `attachCostEfficiency` refused outright when the declaration was absent, discarding a ratio whose
  numerator (the full ledger) and denominator (the all-runs accuracy) were both in the artifact.

The fix derives the count from the mask first in both places and keeps the declaration as a fallback
for archives that never captured per-run detail. Refusal now happens only when neither source can
say, which preserves the "unknown is not one" rule in `DESIGN-RUN-COUNT-INTEGER-GUARD.md`.

## 3. Null is a state, not a zero

Three defects were the same arithmetic mistake: a value that means "not computed" was fed into
number arithmetic, where JavaScript coerces `null` to `0`.

- **Ranking.** Sorting `promptTokensPerCorrect` with `null as number` made every unpriced row
  compare equal (`null - null === 0`). A stable sort left the first capability at the top and
  named it "most expensive per correct" even when no row had a price. The fix filters to priced
  rows before sorting and returns `''` when none remain.
- **Empty mean.** `contentExpectation` has one fewer element than the prompt list (the first prompt
  has no earlier text to share with). A one-question report yields an empty population; `0 / 0`
  printed `NaN%` and serialised to a silent `null`. The mean now returns `null` for an empty
  population and the renderer prints `n/a`.
- **Zero denominators.** `reader-cost-census` already returned `null` for a cache share whose
  prompt total was zero — but the renderer multiplied it by 100, and `null * 100 === 0`, so the
  human line claimed a measured `0.0%`. A single `pct()` helper now renders null and non-finite
  shares as `n/a`, matching the JSON.

## 4. A guard that no writer could satisfy

`tools/cost-ledger.py` adopted a run's own `costEfficiency` only when `state === 'measured'`. The
only writer, `costEfficiencyFrom`, emits `perCorrectAnswerPromptTokens`, `promptTokensPerQuestion`,
`accuracy` and `accuracySource` — and never emits `state`. Every real artifact was therefore
recomputed, and its `accuracySource` was relabelled from `artifact` to `all-runs`. A hand-made
fixture carrying `state` kept the guard looking alive. The guard now validates the fields the
writer actually emits: a positive finite ratio and an accuracy in `(0, 1]`.

## 5. Verification

Strict red → green: every fix has a test that fails on the old code for the documented reason
(`expected 1 to be 4`, `expected undefined to be defined`, `expected 'IE' to be ''`, `NaN%` in
stdout, `cache 0.0%` in stdout, authored ratio ignored). The full `cortex-eval` suite is
3841 passing tests; the coverage gate reports 206 files gated on four dimensions with 0 ratcheted,
and `cost-per-capability.ts` holds 100% statements / functions / lines and 98.07% branches.

## 6. Deliberately not changed

`assembleMemory` forwards `reviewBareDecline` only when a caller names it, while `REGISTERED_ARM`
sets it to `true` and the bench's default `reviewPass` is `none` (so the default eval arm also runs
with the retry off). Defaulting it on in the product would be a cost-and-behavior change — a second
consultation on every bare decline — with an explicit design note against a composition root
turning a mechanism on by itself. That change needs an empirical dispatch to price it first and is
recorded as a candidate in the internal tracking report, not bundled into a correctness fix.
