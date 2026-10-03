# Cortex Architecture

High-level architecture of the Cortex agent memory layer.

## Layering

Cortex follows a strict dependency-inversion layout modeled on `entity-resolver`:

```
cortex-core (contracts + pure algorithms, zero I/O, Node + browser)
  ├── interfaces/    Storage · VectorIndex · LLM · EmbeddingModel
  ├── domain/        MemoryValue · Fact (bitemporal)
  ├── math/          vector · stats · optimal-transport · fsrs
  ├── graph/         associative MemoryGraph (Hebbian + spreading activation)
  ├── value/         value-driven write & abstention decisions
  ├── temporal/      bitemporal fact queries
  ├── contradiction/ Bayesian evidence fusion
  └── consolidation/ retrieval-as-consolidation orchestration

cortex-memory (the composition layer: cortex-core's gates -> one MemorySystem)
  ├── admission      value-gated write admission (first caller of decideWrite)
  ├── sessionize     per-session admission + turn-budget selection
  ├── prompt         one builder parameterised by an answer contract
  ├── parse          raw model output -> Answer (null is an abstention)
  └── memory         CortexMemory: the only async module

cortex-node (Node.js backends)
  └── storage/       SqliteStorage (better-sqlite3) · PgStorage (PostgreSQL)

cortex-llm (pluggable adapters)
  ├── llm/           OpenAICompatibleLLM
  └── embedding/     OpenAIEmbedding · TransformersEmbedding (optional)
```

## Design Principles

1. **Contracts only in core.** Every backend (storage, vector, LLM, embedding) is an
   interface consumed by `cortex-core`; concrete engines live in `cortex-node` /
   `cortex-llm`. This keeps core browser-safe and environment-agnostic. The
   *composition* of those contracts into a runnable system lives in `cortex-memory`,
   which depends on none of the concrete engines.

2. **Float64 everywhere.** Vectors are `Float64Array`; statistics use Kahan summation
   and Welford variance; SVD/eigendecomposition use `ml-matrix` (float64). No float32
   truncation leaks into the cognitive layer.

3. **Pluggable storage.** The `Storage` contract is table-oriented KV. Implementations:
   - embedded SQLite (`better-sqlite3`, WAL mode, JSON values, TTL);
   - remote PostgreSQL (JSONB + GIN-indexed tags);
   - browser (SQLite WASM / IndexedDB — planned).

4. **Embedded-first, remote-scalable.** Cortex never requires an external service or
   process; `better-sqlite3` + brute-force/SQL vector search works offline, while
   PostgreSQL/pgvector provides the scale-out path.

5. **Scientific correctness.** Every benchmark comparison uses Welch's t-test (p < 0.05)
   and ablation; no single-run "lucky" result is accepted.

## Key Algorithms

| Capability | Algorithm | Notes |
|---|---|---|
| Value-driven write | utility threshold (VoI) | replaceable with learned MDP utility |
| Abstention | calibrated confidence threshold | temperature/Platt scaling **not yet implemented** |
| Retrieval-as-consolidation | Hebbian + FSRS (**no TD(λ)**) | significance-gated edge updates |
| Cross-layer distillation | entropy-regularized optimal transport | **implemented in `math/ot.ts`, currently uncalled** |
| Temporal reasoning | bitemporal facts | valid time + system time |
| Contradiction resolution | Bayesian evidence fusion | source-trust-weighted log-odds |
| Similarity | cosine / L2 (Kahan) | Float64 |
| Multi-hop retrieval | spreading activation | self-implemented associative adjacency list |
| Associative graph | Hebbian edges + BFS | self-implemented (Float64, zero deps) |

## Implementation status

Not every algorithm above is on the evaluation path. This section states plainly which
capabilities are load-bearing today, so no reader infers more coverage than exists.

| Capability | Status | Note |
|---|---|---|
| `decideWrite` / `decideRetrieval` / `defaultValueFunction` | Implemented, tested, **now composed and armed** | `cortex-memory` is their first production caller; `cortex-eval`'s own implementation remains the control arm. The pre-registered A/B that measures whether the gated composition *helps* is assembled and awaiting dispatch — see [`docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md`](docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md) |
| Hebbian graph (`MemoryGraph`) | Implemented, tested, **not on the eval path** | Graph recall was trialled for temporal questions and reverted (see below) |
| FSRS (`retrievability` / `review`) | Implemented, tested, **reached through `consolidate`** | `consolidate` still has no caller, so FSRS is reachable only transitively. Stability is in **days** and elapsed time in milliseconds; the two were once both milliseconds, which made `consolidate`'s defaults delete every memory on the first run. See [`docs/AUDIT-CONSOLIDATION-CLOCK.md`](docs/AUDIT-CONSOLIDATION-CLOCK.md) |
| Bitemporal facts | Implemented, tested, **now composed** | Backs `cortex-memory`'s `answerKnowledgeUpdate`, where a previous-vs-current question is a bitemporal query |
| Contradiction resolution | Implemented, tested, **not on the eval path** | — |
| TD(λ) credit assignment | **Not implemented** | No eligibility traces exist in the codebase |
| Optimal-transport distillation | **Implemented but inert** | `sinkhorn` is exported; nothing calls it |
| Fact derivation (provenance DAG) | **Not implemented** | `Fact` records origin (`source`), trust and both time axes, so origin, dual-clock timing and as-of reconstruction **are** delivered. What is missing is the *edge*: a fact derived from three retrieved memories is indistinguishable from one asserted directly, except by its `source` string. A speculative `ProvenanceNode` type once stood in for this and read no code; it was deleted rather than kept as a shape without a graph. The remedy is a `derivedFrom?: string[]` field on `Fact`, not a parallel table. See [`docs/DECISION-PROVENANCE-NODE.md`](docs/DECISION-PROVENANCE-NODE.md) |
| Abstention confidence calibration (Platt / temperature) | **Not implemented** | Thresholds are fixed constants |
| Cross-encoder reranking (`rerankHits` / `fuseRerank`) | **Implemented, wired, off by default** | On both retrieval paths of the eval pipeline; enabled via `CORTEX_RERANK`. See [`docs/MEASURE-B1-RERANKING.md`](docs/MEASURE-B1-RERANKING.md) |
| Recall-curve diagnostic (`buildRecallCurve` / `computeRecallCurve`) | **Implemented, wired, measured** | Separates breadth from ordering; emits `benchmark-recall-curve.json`. First LongMemEval-S reading: ceiling 93.02%, gain 65.12%→2.33% across k=1→20. See [`docs/MEASURE-B2-RECALL-CURVE.md`](docs/MEASURE-B2-RECALL-CURVE.md) |
| Persisted-report re-rendering (`formatAblationReport`) | **Implemented, round-trip safe** | A report read back from `benchmark-*.json` renders identically to the one held in memory; `null` (the JSON form of `NaN`/`±Infinity`) is labelled, never numbered. See [`docs/FIX-REPORT-JSON-ROUNDTRIP.md`](docs/FIX-REPORT-JSON-ROUNDTRIP.md) |

Two consequences worth stating explicitly:

1. The published LongMemEval-S figure is produced by `cortex-eval`, which imports only
   statistics helpers and `BruteForceVectorIndex` from `cortex-core`. `cortex-core` is a
   validated algorithm library, not the system under measurement. See
   [`docs/AUDIT-CODE-VS-DOCS.md`](docs/AUDIT-CODE-VS-DOCS.md) §1 for the call-site evidence.
2. Spreading-activation graph recall **was** wired into the temporal recall path (`1ce76aa`)
   and then removed on measurement: temporal accuracy fell 77.95% → 70.87% (Δ −7.09pp,
   15 questions broken against 6 repaired, one-sided exact McNemar p = 0.039; `7780071`).
   It is closed, not pending.

The root cause of (1) was a missing package, not a missing algorithm: nothing composed the
cognitive layer into a runnable system. **That package now exists** (`cortex-memory`, 129 tests,
100/100/100/100 coverage, passing `cortex-eval`'s `MemorySystem` conformance suite unmodified),
so the cognitive layer is reachable. It is now also **assembled into a measurable arm**: the
pre-registered A/B in [`docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md`](docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md)
puts it against `cortex-eval`'s reference pipeline in one paired `runAblationReport` call, and
the dispatch is the remaining step. It is still not *measured* — a pre-registration is a
prediction, not a result.

The arm needed one structural decision, because it is the first in the repository whose two
sides are different systems. The assembly (`bench-memory-arm.ts`) lives in `cortex-eval/src/`
and is handed both systems already constructed; the entry point that can see both packages lives
in `cortex-memory/bench/`. **The dependency edge is unchanged** — `cortex-memory` still imports
`cortex-eval` as a type-only devDependency and `cortex-eval` still cannot see the product — which
is what keeps the harness an instrument rather than a participant, and the arm's suite asserts
that no such dependency is declared.

## Dependencies

| Concern | Choice | Rationale |
|---|---|---|
| Linear algebra | `ml-matrix` | pure JS, Float64, Jacobi SVD, dual-environment |
| Graph | self-implemented adjacency list | core cognitive algorithm; full precision + determinism |
| Embedded storage | `better-sqlite3` | sync, fast, mature, extension-capable |
| Remote storage | `pg` | standard PostgreSQL client |
| Local embeddings | `@xenova/transformers` (optional) | offline, browser + Node |

See `packages/*/README.md` and the internal design docs for details.
