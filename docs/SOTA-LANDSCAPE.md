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

Two consequences for this repository, and the second is a correction.

First: **it validates the decision not to do LLM extraction at ingest.** That decision was made on cost
arithmetic (§4.3); this paper says it would also have cost accuracy.

Second: **Raw-RAG's shape is our shape** — raw turns, timestamps, hybrid retrieval, a budget, no rewriting.
At 87.53 with a GPT-4o-mini reader it is the strongest evidence available that the distance from our 80.80 is
mostly the reader and not the architecture. See §8.1 for the reading this retires.

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
2. **The reader axis must be priced before any further memory work.** 84.23 → 94.87 from one swap is larger than
   our entire gap, and our 80.80% sits 1.6 points under a GPT-4o oracle ceiling.
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
