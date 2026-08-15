# Cortex

**A value-driven cognitive memory layer for AI agents — for Node.js and the browser.**

Cortex is not another vector database. It is the "brain" of agent memory: it decides
**what to remember, when to remember, when to forget, when to stay silent, and how to
resolve contradictions** — while ordinary storage-and-retrieval concerns are delegated
to pluggable backends.

```
npm install @agentix-e/cortex-core @agentix-e/cortex-node
```

## Why Cortex

Most memory systems solve the "external hard drive" problem (store embeddings, retrieve
by similarity). Cortex solves the "mind" problem:

- **Value-driven memory** — decide what is worth remembering by estimated future
  utility, not raw similarity.
- **Abstention** — refuse to answer when no memory is reliable enough (calibrated
  confidence), instead of forcing a top-k result.
- **Asynchronous consolidation** — a background "sleep" process distills episodic
  memories into semantic knowledge using Hebbian dynamics, an FSRS forgetting curve,
  and entropy-regularized optimal transport.
- **Retrieval-as-consolidation** — every retrieval strengthens what it touches and
  credits success/failure back to the responsible memories (TD(λ)).
- **Bitemporal facts** — every fact carries *valid time* and *system time*, making
  knowledge update, contradiction resolution, and audit native.
- **Provenance & trust** — every memory records its source, trust, and derivation
  history for poisoning defense and GDPR erasure.

## Packages

| Package | Role |
|---|---|
| `@agentix-e/cortex-core` | Contracts + pure algorithms, zero I/O, Node + browser |
| `@agentix-e/cortex-node` | Embedded SQLite (`better-sqlite3`) and remote PostgreSQL backends |
| `@agentix-e/cortex-llm` | Pluggable LLM and embedding adapters (OpenAI-compatible + local transformers.js) |

## Quick Start

```ts
import {
  BruteForceVectorIndex,
  MemoryGraph,
  decideWrite,
  decideRetrieval,
  defaultValueFunction,
} from '@agentix-e/cortex-core';
import { SqliteStorage } from '@agentix-e/cortex-node';

// 1. Pluggable storage (embedded SQLite).
const storage = new SqliteStorage({ filename: ':memory:' });

// 2. Vector index for similarity search.
const index = new BruteForceVectorIndex();

// 3. Associative memory graph for multi-hop retrieval.
const graph = new MemoryGraph();

// 4. Value-driven write decision.
const candidate = { /* a candidate memory */ };
const decision = decideWrite(candidate, defaultValueFunction, 0.5);
if (decision.write) {
  await storage.put('memories', candidate.id, candidate);
}

// 5. Abstention-aware retrieval.
const retrieved = await index.search(embedding, 10);
const answer = decideRetrieval(retrieved, defaultValueFunction, 0.5);
if (!answer.retrieve) {
  // Stay silent instead of hallucinating.
}
```

## Requirements

- Node.js >= 22
- pnpm >= 9

## License

MIT
