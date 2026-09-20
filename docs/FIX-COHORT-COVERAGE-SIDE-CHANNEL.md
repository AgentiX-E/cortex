# FIX — Cohort Coverage Was a Side Channel

**Status:** fixed in `report.ts` + `runner.ts` + `bench/run.ts`; 5 new tests for
the cohort banner, 12 for the retry-fire section (the same defect class, in a
second arm — see §7).

This is the second defect in the conjunction guard, found one round after the
first. The first was the guard's blast radius (`FIX-CONJUNCTION-GUARD-BLAST-RADIUS.md`);
fixing that one *introduced* this one, which is why it is recorded separately.

---

## 1. What the previous fix got wrong

The first fix stopped the guard from discarding every completed report when it
fired. It caught the throw and had the caller write a skip record. Correct as far
as it went.

But it also flipped the caller's `requireCohortCoverage` default to `false`, so
an under-covered cohort now *succeeds* instead of throwing. Verifying that fix
produced this artifact (run `35502712132`):

```
benchmark-conjunction-ablation-report.md      <- present, rendered as an ordinary report
benchmark-ablation-skipped.json               <- []
```

and inside the JSON:

```
cohortCoverage.present: ["80ec1f4f_abs"]
cohortCoverage.missing: 6 of 7
cohortCoverage.ratio:   0.1428
```

A **1-of-7 cohort** produced a full report. The Markdown contained no occurrence
of the words `cohort`, `coverage`, `incomplete`, or `missing` — verified by
grep across the whole file.

## 2. Why this is worse than the failure it replaced

| | Before | After the first fix |
| --- | --- | --- |
| Run outcome | red | green |
| Reports kept | none | all |
| Wrong-experiment risk | **visible** (the run died loudly) | **silent** (the report looks complete) |

The guard exists because R4's P2/P3 are pre-registered against seven specific
questions, so scoring a subset "is not a weaker test, it is a different test that
happens to share a name" — the guard's own words, in the source. The first fix
preserved the guard's verdict for the *strict* configuration and then made the
permissive configuration the default, which moved the wrong-experiment outcome
from a loud failure to a quiet artifact.

**A degraded run that looks healthy is strictly worse than one that fails**,
because the failure is self-announcing and the healthy-looking number is not.

## 3. Root cause

`runQueryExpansionDecompositionAblation` computed `coverage` and returned it:

```ts
return { report, markdown: formatAblationReport(report), coverage };
```

`formatAblationReport(report)` receives only the report, and `report` did not
contain the coverage. So the renderer had no way to print the caveat even if it
wanted to, and the caller that *did* hold the coverage wrote it only to JSON.

The information existed at the return site and was separated from the thing it
qualifies. That is the defect: **coverage is not metadata about the report, it is
part of what the report means.**

## 4. Fix

**4.1 `AblationReport` carries `cohortCoverage`.** Optional, because most arms
declare no cohort. The comment on the field records why it is not a
side-channel return value.

**4.2 `runner.ts` attaches it before formatting**, so `formatAblationReport`
cannot render the numbers without the coverage in hand:

```ts
const result = await runAblationReport(...);
const report: AblationReport = { ...result, cohortCoverage: coverage };
return { report, markdown: formatAblationReport(report), coverage };
```

**4.3 `formatAblationReport` prints a banner above the results** — above, because
a caveat below three tables of Wilson intervals is a caveat nobody reads. An
incomplete cohort gets `**COHORT INCOMPLETE — read these numbers with care.**`
plus the present/total count, the ratio, and the missing ids. A complete cohort
gets an explicit `**Cohort complete**` line, so "satisfied precondition" and
"no precondition declared" are distinguishable.

**4.4 `bench/run.ts` serialises the report as-is** instead of spreading the
side-channel field back in, removing the second path that could disagree about
coverage.

## 5. Acceptance criteria

| Criterion | Evidence |
| --- | --- |
| An incomplete cohort is visible in the Markdown | Test: banner contains `INCOMPLETE`, the ratio, and the missing ids |
| The banner precedes the results | Test: `indexOf('INCOMPLETE') < indexOf('Δ accuracy')` |
| A complete cohort is announced, not silent | Test: `100.00%` + `complete`, and no `INCOMPLETE` |
| Arms without a cohort are unchanged | Test: no `/[Cc]ohort/` in the rendered output |
| Ratio formatted like every other rate | Test: `14.29%` for 1/7 |
| The report carries coverage through the formatter | `AblationReport.cohortCoverage`; fixture built from real types, no cast |
| No workspace regression | 1099 tests, 0 failures; all four packages ≥95% on all four dimensions |

## 6. Not claimed

- **The conjunction arm is still under-covered at `LIMIT=60`.** This fix makes
  the shortfall visible; it does not make R4 measurable. R4 needs `LIMIT=200`.
- **The `[]` skip record from run `35502712132` is correct.** `requireCohortCoverage:
  false` means the guard did not fire, so nothing was skipped — the report
  succeeded and carried its own caveat. Both artifacts were individually
  consistent; the defect was that the caveat never reached the reader.

## 7. The declared gap is now closed — the pattern recurred

§6 of the first revision of this document declared one gap: *"No other arm was
audited for the same pattern."* Auditing it found the pattern **present**, in a
second arm. The gap declaration was accurate, and closing it was not a formality.

### 7.1 Audit of all nine return sites

`runner.ts` has nine ablation functions and nine `{ report, markdown, ... }`
returns. Every one was read:

| # | Function | Line | Extra value computed? |
| --- | --- | --- | --- |
| 1 | `runEmbeddingBenchmark` | 120 | no |
| 2 | `runNaturalLanguageBenchmark` | 178 | no |
| 3 | `runMrAggregationAblation` | 252 | no |
| 4 | `runTemporalEngineAblation` | 311 | no |
| 5 | `runDeterministicCoverageAblation` | 389 | no |
| 6 | `runTimeWindowAnnotationAblation` | 471 | no |
| 7 | `runBitemporalKnowledgeUpdateAblation` | 532 | no |
| 8 | `runAbstentionRetryAblation` | 685 | **yes — `retryFires`** |
| 9 | `runQueryExpansionDecompositionAblation` | 867 | **yes — `coverage`** |

Seven of nine are clean. The defect requires a function that *computes a value
qualifying the result* and then returns it beside the report; the seven clean
arms compute nothing beyond the report, so they have nothing to leak. The two
that do calculate have exactly the two defects fixed in `0e2c30e` and this round.

### 7.2 The second instance

`runAbstentionRetryAblation` computed `retryFires` and returned it beside the
report. The Markdown got the section from a string concatenation at the return
site; the JSON got it from a spread at `bench/run.ts`. Proven on the real
archived artifact — re-rendering `benchmark-mr-retry-ablation-report.json`
dropped the section entirely:

```
has "Abstention-retry fires": false
```

This one matters more than a missing cosmetic table. That arm's published result
is a **null** one, and the source comment states the counter is the only thing
separating *"a working feature on a dataset it cannot help"* from *"a feature
that was never wired in."* Removing the section restores exactly that ambiguity.

Fixed the same way: `retryFires` is a field on `AblationReport`, attached before
formatting; `formatRetryFireSection` now delegates to one implementation
(`retryFireLines`) instead of holding a second copy of the table.

### 7.3 What re-rendering the real artifact then revealed

The fix made it possible to render the archived report, which is the first time
this arm's counters could be read alongside its accuracy numbers:

| Field | Value |
| --- | --- |
| `controlFires` | 0 |
| `treatmentFires` | **3** |
| `questions` | 200 |
| Treatment fire rate | **1.50%** |

Two conclusions:

1. **The experiment is valid.** The control is provably 0, so
   `enableAbstentionRetry: false` genuinely reaches the retry. This had been
   *assumed*; it is now *checked*, and it is the assertion that separates this
   arm's null from a no-op.
2. **The arm is very weakly powered.** At 3 fires in 200 questions, Δ accuracy
   cannot move by more than 1.5 pp, and the observed null is bounded by that.
   The ablation does not show the retry fails to help — it shows it barely runs.
   Those are different findings with different next steps, and only the counters
   distinguish them. This is the concrete reason the section is load-bearing
   rather than decorative.

The renderer therefore grew a third verdict branch. A null has three causes and
each needs a different response:

| Counter state | Verdict printed | Correct next step |
| --- | --- | --- |
| `controlFires > 0` | `INVALID EXPERIMENT` | fix the flag plumbing; discard the result |
| `treatmentFires === 0` | `INERT — never fired` | find a population with bare abstentions |
| `0 < treatmentFires <= 2` | `INERT — under-powered` | the mechanism works; stop hunting a wiring bug |
| `treatmentFires >= 3` | *(no warning)* | read the delta |

The middle two are deliberately distinct. Collapsing "fired once" into "never
fired" sends the next iteration after a wiring bug that does not exist — the
precise misreading the counters are there to prevent, so the renderer must not
commit it itself.

### 7.4 Regression guard for the class, not the instances

Fixing two instances leaves the pattern legal, and the class has now recurred
once. A structural invariant is asserted instead: **every section the renderer
emits is reachable from the report object alone**, checked by rendering a report
after a JSON round-trip — the state every archived artifact is in, and the state
in which both defects became visible.

## 8. Verification

| Criterion | Evidence |
| --- | --- |
| Fires section survives persistence | 12 tests in `report-retry-fires.test.ts`; re-rendering the real artifact prints `3/200` and `1.50%` |
| Control at 0 is asserted, not assumed | Rendered table shows `control \| 0`; `INVALID EXPERIMENT` branch tested |
| The three verdicts are distinguishable | Tests for `(3,4)`→INVALID, `(0,0)`→never fired, `(0,1)`/`(0,2)`→under-powered, `(0,3)`→no warning |
| Section ordering | Test: `Δ accuracy` and `Per-capability paired significance` both precede the fires section |
| No empty table for other arms | Test: deleting `retryFires` removes the section |
| No division by zero | Test: `questions: 0` renders `0.00%` without throwing |
| Structural guard | Test: both sections render from a JSON round-tripped report; neither renders when absent |
| No workspace regression | 920 tests in `cortex-eval`, 0 failures; all four packages ≥95% on all four dimensions |

**Closed gap count: 3 declared → 0 declared.** The prior revision of this
document listed one gap; §7.1 audited it, §7.2 found it real, §7.3–7.4 closed it.
