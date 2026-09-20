# FIX — The Coverage Gate Measures Noise

**Status:** root-caused and reproduced; quantified at 3 distinct results in 6
identical runs. The gate's threshold is unchanged (95); the *input* it reads was
never stable.

**Found by:** noticing that `cortex-core`'s reported coverage differed between
three consecutive verification runs in the same session (98.98, 98.22→98.98,
98.47) while no code had changed. Earlier in the session I had twice dismissed a
low figure as "a stale cached report". That dismissal was wrong, and the
repetition is what turned a dismissed anomaly into an investigation.

---

## 1. Symptom

Six identical `npx vitest run --coverage` invocations in `packages/cortex-core`,
no source or test edit between them:

| Result | Occurrences |
| --- | --- |
| 98.73% | 3 |
| 98.47% | 2 |
| 98.98% | 1 |

Three distinct values. The gate threshold is 95, so every one of these **passes**
— which is precisely why this survived: an unstable measurement that never
crosses the threshold is indistinguishable from a stable one, until the day a
real regression of ~3pp also passes.

> A gate that reads a noisy input is not a gate at 95%. It is a gate at
> `95 ± noise`, and the noise is invisible until it costs something.

## 2. Localisation

The per-file table was **identical across runs**; only the `All files` row moved.
That asymmetry is the key observation: a measurement difference would show up in
the file rows, so the variation had to be in the aggregation, not the measurement.

Extracting `coverage-final.json` (`--coverage.reporter=json`) across five runs
removed the ambiguity. The denominators were **constant** — 789 statements, 296
branches, 19 files, every run — while the numerator moved:

| Run | covered / total | Result |
| --- | --- | --- |
| 1 | 783 / 789 | 99.24% |
| 2 | 779 / 789 | 98.73% |
| 3 | 783 / 789 | 99.24% |
| 4 | 779 / 789 | 98.73% |
| 5 | 781 / 789 | 98.99% |

Within `stats.ts` the covered count was 172 / 176, 168 / 176, 172 / 176, 168 / 176,
170 / 176. **Constant denominator, moving numerator** — so the question narrows
from "which file varies" to "which statements vary".

## 3. Precise localisation

Comparing the per-statement covered flags across the five runs found exactly six
flaky statement ids, all in `stats.ts`:

| Statement id | Source line | Covered across runs 1–5 |
| --- | --- | --- |
| 189 | 190 | `CCC.C` |
| 190 | 191 | `CCC.C` |
| 202 | 203 | `C.C.C` |
| 203 | 204 | `C.C.C` |
| 207 | 208 | `C.CC.` |
| 208 | 209 | `C.CC.` |

Those lines are the bodies of the underflow guards in the continued fraction:

```ts
d = 1 + aa * d;
/* c8 ignore next -- defensive guard, unreachable via valid inputs */
if (Math.abs(d) < 1e-30) {
  d = 1e-30;                    // <- line 190, flaky
}
```

**Every flaky statement is the body of a guard carrying a `c8 ignore next`
annotation.** Six statements, four annotations in this loop, and no other
statement in the file varies.

## 4. The annotation is correct; its application is not

The guard bodies are genuinely unreachable, and this was verified rather than
assumed. Because `dfNum = se2 * se2` and `dfDenom >= 0`, the `df <= 0` guard is
reachable only when `se2 === 0`, which an earlier guard already returns on — so
that one is dead as documented.

For the continued-fraction guards, the claim "`|c|` and `|d|` never approach
`1e-30`" was tested by replicating the loop over a grid of 56 `(x, df)` pairs and
recording the minimum magnitude:

```
minimum |c| or |d| observed:            0.8095...
guard threshold:                        1e-30
margin:                                 29.9 orders of magnitude
```

A guard whose threshold sits **30 orders of magnitude** below every value the
function produces is not reachable by any input this code can generate. The
annotation states a true fact.

So the defect is not the annotation. It is that **the v8 provider's handling of
`c8 ignore` hints is non-deterministic in this configuration**: it sometimes
attributes the enclosing loop's execution to the ignored body and sometimes does
not. The Istanbul/`c8` ignore machinery is a source-map-driven post-processing
step over raw v8 counters, and the flakiness lives in that step.

## 5. Why this is the same class as the earlier defects

This repository has now recorded four defects whose common shape is *a value that
is real in one place and lost in another*: a guard's position, a value returned
beside its result, a number that cannot survive JSON, a pattern fixed twice instead
of once. This is a fifth, in the measurement layer rather than the product:

| # | Boundary | Wrong assumption |
| --- | --- | --- |
| 1 | Position | a precondition check is safe wherever it sits |
| 2 | Return value | a qualifying value may live beside the result |
| 3 | Representation | in-memory and persisted values are the same value |
| 4 | Class | fixing the instances fixes the pattern |
| 5 | **Measurement** | **a coverage number is reproducible** |

The fifth is the most consequential to have gone unnoticed, because the coverage
number is what *validates every other claim in this repository*. A gate that
reads ±0.5pp of noise cannot distinguish a real 1pp regression from run-to-run
variation, and the project standard is stated as "≥95% on every dimension" as
though that were a fact about the code rather than a sample from a distribution.

## 6. Fix

The annotations are correct and are **kept** — deleting them would drop coverage
by ~1pp and replace a true statement with a false one. The instability is
addressed where it lives:

**6.1 `coverage.reporter` writes `json` alongside the text report**, so every
claimed number is re-derivable from raw counters rather than from a rendered
table. The text table is a rendering; the JSON is the evidence.

**6.2 A regression test asserts the annotation set is exactly as expected.**
`coverage-annotations.test.ts` enumerates every `c8 ignore`/`v8 ignore` in
`src/`, asserts the count and the reasons, and fails if a new annotation appears
without being declared. An ignore annotation is an assertion that code cannot run;
an undeclared one is an assertion nobody reviewed. This also makes the count a
reviewed quantity, which is the precondition for the fix below.

**6.3 The gate is documented as noisy, with the measured magnitude.** Stating the
observed spread (±0.5pp) in `vitest.config.ts` is what prevents the next person
from re-deriving §1 and dismissing it as caching, exactly as I did twice.

### 6.4 What was deliberately NOT done

- **Not deleted the annotations.** They are true.
- **Not raised the threshold to absorb the noise.** That would hide a real
  regression behind a wider band; the correct response to a noisy measurement is
  to reduce the noise or state it, not to widen the tolerance until the noise
  fits. Raising the gate from 95 to 96 to "make it stable" would be exactly the
  `|| true` pattern this repository forbids, applied to a metric instead of a
  command.
- **Not switched provider.** Istanbul is a much larger change to the test
  infrastructure than this defect justifies, and the provider is not the part
  that is wrong — the annotation handling is.

## 7. Acceptance

| Criterion | Evidence |
| --- | --- |
| The instability is quantified, not described | 6 runs, 3 distinct results; 5 runs of raw counters: 779/781/783 over a constant 789 |
| The varying statements are identified | 6 ids in `stats.ts`; every one the body of a `c8 ignore` guard |
| The annotations are verified correct, not assumed | 29.9 orders of magnitude between observed minimum and guard threshold |
| The claim is re-derivable | `coverage-final.json` produced by the config |
| Annotation set is reviewed | `coverage-annotations.test.ts` enumerates and pins it |
| The noise is documented where it is configured | `vitest.config.ts` records the measured spread |
| No threshold was weakened | Thresholds unchanged at 95 |
| No regression | All four packages pass; every dimension ≥95% |

## 8. Residual risk, stated

The root cause is inside the v8/`c8` ignore-hint application, which is not this
repository's code. The fix makes the instability *visible and bounded* — the
annotation set is pinned, the raw counters are retained, and the noise magnitude
is on the record — but it does not make the provider deterministic. A future
provider change could reintroduce a different instability, and the mitigation is
the retained `coverage-final.json`, which makes any such recurrence diagnosable
by the same method used here rather than by noticing a number moved.

**Not claimed:** that the reported figure is now stable. It is claimed that its
instability is measured, bounded, explained, and no longer able to pass
unnoticed.
