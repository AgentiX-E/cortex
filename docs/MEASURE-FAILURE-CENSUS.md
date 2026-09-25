# MEASURE — Failure Census: Where the 70 Failures Are

**Status:** measured. The failure population is 70 questions, not 99, and 24.3% of
them are refusals.
**Found by:** roadmap item 9d, opened by `MEASURE-GAP-ATTRIBUTION.md`, which
established that 259 of the 270 ranking-gap questions are already absorbed by the
reader and left open where the failures actually are.

---

## 1. The number that was being spent without being decomposed

`benchmark-report.json` reports accuracy as one figure. The roadmap spends that
figure on capability ranking, and every planning decision in this area has been
made from it. Nothing had ever stated _which_ questions were missing — even
though the per-question diagnostics the benchmark already writes carry the
capability, the verdict and the decision reason for all 500 of them.

The information was in the artifact and absent from the reading of it.

## 2. First correction: the failure population is 70, not 99

The gap attribution noted "the A2 baseline fails 99 of 500" and proposed
decomposing those 99. That figure is the **baseline** arm. The diagnostics are
written from the **feature** arm:

| source                                    | total | correct |
| ----------------------------------------- | ----- | ------- |
| diagnostics (single-session 379 + MR 121) | 500   | **430** |
| `report.feature.metrics.correct`          | 500   | **430** |
| `report.baseline.metrics.correct`         | 500   | 401     |

They agree exactly at 430, so the diagnostics measure the feature arm and the
failure population is **70**. The 99 is a real number about a different arm, and
conflating them would have produced a census that does not reconcile with any
artifact.

> **Discipline:** a count carries the arm it was measured on. When a run has two
> arms, "the system fails N questions" is incomplete without naming which system.

## 3. The census

Across all 500 questions of the A2 feature arm:

| capability | total   | correct | failed | answered wrong | refused wrong |
| ---------- | ------- | ------- | ------ | -------------- | ------------- |
| **TR**     | 127     | 91      | **36** | 27             | 9             |
| **MR**     | 121     | 106     | **15** | 12             | 3             |
| **KU**     | 72      | 59      | **13** | 12             | 1             |
| **IE**     | 150     | 145     | **5**  | 1              | 4             |
| **ABS**    | 30      | 29      | **1**  | 1              | 0             |
| **total**  | **500** | **430** | **70** | **53**         | **17**        |

Two axes, reported separately because they are not the same axis:

- **refused and wrong** (17, 24.3%) — the system declined a question it should
  have answered. Safe failure mode, controlled by the abstention threshold.
- **answered and wrong** (53, 75.7%) — the system asserted something false. The
  dangerous mode, and no guard currently targets it.

Collapsing these into "70 wrong" cannot distinguish a threshold set too high from
a reader that fabricates, and those are opposite fixes.

## 4. What the census changes about the plan

**TR is 51% of all failures** (36 of 70) and is the single largest population by
a factor of 2.4 over MR. TR is also the lowest-accuracy capability at 71.65%. The
two facts agree, which is what makes TR the clear target.

**IE is 5 failures of 150** and 4 of those 5 are refusals. At 96.67% accuracy the
capability is close to saturated, and what remains is a threshold question rather
than a retrieval or ranking question. TR has 36 and IE has 5; work spent on IE
cannot move the aggregate.

**The ABS failure is the R4 target.** `6456829e_abs` appears in the census's
`failedAnsweredIds` — the one ABS question the feature arm answered rather than
refused, and got wrong. That is the same question whose refusal R4's P2 predicted
and which `AUDIT-DISCORDANT-IDENTITY.md` established never moved. Two independent
instruments now name it.

## 5. Why the capability is inferred for MR records

The multi-session diagnostics are filtered to MR before being written, so those
records carry **no** `capability` field. Treating an absent field as unknown would
drop all 121 MR questions from a 500-question census and leave the per-capability
table summing to 379 with nothing in the artifact saying why.

That is the `AUDIT-SILENT-DENOMINATOR.md` defect class again, and it is why the
tests assert that the per-capability counts **sum to the totals** directly rather
than leaving it to inspection. A per-capability table that quietly disagrees with
its own total is the failure this module exists to make impossible.

Inference is sound here rather than a guess: a record without a capability came
from the file that contains exactly one capability.

## 6. A third defect class, caught by an unrelated standard

Fixing the `readonly` accumulator for TypeScript produced a discriminated
consolidation: `CapabilityCensus` is published `readonly`, accumulation needs to
increment, and dropping `readonly` to reuse the type would let an increment site
drift from the published shape without a type error. A separate internal
`MutableCensus` keeps the two in step.

The full gate then failed on **format**, not on tests: four `.ts` files from
earlier commits in this session had drifted out of Prettier style while every
test passed. That is worth recording because it is a class — a gate is only as
strong as its least-run check, and these four files were written, tested, and
verified by injection without the format check ever being run against them
individually.

## 7. Verification

| Step                                                                     | Result                                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Tests written first                                                      | red (module absent)                                                |
| After implementation                                                     | 10/10 green                                                        |
| Module coverage                                                          | **100 / 100 / 100 / 100**                                          |
| Injection: default capability to `unknown` instead of `MR`               | **1 red**                                                          |
| Injection: derive `abstained` from `reason` instead of reading the field | **4 red**                                                          |
| Injection: drop unrecognised capabilities                                | **1 red**                                                          |
| Injection: compute the refusal rate without the zero-denominator guard   | **1 red**                                                          |
| All restores                                                             | byte-exact (md5 `21992703` verified twice)                         |
| Real-artifact run                                                        | 500 records, 70 failed, reconciles with the report                 |
| Full gate                                                                | 1296 tests green, every package ≥95% every dimension, format clean |

The `abstained`-from-`reason` injection failing **4** tests is the strongest
signal in the set: it is the plausible implementation — those fields encode
overlapping information -- and it is wrong because a retry can convert a refusal
into an answer, leaving `reason: 'answered'` on a question that was refused
first. Four independent tests catch it.

## 8. What this does not claim

- **Not a claim about the baseline arm.** The census describes the feature arm.
  The baseline's 99 failures are a different population and would need its own
  crossing of `report.baseline` verdicts against the diagnostics, which record
  only the feature verdict.
- **Not a cause assignment.** The census says _where_ failures are by capability
  and by mode. It does not say _why_ any particular TR question failed; that
  needs the retrieved context and the reader output for each, which the
  diagnostics hold and this census does not read.
- **Not evidence that TR is fixable.** TR being the largest population makes it
  the largest target, not a tractable one.
- **The 17 refusals are not all threshold defects.** A refusal on an ABS question
  is correct behaviour; the one ABS failure here was an _answer_.
