# MEASURE — Card volume on real speech, and the publishing defect it exposed

> Run: `run 39699987781`, artifact `benchmark-cortex-memory-ablation-report.json` (LongMemEval-S,
> 500 questions). Reading produced by `packages/cortex-core/test/card-volume/run.mjs`; numbers below
> are from `packages/cortex-core/test/card-volume/result.json`. Ten-window sample committed so the
> reading re-runs without the 49 MB artifact.

## Why this was measured

Step 17 ended with one sentence doing a lot of work: `release()` refuses a `defer` row because
"a deferral is a question, and the card queue is how it is answered." That is a claim about
frequency — it is only reasonable if deferrals are the exception. The only corpus behind it was
sixty hand-labelled utterances, 40 of which deferred.

## The reading

| Quantity | Full artifact | Ten-window sample |
| --- | --- | --- |
| Evidence windows | 500 | 10 |
| User turns | 54,313 | 1,087 |
| Turns the rule layer defers | **47,543 (87.5%)** | 925 (85.1%) |
| Cards before the gate (one per deferral) | **47,543 — 95.1 per window** | 925 — 92.5 |
| Cards after the gate (one per deferral with a claim) | **35,264 — 70.5 per window** | 718 — 71.8 |
| Median / max cards per window | 60 / 147 | 104 / 118 |
| Claims kept inside those cards | 64,837 | 1,292 |
| Turns that now open nothing | 12,279 (25.8% of deferrals) | 207 (22.4%) |
| Claim fused into a question (blind spot) | 109 (0.2%) | 4 (0.4%) |

The sample agrees with the full run to 1.3 cards per window, which is what a sample is for.

## What the two numbers mean

**87.5% is not "the rules decide a little and ask about the rest".** It is the opposite: deferral is
the normal case, so "ask the owner" is the default path and the rule layer is the exception. Any
design sentence that assumes otherwise is wrong at this workload.

**73.6% of those deferrals contain a question mark.** Since `accept` publishes `card.text`, the
queue's normal case was asking whether a colleague should be allowed to read a task the owner had
given their assistant:

```
Can you write the texts for the PowerPoint presentation ?
please continue, provide 10 additional examples
Thank you
```

That is a publishing defect, not a volume complaint, and it is what step 18 fixed: a card now
carries the claims inside the turn (`claimsIn`), and opens nothing when the turn contains none.

## What the fix does not do

Volume fell 26%, to **70.5 questions per evidence window**. It cannot fall much further by filtering,
because 74.9% of real user turns contain at least one assertion — people state facts constantly. The
remaining problem is **selection** (which twenty of those seventy a person should see today), and
selection is a new capability with its own pre-registered criterion. It is recorded as a gap, not
smuggled into the filter.

## Two properties, measured rather than asserted

1. **Recall on the only set a person labelled before any rule existed**: all **40** `defer` rows of
   `triage-labels.json` still open a card. The gate's job was to refuse requests, not to trim the
   hand-labelled set.
2. **The blind spot is bounded**: a claim and a question inside one sentence ("I like categorising my
   coupons, but how do I decide which categories to prioritise?") travel together and are lost,
   **109 of 47,543 (0.2%)**. The detector is in the script so the number can be re-derived.

## What was checked by reading, not by counting

The 12,279 declined turns were sampled and read. They are questions (`What are the key factors
contributing to the success of Bhutan's Gross National Happiness Index?`), instructions
(`create the focal and sub-ordinate goals based on the interviews`), and continuations
(`continue:`). None carried a claim a colleague could act on. This is a human judgement on a sample,
not a measurement, and it is recorded as such.

## One dead branch, found by measuring

The first version of `claims.ts` carried a table of pleasantries ("thanks", "sounds good", "got it")
matched against the whole sentence and gated on three words or fewer. On the 46,951-turn corpus it
matched **zero** sentences: every entry is one or two words and had already been refused by the
word floor. The table was removed rather than left in place — an unreachable branch is a claim about
the code that the corpus refutes.
