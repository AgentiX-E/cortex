# Cortex — Measure B2: The Retrieval Recall Curve

Design and rationale for the measurement instrument that decides candidate-pool
width. Written before running it, so the reading is fixed in advance rather than
chosen after seeing the number.

## 0. Why a new instrument instead of the existing diagnostics

Retrieval in Cortex is already multi-channel: `retrieveSessionsForQuestion`
fuses four recall channels by reciprocal rank (session centroids from the bare
question, LLM-expanded phrases, deterministic lexical variants, and turn-level
recall). So "add multi-channel retrieval" is not available as a measure.

What remained undecided was **how wide the candidate pool should be**. The
existing diagnostics report `recall@1` and `recall@5`, and that pair cannot
answer the question, because two very different effects are indistinguishable
at a single cutoff:

| Effect | What actually happened | Which measure fixes it |
| --- | --- | --- |
| **Breadth** | The evidence turn was never retrieved | Widen the pool |
| **Ordering** | The evidence was always in the pool, ranked too low | Rerank (measure B1) |

`recall@5` improves under either. Choosing a measure from it is a guess.

## 1. What the curve measures

At each cutoff `k`, over answerable questions only:

| Field | Meaning |
| --- | --- |
| `recalled` | Count whose first answer turn ranks below `k` |
| `recall` | `recalled / total` — what the bi-encoder's own ordering achieves |
| `ceiling` | Fraction whose answer is anywhere in the pool of width `poolWidth` |
| `gain` | `ceiling - recall` — the recall a perfect reranker could add with **no new retrieval** |

Two properties make this the right instrument:

- **`gain` isolates the reranker's headroom.** It is computed against a fixed
  pool, so it cannot be improved by retrieving more — only by ordering better.
  That makes it the number that justifies or refutes measure B1.
- **`ceiling` saturating is the stop signal for widening.** Past the `k` where
  `gain` reaches zero, every additional candidate is cost with no recall behind
  it.

### Worked example

A synthetic distribution (40 answers at rank 1, 25 at rank 3, 20 at rank 8,
10 at rank 16, 5 at rank 41, pool width 50):

```
k      recall   ceiling  gain
1      40.0%    100.0%   60.0%
3      65.0%    100.0%   35.0%
5      65.0%    100.0%   35.0%     <- widening 3 -> 5 buys nothing
10     85.0%    100.0%   15.0%     <- widening 5 -> 10 buys 20pp
20     95.0%    100.0%    5.0%
50    100.0%    100.0%    0.0%
```

The flat 3→5 segment and the steep 5→10 segment are exactly the discrimination
that `recall@1`/`recall@5` cannot express.

## 2. Design decisions

### 2.1 The ceiling is a property of the pool, not of the cutoff

`ceiling` is constant across `k` by construction. It answers "if a reranker could
reorder this pool perfectly, what is the most it could reach". A ceiling that
moved with `k` would make `gain` meaningless, because the reranker does not get
to choose its own cutoff.

### 2.2 `gain` is clamped at zero

When `poolWidth` is set narrower than a requested cutoff, achieved recall can
exceed the pool ceiling. A negative `gain` would read as "reranking hurts"; the
truthful statement is "the pool is too narrow to say anything". The clamp keeps
the number from asserting a conclusion the configuration cannot support.

### 2.3 An empty answer set is a miss, not a match

`rankOfFirstAnswer` returns `null` when the answer set is empty. An abstention
question has no `has_answer` turn; treating "no answer to find" as "found at rank
0" would score every such question as perfect retrieval and inflate every point.
An empty answer set is therefore excluded from the curve rather than counted as a
miss, which would drag every cutoff down by that question's share.

**An empty answer set is not always an abstention question, and the first version
of this document said it was.** The exclusion happens on one condition — no
answer text — but three different situations produce it, and only the first is
intended. `computeRecallCurve` now classifies each one and reports it:

| Reason | Meaning | Excluding it is... |
| --- | --- | --- |
| `abstention` | Correct answer is to refuse; no evidence turn exists | Correct, and the point of the rule |
| `derived` | Answerable, but its answer is a value *computed* from the evidence ("four", "25 minutes and 50 seconds", `$400,000`) so no single turn carries it verbatim | A real answerable question removed from the denominator, which caps how far the ceiling generalises |
| `no-flag` | Answerable, but no turn was ever marked `has_answer` | A silent measurement loss and a data/loader problem |

The measurement that exposed this is in §4.1: a run over **500** questions
produced a curve with a denominator of **428**. The missing 72 are answerable KU
questions whose answers are derived values, and neither the artifact nor this
document said so — `ceiling` sat beside an accuracy measured over 500 as though
the two shared a population. The artifact now carries `considered` and
`excluded[]`, the job summary states both, and the console line prints the
per-reason breakdown.

### 2.4 The measurement uses the graded path's retrieval, including expansion

`computeRecallCurve` calls the same `retrieveTopKByQueries` the graded path uses
and expands queries through the shared `expandDiagnosticQueries`. A diagnostic
that measured bare-question retrieval while the graded path expands would report
a ceiling for a different pipeline — the number would be internally consistent
and externally wrong.

Assistant turns are filtered before retrieval, mirroring the graded path: an
assistant turn is never a candidate, so measuring a pool that included them would
describe a retrieval the pipeline does not perform.

## 3. Pre-registered reading

Fixed before the measurement runs, so the result cannot be reinterpreted after
the fact.

| Observation | Conclusion | Action |
| --- | --- | --- |
| `gain` large at the current pool, `ceiling` flat beyond it | Ordering is the bottleneck, breadth is not | Execute B1's A/B; do **not** widen the pool |
| `ceiling` still climbing at the widest cutoff | Genuine recall headroom exists | Widen `rerankCandidatePool`; re-measure |
| `gain ≈ 0` and `ceiling` flat everywhere | Neither breadth nor ordering is the bottleneck | Stop; the constraint is elsewhere (context admission, or the reader) — see `cortex-docs/docs/08-reader-parity-analysis.md` |

**Falsification condition.** If widening the pool moves `ceiling` but not `gain`,
the pool is not the constraint and the widening must not be kept. If `gain` is
large everywhere yet the pre-registered B1 A/B shows no accuracy movement, then
retrieval ordering does not propagate to answers, and both directions close.

## 4. Status

| Item | Status |
| --- | --- |
| `buildRecallCurve` (pure arithmetic) | Implemented, tested |
| `rankOfFirstAnswer` | Implemented, tested |
| `computeRecallCurve` (measurement) | Implemented, tested |
| `classifyExclusion` (shortfall reporting) | Implemented, tested |
| CLI emission (`benchmark-recall-curve.json`) | Wired, carries `considered` + `excluded[]` |
| Job-summary rendering of the denominator | Wired |
| Coverage, all four dimensions | 100 / 97.05 / 100 / 100 |
| **Smoke measurement** | Run `35498421148`, `LIMIT=60`, `DIAGNOSTICS_LIMIT=100`, 43 answerable |
| **Full measurement** | Run `35523328949`, `LIMIT=0`, `DIAGNOSTICS_LIMIT=0`, 428 answerable of 500 |

### 4.1 The measurement

Two measurements exist. The first is the capped smoke run that set the shape; the
second is the full 500-question run that closed B2.

**Smoke run `35498421148`** (commit `16ca1ea`), `LIMIT=60`,
`DIAGNOSTICS_LIMIT=100`, 43 answerable questions:

| k | recalled | recall | ceiling | gain |
| --- | --- | --- | --- | --- |
| 1 | 12 | 27.91% | 93.02% | 65.12% |
| 3 | 24 | 55.81% | 93.02% | 37.21% |
| 5 | 27 | 62.79% | 93.02% | 30.23% |
| 10 | 33 | 76.74% | 93.02% | 16.28% |
| 20 | 39 | 90.70% | 93.02% | 2.33% |
| 50 | 40 | 93.02% | 93.02% | 0.00% |

**Full run `35523328949`** (commit `a7e846d`), `LIMIT=0`, `DIAGNOSTICS_LIMIT=0`,
DeepSeek + Zhipu GLM embedding-3, temperature 0. Denominator **428 of 500**:

| k | recalled | recall | ceiling | gain |
| --- | --- | --- | --- | --- |
| 1 | 142 | 33.18% | 96.26% | 63.08% |
| 3 | 242 | 56.54% | 96.26% | 39.72% |
| 5 | 289 | 67.52% | 96.26% | 28.74% |
| 10 | 340 | 79.44% | 96.26% | 16.82% |
| 20 | 384 | 89.72% | 96.26% | 6.54% |
| 50 | 412 | 96.26% | 96.26% | 0.00% |

The denominator is confirmed by `benchmark-diagnostics.json`, which reports
`totalQuestions: 500` and `answerableQuestions: 428` in the same run.

### 4.2 Reading, against the pre-registered table in §3

The observed shape is **`gain` large at the current pool with `ceiling` flat
beyond it** — row 1. The pre-registered action is therefore: execute B1's A/B,
and **do not widen the pool.**

Three facts worth stating separately, all read from the full run:

1. **`ceiling` = 96.26% of 428 answerable questions.** 412 have their answer turn
   inside the pool. The other 16 (3.74%) are unreachable by any reordering, so
   that is an honest floor no reranker can touch.
2. **`gain` decays from 63.08% at `k=1` to 6.54% by `k=20`.** The headroom B1
   could occupy is large only where the context window is narrow relative to the
   answer's rank. At the system's working width it has mostly been absorbed by
   width itself. Note that `gain` has **not** reached zero at `k=20` — the
   difference between the smoke run's 2.33% and the full run's 6.54% is the
   sample, not a change in the pipeline, and only the full-run number should be
   quoted.
3. **Cortex has no breadth problem at usable widths.** This closes the direction
   that "add recall channels" proposals would reopen. Any such proposal now has
   to justify itself against the remaining 3.74%, not against `recall@5`, which
   is a cutoff and not a ceiling.

This is exactly why the pre-registration mattered. Read alone, `recall@5 =
62.79%` on the smoke sample looks like a pipeline missing a third of its
evidence and would justify either remedy. The curve shows both the ceiling (so
the evidence is there) and where the ordering debt actually sits (at `k<=10`, not
at the working width).

> **Denominator caution, now partially retired.** The earlier version of this
> section warned that the numbers came from a 60-question sample and could not be
> quoted externally. That is true of the smoke table above and no longer true of
> the full-run table, which is over 428 answerable questions. What survives is a
> narrower caution: **the full-run ceiling is over 428, not the run's 500**, so
> it is not directly comparable to `benchmark-report.json`'s accuracy. The 72
> excluded are answerable KU questions with derived answers (§2.3), and the
> ceiling therefore says nothing about whether *their* evidence would have been
> retrievable. Whether that gap is worth closing is open.

### 4.3 What remains unknown

- **No accuracy claim.** The curve is a retrieval diagnostic; it says nothing
  about what the reader does with the evidence. B1's A/B is the measurement that
  connects ordering to accuracy, and it is not yet run.
- **The `k=1` headroom is an upper bound, not a forecast.** `gain = 63.08%` at
  `k=1` is what a *perfect* reordering would reach. A real cross-encoder will
  capture some fraction of it, and the A/B exists to measure that fraction rather
  than assume it.
- **What the 72 excluded questions would have contributed.** They are answerable
  and the grader scores them; the curve does not see them. A ceiling quoted over
  428 is silent on whether their evidence was retrievable, so any future claim
  about "KU retrieval" has to be measured separately rather than inferred from
  this curve.

## 5. Why this is not just "more diagnostics"

The existing diagnostics were built to pick an abstention threshold — a
different question, answered by the score distribution of hits and misses. This
instrument is built to choose between two *different* remedies for the same
symptom, and its output is a decision, not a description. It was added because
without it the roadmap's B1 and B2 measures could not be told apart: both were
justified by "recall is not 100%", which is true of every retrieval pipeline
ever built and therefore justifies nothing.
