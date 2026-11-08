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

Two dispatches of the same arm, one field apart (`max_prompt_chars` 48,000 → 24,000), same 500 questions,
same reader, same judge, paired by `room-cut.json`:

| | `42355323615` (control) | `42373407439` (reduced) | delta |
| --- | ---: | ---: | ---: |
| overall accuracy | 457/500 = **91.40%** | 441/500 = **88.20%** | **−3.20 pp** |
| `MR` | 101/121 = 83.47% | 93/121 = 76.86% | **−6.61 pp** |
| `TR` | 122/127 = 96.06% | 116/127 = 91.34% | **−4.72 pp** |
| `KU` | 64/72 = 88.89% | 63/72 = 87.50% | −1.39 pp |
| `IE` | 140/150 = 93.33% | 139/150 = 92.67% | −0.67 pp |
| `ABS` | 30/30 = 100% | 30/30 = 100% | 0.00 pp |
| **context tokens / question** | **12,137** | **6,077** | **0.501x** |
| repetitions | 4 | **2** | — |
| cache-hit share | 98.34% | 51.07% | **not admissible** |
| billed tokens / question | 440 | 3,036 | **not admissible** |

Three facts a reader needs, and before this document the matrix could carry only the first two:

1. **The saving is real on context.** 0.501x, from 12,137 tokens to 6,077 — `C1`'s 6,000 threshold is
   **1.013x** away on this arm, i.e. the aim that row has carried since 2026-11-07 is reachable.
2. **The accuracy loss is not where the total says it is.** The aggregate lost 3.20 points; `MR` lost 6.61
   and `TR` 4.72, against `ABS` 0.00 and `IE` −0.67. `C2`'s sentence named the aggregate number, and the
   aggregate is the number that hides a part-level loss.
3. **The bill cannot be read from this pair at all**, and that is the finding this round produced rather
   than the one it set out to produce — see §1.1.

The verdict the instrument returns for the two arms that *can* be compared (accuracy and context, with the
bill excluded) is **`incomparable`**, blocking on `overall`, `MR` and `TR`. That is the correct answer: one
arm reads less and answers less, and a reader who wants one of them has to say which axis the product
optimises. Saying that out loud is the point.

### 1.1 The bill was the reading, and the reading was wrong

The first version of this instrument read the same pair and reported **1.074x** on the bill, and the finding
was going to be that halving the window costs 7.4% more because it breaks the prefix cache. It does not say
that. The two arms ran **4 and 2 repetitions**, and **the cache-hit share is a function of the repetition
count**: a prompt run four times can hit on three, a prompt run twice can hit on one. 51.07% is what one
miss and one hit over equal-sized prompts produces, and 98.34% is what a near-resident prefix produces —
neither number is about the window.

Both artefacts were caught the same way, and the second one is worse than the first:

| pairing | context | bill | why it is not a reading |
| --- | ---: | ---: | --- |
| `42310779222` vs `42373407439` | 0.502x | 1.07x | 4 repetitions against 2, cache share 78.21% vs 51.07% |
| `42355323615` vs `42373407439` | 0.501x | **6.90x** | 4 against 2, cache share 98.34% vs 51.07% |

A 6.90x bill on a 0.50x context is not a plausible cost effect; it is the repetition count. So the tool now
**refuses** the comparison outright — unequal `runs` is exit 2 with the reason — and `compareEfficiency`
reports `billComparable: false` and drops the term from both the promotion and the demotion clause, because a
confounded axis can neither prove nor disprove anything.

**What survives**: the three-axis order (it was designed for exactly this kind of confound and it is what
made the artefact visible), the accuracy and context readings above, and `C3` as a criterion with an `unrun`
value and a named blocker. **What does not**: any claim that this arm is cheaper or dearer to run. It costs
one dispatch at four repetitions to settle, which is `A3` in `docs/PLAN-COMPETITOR-ABLATION.md`.

The general lesson is worth one line because it will recur: **an axis that moves with the configuration
rather than with the system has to be checked for the same confound the accuracy axis has.** A token counter
looks exact and is not — it is exact per configuration, and the cache makes the bill a function of how the
run was shaped.

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
  tokenTolerance: 0.05  // smallest relative movement treated as movement at all
}
```

| outcome | condition |
| --- | --- |
| `dominates` | no gated reading drops by more than the margin, both token ratios are within tolerance of 1 or better, at least one is better, **and** the reference's own half-width is not larger than the margin |
| `dominated` | the same statement with `a` and `b` exchanged |
| `underpowered` | the promotion condition holds but the reference's half-width exceeds the margin, so the sample cannot support the claim — reported as neither a pass nor a fail |
| `incomparable` | everything else, including a genuine tie and a trade-off in either direction |

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
3. **Blocking on a subset errs toward demotion.** `TR` dropped 3.94 pp against a 3.87 pp subset
   resolution — the drop is inside the noise of that subset and still blocks, because blocking denies a
   claim rather than making one.
4. **A cache hit is a bill, never a context.** `billedPromptTokensPerQuestion` exists beside
   `promptTokensPerQuestion` and is documented as incomparable to any competitor's context figure. No vendor
   publishes a cache-hit share, so `Zep 4.4K` is a context number and stays on `C1` where it is one.
   Conflating the two would let this project claim to be cheaper than it is in the only unit the field
   publishes.

---

## 5. What the first reading licenses, and what it refuses

**Licensed.** `42373407439` at 6,077 context tokens per question is **1.013x** `C1`'s 6,000 threshold, so the
aim that row has carried since 2026-11-07 is reachable on this corpus — by a configuration whose `MR` fell
6.61 points and whose `TR` fell 4.72. Both halves are now on the page, and neither was before.

**Refused.** Reading `C2`'s met budget as a cost win. The order says `incomparable` and blocks on three
readings; `C2` keeps its 0.487 and gains a neighbour that says what the cut cost.

**Blocked, with the reason.** `C3`. Unequal repetition counts. Registered rather than estimated, and the
blocker is one field.

**Still open, and named here so it is not discovered later.** The `ABS` subset is 30 questions with a
±5.68 pp interval and reads 100% on both arms: it cannot detect anything, and its `0.00` contribution is a
zero over 30 items rather than a demonstration. The same is true of every capability-level claim at this
sample size until it is **paired**: `paired-flip.ts` and McNemar over discordant pairs have resolution that
depends on the discordant count rather than on the marginal rate, and that is the only route to a
capability-level claim this dataset supports. Registered, not built.

## 6. The interface, and how the reading is reproduced

```bash
node tools/efficiency-frontier.mjs \
  --label window --label squeezed \
  run-42310779222/benchmark-cortex-memory-ablation-report.json \
  run-42373407439/benchmark-cortex-memory-ablation-report.json
```

The tool reads `questionCount`, `runs`, `feature.metrics` (or `metrics`) and `usageBySide.feature` (or
`usage`), and refuses by name on anything absent rather than defaulting — a missing ledger defaulted to zero
would report a 99.9% saving. `--json` is the format `C3`'s evidence file
(`cortex-docs/evidence/longmemeval/frontier.json`) will be written in, so the row cannot carry a typed value;
the file is **absent today** because the only candidate pair is not bill-comparable (§1.1) and the tool refuses
to emit one.

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
