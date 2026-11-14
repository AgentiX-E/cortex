# Cortex

**A value-driven cognitive memory layer for AI agents — for Node.js and the browser.**

Cortex is not another vector database. It is the "brain" of agent memory: it decides
**what to remember, when to remember, when to forget, when to stay silent, and how to
resolve contradictions** — while ordinary storage-and-retrieval concerns are delegated
to pluggable backends.

```
npm install @agentix-e/cortex-core @agentix-e/cortex-storage
```

`cortex-storage` ships one subpath per backend, so a build only links what it uses:
`@agentix-e/cortex-storage/sqlite` or `@agentix-e/cortex-storage/pg`. Both backends are
**optional peers** — install the one you import. The package root exports nothing on purpose;
`tools/entry-guard.mjs` fails the build if a native module ever becomes reachable from it.

## Why Cortex

Most memory systems solve the "external hard drive" problem (store embeddings, retrieve
by similarity). Cortex solves the "mind" problem.

**Every bullet below carries a status tag, because the honest answer differs per bullet and a
list that reads uniformly at full strength is the one thing this file must not be.**

| tag | means |
|---|---|
| **live** | on the measured path: an edit to it changes a published artifact byte for byte |
| **library** | implemented and unit-tested in `cortex-core`, with **no product caller** |
| **absent** | a contract, a design, or nothing at all |

- **Value-driven memory** *(gate live, benefit unproven)* — decide what is worth remembering by
  estimated future utility, not raw similarity. `cortex-memory` calls `decideWrite` on every
  candidate turn, and `CortexMemory.admissionCensus()` now reports whether the threshold cut
  anything — `rejected` is the count it refused. Whether the cut **helps** is what the A/B has
  not established; a pre-registration is a prediction, not a result.
- **Abstention** *(live)* — refuse to answer when no memory is reliable enough instead of forcing
  a top-k result. Measured at 29.25/30 on LongMemEval-S's abstention questions; where the decline
  originates is recorded per reason (`empty` / `threshold` / `llm` / `answered`), because a
  decline the model chose and a decline the gate forced are different findings.
- **Asynchronous consolidation** *(absent, and declined rather than pending)* — `consolidate` is
  the "sleep" process: an FSRS review per access, Hebbian strengthening on co-activation, and a
  cull of everything below a retrievability threshold. It has **zero callers** in either package,
  and `docs/DECISION-SEMANTIC-LAYER-ROUTE.md` §6.2 declines to add one, with the arithmetic: a
  store carries a single clock, so the elapsed time the cull measures is `0` for every entry and
  `retrievability(0, 1) = 1` against a threshold four and a half stable intervals away; the FSRS
  state it writes has no reader in the product (`.stability` occurs zero times in
  `cortex-memory/src`, and `semantic-reach.test.ts` now asserts that); and forgetting an entry
  because time passed is what the `not-later` guard exists to prevent. The mechanism is reachable,
  tested at 100% coverage, and safe to call — `now` is a required argument, because it used to
  read `Date.now()` while aging entries stamped by the caller's clock.
- **Retrieval-as-consolidation** *(absent)* — TD(λ) credit assignment is not implemented; no
  eligibility traces exist in the codebase.
- **Bitemporal facts** *(live on the harness path, library for the product)* — `cortex-core`'s
  `Fact` carries *valid time* and *system time* and is unit-tested, but has **no constructor** in
  either package. What answers the knowledge-update questions is the evaluation harness's own
  `(subject, predicate, object, date)` fact store driving `answerKnowledgeUpdate`, which is a
  different implementation of the same idea. This is why the capability scores and the type is
  still a contract with no caller.
- **Provenance & trust** *(live)* — every memory records its `source` and `sourceTrust`, and
  every fact carries both time axes, so origin and supersession are auditable. **Derivation
  history is not recorded on `Fact`**: `KnowledgeFact.references` *is* the derivation edge and
  `revision.ts` cascades over it, but nothing constructs a `KnowledgeFact` on a product path.

> **Status.** `cortex-core` is a validated library of cognitive contracts and pure
> algorithms: fully unit-tested, ≥95% coverage on all four dimensions. It is *not* the engine
> behind our published LongMemEval-S number — the evaluation harness drives its own memory
> implementation and consumes statistics helpers and one vector index from core.
> **`cortex-memory` composes core's value gates into a runnable `MemorySystem`**, passing the
> harness's conformance suite unmodified, so the cognitive layer is *reachable*. Two of its
> layers are measurable today and one is not:
>
> - its **prompt contract** is live in every published run — `instructionsFor` chooses the block
>   and an edit to it shows up byte-for-byte in the artifact (94 of 94 reachable `MR` prompts,
>   run `42337560027`);
> - its **gate** is live and now **observable** — `admissionCensus()` reports candidates,
>   admitted, rejected, the value range and a distinct count, so an artifact can state that a
>   configured threshold did or did not decide anything. Run `37110579101` is the case for it:
>   `retrievalThreshold: 0` could not close a gate whose maximum observable value was `0.5`, so
>   the repaired program scored what the unrepaired one did;
> - its **benefit** is unmeasured. Two pre-registered A/B pairs ran and both were judged *not
>   evidence about the hypothesis* by
>   [`docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md`](docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md)
>   §7.5, because the registered configuration sets both gates to `0` and a gate that admits
>   everything cannot be compared against anything;
> - its **evidence assembly** is now self-describing, which it was not: `lastRoute()` reports which
>   of the six paths a question took, and `lastRoleCensus()` reports which roles the window it was
>   shown actually contained — counted by the same classifier the `evidenceRoles` filter uses, with
>   `unclassified` kept separate because a turn whose role cannot be read is kept rather than
>   dropped. Both reach the artifact per question. Before §13.374 an audit had to infer the path
>   from the dataset's `capability` and re-derive the roles with its own copy of the prefix regex,
>   and on run `43465626013` those two inferences disagreed with each other about four records for
>   a reason neither could see.
>
> Three documented capabilities remain unwired: optimal-transport distillation (`sinkhorn`,
> exported but uncalled), TD(λ) credit assignment (not implemented), and fact **derivation**
> history on `Fact` (not implemented). See
> [`docs/DESIGN-CORTEX-MEMORY.md`](docs/DESIGN-CORTEX-MEMORY.md),
> [`docs/AUDIT-CODE-VS-DOCS.md`](docs/AUDIT-CODE-VS-DOCS.md) and
> [`ARCHITECTURE.md`](ARCHITECTURE.md) §"Implementation status" for the measured
> reconciliation — that table, not this list, is the authority on what is wired.

## Packages

| Package | Role |
|---|---|
| `@agentix-e/cortex-core` | Contracts + pure algorithms, zero I/O, Node + browser |
| `@agentix-e/cortex-storage` | Storage backends, one subpath each: `./sqlite` (`better-sqlite3`), `./pg` (PostgreSQL). Peers are optional; the root is empty by design |
| `@agentix-e/cortex-ai` | Model adapters, one subpath per dependency profile: `.` remote OpenAI-compatible (needs only `fetch`), `./local` transformers.js (optional peer), `./web` the browser's built-in model (no dependency at all) |
| `@agentix-e/cortex-memory` | Composition layer: wires `cortex-core`'s value gates into one conformance-passing `MemorySystem` |
| `@agentix-e/cortex-eval` | Scientific evaluation harness (metrics, t-test, ablation) + LongMemEval-style mini benchmark |

## Quick Start

```ts
import { decideRetrieval, decideWrite, defaultValueFunction } from '@agentix-e/cortex-core';
import type { MemoryValue } from '@agentix-e/cortex-core';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';

// A memory is a value judgement, not a similarity score.
declare const candidate: MemoryValue;

const write = decideWrite(candidate, defaultValueFunction, 0.5);
if (write.write) {
  const storage = new SqliteStorage({ filename: './cortex.db' });
  await storage.put('memories', candidate.id, candidate);
  await storage.close();
}

// The read side may decline. `retrieve: false` is an answer, and silence beats a guess.
const read = decideRetrieval([candidate], defaultValueFunction, 0.5);
if (!read.retrieve) {
  console.log(`silent at confidence ${read.confidence.toFixed(2)}`);
}
```

The full path — admission, session budgeting, prompt assembly, per-route rooms, parsing, abstention —
is in the **[user manual](docs/USER-MANUAL.md)**, where every example is compiled against the built
declarations by `pnpm manual:check` and both option tables are compared against the option types in
both directions. For the layer map and an honest status table, read
**[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Requirements

- Node.js >= 22
- pnpm >= 9

## License

MIT
