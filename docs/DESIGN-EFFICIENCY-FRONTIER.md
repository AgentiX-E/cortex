# The joint reading: accuracy and cost as one order, not one number

**Why this document exists.** Every criterion this project has prices one axis at a time. `S1`–`S5` and
`R1` read accuracy; `C1` and `C2` read cost; and the reading the field is actually decided on — *more
accuracy for the same readers spending fewer tokens* — had no row at all. This is the design of the one
that now exists (`C3`), the three-axis order behind it (`packages/cortex-eval/src/efficiency-frontier.ts`),
and the arithmetic that says why a single weighted score would have been worse than nothing.

**Status.** The instrument exists and is runnable (`tools/efficiency-frontier.mjs`). The first reading is
taken, off two archived artifacts, and it is not the reading the project expected.

---

## 1. What the matrix could not see, in one pair

Two dispatches, one configuration field apart (`max_prompt_chars` 48,000 → 24,000), same 500 questions,
same reader, same judge:

| | `42310779222` (control) | `42373407439` (reduced) | delta |
| --- | ---: | ---: | ---: |
| overall accuracy | 90.85% (mean of 4) | **88.20%** (mean of 2) | **−2.65 pp** |
| `IE` | 142.5/150 | 139/150 | −2.33 |
| `MR` | 95.75/121 | 93/121 | −2.27 |
| `KU` | 63.75/72 | 63/72 | −1.74 |
| `TR` | 122.25/127 | 116/127 | **−4.53** |
| `ABS` | 30/30 | 30/30 | 0.00 |
| **context tokens / question** | **12,105** | **6,077** | **0.502x** |
| repetitions | 4 | 2 | — |
| cache-hit share | 78.21% | 51.07% | **not admissible** |

Three facts a reader needs, and before this document the matrix could carry none of them jointly:

1. **The saving is real on context.** 0.502x, from 12,105 tokens to 6,077 — `C1`'s 6,000 threshold is
   **1.013x** away on this arm, i.e. the aim that row has carried since 2026-11-07 is reachable.
2. **The loss is not where the total says it is.** `TR` loses 4.53 and blocks; `IE` and `MR` lose about
   2.3 each and sit inside the margin; `ABS` does not move. `C2`'s sentence named the aggregate, and the
   aggregate is the number that hides a part-level loss.
3. **The bill cannot be read from this pair at all**, and that is the finding that produced `C3`'s
   `unrun` rather than a value — see §1.1.

The verdict is **`incomparable`**, blocking on `overall` and `TR`. That is the correct answer: one arm
reads less and answers less, and a reader who wants one of them has to say which axis the product
optimises. Saying it out loud is the point.

### 1.1 Three corrections, and the shape they have in common

This section was wrong three times before it was right, and each correction is the same mistake wearing a
different coat: **a number was read on a population that is not the one the sentence claims.**

| # | what was read | what was wrong | the reading it gave |
| --- | --- | --- | --- |
| 1 | the bill, against `42355323615` | `runs` 4 against 2, and the cache-hit share moves with it | 6.90x on a 0.50x context |
| 2 | the accuracy, against `42355323615` | `ask` moved alongside the window in the same dispatch | −3.20 overall, `MR −6.61`, `TR −4.72` |
| 3 | the accuracy, from `feature.metrics` | that field is **one repetition**; `featureAggregate.avg` is the mean | 90.20% against a mean of 90.85% |

**1. The bill.** A cache hit is charged at 2% of a miss, so the bill is
`promptTokens × (hit × 0.02 + (1 − hit))` and moves with the hit share. A prompt run four times can hit on
three; run twice, on one. The first version of this instrument reported 1.074x against one control and
6.90x against the right one, on a 0.501x context, and neither number is a cost effect. Equal `runs` is
**necessary** — and, it turned out, **not sufficient**:

| pairing | context | bill | cache share | runs |
| --- | ---: | ---: | ---: | --- |
| `42310779222` / `42373407439` | 0.502x | 1.074x | 78.21% / 51.07% | 4 / 2 |
| `42355323615` / `42373407439` | 0.501x | 6.90x | 98.34% / 51.07% | 4 / 2 |
| **`42310779222` / `42355323615`** | **1.003x** | **0.156x** | **78.21% / 98.34%** | **4 / 4** |

The third row is two dispatches of **one system** with the same 24.2M prompt tokens. A term that can price
a 20-point cache difference as an 84% saving on a 0.3% context difference is not a cost measurement; it is
a reading of how the walk was shaped. So the bill **keeps its veto and loses its vote** — a risen bill can
refuse a context saving, a fallen bill can never be the reason an arm is called better. That rule was
found by running the first version: it reported `dominates` for that row.

**2. The control.** `42355323615` was used as the control for the window cut and it is the wrong control:
it moves `ask` (`verbatim` → `verbatim-acts`) and the room representation *in the same dispatch* that
shrank the room. Against the arm that differs in exactly one field, the cut's `MR` loss is −2.27 rather
than −6.61, and its overall loss is −2.65 rather than −3.20. Both are true measurements of two different
questions, and only the second is about `max_prompt_chars`. The tool now **diffs the two
`memoryArmConfig`s**, collapses the aliases (`maxPromptChars` and `maxPromptCharsByRoute.*` are one
variable; `*Routes` and `effectivePromptChars.*` are renderings rather than variables), and forces
`incomparable` when more than one field moved — the arithmetic still prints and may not promote anything.

**3. The population.** `feature.metrics.correct` is the **first repetition**; `ablation.featureAggregate.avg`
is the unweighted mean over all of them, and `report.ts` already states why the second is the one to read:
every cost ratio's numerator is a sum over every repetition, so the denominator has to describe the same
repetitions or the ratio is two populations. This tool read the first field and therefore published
90.20% for an arm that averages 90.85%, and 91.40% for one that averages 91.95% — in both cases the first
repetition, which happened to be the worst. The correction is the repository's own documented rule, which
is the part worth writing down: **the field was named, and the tool still read the other one.**

The general lesson is one line and it recurs: **an axis that moves with the configuration rather than with
the system has to be checked for the same confound the accuracy axis has.** A token counter looks exact and
is not; an accuracy field looks like *an* accuracy and there are two of them; a configuration looks like
one variable and the dispatch moved two.

## 2. Why not one weighted score

The proposal on the table was a composite index — something like `0.7·accuracy + 0.3·(1/tokens)` — and
the argument against it is not taste. It is that **the two axes have resolution that differs by two orders
of magnitude**, so a fixed weight multiplies a noise source by a constant and an exact quantity by another
constant, and the verdict becomes a function of the weights rather than of the measurement.

Measured on the reference arm:

| population | n | observed | Wilson 95% half-width | margin 2.5 pp resolvable? |
| --- | ---: | ---: | ---: | --- |
| overall | 500 | 91.40% | **±2.47 pp** | **yes, by 0.03 pp** |
| `IE` | 150 | 93.33% | ±4.09 pp | no |
| `TR` | 127 | 96.06% | ±3.60 pp | no |
| `MR` | 121 | 83.47% | ±6.60 pp | no |
| `KU` | 72 | 88.89% | ±7.34 pp | no |
| `ABS` | 30 | 100.00% | ±5.68 pp | no |
| **context tokens / question** | 500 | 12,137 | **0 (a sum of provider counters)** | — |

Two consequences, and the second is the one that matters for the roadmap.

**The accuracy axis barely resolves anything at this sample size.** The Wilson interval on the reference is
±2.47 points, so a 2.5-point margin is the finest test the aggregate can support — by three hundredths of a
point — and **no capability subset can support one at all** (±3.60 at best, ±7.34 at `KU`). The judge's own
main effect on the same 29 preference answers was measured at 8–9 points (§13.312.8), three times the
aggregate's whole interval. An index that puts a weight on accuracy therefore puts a weight on a quantity
whose run-to-run movement is larger than every arm effect this campaign has ever reported — and a
re-weighting moves an arm past another **with no run in between**, which is the same failure as widening a
coverage band until the noise fits.

**The token axes have no sampling variance at all.** 12,137 is a sum of provider counters over a fixed
configuration; two runs of the same arm return it. Its only movement is a configuration change, which is
the thing being measured — **and its one confound is `runs`**, which §1.1 is the record of. So the only axis
on which a real improvement can be *demonstrated* here is cost, and the accuracy axis is only ever asked one
question: **was it bought?**

That is not a licence to stop measuring accuracy. It is the reason the criterion has the shape it has —
non-inferiority on accuracy, superiority on cost — which is a clinical-trial design and not a score.

---

## 3. The five candidate composites, and which survive

| candidate | form | verdict |
| --- | --- | --- |
| weighted scalar | `w₁·A + w₂·(1/K)` | **rejected.** Weights are unfalsifiable, the verdict moves with them and not with data, and it silently averages an axis with ±2.47 pp of resolution into one with none. |
| tokens per correct answer | `K / A` | **kept as descriptive only** (`costEfficiencyFrom`, §13.308). A ratio of two noisy quantities with no interval attached, and it explodes as accuracy falls. It already exists and is already displayed; it is not a criterion. |
| accuracy per 1k tokens | `A / K · 1000` | **rejected as a primary.** A monotone transform of the row above, and because `1/K` is convex it rewards very small budgets disproportionately — an arm with 100 tokens and 10% accuracy beats one with 12,137 and 91%. |
| **iso-budget accuracy** `A(K)` | accuracy at a fixed token budget | **accepted.** This is the axis the field publishes on ("24,000 tokens under the pinned reader", `arXiv:2610.05343`), so it is the only form in which our number can sit beside a competitor's. It needs several points at different budgets, which is why it is a curve rather than a row. |
| **iso-accuracy budget** `K(A)` | the cheapest budget that holds accuracy | **accepted, as the criterion.** `C2`'s 0.70 bar is one point on this curve; `C3`'s 1.0 bar is one point on the bill's. It answers the question a product decision actually asks: *how cheap can this be before it starts costing answers?* |
| **dominance / frontier** | Pareto over `(A, K_context, K_billed)` | **accepted as the primitive.** Every row above is derived from it, and it is the only construction that cannot manufacture an ordering out of a tie. |

The rule the matrix now enforces is the last two together:

> An arm may be recorded as an improvement over another only when it is **at least as good on every
> objective and strictly better on one**, where the objectives are aggregate accuracy, `TR`-and-friends
> accuracy (each gated capability separately), context tokens per question, and billed tokens per question.
> Anything else is `incomparable`, which is a result and not a gap.

---

## 4. The order, stated precisely

`compareEfficiency(a, b, policy)` answers *is `a` better than `b`*, and it is symmetric by construction —
`compare(a, b)` and `compare(b, a)` cannot both return `dominates`, and the frontier is computed from the
same relation rather than from a second implementation.

The policy, pre-registered in code (`DEFAULT_EFFICIENCY_POLICY`):

```ts
{ margin: 0.025,        // accuracy drop tolerated as a tie, in proportion
  tokenTolerance: 0.05, // smallest relative movement treated as movement at all
  alpha: 0.05           // level a *paired* accuracy claim has to reach
}
```

| outcome | condition |
| --- | --- |
| `dominates` | no gated reading drops by more than the margin, both token ratios are within tolerance of 1 or better, at least one is better, **and** the reference's own half-width is not larger than the margin |
| `dominated` | the same statement with `a` and `b` exchanged |
| `underpowered` | the promotion condition holds but the reference's half-width exceeds the margin, so the sample cannot support the claim — reported as neither a pass nor a fail |
| `incomparable` | everything else, including a genuine tie and a trade-off in either direction |

**Two instruments, combined asymmetrically.** `compareEfficiency` takes optional `PairedEvidence` — how
many questions each arm won that the other lost — and runs an exact two-sided McNemar test on it. Where it
is supplied:

| direction | rule | why |
| --- | --- | --- |
| demote (`blocking`) | margin rule **or** a certified paired loss | both are evidence against, so needing only one is strictly more conservative |
| promote (`leading`) | a certified paired win **only** | promotion can overstate as the interval widens; a margin is not a test |

The asymmetry is not caution, it is the falsification of a first draft that used the paired test alone. Against
one control the window cut reads 13 won to 23 lost at p = 0.1325, so a rule that demoted only on a significant
pair called a −3.20-point arm "not worse" and promoted it on the 0.50x context. **Absence of a significant pair
is not evidence of no effect**, and a rule built to be strict about evidence has to be strict in the direction
that costs something.

Four properties are deliberate and each has a reason:

1. **The power check applies only to the promotion.** `underpowered` is produced when an arm would be
   *promoted*, never when it would be demoted. "The reference is not worse and costs no more" only becomes
   easier to establish as the interval widens, so demotion cannot overstate; promotion can. `42373407439`
   is the case: demoting it is safe at ±2.47 pp, promoting anything at that width is not.
2. **Power is judged on the aggregate, never on the narrowest subset.** Judged on the subset, every
   comparison would be `underpowered` the moment an arm carries a breakdown (121-question subsets resolve
   ±7.35 pp), and a criterion that can never be green is the failure `ACCEPTANCE-MATRIX.md` §2 refuses.
   The subsets' resolutions are still reported, in `unresolvable`, because an aggregate-level test does not
   license a capability-level claim and a reader is entitled to see which labels that applies to.
3. **Blocking on a subset errs toward demotion.** `TR` dropped 4.53 pp against a 3.60 pp subset
   resolution, and its paired record is **0 won to 5 lost at p = 0.0625** — five questions moved and every
   one moved against the arm, which is a clean sweep the significance level has not yet licensed and the
   margin rule blocks anyway, because blocking denies a claim rather than making one.
4. **A cache hit is a bill, never a context, and the bill is a veto rather than a vote.**
   `billedPromptTokensPerQuestion` exists beside `promptTokensPerQuestion` and is documented as incomparable
   to any competitor's context figure — no vendor publishes a cache-hit share, so `Zep 4.4K` is a context
   number and stays on `C1` where it is one. It may also never be the sole basis of a promotion: its only
   independent content is the cache, and the cache moved 20 points between two four-repetition dispatches of
   one arm (§1.1, row 3).

---

## 5. What the reading licenses, and what it refuses

**Licensed.** `42373407439` at 6,077 context tokens per question is **1.013x** `C1`'s 6,000 threshold, so the
aim that row has carried since 2026-11-07 is reachable on this corpus — by a configuration whose overall
accuracy fell 2.65 points and whose `TR` fell 4.53. Both halves are on the page.

**Refused.** Reading `C2`'s met budget as a cost win. The order says `incomparable` and blocks on `overall`
and `TR`; `C2` keeps its 0.487 and gains a neighbour that says what the cut cost.

**Blocked, with the reason.** `C3`. Unequal repetition counts. Registered rather than estimated, and the
blocker is one field.

**Settled, in the direction that removes a claim.** `42310779222` against `42355323615` is **1.003x the
context and 0.156x the bill** on identical token totals, i.e. two dispatches of one system. Before this round
the order reported `dominates` for that pair. It is now `incomparable`, and the reason is a property of the
instrument rather than of the arms.

**A capability-level claim is still unavailable, and the missing piece is no longer McNemar.** The paired test
exists now; what it lacks is a paired record of the *repetition mean*. The artifact stores **one answer per
question**, so the paired counts are first-repetition answers while the marginals are four-repetition means —
two populations again, in the one place the instrument cannot avoid it. `TR`'s 0 won to 5 lost is therefore a
first-repetition statement, and a confirmatory dispatch that records one answer per question per repetition
would make the same test available on the mean. Registered, not built.

**Still open, and named here so it is not discovered later.** The `ABS` subset is 30 questions with a ±5.68 pp
interval and reads 100% on both arms: it cannot detect anything, and its `0.00` contribution is a zero over 30
items rather than a demonstration.

## 6. The interface, and how the reading is reproduced

```bash
node tools/efficiency-frontier.mjs --json \
  --label registered --label route-room --label reduced \
  run-42310779222/benchmark-cortex-memory-ablation-report.json \
  run-42355323615/longmemeval-s-report/benchmark-cortex-memory-ablation-report.json \
  run-42373407439/benchmark-cortex-memory-ablation-report.json
```

The tool reads `questionCount`, `runs`, `ablation.featureAggregate.avg` (falling back to
`feature.metrics`, and saying which it used), `memoryArmConfig`, `questions[]` and `usageBySide.feature`
(or `usage`). It refuses by name on anything absent rather than defaulting — a missing ledger defaulted to
zero would report a 99.9% saving — and it will not pair on position: a record without a `questionId` is an
error rather than a guess about question order.

`--json` is what `C3` and `C4` read. `summary.matched.billedTokenRatio` is `null` when the single-variable
pair's arms ran different repetition counts, which is why `C3` is `unrun` rather than 107.4%; and
`summary.dominating` is the number `C4` gates on. Neither can be typed into a table, which is the point.

Four refusals are part of the reading rather than the plumbing:

| refusal | what it prevents |
| --- | --- |
| unequal `runs` → bill excluded | a 6.90x "cost" that is the repetition count |
| a pair differing in >1 config field → `incomparable` | `MR −6.61` published as the window's cost when it belonged to a two-variable pair |
| a cache difference → the bill cannot promote | a 0.156x bill on a 1.003x context, i.e. a dominance claim manufactured by the prefix cache |
| a non-significant pair → not a demotion | the first draft promoted a −3.20-point arm for want of a p-value |

The three divisions that `C1` documents are preserved: `usageBySide.feature.promptTokens` is a total over
**every** repetition, so the divisor is `questionCount × runs`. `§13.308` is the record of a reading that
divided an all-repetitions numerator by a one-repetition denominator and made the worse arm look 54% cheaper
than it was; the fixture in `tools/__tests__/test_efficiency_frontier.py` carries `runs: 4` precisely so
that a wrong divisor fails there rather than in a matrix row.

---

## 7. What this does not do

- **It does not compare us to a competitor.** Every point it can order is one of ours. A competitor's row
  becomes admissible only after `COMPETITOR-CODE-AVAILABILITY.md`'s protocol, because the token figure and
  the accuracy figure have to come from the same run under the same reader.
- **It does not replace `C1` or `C2`.** `C1` reads an absolute context figure in the field's unit; `C2` reads
  a paired budget cut. `C3` reads the bill. Three rows, three quantities, and the matrix prints all three.
- **It does not make the accuracy axis informative.** It makes it honest about being uninformative, which is
  the most a ±2.47 pp instrument can do at n = 500.
- **It does not resolve which artifact "the registered arm" is.** `42310779222` and `42355323615` are both
  described that way in the record, and they differ by `ask` and a route room — 0.26% on context, 1.2 points
  on accuracy. Every row picks one of them and none says so. `provenance` in the evidence file records the
  duplication; resolving it needs a dispatch at equal repetitions, not an edit.
