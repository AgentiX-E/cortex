# Cortex — Internal Design Documents

This directory holds Cortex's internal design and audit records. Per repository
convention, **all content here is English**; user-facing documentation lives in
[`AgentiX-E/cortex-docs`](https://github.com/AgentiX-E/cortex-docs).

| Document | Purpose |
| --- | --- |
| [`AUDIT-CODE-VS-DOCS.md`](AUDIT-CODE-VS-DOCS.md) | Code-vs-documentation reconciliation: what the repository actually does, measured at a named revision, plus the wiring gap and its ordered closure plan |
| [`MEASURE-B1-RERANKING.md`](MEASURE-B1-RERANKING.md) | Implementation record for the cross-encoder reranking stage, including the three roadmap premises the code refuted and the wiring bug it found |
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
