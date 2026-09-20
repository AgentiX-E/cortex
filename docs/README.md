# Cortex — Internal Design Documents

This directory holds Cortex's internal design and audit records. Per repository
convention, **all content here is English**; user-facing documentation lives in
[`AgentiX-E/cortex-docs`](https://github.com/AgentiX-E/cortex-docs).

| Document | Purpose |
| --- | --- |
| [`AUDIT-CODE-VS-DOCS.md`](AUDIT-CODE-VS-DOCS.md) | Code-vs-documentation reconciliation: what the repository actually does, measured at a named revision, plus the wiring gap and its ordered closure plan |
| [`MEASURE-B1-RERANKING.md`](MEASURE-B1-RERANKING.md) | Implementation record for the cross-encoder reranking stage, including the three roadmap premises the code refuted and the wiring bug it found |
| [`MEASURE-B2-RECALL-CURVE.md`](MEASURE-B2-RECALL-CURVE.md) | The recall-curve instrument that separates retrieval breadth from retrieval ordering, its first real LongMemEval-S measurement, and the pre-registered reading that decides candidate-pool width |
| [`FIX-CONJUNCTION-GUARD-BLAST-RADIUS.md`](FIX-CONJUNCTION-GUARD-BLAST-RADIUS.md) | A defect found by running the benchmark: a correct pre-flight guard placed after the work it protects, which discarded every completed report when it fired |
| [`FIX-COHORT-COVERAGE-SIDE-CHANNEL.md`](FIX-COHORT-COVERAGE-SIDE-CHANNEL.md) | The defect the previous fix introduced: coverage returned *beside* the report instead of *inside* it, so a 1-of-7 cohort rendered as an ordinary result with no caveat |
| [`FIX-REPORT-JSON-ROUNDTRIP.md`](FIX-REPORT-JSON-ROUNDTRIP.md) | `JSON.stringify` turns `NaN`/`±Infinity` into `null`, so a report that rendered correctly when produced threw when re-read from the archived artifact — found by re-rendering real output, not by reading code |
| [`AUDIT-PERSISTED-NULLS.md`](AUDIT-PERSISTED-NULLS.md) | The class audit that closes the last declared gap: every archived artifact checked for the same substitution, with the nulls that are *values* (an abstention) separated from the nulls that are *losses* — and a re-runnable instrument so the next occurrence is found by a command, not by a reader |
| [`FIX-COVERAGE-GATE-NOISE.md`](FIX-COVERAGE-GATE-NOISE.md) | The measurement layer: the coverage gate reported three different results in six identical runs. Root-caused to non-deterministic v8 handling of `c8 ignore` guards, quantified, and bounded — the threshold was deliberately **not** widened to absorb it |
| [`OPS-UNFETCHABLE-ARTIFACT.md`](OPS-UNFETCHABLE-ARTIFACT.md) | A green run whose artifact and logs were both unreachable (`sa16` returns `AccountNotFound`), the control experiment that separated it from a permission or DNS problem, and the second sink added so the numbers cannot be lost that way again |
| [`../ARCHITECTURE.md`](../ARCHITECTURE.md) | Layering, invariants, key algorithms, implementation status |
| [`../SOTA-BASELINE.md`](../SOTA-BASELINE.md) | Frozen LongMemEval-S baseline (historical anchor, with a staleness note) |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | Engineering standards: ≥95% coverage per dimension, TDD, no mocks |

## Reading order for a new contributor

1. `../README.md` — what the product is, and what it currently is **not**.
2. `AUDIT-CODE-VS-DOCS.md` — which parts are proven, which are aspirational, and why.
3. `../ARCHITECTURE.md` — the design those parts implement.

## Why an audit document is tracked here

Documentation drift is not self-announcing. A capability list can stay constant while the
implementation behind it quietly stops being reachable, and nothing in the test suite would
notice — the tests exercise the modules, so they keep passing. This document exists so that the
claim "the cognitive layer is implemented" and the claim "the cognitive layer is what runs"
remain separable, with evidence attached to each.
