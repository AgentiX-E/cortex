# Cortex Architecture

High-level architecture of the Cortex agent memory layer: the layers, the flows through them, the
interfaces you extend, and — in the last two sections — exactly which parts of this design are wired
to a measured path and which are not.

For how to _use_ the packages, read [`docs/USER-MANUAL.md`](docs/USER-MANUAL.md). For the reasoning
behind a specific decision, each section links the design record that argues it.

## 1. The three decisions that make this not a vector store

A vector store answers "what is similar to this text?". Cortex answers four other questions, and the
architecture exists to keep them separable:

1. **What is worth keeping?** A turn becomes a memory when its estimated future utility clears a
   threshold — not when a similarity score is high. `threshold` gates the write.
2. **What is worth answering from?** Kept evidence is re-valued at read time, and the reader may
   decline. `retrievalThreshold` gates the answer, and it is a _different_ field from `threshold`
   because the two questions have different right answers.
3. **Which prompt does this question deserve?** Six routes (multi-session, temporal, flat,
   knowledge-update, abstention, assistant) exist because six question shapes need different
   instructions, and a single generic prompt measurably loses on all of them together.
4. **What does the answer cost?** The evidence room is budgeted in characters, per route, because one
   character budget is five different _depths_ on five routes (§7.4 of the manual).

Everything else — storage, model calls, embeddings — is delegated through an interface.

## 2. Layer map

```
cortex-core        contracts + pure algorithms. Zero I/O, Node + browser, no native module.
  ├─ interfaces/   Storage · VectorIndex · LLM · EmbeddingModel
  ├─ domain/       MemoryValue · Fact (bitemporal: valid time + system time)
  ├─ math/         vector · stats · optimal-transport · fsrs
  ├─ graph/        associative MemoryGraph (Hebbian edges + spreading activation)
  ├─ value/        write and retrieval value functions
  ├─ temporal/     bitemporal queries
  ├─ contradiction/ Bayesian evidence fusion
  ├─ consolidation/ retrieval-as-consolidation
  └─ federation/   FederatedStorage (routes by table prefix) · ReadSideAssembler

cortex-memory      the composition layer: core's gates -> one object that answers
  ├─ admission     value-gated write admission (the first production caller of decideWrite)
  ├─ sessionize    per-session admission + turn-budget selection
  ├─ prompt        one builder parameterised by a prompt contract and an ask
  ├─ parse         raw model output -> Answer (null is a decline)
  ├─ provider      CortexSessionProvider: a retrieval adapter, for measuring the room in chars
  └─ memory        CortexMemory: the only async module in the package

cortex-storage     one subpath per backend; the package root exports nothing on purpose
  ├─ ./sqlite      SqliteStorage   (better-sqlite3, optional peer)
  ├─ ./pg          PgStorage       (pg, optional peer)
  ├─ ./opfs        SQLite compiled to wasm, file in the OPFS, statements on a worker
  └─ ./idb         IndexedDB, the fallback tier

cortex-ai          one subpath per dependency profile
  ├─ "."           OpenAI-compatible LLM · embeddings · rerankers · retry · usage  (fetch only)
  ├─ ./local       transformers.js embedding + cross-encoder                      (optional peer)
  └─ ./web         the browser's built-in model                                   (no dependency)

cortex-eval        the instrument, not the product: dataset types, the memory-system contract,
                   scoring, paired statistics, ablation reports
```

The dependency edges run **downward only**: `cortex-memory` and `cortex-eval` both depend on
`cortex-core`; `cortex-eval` cannot import the product, and the product may import `cortex-eval` for
_types only_. That edge is what keeps the harness an instrument rather than a participant, and it is
asserted by a test rather than trusted.

## 3. The interfaces you extend

| interface        | package       | what a caller supplies                                                  | why it is injected rather than built                                    |
| ---------------- | ------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `LLM`            | `cortex-core` | `complete(prompt, opts)`, `completeStructured(prompt, schema)`          | Cortex owns no API key and makes no network call of its own             |
| `EmbeddingModel` | `cortex-core` | `embed(texts) -> Float64Array[]`, `dimension()`                         | Float64 output, so no float32 truncation leaks into the cognitive layer |
| `Storage`        | `cortex-core` | `put · get · del · query · transaction · close`                         | An in-memory object with six methods is a valid backend                 |
| `MemorySystem`   | `cortex-eval` | `name`, `answer`, plus optional `answerSessions` / `answerTemporal` / … | The harness routes on which optional members exist                      |

`CortexMemory` is a `MemorySystem`. So is a ten-line object of your own; the harness treats them
identically, which is how the reference pipeline and the product arm are compared in one call.

Two more injection points inside `CortexMemory`, both for the same reason — a value the layer should
not own:

- **`gate.valueFunction`** replaces the utility estimate entirely (default: `cortex-core`'s).
- **`gate.confidenceFor`** supplies per-turn confidence. Without it every admitted turn carries the
  same value, the gate is a two-state switch, and any threshold above `sourceTrust` admits nothing.

## 4. The two flows

### 4.1 Write path (per turn)

```
turn text
  -> admitTurns(context, {now, threshold, sourceTrust, confidenceFor})
       value = confidence * sourceTrust * (0.5 + 0.5 * recency)
       keep  when value >= threshold        (0 admits everything; 1 admits nothing)
  -> AdmittedTurn[]   (the evidence candidate pool)
```

Admission is where "value-driven" becomes concrete. `threshold: 0` is the identity configuration and
is what the published arm runs, which is why the gate's _reach_ is recorded in every artifact: a run
whose gate cannot close must not be read as one whose gate decided.

### 4.2 Read path (per question)

```
question + context (+ sessions, + questionDate)
  -> route:                 flat | multi-session | temporal | knowledge-update | abstention | assistant
  -> admit                  value gate over turns (flat routes) or per session (multi-session)
  -> role filter            optional, BEFORE the budget, so an excluded turn cannot win the room
  -> selectSessionBudget    sessions admitted whole, or trimmed when gate.trim is on
  -> retrieval (optional)   index builds postings over this question's turns, adds a vector channel
                            through an injected embedder, fuses by rank, reranks the head
  -> evidence assembly      relevanceFor (supplied, else the product's index) ranks turns;
                            room = maxPromptCharsByRoute[route]
  -> prompt                 promptContract (rendering + assembly) and ask (instruction)
  -> llm.complete           never a second pass unless reviewPass / selfConsistency asks for one
  -> parseAnswer            last non-empty line, label stripped, token matched case-insensitively
  -> Answer                 string, or null for a decline
```

Three ordering facts are load-bearing and were each a defect once:

- **The role filter runs before the budget.** With the budget first, a session the filter would empty
  can win the whole room on the strength of a turn the reader never sees, and the question declines
  with admissible evidence sitting behind it.
- **`maxPromptCharsByRoute` is resolved in one place.** An option resolved at a call site is an option
  a route can miss, and the artifact would then describe a prompt that was never assembled.
- **A decline is `null`, not `''`.** `''` is a blank answer, which is a wrong answer; the two must not
  arrive at the scorer as one value.
- **`relevanceFor` wins over `index`.** A run that names a signal must be the run the artifact describes;
  the product's own retrieval is the default for a deployment with no harness, not an override of one.
  With neither, the room is a prefix of arrival order — the state every archived run was taken in.

## Design Principles

1. **Contracts in core, engines outside.** Every backend — storage, vector, LLM, embedding — is an
   interface consumed by `cortex-core`, and concrete engines live in `cortex-storage` / `cortex-ai`.
   That keeps core browser-safe and environment-agnostic. The _composition_ of those contracts into a
   runnable system lives in `cortex-memory`, which depends on none of the concrete engines.
2. **Float64 everywhere.** Vectors are `Float64Array`; statistics use Kahan summation and Welford
   variance; decomposition is float64. No float32 truncation leaks into the cognitive layer.
3. **Embedded-first, remote-scalable.** Cortex never requires an external service: SQLite plus a
   brute-force index works offline, and PostgreSQL is the scale-out path rather than the entry
   requirement.
4. **A rule that is only written down is a rule that has already been broken once.** So each of these
   is a gate in `pnpm check`, not a paragraph in a document:

| rule                                                                 | enforced by                                                                       |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| The storage root reaches no native module and no `node:` builtin     | `tools/entry-guard.mjs` — a closure walk, with `./sqlite` as its positive control |
| The `.` entry of `cortex-ai` never reaches transformers.js           | the same walk, with `./local` as the positive control                             |
| A bundle does not silently grow a native dependency                  | `tools/bundle-guard.mjs`                                                          |
| Every public export has a caller or a documented reason              | `tools/export-census.mjs`                                                         |
| Every documented option exists, and every example compiles           | `tools/manual-examples.mjs`                                                       |
| Coverage ≥95% on each of four dimensions, per file                   | `tools/coverage-per-file.mjs`                                                     |
| The browser reading is produced by a real browser                    | `tools/browser-reading-check.mjs`                                                 |
| A document's quoted number still equals the number the code produces | `tools/docs-crosscheck.mjs`                                                       |

## Implementation status: what is wired to a measured path

Not every algorithm in the layer map is on the evaluation path. This table states plainly which ones
are load-bearing today, so no reader infers more coverage than exists.

| Capability                                                 | Status                                                 | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decideWrite` / `decideRetrieval` / `defaultValueFunction` | Implemented, tested, **composed and armed**            | `cortex-memory` is their first production caller. The pre-registered A/B that measures whether the gated composition _helps_ is assembled; the dispatch is the remaining step — a pre-registration is a prediction, not a result                                                                                                                                                                                                                                                                                                         |
| Bitemporal facts                                           | Implemented, tested, **not reached by the product**     | The arm's `answerKnowledgeUpdate` is bitemporal, and the facts it reads are built by `cortex-eval`'s own `fact-store.ts` — `(subject, predicate, object, date)` triples turned into a per-subject timeline. `cortex-core`'s `Fact` (two time axes, `isFactCurrentAt`) has **zero constructors** in either package, and `CortexMemory` never builds one. So the capability is delivered on the measured path by a different implementation, and the type that models it is a contract with no caller. The reach table and the count are in [`docs/AUDIT-SEMANTIC-REACH.md`](docs/AUDIT-SEMANTIC-REACH.md) §3 |
| FSRS (`retrievability` / `review`)                         | Implemented, tested, **reached through `consolidate`** | `consolidate` has no caller, so FSRS is reachable only transitively. Stability is in days and elapsed time in milliseconds; both were once milliseconds, which made `consolidate`'s defaults delete every memory on the first run                                                                                                                                                                                                                                                                                                        |
| Hebbian graph (`MemoryGraph`)                              | Implemented, tested, **not on the eval path**          | Graph recall was wired into the temporal path and removed on measurement: 77.95% → 70.87%, 15 questions broken against 6 repaired, exact McNemar p = 0.039. Closed, not pending                                                                                                                                                                                                                                                                                                                                                          |
| Contradiction resolution                                   | Implemented, tested, **not on the eval path**          | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Cross-encoder reranking                                    | Implemented, wired, **off by default**                 | On both retrieval paths; enabled via `CORTEX_RERANK`. Also reachable from the product through `CortexMemoryOptions.index.rerank`, which runs `rerankHits` over the fused head and counts a degraded stage                                                                                                                                                                                                                                                                                                                                  |
| Retrieval (`SearchIndex`)                                  | Implemented, tested, **wired; not yet the default**    | The product's own stack: postings over `contentTerms`, an optional vector channel through an injected batch embedder, RRF fusion, optional rerank. `CortexMemoryOptions.index` enables it; absent reproduces the archived bytes. It is not the default because `relevanceFor` must keep winning for a dispatched arm, and because a run whose product ranks for itself has not been dispatched yet — [`docs/AUDIT-SEMANTIC-REACH.md`](docs/AUDIT-SEMANTIC-REACH.md) §9 states exactly that: capability established, quality unmeasured |
| Recall-curve diagnostic                                    | Implemented, wired, measured                           | Separates breadth from ordering. First reading: ceiling 93.02%, gain 65.12% → 2.33% across k=1→20                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| TD(λ) credit assignment                                    | **Not implemented**                                    | No eligibility traces exist in the codebase                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Optimal-transport distillation                             | **Implemented, inert**                                 | `sinkhorn` is exported; nothing calls it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Fact derivation (provenance DAG)                           | **Mechanism exists on `KnowledgeFact`, off by default; absent on `Fact`** | This row used to say "not implemented" and to prescribe a `derivedFrom?: string[]` field on `Fact`. The first half is wrong and the second half would be a second mechanism. `KnowledgeFact.references` **is** the derivation edge, and `revision.ts` already cascades over it: a fact whose premise was refuted is marked `stale`, `assemble` turns that into an exclusion without deleting the fact, and the whole path is tested. What is missing is a **caller** (§6 above: the package exists to wire `consolidate`/`resolveContradiction` and has not), not a field. The derivation edge on `Fact` itself is still absent, and a speculative `ProvenanceNode` type once stood in for it and read no code; it was deleted rather than kept as a shape without a graph, and this row is the record that it existed and why. Adding `derivedFrom` to `Fact` would model provenance twice on a type nothing constructs. Reach status, prerequisites and the rejected proposal: [`docs/AUDIT-SEMANTIC-REACH.md`](docs/AUDIT-SEMANTIC-REACH.md) §4.2 and §7 |
| Abstention calibration (Platt / temperature)               | **Not implemented**                                    | Thresholds are fixed constants                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

The published LongMemEval-S figure is produced by `cortex-eval`, which imports statistics helpers and
one vector index from `cortex-core`. `cortex-core` is a validated algorithm library; the system under
measurement is the composition in `cortex-memory`. See
[`docs/AUDIT-CODE-VS-DOCS.md`](docs/AUDIT-CODE-VS-DOCS.md) for the call-site evidence.

## 7. Measurement architecture

Numbers are produced by three separate layers, and conflating them is how a project reports progress
it does not have:

| layer          | what it produces                                                                  | where it lives                                                          |
| -------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| the instrument | per-question correctness, four repetitions, prompt digests, token usage           | `cortex-eval` (`runBenchmark`, `runAblationReport`)                     |
| the arithmetic | paired statistics, McNemar, Wilson bounds, endpoint noise, repetition instability | `cortex-eval` (`paired-*`, `variance.ts`, `judge-audit.ts`)             |
| the arm        | a configuration, a dataset, a dispatch, an artifact                               | `cortex-memory/bench/`, `.github/workflows/benchmark-cortex-memory.yml` |

Two properties the instrument enforces, both because their absence produced published numbers that had
to be retracted:

- **A run records its own configuration**, byte for byte, and the record is checked against the
  dispatcher's inputs (`tools/arm-config-record.py`). Two hand-written documents once drifted from the
  run together and confirmed each other.
- **A claim that was withdrawn stays written down** ([`RETRACTIONS.md`](RETRACTIONS.md)). Thirteen published
  numbers have been corrected so far; a project that republishes only its current figures is
  indistinguishable from one that never changed its mind.
- **A difference smaller than the endpoint's own movement is not a result** (`tools/quantify-endpoint-noise.mjs`).
  The measured floor is 17 questions overall at the observed rate and 27 at the 95% upper bound; per
  capability it is 8 and 15 on `MR`, which is the only capability where this arm trails its own
  reference pipeline. A claim below the bar is a repeat, not a finding.

## 8. Repository map

```
packages/          the five packages above, each with its own tests, coverage config and README
tools/             every gate, and the tests for every gate (tools/__tests__/*.py)
docs/              USER-MANUAL.md and ARCHITECTURE.md are the published surface; the rest are the
                   design and audit records that argue the decisions
.github/workflows/ the measurement dispatches and the verification pipeline
```

## 9. Reading order

1. [`docs/USER-MANUAL.md`](docs/USER-MANUAL.md) — install, providers, options, cost.
2. This file — layers, flows, status.
3. [`SOTA-BASELINE.md`](SOTA-BASELINE.md) — the published numbers and the settings they were taken at.
4. [`docs/DESIGN-CORTEX-MEMORY.md`](docs/DESIGN-CORTEX-MEMORY.md) — why the gates are shaped this way.
5. [`docs/ACCEPTANCE-MATRIX.md`](docs/ACCEPTANCE-MATRIX.md) — the acceptance criteria per capability.
6. [`docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md`](docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md) — the A/B,
   its predictions before dispatch, and every reading since.

## 10. Dependencies

| Concern          | Choice                                 | Rationale                                                  |
| ---------------- | -------------------------------------- | ---------------------------------------------------------- |
| Linear algebra   | `ml-matrix`                            | pure JS, Float64, Jacobi SVD, dual-environment             |
| Graph            | self-implemented adjacency list        | a core cognitive algorithm: full precision and determinism |
| Embedded storage | `better-sqlite3`                       | synchronous, fast, mature, extension-capable               |
| Remote storage   | `pg`                                   | standard PostgreSQL client                                 |
| Local models     | `@huggingface/transformers` (optional) | offline, browser and Node                                  |
| Browser storage  | sqlite-wasm + OPFS, IndexedDB          | no server, no native addon                                 |
