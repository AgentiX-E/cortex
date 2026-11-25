# Scoped pricing: what a capability-scoped dispatch costs, asked before it is dispatched

**Status:** the floor is closed for every capability whose bill has been recorded, and the remaining
ones say they are floors. One number in one file (`tools/spend-baseline.json`, `capabilityRates`)
turns a projection into a price, and the dispatch gate stops demanding a guessed ceiling for the
designs it covers.

## 1. What the instrument said, and what it could not say

`tools/spend-projection.mjs` prices a dispatch by scaling a run that was billed, along three axes:
questions, repetitions, and — since §13.345 — the population. The first two are exact. The third was
not, and the tool was honest about it in a way that made the cheapest experiment in the campaign
unquotable.

`capability=MR` at two repetitions was **projected at 1.73 CNY and billed 5.87** (`§13.348.2`). The
factor `121/500 x 2/4` is right for the **count** of questions and wrong for their **cost**: `MR` is
one of the two routes that carry the reasoning, so its question-run costs **0.0243 CNY** against the
file's **0.0064**. The tool reported `lowerBound: true, lowerBoundBecause: 'population'` and the
dispatch gate refused the run unless the operator named a budget — i.e. guessed 6.

That refusal was correct and it had a cost of its own: a plan built on it can only say *"a scoped
dispatch is cheaper, somewhere between 1.73 and 5.87"*, and a plan that says that cannot be ordered
against a budget. The finding here is not that the floor was wrong. It is that the floor was **the
only thing available**, and the thing that would replace it — the invoice — was already in the
repository as a sentence in a document rather than as data in the baseline.

## 2. The fix, and the two rules it keeps

`tools/spend-baseline.json` gains a block:

```json
"capabilityRates": {
  "measured": {
    "MR": { "billedCny": 5.87, "billedQuestions": 121, "billedRuns": 2, "source": "..." }
  }
}
```

Three numbers and a citation. The rate is `billedCny / (billedQuestions x billedRuns)`, **derived at
read time and never stored rounded**: a file carrying both `5.87` and `0.0243` would be two numbers
that disagree in the fourth decimal, and the one a reader checked would not be the one the arithmetic
used. That is the same rule `cost-per-capability.ts` states for characters-per-token.

Two rules decide which of the two arithmetics a number came from, and both exist because the gate
treats the two differently:

1. **All or nothing on the selection.** `MR,TR` is one billed row and one floored row, so the total is
   a floor, printed under the `LOWER BOUND` heading it has always had. A mixed total that inherited
   the measured heading from its neighbour would be §13.348's defect in the other direction — a figure
   a reader cannot place. `measuredScopedCost` therefore answers `null` for a partial cover rather
   than a mixture, and an `approximate: true` flag was refused for the same reason.
2. **Repetitions are the only extrapolated axis.** Each repetition is its own call with its own
   prompt, which is the claim the file-scaled branch already makes. Above the billed count the total
   carries the `*` that `tools/scoped-spend.mjs` prints, because the cache behaviour at a count nobody
   billed is unmeasured.

The gate's change is one predicate: it asks whether the baseline **covers the selection**
(`_rates_cover`), and only refuses without a named budget when it does not. The arithmetic stays in
the projection — a second implementation in Python would be a second answer to the same question.

## 3. The ladder, priced

Every row is `node tools/spend-projection.mjs --report tools/spend-baseline.json ...`, at the
2026-11-09 prices the baseline was rendered at.

| design | questions | CNY | basis |
| --- | ---: | ---: | --- |
| 60-question probe, 1 repetition | 60 | 0.43 | file-scaled |
| 60-question probe, 2 repetitions | 60 | 0.86 | file-scaled |
| `capability=TR`, 2 repetitions | 127 | 1.81 | **floor** |
| `capability=MR`, 1 repetition | 121 | 2.94 | measured |
| whole file, 1 repetition | 500 | 3.57 | file-scaled |
| `capability=MR`, 2 repetitions | 121 | **5.87** | measured (the invoice) |
| whole file, 2 repetitions | 500 | 7.13 | file-scaled |
| `capability=MR`, 4 repetitions | 121 | 11.74 | measured, extrapolated `*` |
| whole file, 4 repetitions | 500 | 14.26 | measured (`42467`) |

Read down the middle column and the compression is not a discount on the same designs — it is that
**the design a mechanism actually needs is a fifth of the file**: a heading contract that changes what
the multi-session route asks cannot move `IE`, and paying for 500 questions to measure it buys 379
questions the mechanism cannot reach. `MR` at two repetitions is 5.87; the file at two is 7.13; the
file at four is 14.26.

## 4. Why the file-level confirmation is 3.57 and not 16

The published number is a 4-repetition figure (`91.20`, `S16`). The adopted arm is a 2-repetition
figure (`93.50`, `45543010618`). The gap between them is not a missing mechanism, it is **two
repetitions that were already bought** and cannot be pooled with anything unless a third and fourth
exist. One more dispatch at `limit=0, ablation_runs=1` is 3.57 CNY and produces the third; pooling
three against the archived two is what a 4-repetition reading is made of, and the archived pair is
already on disk with a matching `featureConfig`.

So the confirmation's price is **3.57, not 16**, and the ordering rule that follows from it is worth
more than the saving: **certify after you win, not before.** A 1.80-point gain that sits on this arm's
own noise floor (1.6–2.2) is not made publishable by a tighter interval; it is made publishable by
being larger, and only a mechanism can do that. Buying the third repetition now certifies a number
the next mechanism will replace.

## 5. What this does not claim

- **One provider, one week.** The rate is `deepseek-chat` at the 2026-11-09 prices, thinking on
  `multi-session+temporal`. A `zhipu:` dispatch is a different bill and has no rate here; the floor and
  its label are what it gets until one is billed.
- **The bill bundles both arms and the judge.** 5.87 is a whole-dispatch price for 121 questions x 2
  repetitions, so the rate is comparable to another dispatch and **not** to `costPerCapability`'s
  feature-side rows for the same capability, which apportion completion by question-runs and therefore
  understate a thinking route (`MR` reads 0.0119 there against 0.0243 billed — the 2x is the null
  model, not a measurement).
- **Four capabilities are still floors.** `TR`, `IE`, `KU` and `ABS` have never been dispatched alone,
  so their rows in §3 are census-scaled and say so. The repair is one line each, once a bill exists:
  the gate's refusal now names `capabilityRates.measured` as the place to record it.
- **The embedding line is not in any of these numbers.** It is not in the artifact, so no projection
  here carries it; every figure is a floor for "what the dispatch costs" and exact for "what the
  reader costs".

## 6. Tests

| what | where |
| --- | --- |
| the rate is the bill over its own question-runs | `test_spend_projection.py::TestMeasuredScopedCost` |
| at the billed repetition count the projection returns the bill (5.87) | `TestCapabilityScopedRuns::test_the_billed_repetition_count_reproduces_the_invoice_exactly` |
| above it, the extrapolation mark | `...::test_a_design_above_the_billed_repetitions_is_labelled_as_extrapolated` |
| a partially covered selection keeps the floor and its label | `...::test_a_capability_without_a_bill_keeps_the_floor_and_its_label` |
| a zero denominator, a non-positive bill, a capability the census lacks: all refused | `TestMeasuredScopedCost` (3 cases) |
| a covered selection dispatches without a guess; an uncovered one still needs a ceiling | `test_dispatch_spend.py::TestCapabilityScopedPricing` |

No product code changed in this round: `packages/` is untouched, so the coverage readings are §193's.
