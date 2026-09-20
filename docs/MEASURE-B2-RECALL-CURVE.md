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
Abstention questions are excluded from the curve entirely, because they carry no
retrieval signal and would otherwise be scored as misses, dragging every cutoff
down by their share.

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
| CLI emission (`benchmark-recall-curve.json`) | Wired |
| Coverage, all four dimensions | 100 / 97.05 / 100 / 100 |
| **Actual measurement on LongMemEval-S** | **Run** — run `35498421148`, `LIMIT=60`, 43 answerable questions |

### 4.1 The measurement

Run `35498421148` (commit `16ca1ea`), DeepSeek + Zhipu GLM embedding-3,
temperature 0, `DIAGNOSTICS_LIMIT=100`:

| k | recalled | recall | ceiling | gain |
| --- | --- | --- | --- | --- |
| 1 | 12 | 27.91% | 93.02% | 65.12% |
| 3 | 24 | 55.81% | 93.02% | 37.21% |
| 5 | 27 | 62.79% | 93.02% | 30.23% |
| 10 | 33 | 76.74% | 93.02% | 16.28% |
| 20 | 39 | 90.70% | 93.02% | 2.33% |
| 50 | 40 | 93.02% | 93.02% | 0.00% |

### 4.2 Reading, against the pre-registered table in §3

The observed shape is **`gain` large at the current pool with `ceiling` flat
beyond it** — row 1. The pre-registered action is therefore: execute B1's A/B,
and **do not widen the pool.**

Three facts worth stating separately:

1. **`ceiling` = 93.02% of 43 answerable questions.** 40 have their answer turn
   inside the pool. The other 3 (6.98%) are unreachable by any reordering, so
   that is an honest floor no reranker can touch.
2. **`gain` decays from 65.12% at `k=1` to 2.33% by `k=20`.** The headroom B1
   could occupy is large only where the context window is narrow relative to the
   answer's rank. At the system's working width it has mostly been absorbed by
   width itself.
3. **Cortex has no breadth problem at usable widths.** This closes the direction
   that "add recall channels" proposals would reopen. Any such proposal now has
   to justify itself against the remaining 6.98%, not against `recall@5 = 86%`,
   which is a cutoff and not a ceiling.

This is exactly why the pre-registration mattered. Read alone, `recall@5 =
62.79%` looks like a pipeline missing a third of its evidence and would justify
either remedy. The curve shows both the ceiling (93.02%, so the evidence is
there) and where the ordering debt actually sits (at `k<=10`, not at the working
width).

> **Denominator caution.** 60-question stratified sample, not the full 500. The
> three unreachable questions are 6.98% of 43 and move in ~2.3pp steps on a
> different sample. The *shape* — steep `gain` decay, flat `ceiling` — is robust
> at this resolution; the specific `ceiling` is not, and should be re-read from a
> `LIMIT=0` run before being quoted externally.

### 4.3 What remains unknown

- **No accuracy claim.** The curve is a retrieval diagnostic; it says nothing
  about what the reader does with the evidence. B1's A/B is the measurement that
  connects ordering to accuracy, and it is not yet run.
- **The `k=1` headroom is an upper bound, not a forecast.** `gain = 65.12%` at
  `k=1` is what a *perfect* reordering would reach. A real cross-encoder will
  capture some fraction of it, and the A/B exists to measure that fraction rather
  than assume it.

## 5. Why this is not just "more diagnostics"

The existing diagnostics were built to pick an abstention threshold — a
different question, answered by the score distribution of hits and misses. This
instrument is built to choose between two *different* remedies for the same
symptom, and its output is a decision, not a description. It was added because
without it the roadmap's B1 and B2 measures could not be told apart: both were
justified by "recall is not 100%", which is true of every retrieval pipeline
ever built and therefore justifies nothing.
