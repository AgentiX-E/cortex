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
| Abstention | calibrated confidence threshold | temperature/Platt scaling |
| Retrieval-as-consolidation | Hebbian + FSRS + TD(λ) | significance-gated edge updates |
| Cross-layer distillation | entropy-regularized optimal transport | Sinkhorn-Knopp |
| Temporal reasoning | bitemporal facts | valid time + system time |
| Contradiction resolution | Bayesian evidence fusion | source-trust-weighted log-odds |
| Similarity | cosine / L2 (Kahan) | Float64 |
| Multi-hop retrieval | spreading activation | self-implemented associative adjacency list |
| Associative graph | Hebbian edges + BFS | self-implemented (Float64, zero deps) |

## Dependencies

| Concern | Choice | Rationale |
|---|---|---|
| Linear algebra | `ml-matrix` | pure JS, Float64, Jacobi SVD, dual-environment |
| Graph | self-implemented adjacency list | core cognitive algorithm; full precision + determinism |
| Embedded storage | `better-sqlite3` | sync, fast, mature, extension-capable |
| Remote storage | `pg` | standard PostgreSQL client |
| Local embeddings | `@xenova/transformers` (optional) | offline, browser + Node |

See `packages/*/README.md` and the internal design docs for details.
