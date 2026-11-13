# Does the product reach the semantic layer? A call-chain audit at `b0fe73f`

An audit of this repository (dated 2026-11-12, taken at `d0c3f86`) concluded that cortex has no semantic
layer, and a second reader (`cortex-docs`' rebuttal of that audit) narrowed the claim to: *the kernel exists
but the product never calls it*. The second reading is the one this file tests, because it is the one that
can be false.

**Verdict: the reach claim is true, and the audit that made it understates two things and overstates two
others.** The kernel is 2,899 lines that the shipping package imports **none** of, in a package that imports
22 of `cortex-core`'s exports and uses every one of them. What the audit gets wrong is the *reason* — it
attributes the gap to a missing semantic layer, when the gap is a missing **fact source**: `assemble`,
`reviseLedger` and `resolveContradiction` consume `KnowledgeFact`, and nothing in either package constructs
one outside a test and one ablation. Wiring them, as that audit's P0-1 proposes, compiles against an empty
list.

Method: call-chain, not keyword. Every row below is `file:line` at `b0fe73f` and was read, not grepped —
`packages/cortex-memory/src/__tests__/semantic-reach.test.ts` now asserts the central claim executably so
this file cannot quietly rot.

## 1. The claim, restated at the only resolution that can be tested

"The product has no semantic layer" is three claims wearing one sentence, and they have different truth
values:

| Reading | Claim | Verdict |
| --- | --- | --- |
| **Code semantics** | parser, AST, symbol table, call graph, data flow | **True and not a defect** — cortex is not a code index, and `code-analyzer` owning that layer is the positioning |
| **Storage semantics** | typed facts, slot identity, relation edges, valid time, contradiction, derivation | **True for reach, false for existence** — all six exist and are tested; the product calls none |
| **Business-intelligence semantics** | metric and dimension definitions (dbt, Cube) | Not applicable; the industry borrows the word from here |

The audit that started this said "no node types, no edges". At `b0fe73f` that is false without the "code"
qualifier: `knowledge/taxonomy.ts:36` is a closed set of **9 fact types**, `:101` is **11 edge types**, and
`:161` is an admissibility table that refuses `causes` from a sentence that only says `then`. What is true
is narrower and worse for us: **nothing in the shipping path ever builds one.**

## 2. What the product imports

`cortex-memory/src` imports **22** symbols from `@agentix-e/cortex-core`, and they are exactly the
storage, triage, disclosure, value-gate and memory-value surfaces:

```
Admission AdmittedFact CardQueue FederatedStorage KnowledgeCard LLM MemoryValue OutputGuard
OutputScan ProposalResult ReadSideAssembler ReleaseRecord ScopedRow Storage TaskScope
TriageError TriageProposer TriageWriter ValueFunction createMemory decideRetrieval decideWrite
```

Of the semantic kernel's exports — `KnowledgeFrame`, `KnowledgeFact`, `FactType`, `EdgeType`,
`buildKnowledgeUnit`, `deriveAssumptions`, `deriveSupersedes`, `reviseLedger`, `assemble`,
`resolveContradiction`, `consolidate`, `MemoryGraph`, `slotKey`, `renderBlocks`, `isFactCurrentAt` — the
count is **zero**. Two of the 22 (`decideWrite`, `decideRetrieval`) are why the package exists; they are the
positive control in the test, because an assertion that passes on an empty import list would prove nothing.

## 3. The reach table

`T` type only · `I` implemented, no caller outside its own module · `E` called by the evaluation arm only ·
`P` on the shipping path.

| # | Capability | Evidence | Caller | State |
| ---: | --- | --- | --- | --- |
| 1 | Original sentence / fact split, span reconstructed by `locate()` | `knowledge/frame.ts:65`, `:156` | `assumption-ablation.ts:176` | **E** |
| 2 | 9 fact types (closed set) | `knowledge/taxonomy.ts:36` | via frames only | **I** |
| 3 | Polarity, modality, futurity, plan state | `knowledge/temporality.ts` | `assemble` | **I** |
| 4 | 11 edge types + admissibility table | `knowledge/taxonomy.ts:101`, `:161` | `deriveSupersedes` | **I** |
| 5 | Entity identity | `taxonomy.ts:121` — `same-entity` only from a **declared** alias | no alias registry exists | **I** |
| 6 | Slot identity `slotKey(subject, predicate)` | `knowledge/assumption.ts:159` | revision, assemble | **I** |
| 7 | Bitemporal `Fact` (`validFrom/Until`, `systemFrom/Until`) | `domain/fact.ts:7`, `:28` | **none: zero constructors** | **T** |
| 8 | Assumption ledger, 6 kinds, recomputable counts | `assumption.ts:45`, `:124` | `assumption-ablation.ts:192` | **E** |
| 9 | Unit assembly gate (refuse a split that loses a relation) | `knowledge/unit.ts:127` | `tools/knowledge-probe.mjs:118` | **I** |
| 10 | Revision: supersede, stale cascade, plan lifecycle | `knowledge/revision.ts:128`, cascade at `:264` | `assumption-ablation.ts:536` | **E** |
| 11 | Answer-side exit: the four questions, `asOf` hard filter | `context/assemble.ts:198` | `assumption-ablation.ts:680` | **E** |
| 12 | Contradiction: log-odds fusion over a slot | `contradiction/resolve.ts:21` | **none** | **I** |
| 13 | Consolidation / forgetting (FSRS) | `consolidation/consolidate.ts:40` | **none** | **I** |
| 14 | Disclosure governance: 12 rules, cards, proposals, echo guard | `triage/*`, `disclosure/session.ts` | product | **P** |
| 15 | Storage: one KV table | `cortex-storage/src/storage/sql.ts:60` | product | **P** |
| 16 | Semantic gates K0–K3 / V1 / T1–T4 over a 17-case set | `cortex-eval/src/acceptance.ts:259` | arm | **E** |
| 17 | Product retrieval: `lexicalRelevance` + session budget | `relevance.ts:178`, `sessionize.ts:37` | product | **P** |
| 18 | Answer-level supersession with span-and-date authorisation | `supersede.ts:405`, `memory.ts:1603` | product | **P** |
| 19 | Aggregation plan over scope / predicate / operation | `aggregation/`, `tally.ts` | product | **P** |

**P is 5 of 19, and three of the five are the semantic ones that survived** (§14, §18, §19: disclosure,
supersession, aggregation). That is the honest shape of the gap: the product has *answer-side* semantics
and no *store-side* semantics. The audit's summary — "a mechanism the shipping path never calls is
decoration with a test suite", quoted from `context/assemble.ts:9` itself — applies to eleven of the
nineteen rows.

The kernel's size at this commit: **2,899 lines** (`knowledge/*` 2,089 + `context/assemble.ts` 382 +
`contradiction/resolve.ts` 93 + `consolidation/consolidate.ts` 93 + `graph/memory-graph.ts` 207 +
`domain/fact.ts` 35).

## 4. Four corrections to the audit under review

### 4.1 "Product retrieval is pure lexical — no embedding, no BM25, no RRF, no rerank"

**Conditioned, and the condition is the whole story.** It is true of `cortex-memory` *as a library*: the
default ranker is `lexicalRelevance`, and both the module and the type say why —
`relevance.ts:38` ("I/O-free and model-free — no embedding, no LLM. That is what lets `cortex-memory` keep
its `build: 'none'`") and `types.ts:342` ("this package reads no embedding model: the same boundary
`confidenceFor` and `llm` already draw").

It is false of the run that produced the 91.25% row. `bench-memory-arm.ts` records the arm's own
configuration, and `43264749133`'s artifact carries `relevanceSignal: 'retrieval-anchored'` with
`embedding: {provider: 'openai-compatible', model: 'embedding-3', dimensions: 1024, preflight: 'ok'}`;
`bench/run-ablation.ts:467` builds that backend and `:644` routes `retrieval-hybrid` / `retrieval-anchored`
through `retrieveTopKByQueriesHybrid`. So the registered product arm **does** retrieve semantically — via an
injected ranker, not via a retriever the product owns.

That distinction is the real finding, and it is sharper than "pure lexical": the product exposes a
**ranker hook** and owns **no retrieval stack**. Everything that turns a corpus into candidates lives in
`cortex-eval` or in the arm's CLI. A consumer who installs `@agentix-e/cortex-memory` and passes nothing
gets lexical selection over whatever they hand it. That is a legitimate design (it is what keeps the package
testable and model-free) and it is also the exact reason the audit can say "the features are in the harness"
and be right.

### 4.2 "Derivation provenance does not exist"

**False for the type that is constructed.** `KnowledgeFact.references` is the derivation link, and
`revision.ts:264` cascades over it: a fact whose premise was refuted is marked `stale`, and
`assemble.ts`'s third question turns that into an exclusion *without deleting the fact*. The module states
its provenance explicitly — the chain "exists because the system recorded it, not because a benchmark
supplied it", which is PACMI's stated gap.

What does not exist is `Fact.derivedFrom` in `domain/fact.ts`, which is the name `ARCHITECTURE.md:171`
proposes. That type has **zero constructors**, so adding the field would create a second provenance
mechanism on a type nothing builds — the same defect class as the two comparators and the two room parsers
this repository has already caught. §7 records the verdict: **reject as written**; the mechanism is there
and what it lacks is a caller.

### 4.3 "P0-1: call `assemble({intent, asOf, ranked})` before the prompt"

**Not implementable as written, and the missing link is in the audit's own §4.** `assemble` consumes
`KnowledgeFact[]`. A `KnowledgeFact` comes from a `KnowledgeFrame` (span, type, polarity, time), which
comes from a unit, which comes from an extraction channel. The audit's own item ① says the extraction
channel is absent, and its P2 says provenance is absent — so P0-1 as sequenced calls a function whose
argument no module can produce.

Landing it anyway is easy and would be indistinguishable from working: `assemble([])` returns an empty
block set, the prompt is unchanged, the tests pass, and the reach table gets to say `P`. That is a fake
wiring, and it is exactly the failure `MEASURE-PLAN-SHAPE.md` priced at 43 mechanism flips for 46 damages.
The sequence has to be: **fact source → `assemble` → measurement**, and the fact source is a decision about
extraction that the campaign has already refused once at −19.62 points (§5.1 below).

### 4.4 "91.25% is the arm's reading, not the product's"

**True in one sense, false in the one that matters for this audit.** The reading is produced by
`runCortexMemoryArm`, whose feature side is `cortex-memory`'s `CortexMemory` — constructed in
`cortex-memory/bench/run-ablation.ts:526` and handed over pre-constructed (`bench-memory-arm.ts:15-25`
explains why the handover is load-bearing). So the product's admission, sessionisation, selection and
prompt assembly are all in the measured path, and a regression in any of them moves the number.

What the arm owns is the *other* half: candidate retrieval, reranking, the reader, the judge, the scoring.
The correct sentence is therefore **"the product is measured; the retrieval stack is not the product's"**,
which is a different repair from "the product is not measured".

## 5. Two findings the audit did not have

### 5.1 The product implements an interface the instrument owns, and does not declare it

`memory.ts:25` is `import type { Answer, SessionAwareMemorySystem } from '@agentix-e/cortex-eval'`, and
`memory.ts:132` is `export class CortexMemory implements SessionAwareMemorySystem`. `cortex-memory`'s
`package.json` declares `cortex-core` and nothing else, so the edge is **type-only and undeclared**: it
resolves inside the workspace and breaks for anyone who installs the product without the harness, because
the emitted `.d.ts` names a package that will not be there.

`AUDIT-EVAL-CONTRACTS.md` §2 records the edge as "type-only and acyclic" and relies on that; the acyclicity
is real, the declaration is not. The direction is also backwards from the layering the campaign states
everywhere else: the product's public contract is owned by the measuring instrument.

**Repaired in this round.** `Answer`, `MemorySystem` and `SessionAwareMemorySystem` moved to
`cortex-core/src/protocol/memory-system.ts`; `cortex-eval` re-exports them so its public surface is
unchanged, and `cortex-memory` imports them from the base. `cortex-memory`'s `package.json` gains nothing,
because the edge is now gone rather than declared.

There was a **second** occurrence, and the executable assertion is what found it: `parse.ts:10` imported
`Answer` from `cortex-eval` as well, which reading the class's header would never have shown — the header
names `memory.ts` and stops. `packages/cortex-memory/src/__tests__/semantic-reach.test.ts` now asserts that
no file in the shipping package imports the harness *at all*, not merely that the import is type-only. That
stronger form is what keeps the backwards edge from returning the next time a type is convenient.

### 5.2 `MemoryType` has exactly one reachable value

`domain/memory.ts:4` declares `'episodic' | 'semantic' | 'procedural'`. `createMemory` defaults to
`'episodic'` (`:52`), `admission.ts:288` hardcodes it, and **no code reads the field** — not selection, not
prompt rendering, not the FSRS schedule (which reads `stability`). `'semantic'` appears in this repository
exactly once: in the declaration of the union.

So "cortex has semantic memory" is not merely unwired, it is *unrepresentable*: there is no value to write
and nothing that would read one. The audit reports this as a detail; it belongs in the reach table's §3 as
row 1's precondition, because a typed-fact store's whole point is that some memories are not episodes.

## 6. The charter gap, in the package's own words

`cortex-memory/src/index.ts:1-7` says the package exists because "`decideWrite`, `decideRetrieval`,
`consolidate` and `resolveContradiction` had zero production callers". Four named, two wired: `decideWrite`
(through `admitTurns`) and `decideRetrieval` (through `provider.ts`). `consolidate` and
`resolveContradiction` are still at zero — `consolidate`'s only would-be caller is `MemoryGraph`, and
`MemoryGraph` has no caller either.

That is not a new finding; it is the package's stated purpose, half-unmet, documented in its own header for
as long as the header has existed. It is the cleanest evidence that the audit's thesis is right in spirit:
the wiring was planned here, named here, and never finished here.

## 7. What to do, item by item

The audit under review proposes P0–P4. Each is re-scored against the facts above, with the prerequisite that
the audit's sequencing omits.

| Its item | Proposal | Verdict | Why |
| --- | --- | --- | --- |
| P0-1 | `assemble()` into evidence assembly | **Blocked, re-sequenced** | Needs `KnowledgeFact[]`; no module can produce one. Prerequisite: a fact source that does not replace the original text |
| P0-2 | answer-side state tracing, tenth `promptContract` | **Accept as the first step** | Data source exists in the product (`supersede.ts`, `memory.ts:1603`) and needs no extraction; mechanism endpoint is a tracing-table presence rate, so a score cannot move without it |
| P1-1 | FEB-30 four intrinsic metrics as acceptance rows | **Accept, second** | They measure the store, not the answer, which is the only way the semantic work can be judged at all; needs the 30 fact-evolution traces to exist first |
| P2-1 | `Fact.derivedFrom?: string[]` | **Reject as written** | §4.2: `references` + `stale` already do it on the type that is built; adding the field creates a second mechanism on a dead type |
| P3-1 | `membership` predicate in the aggregation spec | **Accept, third** | The only item that moves a *measured* product capability (MR's "off by one" family, 7 of 26) with no new model call |
| P4-1 | ontology package, ≤12 types | **Reject for now** | Validates a fact stream that does not exist; the audit's own veto condition (rejection rate ≤5%) cannot be evaluated |
| P4-2 | bounded BFS multi-hop | **Reject for now** | Its own precondition (recover ≥3 of the 11 recoverable ranking questions) has no measurement; `expandTyped` is arm-only anyway |
| — | move the protocol types into `cortex-core` (§5.1) | **Done this round** | The product must not be typed by the instrument; the edge is gone, not declared |
| — | `MemoryType` (§5.2) | **New P2, decide by use** | Either a reader appears when facts land, or the two unreachable members are deleted; a settable label nobody reads is decoration |

The one-line summary of the ordering: **the semantic layer's missing half is a fact source, and the
cheapest fact source that cannot hurt is the one the product already computes** — supersession state from
`supersede.ts`, which is span-authorised, already called, and already spends its call.

## 8. What this audit does not claim

- **It does not claim the kernel should be deleted.** Eleven rows at `I`/`E` are the reason the semantic
  work is a wiring problem rather than a research problem; deleting them would turn a known gap into an
  unknown one.
- **It does not claim the 91.25% is wrong.** §4.4: the product is in the measured path. What is missing from
  that number is the store's own quality, which no current gate measures.
- **It does not claim extraction is the answer.** The campaign's own −19.62 for replacing text with
  extracted atoms stands, and nothing here proposes to revisit it. A fact source is **additive** or it is
  not worth building.
- **It cannot measure.** No run was dispatched for this file; every number above is either a line count, a
  call-chain fact, or a figure quoted from an existing artifact with its run id.

## 9. The four capabilities an answering system needs, and which of them the product had

§3 counted the semantic kernel and found 5 of 19 rows on the shipping path. That count was about the
*knowledge* layer. A sharper question was asked of it, and the answer is worse: of the four things an
answering system must do — retrieve, rerank, read, judge — the product owned **one and a half**.

The distinction matters because "the semantic layer is unwired" is a statement about an optional
capability, and "the product does not retrieve" is a statement about the thing it is sold as.

### 9.1 The table, with the file that decides each row

| capability | where it lived | evidence | verdict |
| --- | --- | --- | --- |
| **reader** | `cortex-memory` | `memory.ts:12` states the flow; `prompt.ts` (five contracts, the retry and repair paths), `parse.ts`, `#consult` calls `LLM.complete` | **product. Never was the gap.** |
| **judge** | `cortex-eval` | `question-record.ts`, `metrics.ts` | **correctly not the product.** A ruler inside the thing it measures measures nothing. |
| **retrieval** | `cortex-eval` | `relevance-index.ts` (665 lines) builds the index and the rerank, then hands `CortexMemory` a synchronous `(question, turn) => number` through `relevanceFor` (`types.ts:359`) | **not the product.** With no callback the room was spent in arrival order. |
| **rerank** | `cortex-core` mechanically, `cortex-eval` in practice | `retrieval/rerank.ts` exports `rerankHits`; its callers are `relevance-index.ts:663` and `natural-language-memory.ts`, both in the harness. `cortex-memory` imports neither. | **not the product.** The mechanism existed one layer below and had no product caller — the same shape §3 recorded for `assemble`. |

So the audit's charge is half right, and the half it got right is the half that matters. §4.4 was also half
right for the same reason: the 91.25% row *does* run `CortexMemory`, and the ranking inside it comes from the
instrument.

### 9.2 Why "inject the signal" was not a boundary but a hole

`types.ts` defended the callback with the criterion `relevance.ts` states: *"I/O-free and model-free — no
embedding, no LLM"*, which is what lets this package depend on `cortex-core` alone. The criterion is right.
The conclusion drawn from it was not: the package that will not read a model still has to **decide what the
model is asked about**, and there is a difference between *constructing a client* and *composing a mechanism
whose scoring function is injected*. The package already draws that distinction correctly for the reader —
`LLM` is an interface it is handed, not a client it builds — and it simply had not drawn it for retrieval.

Two consequences followed, and both are visible in the archived numbers:

1. **The product could not answer without being ranked.** `chooseEvidence` falls back to
   `truncateCodePointSafe(plan.render(plan.turns), room)` when `relevanceFor` is absent — a prefix of arrival
   order. That is why `38114272884` measured the gold turn inside the delivered prefix for 12.4% of questions.
2. **The retrieval that produced every published figure had no product-side counterpart.** A defect in it
   could only be found by reading `cortex-eval`, and a user of the published package could not reproduce it at
   all.

### 9.3 The repair, and what it deliberately is not

`retrieval/search-index.ts` composes the missing two:

| stage | decision | why that decision |
| --- | --- | --- |
| lexical channel | `contentTerms` + `lexicalRelevance`, the product's own definitions, with postings used only to narrow candidates | a second scorer with the same name would make "lexical" mean two things, and an index whose candidate set disagrees with its scorer can drop the turn the scorer ranks first |
| vector channel | injected batch `embed`, cosine over the values | batching is the contract because a per-turn call cannot be priced; the package still reads no model |
| fusion | reciprocal rank, `k = 60` | cosine, lexical and any future BM25 do not share a scale, and a normaliser is a free parameter the benchmark would then be measuring |
| rerank | `cortex-core`'s `rerankHits` over the fused head, with the scorer wrapped | the core function degrades to the input order on every failure, so `rerankCalls` beside `rerankDegraded` is what separates a stage that agreed from a stage that failed |
| score after fusion | the position, `1 / (60 + rank)` | the prompt sorts on this number; keeping a channel's raw magnitude would let the sort undo the reranker it never saw |

It is **not** a second retrieval stack beside the harness's. `relevanceFor` still wins when both are supplied,
so every registered arm keeps its declared signal and the archived runs stay comparable; `index` absent
reproduces the previous bytes exactly, which is asserted on the flat **and** the session-aware route.

### 9.4 The defect the wiring test caught, which no unit test could

The first version of `lookup` returned `(turn: string) => number`. Every unit test of the index passed. The
prompt calls `relevanceFor(question, turn)`, so the map was queried with the **question**, missed on every
turn, scored them all zero, and the selection fell back to arrival order — while the census reported a healthy
index with `turns: 12, terms: 7`. The failure is invisible in any test of the mechanism and obvious in a test
that asserts a late topical turn reaches the prompt, which is why `search-wiring.test.ts` exists beside
`search-index.test.ts`. The returned signature is now the prompt's, and one test pins the parameter that is
not read by comparing the same turn under two different questions.

The second defect is the census's own timing: it was snapshotted before `lookup`, so `embedCalls` counted the
corpus batch and never the query, and `rerankCalls` would have been `0` on every run — the exact count a
reader would use to decide the stage ran. It is taken after the lookup now.

### 9.5 What this does and does not establish

**Does:** the product can retrieve, fuse and rerank on its own; the option reaches the prompt on the flat and
the session-aware routes; absence is the identity; the override wins; every stage that can silently degrade is
counted.

**Does not:** measure whether the product's own retrieval is *better* than the harness's. That is a dispatch,
not a paragraph, and the arm it needs is one whose `relevanceFor` is absent and whose `index` is set — the
first configuration in this repository's history where the product ranks for itself. Until that reading
exists, the claim is capability, not quality.
