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
count is **zero at `b0fe73f`**. It is no longer zero: §10 records what moved, which row of the table below
moved with it, and what deliberately has not. Two of the 22 (`decideWrite`, `decideRetrieval`) are why the package exists; they are the
positive control in the test, because an assertion that passes on an empty import list would prove nothing.

## 3. The reach table

`T` type only · `I` implemented, no caller outside its own module · `E` called by the evaluation arm only ·
`P` on the shipping path.

| # | Capability | Evidence | Caller | State |
| ---: | --- | --- | --- | --- |
| 1 | Original sentence / fact split, span reconstructed by `locate()` | `knowledge/frame.ts:65`, `:156` | `assumption-ablation.ts:176` | **E** |
| 2 | 9 fact types (closed set) | `knowledge/taxonomy.ts:36` | via frames only | **I** |
| 3 | Polarity, modality, futurity, plan state | `knowledge/temporality.ts` | `assemble`, which reads `isPlan` / `planFactor` on every candidate (§11) | **P** |
| 4 | 11 edge types + admissibility table | `knowledge/taxonomy.ts:101`, `:161` | `deriveSupersedes`, from `semantic-facts.ts` (§10) | **P** |
| 5 | Entity identity | `taxonomy.ts:121` — `same-entity` only from a **declared** alias | no alias registry exists | **I** |
| 6 | Slot identity `slotKey(subject, predicate)` | `knowledge/assumption.ts:159` | `deriveAssumptions` and `assemble`, both reached through `semantic-facts.ts` (§11) | **P** |
| 7 | Bitemporal `Fact` (`validFrom/Until`, `systemFrom/Until`) | `domain/fact.ts:7`, `:28` | **none: zero constructors** | **T** |
| 8 | Assumption ledger, 6 kinds, recomputable counts | `assumption.ts:45`, `:124` | `semantic-facts.ts` (§11) and `assumption-ablation.ts:192` | **P** |
| 9 | Unit assembly gate (refuse a split that loses a relation) | `knowledge/unit.ts:127` | `tools/knowledge-probe.mjs:118` | **I** |
| 10 | Revision: supersede, stale cascade, plan lifecycle | `knowledge/revision.ts:128`, cascade at `:264` | `semantic-facts.ts` (§11) and `assumption-ablation.ts:536` | **P** |
| 11 | Answer-side exit: the four questions, `asOf` hard filter | `context/assemble.ts:198` | `semantic-facts.ts` (§11) and `assumption-ablation.ts:680` | **P** |
| 12 | Contradiction: log-odds fusion over a slot | `contradiction/resolve.ts:21` | **none — Declined**, `DECISION-SEMANTIC-LAYER-ROUTE.md` §6.1 | **I** |
| 13 | Consolidation / forgetting (FSRS) | `consolidation/consolidate.ts:40` | **none — Declined**, `DECISION-SEMANTIC-LAYER-ROUTE.md` §6.2 (§13 here) | **I** |
| 14 | Disclosure governance: 12 rules, cards, proposals, echo guard | `triage/*`, `disclosure/session.ts` | product | **P** |
| 15 | Storage: one KV table | `cortex-storage/src/storage/sql.ts:60` | product | **P** |
| 16 | Semantic gates K0–K3 / V1 / T1–T4 over a 17-case set | `cortex-eval/src/acceptance.ts:259` | arm | **E** |
| 17 | Product retrieval: `lexicalRelevance` + session budget | `relevance.ts:178`, `sessionize.ts:37` | product | **P** |
| 18 | Answer-level supersession with span-and-date authorisation | `supersede.ts:405`, `memory.ts:1603` | product | **P** |
| 19 | Aggregation plan over scope / predicate / operation | `aggregation/`, `tally.ts` | product | **P** |

**At `b0fe73f` P is 5 of 19, and three of the five are the semantic ones that survived** (§14, §18, §19:
disclosure, supersession, aggregation). §10 moves one more — the edge layer — and §11 moves five: the fact
source's ledger, its revision and the answer-side exit. **P is now 11 of 19.** What has *not* moved is as
deliberate as what has: rows 2, 5 and 7 stay `I`/`T` because one member of a closed set being written is not
the closed set being reachable, no alias registry exists, and the two-axis `Fact` still has zero constructors;
rows 12 and 13 are recorded declines rather than pending ones — and row 13's decline is a statement about its *inputs* (one clock, one instant) rather than about its cost. The audit's summary — "a mechanism the shipping path never calls is
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
- **It does not claim §9.1's verdicts are the current state.** Two of the four are historical by construction:
  the retrieval and rerank cells describe `b0fe73f`, and §9.3 is the repair. The present state lives in
  `ARCHITECTURE.md`'s layer map and in the acceptance matrix's `S9` / `S11` rows, not in this table.
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
| **retrieval** | `cortex-eval` | `relevance-index.ts` (665 lines) builds the index and the rerank, then hands `CortexMemory` a synchronous `(question, turn) => number` through `relevanceFor` (`types.ts:359`) | **not the product — until §9.3.** With no callback the room was spent in arrival order. |
| **rerank** | `cortex-core` mechanically, `cortex-eval` in practice | `retrieval/rerank.ts` exports `rerankHits`; its callers are `relevance-index.ts:663` and `natural-language-memory.ts`, both in the harness. `cortex-memory` imports neither. | **not the product — until §9.3.** The mechanism existed one layer below and had no product caller — the same shape §3 recorded for `assemble`. |

So the audit's charge is half right, and the half it got right is the half that matters. §4.4 was also half
right for the same reason: the 91.25% row *does* run `CortexMemory`, and the ranking inside it comes from the
instrument.

**Two of the four verdicts above are historical, and the table now says so.** They read `not the product`
because that was true at `b0fe73f`; §9.3 records the repair — `retrieval/search-index.ts`, 560 lines, the
product's own postings, optional vector channel, RRF and optional rerank — and the acceptance matrix carries the
two rows that measure it: `S9` (the product ranks its own evidence) and `S11` (nothing ranks). The past tense
stays, because an audit has to keep saying what it found. What changed is that the bold verdict no longer stands
alone: a reader who stops at this table was reading a claim about 2026-08 as if it were about today, and that has
already happened once — a question about where the semantic layer lives was answered off this table by an author
who had the §9.3 repair in front of them and did not follow the arrow.

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

## 10. What moved, and the defect that had to be fixed before anything could

`docs/DECISION-SEMANTIC-LAYER-ROUTE.md` chose route B — wire the kernel — and fixed the order: a fact source
first, because `assemble`, `reviseLedger` and `resolveContradiction` all consume `KnowledgeFact[]` and a wiring
that hands them an empty list is indistinguishable from working. This section records the first step of that
order and the defect it uncovered.

### 10.1 The row that moved

| # | capability | before | now | by |
| ---: | --- | --- | --- | --- |
| 4 | 11 edge types + admissibility table | `I` | **`P`** | `semantic-facts.ts` calls `deriveSupersedes` over the two facts it builds; `memory.ts` calls `semantic-facts.ts` |
| 2 | 9 fact types (closed set) | `I` | `I` | the fact source writes `type: 'state'` and the checker validates it against `FACT_TYPES`; one member of nine being written is not the closed set being reachable |
| 7 | Bitemporal `Fact` (two axes) | `T` | `T` | untouched. The facts the product builds are `KnowledgeFact`, which carries one time; the two-axis type still has zero constructors |
| 11 | `assemble`, four questions, `asOf` | `E` | `E` | exit criterion E2, and it needs the facts this step produces before it can be called on anything |

### 10.2 The fact source, in one paragraph

`supersede.ts` reaches `replace` only after three checks — the quote is in the evidence character for character,
the date is on the same record as the quote, and that record is later than the one the previous answer rests on.
That is the strongest authorisation in the campaign, and until `semantic-facts.ts` existed its result was thrown
away one frame after being computed. The module builds two `KnowledgeFact`s on one slot (`subject` = the
question, `predicate` = `'answer'`), dated from the two records, with the `supersedes` edge `deriveSupersedes`
derives from the dates rather than from a guess. `renderBlocks` renders them; `prompt.ts` puts the block between
the evidence and the question. Zero model calls, and the sentence stays — the facts are added beside the
evidence, never in place of it, because the campaign's `−19.62` for atom substitution stands unretracted.

### 10.3 The defect: the record splitter never split a real prompt

This was found by needing the record's own date, and it is the largest thing in this round.

`evidenceRecords` used to open a record at a line whose first non-space character was `[`. **No line of a real
prompt starts with a bracket**: `formatEvidence`'s default label is `` `${index + 1}. ` ``, so a delivered turn
opens `1. [2023/01/15 (Sun) 09:10] user: …`. The splitter therefore produced **one record holding the entire
evidence**, on every question, in every run that used the pass.

Three consequences, in order of severity:

| consequence | what it meant |
| --- | --- |
| `answerRecord === last.index === 0` always | the ordering check skips a comparison inside one record **by design**, so `§13.371`'s `not-later` guard — written to stop a correct answer being replaced by the value it supersedes — **never ran on the shipping path** |
| the "same line" date rule degraded | from *the date is on this record* to *the date is somewhere in the window*, which is a different and much weaker claim |
| `record` was a constant `0` | the field the census publishes described nothing |

**Why no test caught it.** Every fixture in `supersede.test.ts` was an unnumbered string. The guard's own test —
the `ed4ddc30` case, which is the reason the guard exists — passed because the fixture was a rendering the
product never produces. This is the third instance in this repository of a test that agreed with the code
rather than with the system, and the first where the disagreement was a *whole-population* one: not a rare
input, but every input.

**Repair.** `RECORD_OPENS = /^\s*(?:#\d+\s|\d+\.\s)?\[/` — the position label is optional, so an unnumbered
evidence keeps the exact split it had and every fixture written before this repair still describes what it
described. Four tests now pin the numbered shape, including the `not-later` case that could not previously
fire. The trailing newlines a `\n\n` separator leaves on a record are stripped, so a record's text is the turn's
text — the fact source stores it.

### 10.4 What is deliberately not claimed

- **No dispatch was made.** Every number in this section is a line count, a call-chain fact, or a test result.
  The mechanism is off by default and E6 — the paired reading — is `unrun`.
- **E1 is not "closed" by this section alone.** The criterion is *a behavioural test in which the same corpus
  produces different prompt bytes because of the fact*, and that exists
  (`semantic-carry.test.ts`, three conditions: empty store, switch off, both). What is not established is that
  carrying the fact makes an answer **better**, which is E6's question and needs a dispatch this round did not
  spend.
- **The `−19.62` stands.** Nothing here replaces text with atoms.

## 11. The ledger reaches the block, and the value it refutes stops being served as a fact

§10 built a fact source and this section is what happens when the exit is wired to it. It is the second step of
`DECISION-SEMANTIC-LAYER-ROUTE.md` §3's order, and it moved five rows.

### 11.1 The defect the wiring exposed

For one round the block looked like this:

```
UPDATES:
fact:     30 dozen  [state]
status:   replaces "20 dozen"
fact:     20 dozen  [state]
status:   superseded by "30 dozen"
```

`20 dozen` is a **refuted** value. It was printed on a `fact:` line, at the same weight as the value that
replaced it, and the only thing distinguishing them was a relation line the reader had to parse. Nothing was
wrong with `renderBlocks`; the problem was that **nothing had ever written `refuted`**. The facts carried no
assumptions at all, so `reviseLedger`'s `apply` found no `persistence` to rewrite and returned each fact
unchanged — a mechanism that is imported, called, and inert, which is the failure §4.3 priced.

Two changes fix it and neither is optional: `deriveAssumptions` gives each fact a `persistence` and a
`uniqueness`, and `reviseLedger` runs over the built unit. Then `assemble` — the single exit — refuses the
refuted fact, and the block becomes the one thing a memory layer should say:

```
UPDATES:
fact:     30 dozen  [state]
status:   replaces "20 dozen"
assumed:  confirmed
```

Nothing is lost. The relation line still quotes the value it replaced, so the reader knows both values; what
changes is that the stale one is no longer *served* as a fact.

### 11.2 The order, and why it is not stylistic

`buildKnowledgeUnit` then `reviseLedger`. A revision applied before the build would write a `refuted` onto a
fact whose span and grounding had not been checked, so a refused unit would leave a modified fact set behind
and a caller reading it would see a refutation from a unit that does not exist.

`frame.at` is the later record's instant, and that is also the `openedAt` of every assumption: both facts
entered one ledger at one moment — the one where the substitution was authorised. The block then reads the
ledger at that same instant rather than at wall-clock now. Without it `deriveAssumptions` opens every
assumption at the epoch and `assumptionPenalty` reports `aged` for every unit this module can build. That
number is invisible — `penalty.reason` is not rendered — which is precisely why it is asserted in a test and
not left to an artifact.

### 11.3 The kernel gap this closed

`renderBlocks` has carried `omitFrame` since the semantic block was first written, and its own comment names
this caller. `assemble` had no way to pass it, so the budget it spends on the rendered form was spending room
on a line the caller cannot print. `AssembleInput.omitFrame` is that option: additive, default `false`, and the
trial render and the delivered render now measure the same thing. The alternative — take `served` and render
separately — was rejected because it drops the conflict `flags` `assemble` computes, and nothing in the
caller's own output would show the loss.

### 11.4 What is declined, and the arithmetic that decided it

Row 12 (`resolveContradiction`) stays `I`, and it is now a **recorded decline** rather than a pending item.
`DECISION-SEMANTIC-LAYER-ROUTE.md` §6.1 has the table: the function's two inputs (`confidence`, `sourceTrust`)
do not exist on `KnowledgeFact`, giving both facts the same value is not neutral, and the measured result on
the pair as the fact source orders it is a winner of **`20 dozen`** — the value the revision just refuted —
with a posterior of 0.999. The belief ties because the arithmetic is symmetric, and the tie is broken by array
order. A call site would be decoration that changes an answer for the worse.

### 11.5 The rows

| # | capability | before | now | by |
| ---: | --- | --- | --- | --- |
| 3 | polarity, modality, futurity, plan state | `I` | **`P`** | `assemble` evaluates `isPlan` / `planFactor` on every candidate. Stated precisely: no fact the product builds carries a plan state, so the futurity arm answers `1` — the module is called and its plan vocabulary is never exercised |
| 6 | `slotKey(subject, predicate)` | `I` | **`P`** | called by `deriveAssumptions` and by `assemble`, both reached from `semantic-facts.ts` |
| 8 | assumption ledger, 6 kinds | `E` | **`P`** | `deriveAssumptions` in `semantic-facts.ts` |
| 10 | revision: supersede, cascade, plan lifecycle | `E` | **`P`** | `reviseLedger` in `semantic-facts.ts`; the cascade stays off, and that is `revision.ts`'s own published default |
| 11 | answer-side exit, four questions, `asOf` | `E` | **`P`** | `assemble` in `semantic-facts.ts`, with `omitFrame` and a positional rank |
| 12 | contradiction, log-odds fusion | `I` | `I` | **Declined** — §11.4 |

### 11.6 What this does not claim

- **No accuracy claim.** `semanticCarry` is still off by default, still zero-reach on a population whose
  questions each bring their own corpus, and E6 is still `unrun`.
- **The rank is not a relevance score.** `assemble` needs one number per candidate and this caller supplies a
  position — `factIds` is the order the fact source asserts. It decides nothing while the ledger is on, because
  the refuted fact never reaches the ranking; inventing a similarity would be a second retriever nothing else
  could see, which is `assemble`'s own stated refusal.
- **Five rows is not five mechanisms.** Rows 3, 6, 8, 10 and 11 are reached through **one** file, over **two**
  facts per unit, with values this module fixes. The reach is real and it is narrow, and the table says which.

## 12. `MemoryType` gets a value it writes and a reader that acts on it

§5.2's finding was that `'semantic'` appeared in this repository exactly once — in the declaration of the
union — and that "cortex has semantic memory" was therefore not merely unwired but **unrepresentable**. This
section closes it. E3 (`DECISION-SEMANTIC-LAYER-ROUTE.md` §3 row 3) states the criterion as *`MemoryType` writes
and reads `'semantic'`*, names the fake as *a settable label nobody reads*, and names the check as *one test:
write → read back → behaviour changes*.

### 12.1 What was actually missing

The store the product owns is `CortexMemory`'s semantic slot: eight authorised substitutions, each a
`KnowledgeUnit` with two facts and a `supersedes` edge. It held `SemanticUpdate` — a unit, a fact order, an
anchor — and **no `MemoryValue` at all**. So the one place in the product where a memory about the world (as
opposed to a reading of a window) exists was the one place the product's own memory type never reached.

That is why E3 is not decoration dressed as a type. A memory layer's taxonomy is the claim that not all
memories are the same kind of thing; a store that has two kinds of content and one type for both cannot say so,
and the eviction is where it pays: `shift()` gave up the entry that had been held longest, which is the right
rule for observations and the wrong one for knowledge.

### 12.2 The write

`semantic-facts.ts` gains `memoryForUpdate`: the `MemoryValue` an authorised update *is*. Five fields are
given a value and each has a source, and the three easiest to invent are deliberately absent.

| field | value | where it comes from |
| --- | --- | --- |
| `id` | `update.key` | the dedup key, so one update is one entry |
| `content` | the rendered block | the characters a prompt would carry, produced by `assemble` |
| `type` | `'semantic'` | the claim |
| `source` | the record header | the record the authorisation was read from — not `'supersede'`, which names the mechanism rather than the provenance |
| `createdAt` / `lastAccessedAt` | `now` | the store's injected clock, **not** `learnedAt`: an entry absorbed in 2026 whose corpus is dated 2023 must not read as older than the store holding it |

`value`, `confidence`, `sourceTrust`, `stability` and `difficulty` are left to `createMemory`, which is exactly
what an admitted turn carries. A semantic entry with `value: 1` would be a claim about future utility that no
observation supports.

Building the entry forced one repair in the splitter. `source` initially came back as `2. [2023/03/12 …] user:`
— the renderer's **position prefix**, which is a position in one window and not a property of the record. The
same sentence is `5. ` in a window with three more turns in front of it, so the provenance would have changed
between two renderings of one record. `splitRecord` now strips the prefix with the pattern `supersede.ts` uses
to find record boundaries.

### 12.3 The read

`retention.ts` is a `Record<MemoryType, RetentionRule>` and `leastRetained` compares the pair it produces.

| type | rank | why |
| --- | --- | --- |
| `semantic` | `[lastAccessedAt, reads]` | kept by being *used*; an entry no window has carried is the first to lose |
| `episodic` | `[createdAt, 0]` | a turn is a reading of one window; how often a later window quoted it says nothing |
| `procedural` | `[createdAt, 0]` | same, stated rather than defaulted so the table has no silent member |

A table rather than `if (type === 'semantic')` for a specific reason: the union would otherwise have two
members that exist as a comment, and a fourth member added later would fall through to whatever the `else` did.

The second element is a **read count**, and the reason is not a preference. The clock is injected and fixed
(`CortexMemoryOptions.now`), and the store stamps one instant on every entry, so within an instance every
`lastAccessedAt` is equal whether or not a window ever carried the entry. A rank of `[lastAccessedAt]` alone
would order nothing, and a test asserting it would pass on a store where the read-back never happened. The
count is the quantity the store genuinely observes, so the tie-break is that count.

`reads` lives on the store's own record and not in `MemoryValue.value`, whose contract is `[0, 1]` and whose
producer is the admission gate — two scales sharing one field is the defect `math/fsrs.ts` spent a docstring
repairing in the time domain.

### 12.4 The pair that makes it a criterion and not an assertion

`semantic-memory-type.test.ts` runs two stores through nine absorptions — the eighth fills the bound, the ninth
crosses it — and differs in **one event**:

| condition | what the store saw | what is evicted |
| --- | --- | --- |
| A — control | eight updates, no window in between | `record 0`, the oldest |
| B — mechanism | eight updates, one window over `record 0` | `record 1`, the one after it |

Under a store that ignored `type` — and under the `shift()` this replaced — A and B reach the same store. Only
the pair separates "the rule read the type" from "the rule happened to agree with insertion order", which is
why B alone would have been an assertion about the code rather than about the product.

`semanticCarryCensus()` gained `stored`, a count **over `MemoryType`** rather than over events. Eight
`episodic` entries would be eight absorptions by every other number in that object; the type census is the only
place the product's own taxonomy appears in a reading.

### 12.5 What the census found without being asked

`tools/export-census.mjs` reported `cortex-core: MemoryType` **leaving** the orphan ledger this round, because
`retention.ts` imports it. It had been listed as `referenced-locally` — the symbol has a live call site and only
its `export` keyword is unnecessary — but for a union member that classification was the whole problem: the
type was exported, documented, and read by nothing.

The gate also caught two exports written in this round and withdrawn in it: `retentionRank` (the ranking and
the choice it feeds are one decision, so the boundary is `leastRetained`) and `Retainable` (nothing outside
names the parameter type). That is the fifth round running in which this gate reported a symbol in the round
that declared it.

### 12.6 Mutations, all eight killed

| # | mutation | killed by |
| ---: | --- | --- |
| 1 | `type: 'semantic'` → `'episodic'` | all four end-to-end tests |
| 2 | `leastRetained` → `return 0` (the old `shift()`) | the mechanism test **only** — the control stays green |
| 3 | `stored.reads += 1` → `+= 0` | the mechanism test only |
| 4 | the position-prefix strip removed | the `source` test |
| 5 | `content` → `''` | the `content` test |
| 6 | `id` → `crypto.randomUUID()` | the `id` test |
| 7 | `createdAt` → `learnedAt` | the stamp test |
| 8 | `source` → the body | the `source` test |

Mutations 2 and 3 are the ones that matter: each kills **only** the mechanism test and leaves the control green,
which is what says the pair is causal rather than parallel.

### 12.7 What this does not claim

- **No accuracy claim, again.** `semanticCarry` is still off by default, still zero-reach on a population whose
  questions each bring their own corpus, and E6 is still `unrun`.
- **The retype does not change any archived bytes.** The store is rebuilt per instance, the block's content is
  unchanged, and `semantic-carry.test.ts`'s byte-for-byte comparison between condition B and a control store is
  still the assertion it was.
- **`dropped` is now a function of the read history, not of arrival order.** On a run where every question
  brings its own corpus no window ever reads an entry, so the count is identical to the one `shift()` produced —
  and the difference only appears where the mechanism is supposed to exist.

## 13. The forgetting clock has one instant in it, and nothing reads what it writes

E4 asks for one of two things: a caller, or an explicit `Declined` with the reasons written down. `consolidate`
gets the second, and this section is the evidence rather than the verdict —
[`DECISION-SEMANTIC-LAYER-ROUTE.md`](DECISION-SEMANTIC-LAYER-ROUTE.md) §6.2 is the verdict.

### 13.1 What the mechanism needs, and what the product has

`consolidate(memories, graph, accesses, { now })` does three things: an FSRS review per access record, Hebbian
strengthening on co-activation, and a cull of every entry whose retrievability has fallen below a threshold
(default `0.01`, i.e. `exp(-4.6)` ≈ 4.6 stable intervals). Its inputs are therefore **time** — an access instant
per record and a batch instant — and **a store whose entries were stamped by the same clock**.

The product, since E3, has such a store: `CortexMemory`'s semantic slot holds `MemoryValue`s built by
`memoryForUpdate`. What it does not have is a second instant. `CortexMemoryOptions.now` is a single number per
instance, and `memoryForUpdate` stamps `createdAt` and `lastAccessedAt` with it. So:

| quantity | value | why |
| --- | --- | --- |
| `now − lastAccessedAt` for every entry | `0` | one clock, one stamp |
| `retrievability(0, 1)` | `1` | `exp(0)`; stability defaults to one day |
| the default threshold | `0.01` | `exp(-4.6)`, i.e. **4.6 stable days away** |
| entries the cull can remove | `0` | the gap is not small, it is unbridgeable inside one instance |

The cull cannot fire. Not at a boundary and not rarely — never, for as long as the store is one instance with
one clock. And a review pass with no access records has nothing to review, so the batch is a no-op that returns
a counter.

### 13.2 The state it writes has no reader

A review moves `stability` and `difficulty`; the cull reads `stability`. In `packages/cortex-memory/src` the
access `.stability` occurs **zero** times, and `.difficulty` likewise. So the FSRS state is a closed loop
between `consolidation/consolidate.ts` and `math/fsrs.ts`: written by one, read by the other, and by nothing
that decides anything. A wired call would multiply a field by `1.25` per read — `review`'s no-spacing floor —
and hand the result to nobody.

That is the decoration `AUDIT-SEMANTIC-REACH.md` §4.3 priced, arrived at from the other side: not a symbol
imported and never called, but a call whose output has no consumer. `semantic-reach.test.ts` now asserts the
zero, which makes the decline **self-cancelling**: the day a product module reads `.stability`, that test fails
and the decline has to be re-argued against whatever the module wanted it for.

### 13.3 Its direction of action is what `not-later` exists to prevent

Forgetting removes an entry because time passed. The entry is not an observation of a window; it is a
substitution whose corpus still says `30 dozen`. Dropping it does not make that statement false — it makes the
prompt fall back to the evidence, where the superseded `20 dozen` sits unmarked. That is the exact outcome
§13.371's `not-later` guard was written against, and the defect a previous round found when a refuted value was
printed as a fact beside its replacement.

The question the store genuinely has is *which* entry to give up when the bound is crossed, and E3 answered it by
read-rank (`lastAccessedAt`, then the read count). A decay rule would be a **second** eviction rule over the same
eight slots — and the two would disagree on exactly the case that matters, an entry that is old but carrying the
current answer.

### 13.4 The trap this found, and the repair

The forgetting pass read `Date.now()` while the entries it aged had been stamped by the caller's clock. No test
could see it: every fixture in `consolidation-clock.test.ts` and `consolidate.test.ts` stamps `Date.now()`, so the
two clocks agreed on every input the suite had. That is the same shape as the unit defect
[`AUDIT-CONSOLIDATION-CLOCK.md`](AUDIT-CONSOLIDATION-CLOCK.md) records — a fixture that happens to satisfy the
code — one argument further along.

It bites exactly the caller who would wire it. A replay pins `now` to the corpus date; a batch consolidated
today then measures `2023-03-12` against today, `exp(-1343)`, and **deletes the entire store**:

| caller | entry stamped | batch clock used | `forgotten` |
| --- | --- | --- | --- |
| a fresh process, `now = Date.now()` | now | now | `0` |
| a replay, `now` pinned to the corpus | 2023-03-12 | wall clock | **every entry** |
| a replay, after the repair | 2023-03-12 | `now` | `0` |

`now` is a required parameter now, and there is no default: a default of `Date.now()` would be right only for
callers who stamp with wall time, and silently wrong for everyone else. The module header says the batch is
"pure, side-effect-free orchestration", which was false while it read a wall clock; it is true now, and the
signature is what enforces it.

Two `@ts-expect-error` lines in `consolidation-clock.test.ts` pin the shape:

```ts
// @ts-expect-error -- no options at all: the batch instant has no default.
const noOptions = () => consolidate(build(), new MemoryGraph(), []);
// @ts-expect-error -- other options given, clock still missing, still refused.
const noClock = () => consolidate(build(), new MemoryGraph(), [], { decay: false });
```

The second is the one that matters. The first only says the fourth argument is required; the second says an
author who supplies *other* options still cannot omit the clock — which is the realistic omission, and the one an
optional field with a `?? Date.now()` fallback would let through.

### 13.5 Mutations

| # | mutation | killed by |
| ---: | --- | --- |
| 1 | the forget pass back on `Date.now()` | *keeps an entry stamped at the batch instant* — `1 failed` |
| 2 | `now?: number` with `?? Date.now()` | `tsc`: `TS2578 Unused '@ts-expect-error' directive` |
| 3 | `lastAccessedAt` ← `learnedAt` instead of the store clock | the stamp test **and** the elapsed-time test — `2 failed` |
| 4 | a product module reads `.stability` | the reach alarm in `semantic-reach.test.ts` — `1 failed` |

Mutation 2 is a type-level kill rather than a runtime one, and it is the one that keeps the trap closed: a
fallback reintroduces the second clock without changing a single assertion, because every fixture passes `now`
explicitly.

### 13.6 A fact about this repository's test topology, found by being wrong

The first run of the new memory-side test failed with `forgotten === 1` **against correct source**, because
`cortex-memory` imports `@agentix-e/cortex-core` through the package barrel, i.e. through `dist/`. A signature
change in core is invisible to memory's tests until `pnpm build` runs — the assertion was reading the previous
build, which still consults the wall clock. `pnpm check` builds first, so the gate was never at risk, but a
reader running one package's tests after editing another's source is. Recorded here rather than fixed: the
alternative is `paths` aliasing every package to its source, which changes what every test in the repo is
actually importing.

### 13.7 What this does not claim

- **No accuracy claim.** `semanticCarry` is still off by default and E6 is still `unrun`.
- **The decline does not say a forgetting clock is wrong for a memory layer.** It says this store has no clock
  to run it on and no reader for its output. Reopening conditions are in §6.2 of the decision: entries stamped on
  more than one clock, and a decision that ranks retention by FSRS state.
- **`consolidate` is not worse off for it.** It gained a required clock, two type-level guards and a test whose
  fixtures no longer agree with the code by accident. Its coverage is 100/100/100/100.

## 14. The eviction rule moved to the domain, and the count it ranks by had to move first

### 14.1 What was in the wrong package, and why the signature was the tell

§12 built `leastRetained` in `cortex-memory`, and the argument for the placement was never made — the file was
written where the store is. It is a pure function over a `MemoryValue`: no clock, no store, no I/O, nothing to
await. `cortex-core` states that as its own reason to exist (*"contracts + pure algorithms (zero I/O, Node +
browser)"*, `packages/cortex-core/package.json`), so on the package's own terms the rule was on the wrong side of
the boundary for one round.

The signature is what made it visible. It read:

```
leastRetained(entries: readonly { readonly memory: MemoryValue; readonly reads: number }[]): number
```

Every input of a pure rule should be a value the domain can name. `reads` was not: `MemoryValue` had no field for
it, the store kept it on its own `StoredUpdate` record, and the caller passed it in. A rule that needs an input the
domain type cannot express is a rule the domain cannot describe, and the second parameter is where that shows up.

This is not a tidiness claim. Had the count stayed outside, the rank would have been a function of the entry
**plus** whatever the caller claimed about it, and nothing would have stopped two callers from claiming different
counts for the same entry. The field makes the count a property of the entry, so the rank is a function of the
entry alone.

### 14.2 The repair, in the order it had to happen

1. `cortex-core/src/domain/memory.ts` — `MemoryValue.reads: number`, required, defaulted to `0` in `createMemory`.
   Required rather than optional, for the reason §12 gave about `MemoryType`: a field that a constructor may omit
   is a field half the fixtures will omit, and the compiler is the only reader that never forgets.
2. `cortex-core/src/domain/retention.ts` — the table, the rank and `leastRetained`, with
   `RetentionRule = (memory: MemoryValue) => readonly [number, number]` and no second argument.
3. `cortex-memory/src/memory.ts` — `StoredUpdate` loses its `reads` field; the eviction projects the records onto
   the entries they hold (`leastRetained(this.#semanticUpdates.map((stored) => stored.memory))`), and the read-back
   increments `stored.memory.reads`.
4. `cortex-memory/src/retention.ts` and its test are deleted. There is no re-export: a compatibility shim would
   have kept two import paths for one rule and made the census count it twice.

`reads` is **not** `MemoryValue.value`, and that distinction is the whole reason the field exists rather than the
count being folded into the utility the domain already had. `value` is `[0, 1]` by contract and is computed by an
admission gate from a caller-supplied `valueFunction`; these entries never pass that gate. A use count is
unbounded and observed. One field holding two scales is the defect `math/fsrs.ts` spent a docstring repairing in
the time domain, and the repair there was to stop sharing a literal rather than to add a second meaning.

### 14.3 What the required field cost, counted

`tsc` reported **17** errors across 13 test files, and every one was the same shape: a hand-written `MemoryValue`
literal in a fixture that had listed the twelve fields it cared about and would now have to list thirteen. Fifteen
of them were a single stub (`stability: 1, difficulty: 5,` followed by the new `reads: 0,`).

That is worth recording rather than apologising for: the 17 errors are the count of places this repository
constructs a `MemoryValue` by hand instead of through `createMemory`. **Zero** production modules needed a change
— `memoryForUpdate`, `admitInto` and every other constructor already go through `createMemory` or spread its
result — so the cost of the field is exactly the cost of the fixtures that were bypassing it.

`cortex-storage` was checked before the field was added and does not serialise `MemoryValue` at all (zero
occurrences in `packages/cortex-storage/src`), so no schema, no migration and no persisted artefact is involved.

### 14.4 What the tests now assert that they could not before

§12's five assertions are unchanged in intent and rewritten in shape: entries rather than `{ memory, reads }`
pairs. Three are new.

| # | assertion | what it is for |
| ---: | --- | --- |
| 1 | `createMemory(...)` has `reads === 0` **and** `value === 0.5` | independence: the count was not folded into the utility field |
| 2 | `const wrongShape: readonly MemoryValue[] = [{ memory, reads: 3 }]` under `@ts-expect-error` | the old shape is not assignable, so the caller-side count cannot come back without a compile error |
| 3 | `leastRetained([])` returns `0` and a single entry returns `0` | the documented contract, including the `-1` sentinel the implementation refuses to add |

### 14.5 The mutations this round is built to kill

| # | mutation | killed by |
| ---: | --- | --- |
| 1 | `semantic: (memory) => [memory.lastAccessedAt, 0]` | the semantic case dies; the episodic control stays green — which is what proves the count is the causal input |
| 2 | `leastRetained` returns `0` | every assertion whose expectation is non-zero |
| 3 | the parameter goes back to `{ memory, reads }[]` | `tsc`: `TS2578 Unused '@ts-expect-error' directive` |
| 4 | `reads` written into `value` instead of its own field | the independence assertion in 14.4 |

Mutation 1 is the pair again: on its own, "the unread entry loses" is a statement about one code path. What makes
it a measurement is that the **same counts** on `episodic` produce the opposite victim, so the type is doing the
work rather than the index.

### 14.6 Why `semantic-facts.ts` stays in `cortex-memory`, asked once so it need not be asked again

It imports seven semantic-kernel symbols from `cortex-core` (`assemble`, `buildKnowledgeUnit`,
`deriveAssumptions`, `deriveSupersedes`, `locate`, `reviseLedger`, and the `KnowledgeUnit` types) and one thing
core does not have: `SupersessionVerdict` from `./supersede.js`, whose producer decides with a model call. Moving
the module up would drag the LLM interface and a prompt into a package whose contract is zero I/O.

The split that survives both questions is: **pure decisions live where the domain is; the composition of a
decision with a model call lives where the model is.** `leastRetained` is the first. `semantic-facts.ts` is the
second, and `memory.ts`'s `#semanticAbsorb` — which splices, counts and mutates — is the third.

### 14.7 What this round does not claim

- **No accuracy claim, and none is possible from a move.** `semanticCarry` is still off by default and E6 is still
  `unrun`; a refactor that changes no behaviour predicts `deltaQuestions === 0`, and a non-zero reading would mean
  the move leaked across questions.
- **No claim that the rest of `cortex-memory` is correctly placed.** This round adjudicated one file with a pure
  rule in it. `question-shape.ts`, `confidence.ts` and `tally.ts` were not examined, and the layer map's staleness
  (§14.8) is the reason to suspect at least one more.
- **No claim that the layer map is now complete.** It lists directories, not files; a file added inside a listed
  directory is still invisible to it.

### 14.8 The documentation defect that prompted the question

The question this round answered — *"is the semantic layer really in `cortex-memory`?"* — was reasonable, and the
architecture document is why. `ARCHITECTURE.md` §2 listed eight `cortex-core` directories and omitted
`knowledge/` (2,089 lines) and `triage/` (4,188 lines): **6,277 of the package's 11,085 non-test lines, 56.6% of
it**, and the whole of the semantic kernel. It likewise listed thirteen `cortex-memory` modules and omitted
`semantic-facts.ts`. A reader taking the map at face value would conclude that the semantic layer is a `memory`
concern, which is the opposite of what the reach table says.

The map is now complete at directory level and states the two counts that make the kernel's weight visible. That
is the repair; the deeper one — a generated map, checked like `docs-crosscheck` checks its markers — is not done,
and recording it here is the alternative to pretending the drift cannot recur.

---

## 15. E6 had no arm, and every round that called it `unrun` was describing the wrong obstacle

E6 is the eighth and last semantic-layer exit criterion: *a paired readout with `deltaQuestions >= -5`*. Six
rounds have closed with the sentence "E6 is `unrun`", and each one read that as a note about budget — the next
step being a dispatch. It was not. **The treatment could not be administered at all.**

### 15.1 What was missing, as three separate objects

| # | Object | The fact | Where it showed |
| ---: | --- | --- | --- |
| 1 | the arm's option surface | `CortexMemoryArmOptions` carried no `semanticCarry` field, `cortextMemoryArmOptions` read no environment variable for it, and `bench/run-ablation.ts` forwarded twenty-five product options into the constructor — every one of them with a paragraph on why absence is the shipped configuration. Twenty-six was not among them. | a run could not turn the mechanism on |
| 2 | the artifact's census | `CortexMemory.semanticCarryCensus()` exists, is tested, and no reader in `cortex-eval` named it. `traceCensus` reads three accessors (`recoveryCensus`, `auditCensus`, `supersessionCensus`); the carry census was a fourth with no caller. | a dispatch, had one been possible, would have produced `delta = 0` with nothing on the record to say whether the layer carried nothing or never ran |
| 3 | the criterion | `S9` and `S10` and `S11` exist for the ranking's three arms; the semantic layer had no row at all. | even a reading would have been compared against nothing |

The three are one chain, and the third is why the first two were invisible: a criterion with no row cannot be
`unrun` in any way a reader would notice, because the only record of it was a sentence in a document.

### 15.2 Why `0` is the number this population must produce, and why that is a design fact

An update is about the record it was authorised by. `updateAppliesTo` is a substring test on that record against
each turn of the window (`semantic-facts.ts:383`), and the docblock above it says why a softer test would be
wrong: a similarity would let an update about one corpus reach a question about another, which on a benchmark is
a cross-question leak. The registered population answers every question from its own corpus, so **no question's
window ever carries another question's record**, and the reach is zero by construction — `DECISION-SEMANTIC-
LAYER-ROUTE.md` §5 states this, and `semantic-carry.test.ts` asserts it for the one-instant case.

So E6 on this population is `0`, and `0 >= -5` is a pass. A pass that means *the treatment did not run* is worse
than no row, which is what §15.4 is for.

### 15.3 The repair, in three parts

1. **`CORTEX_MEMORY_SEMANTIC_CARRY`**, read by `readToggle` like every other boolean in the arm (`'1'` on, absent
   is the control), projected into `CortexMemoryArmOptions` in both the enabled and the disabled state, forwarded
   conditionally into the constructor, echoed on the run's config line, and recorded in `featureConfig`. The
   conditional spread is the house shape and its reason is the same one every other option gives: absent is the
   state every archived artifact was produced under, so a present-but-false key would make "the control ran" and
   "the treatment was configured off" two facts the artifact cannot tell apart.
2. **`semanticCarry` on the report**, folded over every instance the run answered through (`censusSourcesOf`,
   §13.244), absent when the build has no accessor. The fold carries the store's own arithmetic as a check:
   `absorbed - dropped` equals the sum of `stored`, because `stored` counts the entries in hand. A record that
   breaks it is dropped rather than published, which is the rule `supersessionAcross` applies to
   `attempted === replaced + refused`.
3. **`S12` and `S13`**, with `S12.requires = ['S13']` and a fifth evaluation state, `void`, for a number that
   exists and cannot answer its row's question.

### 15.4 Why the row needed a new state rather than a stricter threshold

No threshold separates "the layer gained nothing" from "the layer did nothing": both read `0`. No comparison of
one number can either. What separates them is a second number — the reach — and the only way to make a row's
verdict depend on another row is to declare it. So `Criterion.requires` exists, `applyRequirements` is a second
pass over the whole matrix (it needs every verdict, which `verdictOf` deliberately does not), and `void` is the
state it produces. `void` is counted with `unrun` and `stale` by the release gate and labelled separately,
because the repairs differ: a dispatch, an artifact re-hung, a population.

### 15.5 Mutations

Seventeen, all killed, each run in isolation against the suite that owns it:

| # | Mutation | Killed by |
| ---: | --- | --- |
| 1 | parser returns `false` regardless of the variable | "turns it on for the strict string `1`" |
| 2 | `readToggle(..., { defaultOn: true })` | "an unset variable is the control" |
| 3 | disabled arm projects `semanticCarry: true` | "projects the control on a disabled arm" |
| 4 | `options.semanticCarry !== false` in the config projection | the hand-built options case: `undefined` must record `false` |
| 5 | the census is not attached to the report | "carries the census" |
| 6 | `served` summed as `0` | the pool test's `served === 3` |
| 7 | `withheld` summed as `0` | the pool test's `withheld === 3` |
| 8 | `stored` overwritten per instance instead of summed | the pool test's `stored.semantic === 3` |
| 9 | the `absorbed - dropped` invariant dropped | "omits a census that contradicts itself" |
| 10 | the three-name `stored` check dropped | "refuses a `stored` census over more or fewer names" |
| 11 | the constructor spread deleted | the text assertion in `semantic-carry-arm.test.ts` |
| 12 | the log clause deleted | the same |
| 13 | `featureConfig` drops the entry | the same |
| 14 | `applyRequirements`'s fixpoint replaced by one pass over the input statuses | "names every unmet precondition", whose list puts the dependent row **first** |
| 15 | the unknown-id throw removed | "refuses a precondition that names no row" |
| 16 | `blocking: false` flipped to `true` on a `void` row | "cannot pass while its precondition has not" |
| 17 | `requires` read as an empty list | "cannot pass while its precondition has not" |

Mutations 11–13 are **text** assertions, and that is the weakest thing in this round: `bench/**` is excluded from
coverage as an entry point, so the line that carries the treatment from the parsed options into the constructor
cannot be executed by any test. Every other treatment in this arm has the same gap and the same compensation
(`maxTurnChars` documents it in the constructor). What is different here is that the artifact now carries the
reach beside the switch, so a spread deleted in a future change would show up as `semanticCarry: true` with
`absorbed: 0` on a run that asked knowledge-update questions — visible, but only to a reader who looks.

### 15.6 What this round does not claim

- **No reading.** Nothing was dispatched: this environment has no reader credential and cannot reach the
  dataset host. `S12` is `void` and `S13` is `unrun`, and the matrix prints exactly that.
- **No claim that the registered population can carry the mechanism.** It cannot, by §15.2, and `S13`'s `onMiss`
  says what the repair is: two windows over one corpus rather than another dispatch of this one.
- **No claim that a dispatch of `S12`/`S13` would be informative.** On the registered population it would produce
  `0` over `0`, which is `void` — a correct report of a population that cannot answer the question.
- **No accuracy claim.** `semanticCarry` remains off by default; `CORTEX_MEMORY_SEMANTIC_CARRY` unset is the
  state every archived artifact was produced under, and it still is.

One sentence: **this round did not give the semantic layer a number — it gave it the ability to have one, and
made the row refuse to pass until it does.**

## 16. E6's obstacle was a population, and it took four objects to make one

§15 ended with the sentence *"this round did not give the semantic layer a number — it gave it the
ability to have one, and made the row refuse to pass until it does."* Eight rounds of that sentence
is enough to ask what the ability was still missing, and the answer is not a reader credential. It is
a **population**: `S13`'s own `onMiss` names it — *"two windows over one corpus"* — and until this
round nothing in the repository could build one.

### 16.1 What the row needed, as three objects again

| # | Object | The fact | Where it showed |
| ---: | --- | --- | --- |
| 1 | the population | `loadLongMemEval` produces one question per instance and every instance carries its own haystack. There was no selector that asked a corpus twice, so `semanticCarry`'s reach could only ever be zero (`S13.onMiss`, and §15.2's arithmetic). | the mechanism had no population to act on |
| 2 | the pair | `CORTEX_MEMORY_SEMANTIC_CARRY` said what the **feature** side does; nothing said what the baseline was. `S9` compared two dispatches and paid the drift `PREREGISTRATION` §2.2 exists to bound. | the delta would have been between two runs, not two sides of one pass |
| 3 | the store | the pool gives each worker its own `CortexMemory`, and the claim loop handed out one **index** at a time. Two windows of one corpus could be answered by two workers, so the second read a store that never absorbed the first. | the treatment would run and reach nothing — the reading `S13` refuses |

The three are one chain in the same sense §15.1's were, and the third is again the one that would
have been invisible: a split corpus produces `matched: 0`, and `matched: 0` is exactly what a
mechanism that carried nothing produces.

### 16.2 The multiplication, and where it sits among the selectors

`two-window.ts` takes the loaded dataset and asks each corpus `windows` times: ids take `#wN`, the
questions of one corpus stay adjacent, and `windows = 1` returns the argument **itself**.

- **The identity is the same object, not a copy.** Every archived artifact was produced under one
  window per corpus, and a copy with the same contents would still be a second code path through the
  dataset. The `toBe` in `two-window.test.ts` is that sentence as an assertion.
- **The order is corpus-major, and that is a contract rather than a preference.** `Question.corpus`
  states it: contiguous, one instance, ascending. §16.3 is what enforces it.
- **It runs last among the selectors.** `LIMIT` asks how many corpora and `CORTEX_CAPABILITY` asks
  which, so both must see corpora rather than windows — otherwise `LIMIT=78, capability=KU,
  windows=2` would mean "156 questions, half of them second windows", and the sample size would
  depend on a multiplication nobody could see in the log.
- **It refuses a restore plan.** A plan names recorded question ids and the multiplication renames
  them, so the restriction would select nothing — after the dataset download and with a message about
  the plan rather than about the two selectors that cannot both be true.

### 16.3 One corpus, one instance — and why the claim stayed dynamic

The pool's claim loop is `next++`: the index is taken atomically and the worker that took it answers
it. That is right for an independent population and wrong for a corpus, and the fix is not a
pre-sliced array — the comment above the counter says why: slicing makes a slow worker's share the
whole pass's critical path.

`claimRun` takes the **run** instead: starting at the claimed index, it takes every following index
whose `corpus` is equal, and the worker answers them in order on its own instance. Still claimed on
demand, so the load balance is unchanged; just atomic, so a corpus cannot be split. A question with no
`corpus` claims exactly one index, which is the pass every archived artifact was produced by.

### 16.4 The control is the same system, and the pair refuses to be two controls

`arm-pairing.ts` reads `CORTEX_MEMORY_AB`: `reference` is the registered pair (the reference pipeline
against the cognitive one) and the default; `carry` builds **both** sides from one constructor with
one flag between them. `run-ablation.ts` therefore has one `buildCortex(carry)` and two callers, not
two literals that would agree until one was edited.

The refusal is the part worth writing down. `ab=carry` with `semanticCarry` off on the feature side is
two controls, a delta of `0`, and a census of `0` — a null result published for a comparison that
never administered the treatment. It is refused **before the first call**, so it costs nothing to
find out.

### 16.5 The dispatch

`semantic-carry.yml` + `tools/dispatch-semantic-carry.py`, on a real runner, with the preset written
out in the open and one declared departure: `review_pass: supersede`, because absorption happens only
in that pass on that route. A carry run on the registered `bare` pass would dispatch a mechanism with
nothing to carry. The pass is on **both** sides, so the pair still isolates the carry; what it does
not isolate is the pass, and `memoryArmConfig.reviewPass` on the artifact is where a reader checks it.

### 16.6 Thirteen mutations, and the one that lived until the test was fixed

Each mutation is applied to the source, the suite that owns it is run, and the source is restored. A
mutation **survives** when the owning suite still passes, which means the suite is not testing the line
the mutation removed.

| # | Mutation | Owning suite | Verdict |
| ---: | --- | --- | --- |
| 1 | `claimRun` claims one index at a time, even when a corpus is present | `corpus-run-claim.test.ts` | killed |
| 2 | a corpus's windows are claimed in descending order | `corpus-run-claim.test.ts` | killed |
| 3 | `withWindows` returns a copy at one window instead of the argument | `two-window.test.ts` | killed |
| 4 | the window marker becomes a prefix (`#w1q` rather than `q#w1`) | `two-window.test.ts` | killed |
| 5 | the corpus is left off the multiplied question | `two-window.test.ts` | killed |
| 6 | `readWindowCount` accepts zero | `two-window.test.ts` | killed |
| 7 | an unset `CORTEX_WINDOWS` means two | `two-window.test.ts` | killed |
| 8 | an unset `CORTEX_MEMORY_AB` means `carry` | `arm-pairing.test.ts` | killed |
| 9 | the population is dropped on the way into the report | `report-population.test.ts` | killed |
| 10 | the population line is dropped from the Markdown | `report-population.test.ts` | killed |
| 11 | the carry pair is built without the flag, reading the arm instead | `semantic-carry-arm.test.ts` | killed |
| 12 | the control side is the reference pipeline in both pairings | `semantic-carry-arm.test.ts` | killed |
| 13 | a carry pair whose treatment side was left off is not refused | `semantic-carry-arm.test.ts` | killed |

Number 1 is the one to write down, because it survived the first time and it survived *because the
test was wrong in a way that looks like success*. `runBenchmark` takes nine positional arguments and
`corpus-run-claim.test.ts` passed the worker pool into the eighth, which is `budgetMs`. TypeScript does
not catch it — a pool object where a number belongs is not a shape error at the call site, because the
parameter is typed `unknown`-tolerant in that position — and the suite then ran a **serial pass wearing
a concurrent pass's arguments**: one worker, one `claimRun` at a time, so a `claimRun` mutated into
`claim()` still answered everything correctly and the mutation lived. Two named helpers
(`runPooled`/`runSerial`) plus a comment at the helper is the fix: the suite now fails when the run is
not pooled, which is the only way that mutation reads as a mutation.

The lesson generalises past this file: a mutation that survives is a question about the *suite* first
and the source second, and the answer here was that the suite had been measuring a different
instrument than the one it named.

A mutation whose target text is not found is reported as `SETUP-FAIL` and **counted as a survivor**.
That is deliberate and it is the same rule: a mutation that was never applied cannot be told apart from
one that was applied and killed nothing, and a harness that treated "could not find the line" as a pass
would report a clean board after a refactor renamed the line.

### 16.7 The reading

Run [`43590434060`](https://github.com/AgentiX-E/cortex/actions/runs/43590434060), artifact
`14115493476`, `completed success`, about two hours. Preset: `capability=KU`, `ablation_runs=2`,
`workers=4`, `thinking=disabled`, `CORTEX_MEMORY_AB=carry`, `CORTEX_MEMORY_SEMANTIC_CARRY=1`,
`CORTEX_WINDOWS=2`, `review_pass=supersede`.

| Object | Reading |
| --- | --- |
| population | `72 corpora x 2 windows` = 144 questions, ids carry `#w` |
| carry census | `absorbed 3 / dropped 0 / matched 8 / served 8 / withheld 8`; `stored {episodic 0, procedural 0, semantic 3}` |
| the invariant | `absorbed - dropped = 3 = stored.episodic + stored.procedural + stored.semantic` — the store's own arithmetic holds across the four workers `semanticCarryAcross` folded |
| correct answers | control `245/288 = 85.07%`, treatment `244/288 = 84.72%`, **one question** over two repetitions |
| delta, second window | **`0.0`** over `n = 72` (`baselineOnly 1`, `featureOnly 1`) |
| delta, first window | `-0.5` over `n = 72` — the absorbing window, which the mechanism cannot move |
| delta, all windows | `-0.5` over `n = 144` |
| McNemar, second window, first repetition | `b = 3`, `c = 1`, `p = 0.6250` |
| the discordant four | gained `c4ea545c#w2`; lost `10e09553#w2`, `50635ada#w2`, `f685340e#w2` |
| supersession | `attempted 285 / replaced 13 / refused 272` — `no-change 204`, `restates 63`, `not-later 4`, `date-not-on-line 1`, and `unreadable`, `no-quote`, `agrees`, `not-in-evidence` all `0` |

The matrix, after this run:

```
S12  —    >= -5   unrun   semantic layer: carrying an authorised update into a later window
S13  8    >= 1    pass    semantic layer: whether the treatment reached any window at all
```

**`S13` is a pass for the first time, and it is a pass on `8`, not on `0`.** Eight questions answered
from a window that still carried a record one of the three absorbed updates authorised. That is the
first evidence this project has that `semanticCarry` reaches anything at all; every previous dispatch
reported `0`, and `0` is also what a mechanism that does nothing reports, which is why the row is a
count rather than a delta.

**`S12` is `unrun`, and that is the designed outcome rather than a failure.** The dispatch was a
screening pair — 72 corpora, 2 repetitions — and `semantic_carry_analysis.py --tier screening` writes
its delta under `screening.deltaQuestions` and leaves `paired.deltaQuestions` **absent**, so the row
that reads that key has no value. A `void`-to-`pass` transition on this population would have been a
claim about 500 corpora at four repetitions measured on 72 at two. The number the screening pair did
produce is `0.0` over the second window, and it is published — in
`cortex-docs/evidence/longmemeval/semantic-carry.json`, under a key the matrix does not read.

**One reading that is not the reading, written down because I nearly published it.** Every one of the
144 questions carries `supersessionConsultations: 4`, and `0ddfec37#w2` carries four
`supersessionReplacements` with no refusals at all. It is tempting to read those as the carry arriving.
They are not: the consultations are the *supersession pass* reading each window's candidate facts, they
are uniform across the population (144 of 144), and they appear on the control side too. The carry's
only evidence in this artifact is the census — `matched`, `served`, `withheld` — because the census is
the one field produced by the semantic store rather than by the pass in front of it. A per-question
column that is the same number on every row cannot be evidence of a treatment that reached eight of
them.

### 16.8 What this round does not claim

- **No claim that the carry is worth anything yet.** The second-window delta is `0.0`, the McNemar pair
  is `3` against `1` (`p = 0.625`), and one question was lost over two repetitions. The mechanism
  reached; whether reaching helps is unanswered, and `S12` stays `unrun` until the registered
  population is dispatched.
- **No claim that `S13`'s `8` is stable.** It is one run, four workers, two repetitions, and the
  census is a sum over instances: a second dispatch of the same shape could read a different number
  without either being wrong. What the run establishes is that the counter is not structurally zero.
- **No claim about the registered population.** 500 corpora x 4 repetitions is 4,000 questions x 2
  sides x 4 features, which is not one job. The number `8` is over 72 corpora and does not scale by
  arithmetic: the second window is where a carry can land, and how many of the 500 carry one is exactly
  what the registered dispatch would measure.
- **No claim that the pass is free.** `review_pass=supersede` is on both sides, so the pair isolates
  the carry and not the pass; 272 of 285 supersession attempts were refused, and the four refusals that
  are *not* `no-change`/`restates` (`not-later 4`, `date-not-on-line 1`) are the pass declining on
  grounds a future round may want to audit.
- **No default was changed.** `CORTEX_MEMORY_SEMANTIC_CARRY` is still unset everywhere outside these
  workflows, and every archived artifact was produced with it unset.

One sentence: **the semantic layer reached eight windows and moved none of them, and the row that
measures the movement is now waiting on a population rather than on a mechanism.**
