# SOTA-LANDSCAPE

What the frontier is, as of 2026-10-28, and what each published mechanism would have to do to be worth copying.

## 0. One paragraph

The published LongMemEval frontier is **96.20%** and the reproducible one is **85.8–86.5%**. The distance
between those two sentences is the most important fact in this document: on the same 500-question benchmark,
the same published metric and the same judge, the numbers a vendor announces and the numbers an independent
party can re-derive differ by 10 points at the top of the range and by **62 points** at the bottom (Mem0: 94.4%
self-reported, 32.4% reproduced). So this file does two things and refuses a third. It records every figure with
the four attributes that decide whether it may be compared, it derives a testable increment from each mechanism
that is actually implementable here, and it does **not** treat any of these numbers as a target.

## 1. The four attributes a quotable number needs

A score without all four is not a measurement, it is a press release. Every table below carries them.

| attribute | why it changes the score | observed range |
| --- | --- | --- |
| **dataset file** | the September 2025 cleaned release is not the file earlier results ran on | unquantified, but Mem0's own harness pins the cleaned file |
| **answer model (reader)** | the same memory system moves **84.23% → 94.87%** when only this changes | **+10.64pp** from one swap, vendor's own ablation |
| **judge model** | the benchmark specifies `gpt-4o-2024-08-06`; several results grade with GPT-5 or GPT-OSS-120B | unquantified |
| **metric** | Recall@20 is not answer accuracy | Supermemory: 97% recall vs 85.86% single-pass accuracy |

The reader axis is the one that decides this project's next move. Mastra's published pair — 84.23% with GPT-4o,
94.87% with GPT-5-mini, **same memory system, same corpus, same judge family** — is a controlled experiment on
the reader, and it is larger than the entire gap this project is trying to close. Any plan that attributes the
frontier's lead to *memory architecture* without first pricing the reader is a plan built on an unattributed
delta.

## 2. Published scores, with grade

Grades follow `ACCEPTANCE-MATRIX.md` §5: **A** = same dataset, judge, reader and metric; **B** = same dataset
and metric, different reader or judge; **C** = different metric, subset, or an unreproducible recipe.

| system | score | grade | reader | judge | note |
| --- | --- | --- | --- | --- | --- |
| agentmemory V4 | **96.20%** (481/500) | C | Claude Opus 4.6 | GPT-4o, seed 42 | single deterministic run; six-signal retrieval; code public |
| Chronos High (PwC) | 95.60% | C | not stated in the public summary | not stated | arXiv, 2026-03 |
| Mastra Observational Memory | 94.87% | C | GPT-5-mini | GPT-4o | vendor research page; **same system at 84.23% with GPT-4o** |
| OMEGA | 93.20% raw / 95.4% task-weighted | C | unspecified | unspecified | the 95.4% is a task-weighted average, not raw accuracy |
| Hindsight (Vectorize) | 91.40% | C | Gemini 3 Pro | GPT-OSS-120B | non-standard judge on both sides |
| EmergenceMem | 86.00% | C | GPT-4o | GPT-4o | internal, not reproducible |
| memoricai | **85.8%** | A | gpt-4o-2024-08-06 | gpt-4o-2024-08-06 | independent; the reproducible frontier |
| Redis reproduction | **86.5%** | A | GPT-4o-class | official | independent; converges with the row above |
| Supermemory | 85.86% single-pass | B | GPT-4o | GPT-4o | advertised ~99% is an 8-variant ensemble |
| Mastra OM (base) | 84.23% | B | GPT-4o | GPT-4o | the reader-controlled half of the pair above |
| Emergence Simple | 82.40% | B | GPT-4o | GPT-4o | oracle-context baseline |
| Oracle (gold context handed over) | 82.40% | A | GPT-4o | GPT-4o | **the ceiling for a GPT-4o reader given the answer's evidence** |
| **Cortex** | **80.80%** | — | DeepSeek | official prompts | four-run band 79.4–82.4% |
| Zep | 71.20% | A | GPT-4o | GPT-4o | graph memory, 2025-01 paper |
| full context | 60.20% | A | GPT-4o | GPT-4o | the paper's no-memory baseline |

Two rows deserve to be read together and are the reason this project does not chase 96%. **The oracle row
(82.40%) and the Cortex row (80.80%) are 1.6 points apart.** An oracle run is handed the gold evidence and asked
only to read it. A memory system that retrieves well on a GPT-4o-class reader therefore has ~1.6 points of
headroom before it hits the reader's ceiling on this benchmark — and Mastra's 94.87% is *above* that ceiling,
which means it is not the same experiment. Either a stronger reader raised the ceiling (the reader axis), or the
configuration differs in a way the publication does not state.

## 3. Independent reproductions, which is the only tier that constrains us

| source | finding |
| --- | --- |
| memoricai | frontier at 85.8%; self-reports diverge by +3 to −28pp |
| Redis | independent reproduction converges at 86.5% |
| benchd.ai (six open-source systems, 500 questions) | LlamaIndex 59.0%, LangChain 59.0%, **LLM baseline 57.6%**, AutoGPT 47.4%, **Mem0 OSS 32.4%**, Cognee 20.0%, **Graphiti 0.0%** |
| **arXiv:2610.30755** (12 systems, 4 benchmarks) | **Raw-RAG wins 6 of 7 benchmark-model settings.** LongMemEval **87.53** against the best agentic memory system at 87.40; MemoryAgentBench 48.32 vs 43.84 (GPT-4o-mini) and 53.41 vs 47.88 (DeepSeek-V4-Flash) |
| **arXiv:2608.19652** (StateMem) | 0.656 on LongMemEval with a **DeepSeek** reader (0.580 with Qwen), against Mem0 0.594 — the only published DeepSeek-reader figure on this benchmark |

The benchd.ai row is the single most useful table in this literature, because it is the only one that measures
systems *against a baseline with no memory at all* on the same harness. Three consequences:

1. **Most open-source memory systems lose to no memory.** 57.6% is what you get by putting the history in the
   window; four of six systems score below it. A memory system's first acceptance criterion is therefore
   "beats full context", not "beats the leaderboard".
2. **A 0.0% and a 20.0% are instrument results before they are system results.** Graphiti at 0.0% on a
   conversational corpus is a claim about that harness's fit, not about graph memory — the same shape of
   finding this repository had to make about its own Mem0 run (§6).
3. **Temporal reasoning is where every system collapses**, including the baseline. That is where a mechanism
   advantage can exist at all.

## 4. The mechanisms, and what each one would have to prove here

Five architectures are public enough to copy from. Each row states the mechanism, the evidence for it, what it
would cost us, and the falsifiable prediction it must produce.

### 4.1 Compression instead of retrieval (Mastra Observational Memory)

Two prompt blocks: a persistent block of compressed *observations*, and a rolling block of raw messages. At
~30k tokens an Observer agent compresses, and a Reflector agent merges and de-duplicates. No vector store, no
retrieval call, no graph. Reported 84.23% (GPT-4o) — **above the oracle baseline**, which is the interesting
part: the gain is not in finding evidence, it is in *not re-reading the whole history*.

| cost | prediction it must produce |
| --- | --- |
| one LLM call per compression window per question, ~500 × k calls | at matched token budget, compression ≥ our retrieval on TR and MR; if it is not, the win was the reader |

This is the highest-value mechanism to test and the most expensive to run. It is also the one whose published
number is least separable from its reader.

### 4.2 Six-signal hybrid with per-capability budgets (agentmemory V4)

Retrieval scores six weighted signals — semantic 0.30, activation 0.18, graph 0.18, lexical/BM25 0.12, temporal
0.12, importance 0.10 — then a cross-encoder reranks, then a **token budget chosen by question type**
(multi-session 7,500 / temporal 5,000 / knowledge-update 2,500 / single-session 1,500–3,500), with
`[Session date: YYYY-MM-DD]` injected per session and coreference hints added for multi-session.

| what we already have | what we do not |
| --- | --- |
| hybrid semantic+lexical relevance (`retrieval-hybrid`) | the four remaining signals |
| per-route character caps (`maxTurnCharsRoutes`) | a budget that varies by *capability* rather than by route |
| date framing on temporal | coreference hints on multi-session |
| — | a cross-encoder reranker |

The self-reported retrieval figure — R@5 95.2% for BM25+vector, 96.6% for vector-only — is a **retrieval**
number, and this project already has that axis: `cortex-session` reads 87.0% recall@10 and `lexical-reference`
89.0% on 100 questions. So the honest statement is that the retrieval gap to a public six-signal system is
**6–9 points of recall@10**, and every one of those signals is implementable here.

### 4.3 Fact extraction at ingest (Hindsight, Mem0 managed, Zep)

An LLM reads each turn and writes facts; retrieval then searches facts. This is what the 94.4% Mem0 number
actually configures, and it costs **one model call per turn — ~275,000 calls on this corpus**. Zep reaches
71.2% with a graph variant. The reproduction at `infer=0` is 32.4%.

**Decision rule, already in force:** not run at 500 questions. The cost is a bill, not a comparison, and the
`manifest` records `infer` so a number from either configuration can never be quoted as the other.

### 4.4 Temporal indexing plus query expansion (the paper's own ablations)

The benchmark authors report three findings worth copying: round(**) granularity beats session and beats atom;
memory-value-flat indexing is a strong baseline; and a simple time-aware index plus query expansion adds 7–11
points on temporal reasoning.

| finding | our state |
| --- | --- |
| round granularity, not session | we shipped `relevanceUnits: session` and **it refuted itself** (MR 83/121 against a 96/121 floor) |
| flat memory-value index | we have `relevanceTopK: 256` over turns |
| time-aware index + expansion | date framing installed; `queryExpansion: llm` built, unmeasured |

### 4.5 Operation-level memory (MemOps, 2026-07)

2006 probes over 403 dialogues, scoring memory **operations** — write, forget, update, reflect — rather than
final answers, with structured traces. It separates "the answer is right for the wrong reason" (an expired value
reused, a forgotten fact leaked) from "the answer is wrong".

| why it matters here | status |
| --- | --- |
| our KU failures are partly stale-value reuse, which this scores directly | not adopted |
| our abstention route is a *forgetting* behaviour with no forgetting metric | not adopted |
| it names the failure classes we currently infer from discordant pairs | candidate |

### 4.6 Naive retrieval beats every organised memory, and the mechanisms cost accuracy when added

arXiv:2610.30755 (Xi'an Jiaotong, 2026-10-22, 62 pages) is the most uncomfortable result in this landscape,
because it is the one that removes work rather than adding it. **Raw-RAG**: serialize the raw conversation
with timestamps, chunk, dense-retrieve, rerank, hand the evidence to a reader. No extraction, no rewriting, no
graph, no consolidation. It wins **six of seven** benchmark-model settings against twelve memory systems.

| experiment | result |
| --- | --- |
| Mem0's own write decisions, audited | on LoCoMo, UPDATE + DELETE are **4.39%** of 33,902 decisions and effective mutations **1.90%**; on LongMemEval **2.46%** and **1.34%** of 428,858 |
| replace UPDATE with append-only ADD and DELETE with NONE | LoCoMo goes **67.36% → 69.42%** — explicit rewriting bought nothing |
| add machinery to Raw-RAG | atomic fact extraction **−19.62**, summarisation **−5.81**, graph expansion **−5.78** |
| why extraction hurts | it takes test-time learning from **47.68%** to **15.37%** — the demonstrations it needs are broken apart |

**It is also the most reproducible competitor this project has found**, which changes the order of §6.2:

| requirement | RAW-RAG |
| --- | --- |
| licence | MIT |
| reader | OpenAI-compatible `LLM_*` **and an explicit `DEEPSEEK_*` block** — the reader this arm uses is a first-class configuration |
| embedder | OpenAI-compatible `VECTORIZE_*`, so Zhipu's `embedding-3` fits |
| corpus | **`longmemeval/longmemeval_s_cleaned.json`, the same file this project runs** |
| launch | `python -m evaluation.cli --dataset longmemeval --system rag` |
| its own ablations | `rag_atomic_facts`, `rag_raw_summary`, `rag_graph_expanded_raw` — the same three mechanisms §4.6 measured as harmful |
| reranker | the one open dependency: the paper uses a Cohere `/v2/rerank` endpoint, and a local cross-encoder or an OpenAI-compatible rerank endpoint would have to be substituted |

Two consequences for this repository, and the second is a correction.

First: **it validates the decision not to do LLM extraction at ingest.** That decision was made on cost
arithmetic (§4.3); this paper says it would also have cost accuracy.

Second: **Raw-RAG's shape is our shape** — raw turns, timestamps, hybrid retrieval, a budget, no rewriting.
At 87.53 with a GPT-4o-mini reader it is the strongest evidence available that the architecture is not what
separates us from the frontier. **The clause that used to follow — "and the distance is therefore mostly the
reader" — is withdrawn as of `PREREGISTRATION` §13.110**, which swapped this arm's reader for a larger model
of the same family and lost **7.20 points** (417 → 381 of 500) with four of five capabilities down. The
architecture is not the gap and the reader is not a free lever; what is left is the one stage Raw-RAG has and
this arm does not — the reranker, worth **−3.92** when removed from their own pipeline (§4.9).

### 4.7 State over retrieval, and a reader-side intervention that transfers

arXiv:2608.19652 (StateMem) attacks a different axis: not what to retrieve but what the answer call is told to
do. Its wrapper rewrites the one answer call an existing backend already makes into two sections — first
*trace, in chronological order, every relevant value, revision, standing rule and derived input*, capped at 250
words; then *resolve the question from that trace* with later-over-earlier precedence and explicit retirement.

| measurement | value |
| --- | --- |
| LongMemEval, DeepSeek reader | StateMem **0.656** vs Mem0 0.594 |
| LongMemEval, Qwen reader | 0.580 vs 0.566 |
| temporal reasoning, DeepSeek | StateMem **0.624** vs long context **0.391** |
| knowledge update | **0.795** |
| transfer across six backends | **+31.7 to +66.6 points** over each backend alone |
| attributed to state structure specifically | **+15.0 to +31.7** after a matched control with the same call count, format and budget |

The matched control is the part worth copying as a method: the control asks for a generic relevant-information
summary with the same two-section format and the same 250-word budget, so the difference isolates the
*structure* rather than the extra text. This repository's `dispatch2` reading is the same family of
intervention; the StateMem result says the pair (intervention, matched control) is what makes it attributable.

### 4.8 Four papers in one day, three of which bound what this project may claim

The 2026-10-22/26 batch is worth reading together because each one removes a different assumption.

| paper | finding | what it bounds here |
| --- | --- | --- |
| arXiv:2610.31366, **AfterDeleteBench** | one query recovered a deleted secret from Qwen2.5-7B in ~**2/3** of cases while controls that never saw it recovered zero; with only derived artefacts left, exact reconstruction succeeded **62–99%** across Qwen, Mistral and Phi-3. Provenance-aware closure — deleting everything downstream — dropped recovery to zero | any future "forget this" claim has to be measured *behaviourally*, not as a storage operation |
| arXiv:2610.30698, **validity ledger** | flipping only the *validity state* of memories, content untouched, changed the operative context in **96.25%** of 2,080 matched pairs and cost **40.54 points** on LongMemEval; oracle enforcement restored all of it | the bookkeeping of which memory is current is a **40-point** lever, not a housekeeping detail — this is the axis our KU capability sits on |
| arXiv:2610.30478, **distillation vs buffer** | distilling memory into weights bought a non-significant **+1**; attaching a frozen retrieval buffer bought **+34** | any proposal to move memory into parameters is measured against a frozen-buffer baseline, not against nothing |
| **MemoryTax** (prior week) | Opus 5.5 plus raw-history search reached **99%** at under half the cost | the frontier's own recipe is *raw record plus a good search box* — which is this project's shape |

Two of these say the same thing from opposite directions: **what is worth engineering is provenance** —
knowing what came from where, what is still current, and what must die when a source is deleted. That is a
write-time and bookkeeping problem, and this project's ledger (`temporality` + `bitemporal`) is aimed at
exactly it while its retrieval is aimed at the part the benchmarks keep voting down.

## 5. Datasets, ranked by what they would add

| dataset | scale | what it scores that we do not | verdict |
| --- | --- | --- | --- |
| **LongMemEval-S** | 500 q, ~115k tokens | the current axis | in use |
| **LongMemEval-V2** | up to 115M tokens, agent trajectories | retrieval from *experience* (workflows, gotchas) not chat; best 72.5% vs RAG 48.5% | candidate; different task, new baseline needed |
| **MemOps** | 2006 probes, 403 dialogues | memory operations, stale-value reuse, forgotten-fact leakage | candidate; directly targets our KU and ABS failure classes |
| **MemoryAgentBench** | incremental | selective forgetting, multi-hop conflict resolution (≤28% for all systems) | candidate; novel-competency axis |
| **LoCoMo** | 1540 q, 35 sessions | multi-session dialogue | secondary; Mem0 OSS scored 0.0% on it in one harness, which is an instrument question first |
| **Agent Memory Leaderboard** | 10+ datasets, 5000 q | a **public leaderboard with a fixed reader and an Add/Search protocol** | see §7 |
| **BEAM** | 10M tokens | scale degradation | not now; cost |

## 6. The instrument lesson this landscape repeats

Every reproduction in §3 was preceded by a harness defect that produced a plausible number. The benchd.ai
Graphiti 0.0%, the Mem0 OSS 32.4%, and **our own Mem0 0.0% on run 40519523383** share one shape: a system that
appeared to retrieve nothing was a system whose store received nothing. Ours was diagnosable in one line —
`FAISSConfig.embedding_model_dims` defaults to 1536, our embedder produces 1024, and `assert d == self.d` failed
on every `add` — but the failure was caught per session, counted as a skip, and rendered as a score.

So the rule this project now enforces, and which any competitor comparison must satisfy before a number is
quoted: **a score is only quotable beside the corpus that reached the store, the width the store was built at,
and the count of questions the system refused.** Anything less is a plausible number, and plausible numbers are
how this field got a 62-point spread on one benchmark.

## 7. The one external channel worth entering

The Agent Memory Leaderboard (launched 2026-07-29) standardises exactly what
`tools/competitor-sut/PROTOCOL.md` already implements: systems expose **Add** and **Search**; the platform
supplies a fixed answer model, a unified judge, and version-tracked results; open-source methods submit code and
configuration.

| their requirement | our state |
| --- | --- |
| `Add` (ingest) over a stable interface | `ingest` — implemented |
| `Search` returning evidence for a query | `search` — implemented |
| fixed answer model supplied by the platform | ours is configurable; the arm would run their reader |
| reproducible configuration | every arm option is recorded in the artifact |
| ablations judged by ability tag | our per-capability table is the same decomposition |

This is the only route by which a Cortex number can become grade-A against the frontier without us grading our
own homework. It is a submission problem, not a research problem, and it is the highest-value external action
available.

## 8. What this document changes about the plan

1. **The target is 85.8%, not 96.2%.** Anything above the grade-A frontier is either a different reader or a
   different metric until an independent run says otherwise.
2. **A reading made here is withdrawn.** An earlier version of this file treated the 82.4% oracle as the reader
   ceiling and inferred that 80.80% sitting 1.6 points under it meant retrieval had little left to buy. Raw-RAG
   at 87.53 with GPT-4o-mini — 5.1 points *above* that oracle — retires the inference. 82.4 was one
   configuration of an oracle, not a bound, and the reader axis has to be priced by measurement rather than
   inferred from a seat under it. The `S1` row in `ACCEPTANCE-MATRIX.md` carries the same retraction rather
   than a quietly corrected claim.
3. **The reader axis has now been priced, and the price is negative.** 84.23 → 94.87 from one external swap is
   larger than our entire gap, which is why the axis was worth a run; the run (§13.110) answered −7.20 for a
   larger model of the same family, with the mechanism visible in the artifact as format non-compliance and
   weaker enumeration. So "a better reader is out there" remains true and "a bigger reader is better" does not,
   and the next reader run has to select on contract compliance rather than on size.
4. **The retrieval gap is 6–9 points of recall@10**, and it is addressable with signals the public systems
   enumerate. That is a mechanism list, not a mystery — but §4.6 says to add them one at a time and measure,
   because three of the four mechanisms that paper tried made things worse.
5. **The next external milestone is a submission, not a score**: run our arm under a fixed external reader.
6. **Every number in this file is quoted with its four attributes or not at all**, because the alternative is
   contributing to the spread this document exists to measure.
7. **Adding mechanism is now the hypothesis under test, not the default.** §4.6's four experiments all moved
   the same way, and two of them are exactly what this project was about to build. That does not make them
   wrong here, but it does mean each one ships at weight zero, with a census, and with a pre-stated condition
   under which it is removed.

### 4.9 What the two repositories give us that the papers do not

Two of the systems above publish code, and reading it changes what this project can copy. The papers say
*what* won; the repositories say *at which parameters*, which is the only form in which a result can be
re-run here.

**RAW-RAG** (`github.com/Litmeb/RAW-RAG`, MIT) is a four-stage pipeline with every number in the README:

| stage | what the code does | what it means here |
| --- | --- | --- |
| build | serialize history with timestamps → overlapping windows of **L tokens with O overlap** (the LongMemEval profile uses the paper's 256/32) → one flat index | we already have raw turns with dates; our unit is a *turn*, not a window, and a turn is 272 characters at the median (§13.67) against their ~1,000 |
| retrieve | top **K = 128** windows by cosine | we retrieve 256 turns through a hybrid channel (§13.64) and then spend the budget on a prefix |
| rerank | cross-encoder over (question, window) → top **k = 15** | **we have no rerank stage in this arm at all.** `cortex-ai` implements both an OpenAI-compatible client and a local cross-encoder, and `bench-arm-options.ts` wires them — for a *different* benchmark |
| read | reader sees 15 raw windows and the question | we hand the reader a relevance-ordered prefix of up to 240 turns at the adopted budget |

Its ablations are the ones worth stealing because they are single-variable and paired on the same 20,000
bootstrap samples with Holm correction:

| ablation | Δ | what it says about us |
| --- | --- | --- |
| remove reranking | **−3.92** (48.32 → 44.40) | the rerank stage is the largest single component of their pipeline, and it is the one stage we do not have |
| return only 1 evidence item | −11.73 | precision has a floor too; this is not an argument for k = 1 |
| k = 5 … 60 | stable | a 15-item window is not a lucky choice |
| k = 120 | **−14.57** | more evidence than the reader can use is worse than less, by a wide margin |
| add atomic-fact extraction | −19.62 | already adopted here as a non-goal (§4.6) |
| add summarisation / graph expansion | −5.81 / −5.78 | same |

Two corrections to how this project had been reading that table. First, **the reranker is not an optional
refinement** — removing it costs more than any mechanism they added, which makes it the first thing to
port rather than the last. Second, **k = 120 losing 14.57 points is a statement about a 120-item window of
~1,000-character chunks**, i.e. roughly 120,000 characters, twice our adopted 48,000 budget — so it does
not predict what 96,000 does here, but it does say the direction is not free. `PREREGISTRATION` §13.113 is
the run that measures our own curve.

**MemoryTax** (`github.com/hexuan21/MemoryTax`, MIT) is not a system; it is a **measurement framework**,
and it is the more valuable of the two because this project has no equivalent:

```
common/api/        OpenAI-compatible chat, embedding and reranker clients with token and call accounting
common/qa_prompts/ one unified QA prompt per benchmark
common/judge/      LLM-judge prompts and runner
common/bench/      download + prepare + the evaluated subsets
reproduction/_naive_rag/   1-round and 2-round naive RAG, as the reference every system is scored against
reproduction/<baseline>/   setup.sh clones the official repo at a pinned commit, patches/, harness/
```

Three things in that layout are worth adopting outright:

1. **Pinned-commit reproduction with patches as a first-class artefact.** `setup.sh` clones at a commit and
   `patches/` holds the minimal changes needed to run under their harness. This is the discipline
   `COMPETITOR-REPRODUCTION.md` §6.1 arrived at the hard way, after mem0's `0.0%` turned out to be a
   dimension mismatch rather than a result — and here it is a directory convention instead of a lesson.
2. **A per-question ledger rather than two aggregate scores.** Memory benefit is *questions only the memory
   system answers correctly*; memory tax is *questions the memory system gets wrong that RAG gets right*;
   net value is the difference. The aggregates this project reports (McNemar, discordant identity lists)
   carry the same information in a form that has to be recomputed; the ledger form is what a reader can act
   on, and it is what §13's `onMiss` fields have been approximating in prose.
3. **Subsets declared in code, not in a paper.** LongMemEval-s is the full 500; PersonaMem-v2 is a 20%
   persona subset (934 questions); MINT-Eval is a 10% corpus subset (1,557). `common/bench` owns the
   definitions, so a number is always attached to the file that produced it.

Its own headline is a *fix* rather than a finding — "search the raw history alongside the memory store and
rerank jointly" — which is a recommendation this arm already satisfies by construction, since it has no
memory store to search alongside. What it adds is the evidence that this is not a weakness of the design
but the design.

## 9. The three things this landscape says are still missing, in order

1. **A rerank stage.** §4.9: the single largest component of the strongest reproducible competitor, absent
   from this arm, implemented in this repository but wired to a different benchmark, and reachable through a
   provider we already hold a key for.
2. **A per-question ledger.** §4.9 item 2. Every increment so far has been judged on aggregate accuracy and
   a paired test; none has been judged on *which questions it bought and which it cost*, which is the number
   that decides whether two increments compose.
3. **A second reader that obeys the contract.** §4.7's wrapper results and §13.110's −7.20 both say the
   reader is a lever; only one of them says which direction is available.
