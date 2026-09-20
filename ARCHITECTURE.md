# Cortex Architecture

High-level architecture of the Cortex agent memory layer.

## Layering

Cortex follows a strict dependency-inversion layout modeled on `entity-resolver`:

```
cortex-core (contracts + pure algorithms, zero I/O, Node + browser)
  ├── interfaces/    Storage · VectorIndex · LLM · EmbeddingModel
  ├── domain/        MemoryValue · Fact (bitemporal) · ProvenanceNode
  ├── math/          vector · stats · optimal-transport · fsrs
  ├── graph/         associative MemoryGraph (Hebbian + spreading activation)
  ├── value/         value-driven write & abstention decisions
  ├── temporal/      bitemporal fact queries
  ├── contradiction/ Bayesian evidence fusion
  └── consolidation/ retrieval-as-consolidation orchestration

cortex-node (Node.js backends)
  └── storage/       SqliteStorage (better-sqlite3) · PgStorage (PostgreSQL)

cortex-llm (pluggable adapters)
  ├── llm/           OpenAICompatibleLLM
  └── embedding/     OpenAIEmbedding · TransformersEmbedding (optional)
```

## Design Principles

1. **Contracts only in core.** Every backend (storage, vector, LLM, embedding) is an
   interface consumed by `cortex-core`; concrete engines live in `cortex-node` /
   `cortex-llm`. This keeps core browser-safe and environment-agnostic.

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
| `decideWrite` / `decideRetrieval` / `defaultValueFunction` | Implemented, tested, **not on the eval path** | The bench is served by `cortex-eval`'s own memory implementation |
| Hebbian graph (`MemoryGraph`) | Implemented, tested, **not on the eval path** | Graph recall was trialled for temporal questions and reverted (see below) |
| FSRS (`retrievability` / `review`) | Implemented, tested, **not on the eval path** | Used by `consolidate` only |
| Bitemporal facts | Implemented, tested, **not on the eval path** | — |
| Contradiction resolution | Implemented, tested, **not on the eval path** | — |
| TD(λ) credit assignment | **Not implemented** | No eligibility traces exist in the codebase |
| Optimal-transport distillation | **Implemented but inert** | `sinkhorn` is exported; nothing calls it |
| Abstention confidence calibration (Platt / temperature) | **Not implemented** | Thresholds are fixed constants |
| Cross-encoder reranking (`rerankHits` / `fuseRerank`) | **Implemented, wired, off by default** | On both retrieval paths of the eval pipeline; enabled via `CORTEX_RERANK`. See [`docs/MEASURE-B1-RERANKING.md`](docs/MEASURE-B1-RERANKING.md) |
| Recall-curve diagnostic (`buildRecallCurve` / `computeRecallCurve`) | **Implemented, wired, measured** | Separates breadth from ordering; emits `benchmark-recall-curve.json`. First LongMemEval-S reading: ceiling 93.02%, gain 65.12%→2.33% across k=1→20. See [`docs/MEASURE-B2-RECALL-CURVE.md`](docs/MEASURE-B2-RECALL-CURVE.md) |

Two consequences worth stating explicitly:

1. The published LongMemEval-S figure is produced by `cortex-eval`, which imports only
   statistics helpers and `BruteForceVectorIndex` from `cortex-core`. `cortex-core` is a
   validated algorithm library, not the system under measurement. See
   [`docs/AUDIT-CODE-VS-DOCS.md`](docs/AUDIT-CODE-VS-DOCS.md) §1 for the call-site evidence.
2. Spreading-activation graph recall **was** wired into the temporal recall path (`1ce76aa`)
   and then removed on measurement: temporal accuracy fell 77.95% → 70.87% (Δ −7.09pp,
   15 questions broken against 6 repaired, one-sided exact McNemar p = 0.039; `7780071`).
   It is closed, not pending.

The root cause of (1) is a missing package, not a missing algorithm: nothing composes the
cognitive layer into a runnable system. `docs/AUDIT-CODE-VS-DOCS.md` §6 specifies the required
`cortex-memory` seam, the dependency direction that keeps `cortex-eval` an instrument rather than
a participant, and the ordered work that closes the gap.

## Dependencies

| Concern | Choice | Rationale |
|---|---|---|
| Linear algebra | `ml-matrix` | pure JS, Float64, Jacobi SVD, dual-environment |
| Graph | self-implemented adjacency list | core cognitive algorithm; full precision + determinism |
| Embedded storage | `better-sqlite3` | sync, fast, mature, extension-capable |
| Remote storage | `pg` | standard PostgreSQL client |
| Local embeddings | `@xenova/transformers` (optional) | offline, browser + Node |

See `packages/*/README.md` and the internal design docs for details.
