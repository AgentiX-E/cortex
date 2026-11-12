# SOTA-LANDSCAPE

What the frontier is, as of 2026-10-28, and what each published mechanism would have to do to be worth copying.

## 0. One paragraph

The published LongMemEval frontier is **96.40%** (Exabase M-1, 2026-07) and the reproducible one is **85.8–86.5%**. The distance
between those two sentences is the most important fact in this document: on the same 500-question benchmark,
the same published metric and the same judge, the numbers a vendor announces and the numbers an independent
party can re-derive differ by 10 points at the top of the range and by **62 points** at the bottom (Mem0: 94.4%
self-reported, 32.4% reproduced). So this file does two things and refuses a third. It records every figure with
the four attributes that decide whether it may be compared, it derives a testable increment from each mechanism
that is actually implementable here, and it does **not** treat any of these numbers as a target.

## 1. The four attributes a quotable number needs

A score without all four is not a measurement, it is a press release. Every table below carries them.

| attribute                 | why it changes the score                                                                      | observed range                                             |
| ------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **dataset file**          | the September 2025 cleaned release is not the file earlier results ran on                     | unquantified, but Mem0's own harness pins the cleaned file |
| **answer model (reader)** | the same memory system moves **84.23% → 94.87%** when only this changes                       | **+10.64pp** from one swap, vendor's own ablation          |
| **judge model**           | the benchmark specifies `gpt-4o-2024-08-06`; several results grade with GPT-5 or GPT-OSS-120B | unquantified                                               |
| **metric**                | Recall@20 is not answer accuracy                                                              | Supermemory: 97% recall vs 85.86% single-pass accuracy     |

The reader axis is the one that decides this project's next move. Mastra's published pair — 84.23% with GPT-4o,
94.87% with GPT-5-mini, **same memory system, same corpus, same judge family** — is a controlled experiment on
the reader, and it is larger than the entire gap this project is trying to close. Any plan that attributes the
frontier's lead to _memory architecture_ without first pricing the reader is a plan built on an unattributed
delta.

**This project has now priced it on its own configuration, and the price was negative.** On 2026-10-28 two runs
with a byte-identical `memoryArmConfig` differed only in `DEEPSEEK_MODEL`: `deepseek-chat` 417/500, the
same-family larger `deepseek-v4-pro` **381/500 — −7.20pp**, every capability down and `ABS` the only one up
(§4.6, §8 item 2). The variance on this axis is real and large, as Mastra's 10.64pp says; its **sign is not
given by "bigger"**. The selection criterion that follows is contract compliance, not parameter count, and the
remaining unexplained distance — 2.35–3.05pp to the reproducible frontier, 4.08pp to RAW-RAG — belongs to the
one stage this repository has not implemented yet: cross-encoder reranking (§4.9).

## 2. Published scores, with grade

Grades follow `ACCEPTANCE-MATRIX.md` §5: **A** = same dataset, judge, reader and metric; **B** = same dataset
and metric, different reader or judge; **C** = different metric, subset, or an unreproducible recipe.

| system                            | score                            | grade | reader                           | judge             | note                                                                                                                    |
| --------------------------------- | -------------------------------- | ----- | -------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Exabase M-1                       | **96.40%**                       | C     | **Gemini 3 Flash** (≈6x cheaper than peers) | not stated | vendor press release, 2026-07-28; ~20% fewer tokens per query than the next best system; same release reports BEAM 76.9 / 75.0 / 68.0 |
| agentmemory V4                    | **96.20%** (481/500)             | C     | Claude Opus 4.6                  | GPT-4o, seed 42   | single deterministic run; six-signal retrieval; code public                                                             |
| Chronos High (PwC)                | 95.60%                           | C     | not stated in the public summary | not stated        | arXiv, 2026-03                                                                                                          |
| Mastra Observational Memory       | 94.87%                           | C     | GPT-5-mini                       | GPT-4o            | vendor research page; **same system at 84.23% with GPT-4o**                                                             |
| OMEGA                             | 93.20% raw / 95.4% task-weighted | C     | unspecified                      | unspecified       | the 95.4% is a task-weighted average, not raw accuracy                                                                  |
| Hindsight (Vectorize)             | 91.40%                           | C     | Gemini 3 Pro                     | GPT-OSS-120B      | non-standard judge on both sides                                                                                        |
| EmergenceMem                      | 86.00%                           | C     | GPT-4o                           | GPT-4o            | internal, not reproducible                                                                                              |
| memoricai                         | **85.8%**                        | A     | gpt-4o-2024-08-06                | gpt-4o-2024-08-06 | independent; the reproducible frontier                                                                                  |
| Redis reproduction                | **86.5%**                        | A     | GPT-4o-class                     | official          | independent; converges with the row above                                                                               |
| Supermemory                       | 85.86% single-pass               | B     | GPT-4o                           | GPT-4o            | the advertised 98.6 is `pass@k` over 8 variants and the 97.2 is a majority of 12; neither is this row's metric          |
| Mastra OM (base)                  | 84.23%                           | B     | GPT-4o                           | GPT-4o            | the reader-controlled half of the pair above                                                                            |
| Emergence Simple                  | 82.40%                           | B     | GPT-4o                           | GPT-4o            | oracle-context baseline                                                                                                 |
| Oracle (gold context handed over) | 82.40%                           | A     | GPT-4o                           | GPT-4o            | **the ceiling for a GPT-4o reader given the answer's evidence**                                                         |
| **Cortex**                        | **91.05%** (455.25/500, four-run mean) | B     | DeepSeek `deepseek-chat`         | official prompts  | the arm as it ships, `42533236864`; the gated form of this row is `S1` in `ACCEPTANCE-MATRIX.md`, which reads the same run. This cell carried **83.45%** for three rounds after the arm had moved and was 7.6 points behind its own matrix until round 60 replaced it |
| MemCog                            | 95.80%                           | C     | GPT-4o-mini / GPT-4.1-mini       | GPT-4o            | arXiv:2605.28046; **baseline column copied from two other papers**, not re-run; multi-session 92.48 by 2–3 ReAct steps  |
| PlugMem                           | 90.20%                           | C     | not stated                       | not stated        | arXiv:2603.03296, ICML 2026; **Apache-2.0 code**, so this is the row that can become a measurement                      |
| MEMTIER                           | 38.20%                           | C     | Qwen2.5-7B, 6 GB GPU             | not stated        | Algorithms 19(7):607; the only 7B row held, and it makes the 57-point reader effect visible in one table                |
| Zep                               | 71.20%                           | A     | GPT-4o                           | GPT-4o            | graph memory, 2025-01 paper                                                                                             |
| full context                      | 60.20%                           | A     | GPT-4o                           | GPT-4o            | the paper's no-memory baseline                                                                                          |

Two rows deserve to be read together, and they are the reason this project does not chase 96%. **The oracle row
(82.40%) and the Cortex row (83.45%) are 1.05 points apart, and the Cortex row is on the wrong side of the
oracle — it is above it.** That sentence used to be its own retraction, so it is worth stating precisely what
it destroys: an oracle is handed the gold evidence and asked only to read it, so a system that beats it cannot
be evidence that "retrieval has ~1 point of headroom left". Either the oracle row is one GPT-4o configuration
rather than a ceiling (§4.6), or the DeepSeek reader buys something the oracle's reader does not — and with
`deepseek-v4-pro` measured at **−7.20pp** against `deepseek-chat` on this arm, "reader" is no longer a free
explanatory variable to reach for (§8, item 2). Mastra's 94.87% is still above both rows, which means it is
not the same experiment: either a stronger reader raised the ceiling, or the configuration differs in a way
the publication does not state.

### 2.1 A score is not a number until the rule that produced it is named

Three of the rows above cannot be sorted against the others for a reason none of the five conditions
catches, and it is not the reader or the judge. Supermemory's advertised 98.6 is **any-of-eight**:
eight specialised prompt variants each answer, and the question counts correct if one of them is. Its own
second configuration — twelve variants reduced by majority vote — reports 97.2. Every other row in this
table is one answer per question. Dataset, variant, reader, judge and harness can all be identical across
those two numbers while they remain two different questions.

The ledger has therefore grown a sixth field, `scoring ∈ {single, pass@k, majority}`, required on every row
with no default. The audit is `AUDIT-SCORING-RULE-AS-CONDITION.md`, and the part of it worth repeating here
is that **this document already said the 99 was an eight-variant ensemble** while the tool that prints the
comparability groups had no field to hold that fact. A caveat written in prose and absent from the artifact
is a caveat that cannot be enforced, printed, or noticed when a future row arrives without it.

Two consequences for how this landscape is read:

- **`--gap` now reports the rule as a differing field.** The any-of-eight row is four fields from ours
  instead of one, so it is out of the tie set entirely rather than being the nearest thing to it.
- **The remaining 26-way tie is the real finding.** Every single-answer LongMemEval-S row differs from
  this arm in exactly _answer model, judge, harness_ — the three things only a re-run can change. That is
  what `PLAN-COMPETITOR-HARNESS.md` is for, and it is why no amount of reading can produce a rank.

## 3. Independent reproductions, which is the only tier that constrains us

| source                                             | finding                                                                                                                                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| memoricai                                          | frontier at 85.8%; self-reports diverge by +3 to −28pp                                                                                                                                                        |
| Redis                                              | independent reproduction converges at 86.5%                                                                                                                                                                   |
| benchd.ai (six open-source systems, 500 questions) | LlamaIndex 59.0%, LangChain 59.0%, **LLM baseline 57.6%**, AutoGPT 47.4%, **Mem0 OSS 32.4%**, Cognee 20.0%, **Graphiti 0.0%**                                                                                 |
| **arXiv:2610.30755** (12 systems, 4 benchmarks)    | **Raw-RAG wins 6 of 7 benchmark-model settings.** LongMemEval **87.53** against the best agentic memory system at 87.40; MemoryAgentBench 48.32 vs 43.84 (GPT-4o-mini) and 53.41 vs 47.88 (DeepSeek-V4-Flash) |
| **arXiv:2608.19652** (StateMem)                    | 0.656 on LongMemEval with a **DeepSeek** reader (0.580 with Qwen), against Mem0 0.594 — the only published DeepSeek-reader figure on this benchmark                                                           |

The benchd.ai row is the single most useful table in this literature, because it is the only one that measures
systems _against a baseline with no memory at all_ on the same harness. Three consequences:

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

Two prompt blocks: a persistent block of compressed _observations_, and a rolling block of raw messages. At
~30k tokens an Observer agent compresses, and a Reflector agent merges and de-duplicates. No vector store, no
retrieval call, no graph. Reported 84.23% (GPT-4o) — **above the oracle baseline**, which is the interesting
part: the gain is not in finding evidence, it is in _not re-reading the whole history_.

| cost                                                             | prediction it must produce                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| one LLM call per compression window per question, ~500 × k calls | at matched token budget, compression ≥ our retrieval on TR and MR; if it is not, the win was the reader |

This is the highest-value mechanism to test and the most expensive to run. It is also the one whose published
number is least separable from its reader.

### 4.2 Six-signal hybrid with per-capability budgets (agentmemory V4)

Retrieval scores six weighted signals — semantic 0.30, activation 0.18, graph 0.18, lexical/BM25 0.12, temporal
0.12, importance 0.10 — then a cross-encoder reranks, then a **token budget chosen by question type**
(multi-session 7,500 / temporal 5,000 / knowledge-update 2,500 / single-session 1,500–3,500), with
`[Session date: YYYY-MM-DD]` injected per session and coreference hints added for multi-session.

| what we already have                                   | what we do not                                            |
| ------------------------------------------------------ | --------------------------------------------------------- |
| hybrid semantic+lexical relevance (`retrieval-hybrid`) | the four remaining signals                                |
| per-route character caps (`maxTurnCharsRoutes`)        | a budget that varies by _capability_ rather than by route |
| date framing on temporal                               | coreference hints on multi-session                        |
| —                                                      | a cross-encoder reranker                                  |

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

| finding                        | our state                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| round granularity, not session | we shipped `relevanceUnits: session` and **it refuted itself** (MR 83/121 against a 96/121 floor) |
| flat memory-value index        | we have `relevanceTopK: 256` over turns                                                           |
| time-aware index + expansion   | date framing installed; `queryExpansion: llm` built, unmeasured                                   |

### 4.5 Operation-level memory (MemOps, 2026-07)

2006 probes over 403 dialogues, scoring memory **operations** — write, forget, update, reflect — rather than
final answers, with structured traces. It separates "the answer is right for the wrong reason" (an expired value
reused, a forgotten fact leaked) from "the answer is wrong".

| why it matters here                                                        | status      |
| -------------------------------------------------------------------------- | ----------- |
| our KU failures are partly stale-value reuse, which this scores directly   | not adopted |
| our abstention route is a _forgetting_ behaviour with no forgetting metric | not adopted |
| it names the failure classes we currently infer from discordant pairs      | candidate   |

### 4.6 Naive retrieval beats every organised memory, and the mechanisms cost accuracy when added

arXiv:2610.30755 (Xi'an Jiaotong, 2026-10-22, 62 pages) is the most uncomfortable result in this landscape,
because it is the one that removes work rather than adding it. **Raw-RAG**: serialize the raw conversation
with timestamps, chunk, dense-retrieve, rerank, hand the evidence to a reader. No extraction, no rewriting, no
graph, no consolidation. It wins **six of seven** benchmark-model settings against twelve memory systems.

| experiment                                               | result                                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mem0's own write decisions, audited                      | on LoCoMo, UPDATE + DELETE are **4.39%** of 33,902 decisions and effective mutations **1.90%**; on LongMemEval **2.46%** and **1.34%** of 428,858 |
| replace UPDATE with append-only ADD and DELETE with NONE | LoCoMo goes **67.36% → 69.42%** — explicit rewriting bought nothing                                                                               |
| add machinery to Raw-RAG                                 | atomic fact extraction **−19.62**, summarisation **−5.81**, graph expansion **−5.78**                                                             |
| why extraction hurts                                     | it takes test-time learning from **47.68%** to **15.37%** — the demonstrations it needs are broken apart                                          |

**It is also the most reproducible competitor this project has found**, which changes the order of §6.2:

| requirement       | RAW-RAG                                                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| licence           | MIT                                                                                                                                                                    |
| reader            | OpenAI-compatible `LLM_*` **and an explicit `DEEPSEEK_*` block** — the reader this arm uses is a first-class configuration                                             |
| embedder          | OpenAI-compatible `VECTORIZE_*`, so Zhipu's `embedding-3` fits                                                                                                         |
| corpus            | **`longmemeval/longmemeval_s_cleaned.json`, the same file this project runs**                                                                                          |
| launch            | `python -m evaluation.cli --dataset longmemeval --system rag`                                                                                                          |
| its own ablations | `rag_atomic_facts`, `rag_raw_summary`, `rag_graph_expanded_raw` — the same three mechanisms §4.6 measured as harmful                                                   |
| reranker          | the one open dependency: the paper uses a Cohere `/v2/rerank` endpoint, and a local cross-encoder or an OpenAI-compatible rerank endpoint would have to be substituted |

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
_trace, in chronological order, every relevant value, revision, standing rule and derived input_, capped at 250
words; then _resolve the question from that trace_ with later-over-earlier precedence and explicit retirement.

| measurement                                | value                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| LongMemEval, DeepSeek reader               | StateMem **0.656** vs Mem0 0.594                                                       |
| LongMemEval, Qwen reader                   | 0.580 vs 0.566                                                                         |
| temporal reasoning, DeepSeek               | StateMem **0.624** vs long context **0.391**                                           |
| knowledge update                           | **0.795**                                                                              |
| transfer across six backends               | **+31.7 to +66.6 points** over each backend alone                                      |
| attributed to state structure specifically | **+15.0 to +31.7** after a matched control with the same call count, format and budget |

The matched control is the part worth copying as a method: the control asks for a generic relevant-information
summary with the same two-section format and the same 250-word budget, so the difference isolates the
_structure_ rather than the extra text. This repository's `dispatch2` reading is the same family of
intervention; the StateMem result says the pair (intervention, matched control) is what makes it attributable.

### 4.8 Four papers in one day, three of which bound what this project may claim

The 2026-10-22/26 batch is worth reading together because each one removes a different assumption.

| paper                                        | finding                                                                                                                                                                                                                                                                                                                     | what it bounds here                                                                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| arXiv:2610.31366, **AfterDeleteBench**       | one query recovered a deleted secret from Qwen2.5-7B in ~**2/3** of cases while controls that never saw it recovered zero; with only derived artefacts left, exact reconstruction succeeded **62–99%** across Qwen, Mistral and Phi-3. Provenance-aware closure — deleting everything downstream — dropped recovery to zero | any future "forget this" claim has to be measured _behaviourally_, not as a storage operation                                              |
| arXiv:2610.30698, **validity ledger**        | flipping only the _validity state_ of memories, content untouched, changed the operative context in **96.25%** of 2,080 matched pairs and cost **40.54 points** on LongMemEval; oracle enforcement restored all of it                                                                                                       | the bookkeeping of which memory is current is a **40-point** lever, not a housekeeping detail — this is the axis our KU capability sits on |
| arXiv:2610.30478, **distillation vs buffer** | distilling memory into weights bought a non-significant **+1**; attaching a frozen retrieval buffer bought **+34**                                                                                                                                                                                                          | any proposal to move memory into parameters is measured against a frozen-buffer baseline, not against nothing                              |
| **MemoryTax** (prior week)                   | Opus 5.5 plus raw-history search reached **99%** at under half the cost                                                                                                                                                                                                                                                     | the frontier's own recipe is _raw record plus a good search box_ — which is this project's shape                                           |

Two of these say the same thing from opposite directions: **what is worth engineering is provenance** —
knowing what came from where, what is still current, and what must die when a source is deleted. That is a
write-time and bookkeeping problem, and this project's ledger (`temporality` + `bitemporal`) is aimed at
exactly it while its retrieval is aimed at the part the benchmarks keep voting down.

### 4.9 What the two repositories give us that the papers do not

Two of the systems above publish code, and reading it changes what this project can copy. The papers say
_what_ won; the repositories say _at which parameters_, which is the only form in which a result can be
re-run here.

**RAW-RAG** (`github.com/Litmeb/RAW-RAG`, MIT) is a four-stage pipeline with every number in the README:

| stage    | what the code does                                                                                                                                        | what it means here                                                                                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| build    | serialize history with timestamps → overlapping windows of **L tokens with O overlap** (the LongMemEval profile uses the paper's 256/32) → one flat index | we already have raw turns with dates; our unit is a _turn_, not a window, and a turn is 272 characters at the median (§13.67) against their ~1,000                                                     |
| retrieve | top **K = 128** windows by cosine                                                                                                                         | we retrieve 256 turns through a hybrid channel (§13.64) and then spend the budget on a prefix                                                                                                          |
| rerank   | cross-encoder over (question, window) → top **k = 15**                                                                                                    | **we have no rerank stage in this arm at all.** `cortex-ai` implements both an OpenAI-compatible client and a local cross-encoder, and `bench-arm-options.ts` wires them — for a _different_ benchmark |
| read     | reader sees 15 raw windows and the question                                                                                                               | we hand the reader a relevance-ordered prefix of up to 240 turns at the adopted budget                                                                                                                 |

Its ablations are the ones worth stealing because they are single-variable and paired on the same 20,000
bootstrap samples with Holm correction:

| ablation                            | Δ                         | what it says about us                                                                                      |
| ----------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| remove reranking                    | **−3.92** (48.32 → 44.40) | the rerank stage is the largest single component of their pipeline, and it is the one stage we do not have |
| return only 1 evidence item         | −11.73                    | precision has a floor too; this is not an argument for k = 1                                               |
| k = 5 … 60                          | stable                    | a 15-item window is not a lucky choice                                                                     |
| k = 120                             | **−14.57**                | more evidence than the reader can use is worse than less, by a wide margin                                 |
| add atomic-fact extraction          | −19.62                    | already adopted here as a non-goal (§4.6)                                                                  |
| add summarisation / graph expansion | −5.81 / −5.78             | same                                                                                                       |

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
2. **A per-question ledger rather than two aggregate scores.** Memory benefit is _questions only the memory
   system answers correctly_; memory tax is _questions the memory system gets wrong that RAG gets right_;
   net value is the difference. The aggregates this project reports (McNemar, discordant identity lists)
   carry the same information in a form that has to be recomputed; the ledger form is what a reader can act
   on, and it is what §13's `onMiss` fields have been approximating in prose.
3. **Subsets declared in code, not in a paper.** LongMemEval-s is the full 500; PersonaMem-v2 is a 20%
   persona subset (934 questions); MINT-Eval is a 10% corpus subset (1,557). `common/bench` owns the
   definitions, so a number is always attached to the file that produced it.

Its own headline is a _fix_ rather than a finding — "search the raw history alongside the memory store and
rerank jointly" — which is a recommendation this arm already satisfies by construction, since it has no
memory store to search alongside. What it adds is the evidence that this is not a weakness of the design
but the design.

### 4.10 Model-swap portability: one controlled study, one gateway mechanism, one taxonomy

This is the literature a deployment-on-a-different-reader question actually sits in, and it was not in
this landscape until the round that asked whether a reader nobody measured could be made safe.

**Goyal & Ray, *Does Your Agent's Memory Survive a Model Upgrade? A Controlled Study of Memory
Portability*, arXiv:2609.05339 (2026-09-04, under review, 18 pp).** The same history stored four ways,
read by a swapped-in model, 48 synthetic histories with randomised answer codes, **exact scoring and no
LLM judge**, two open-weight models under 10B:

| format | accuracy after a writer swap | what it costs here |
| --- | --- | --- |
| LC-RAW (verbatim long context) | the baseline everything is measured against | this is the arm's own shape: raw turns, no store |
| KG-fixed (fixed-schema graph) | **+0.0004 ± 0.0020** — uncertainty five times the effect | we have no graph, and this is the row that says a *schema* is what makes memory portable |
| NOTES (model-compressed) | **+9.91 or −13.28**, by direction | we compress nothing, which is why the arm has no such row |
| RAG, full re-embed | **+11.90** available | |
| RAG, 50/50 mixed index | **+4.96** — forfeits most of it, and every call still succeeds | **Zhipu `embedding-3` versus the hash fallback is exactly this case** |

Their three recommendations are direction-specific migration testing, strict embedding-space isolation,
and retaining source histories for repair (store-only repair failed the 90% recovery target in **all 48**
cases; with raw history retained, 34 of 48 recovered). The third is already true here — every artifact
keeps `turns` — and the first two this project has not done. Their decomposition is also worth copying as
a method: 80% of the notes deficit is born at *writing*, 81% of the retrieval deficit at *lookup* — the same
symptom with two different causes, separated by where the loss happens.

**LiteLLM's health-check routing** is the shipped version of the same instinct and is the closest thing to a
competitor for `DegradationGuard`. It runs a background loop that pings every deployment, removes failing
ones from the pool, supports `allowed_fails_policy` per error class, and — the part that matters — **puts
them back when the cooldown expires.** Two differences are the whole argument for our design:

| | LiteLLM | `DegradationGuard` |
| --- | --- | --- |
| what it observes | liveness: 401/404/5xx, timeouts, a `max_tokens=1` completion | conformance: empty answer, transcript echo, unrecognised abstention |
| what it can conclude | this endpoint is down | this reader does not produce what the parser reads |
| recovery | automatic, after a cooldown | **none, by construction** |

Its bidirectional recovery is correct for its question and would be wrong for ours: a cooldown expiring says
the endpoint answers again, while ours would have to say the *reader's output became readable again*, and
nothing in the four signals can say that. LiteLLM also has `health_check_ignore_transient_errors` for 429
and 408 — the same insight as our `3 of 20` floor, applied to availability rather than conformity.

**The instrumented-contract taxonomy** (Datasumi, 2026) names eight structured-output outcomes
— `valid`, `schema_invalid`, `malformed_json`, `provider_refusal`, `content_filtered`, `truncated`,
`tool_call_instead_of_result`, `timeout` — and its central claim is the one this project arrived at
independently: **a gateway that returns HTTP 200 for a refusal, a truncation and a schema failure hides
production failures from everyone, including its operator**, and "portability on paper; regressions found
by customers" is what a compatibility proxy buys. Two of its eight are gaps here: **`truncated`** is not one
of our four signals, and a response cut at the output limit can still carry a parseable answer early in the
text. `provider_refusal` and `content_filtered` collapse into `parse-failed` for this arm, and
`tool_call_instead_of_result` does not apply because the arm has no tools.

**The judge literature is what bounds any swap measured through a judge.** Cortex's first scoring tier is
exact match, and the controlled study above keeps the judge out entirely for the same reason. The numbers
that make that non-negotiable: identical-input pairwise flip rates of **11–14%** across six judges and three
providers, unchanged across model generations (Yagubyan, GroundLM 2026); same-window Spearman agreement
**0.400** against a pre-registered 0.90 gate, next-day replay 0.78 against 0.99, and **no provider reaching
0.99** across four (2026, 52,988 requests); and two production judges that are >0.95 test–retest reliable
while carrying position bias >0.10 — *consistent and wrong* (>541,000 judgments across 21 judges).

---

## 5. Datasets, ranked by what they would add

| dataset                      | scale                                 | what it scores that we do not                                                      | verdict                                                                                     |
| ---------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **LongMemEval-S**            | 500 q, ~115k tokens                   | the current axis                                                                   | in use                                                                                      |
| **LongMemEval-V2**           | up to 115M tokens, agent trajectories | retrieval from _experience_ (workflows, gotchas) not chat; best 72.5% vs RAG 48.5% | candidate; different task, new baseline needed                                              |
| **MemOps**                   | 2006 probes, 403 dialogues            | memory operations, stale-value reuse, forgotten-fact leakage                       | candidate; directly targets our KU and ABS failure classes                                  |
| **MemoryAgentBench**         | incremental                           | selective forgetting, multi-hop conflict resolution (≤28% for all systems)         | candidate; novel-competency axis                                                            |
| **LoCoMo**                   | 1540 q, 35 sessions                   | multi-session dialogue                                                             | secondary; Mem0 OSS scored 0.0% on it in one harness, which is an instrument question first |
| **Agent Memory Leaderboard** | 10+ datasets, 5000 q                  | a **public leaderboard with a fixed reader and an Add/Search protocol**            | see §7                                                                                      |
| **BEAM**                     | 100K / 500K / 1M / 10M; 2,000 probes  | scale degradation across ten abilities                                            | **cost, not doubt.** The 2026-10-05 past.dev release publishes a harness and per-question results (100K 92.08 / 10M 85.03), so the earlier "no reproducible BEAM number exists" no longer holds. Its own breakdown reports **multi-session 28.17% at 10M** — the route we are worst at, at the scale we have never tested |

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

| their requirement                           | our state                                            |
| ------------------------------------------- | ---------------------------------------------------- |
| `Add` (ingest) over a stable interface      | `ingest` — implemented                               |
| `Search` returning evidence for a query     | `search` — implemented                               |
| fixed answer model supplied by the platform | ours is configurable; the arm would run their reader |
| reproducible configuration                  | every arm option is recorded in the artifact         |
| ablations judged by ability tag             | our per-capability table is the same decomposition   |

This is the only route by which a Cortex number can become grade-A against the frontier without us grading our
own homework. It is a submission problem, not a research problem, and it is the highest-value external action
available.

## 8. What this document changes about the plan

1. **The target is 85.8%, not 96.4%.** Anything above the grade-A frontier is either a different reader or a
   different metric until an independent run says otherwise. The published ceiling moved from 96.20 to
   **96.40** when Exabase M-1 announced it, and the movement is the point: a ceiling that anyone can raise by
   announcing a number is not a target, it is a ranking of press releases. The 96.40 row is quoted with all
   four attributes precisely so that the next announcement does not require re-reading this paragraph.
2. **A reading made here is withdrawn.** An earlier version of this file treated the 82.4% oracle as the reader
   ceiling and inferred that 80.80% sitting 1.6 points under it meant retrieval had little left to buy. Raw-RAG
   at 87.53 with GPT-4o-mini — 5.1 points _above_ that oracle — retires the inference. 82.4 was one
   configuration of an oracle, not a bound, and the reader axis has to be priced by measurement rather than
   inferred from a seat under it. The shipped arm now reads **83.45%**, i.e. **1.05 points above that oracle**,
   which is the same withdrawal stated arithmetically: a number that moves past the supposed ceiling by
   changing what is retrieved (and which retry fires) cannot be bounded by it. The `S1` row in
   `ACCEPTANCE-MATRIX.md` carries the same retraction rather than a quietly corrected claim.
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

## 9. The three things this landscape says are still missing, in order

1. **A rerank stage.** §4.9: the single largest component of the strongest reproducible competitor, absent
   from this arm, implemented in this repository but wired to a different benchmark, and reachable through a
   provider we already hold a key for.
2. **A per-question ledger.** §4.9 item 2. Every increment so far has been judged on aggregate accuracy and
   a paired test; none has been judged on _which questions it bought and which it cost_, which is the number
   that decides whether two increments compose.
3. **A second reader that obeys the contract.** §4.7's wrapper results and §13.110's −7.20 both say the
   reader is a lever; only one of them says which direction is available.

### 4.10 Sufficiency rather than relevance (BFR, QEMem, xMemory)

This family arrived in the second half of 2026 and it is the first one whose diagnosis matches a defect this
campaign measured rather than inferred. All three reject the framing in which retrieval is a ranking problem.

> "Improving selection within the initial candidate pool cannot recover evidence that was never retrieved."
> — *Relevance Is Not Sufficiency* (arXiv 2610.09348)

**BFR (Budgeted Flat Reconstruction)** decomposes the question into information requirements by Formal Concept
Analysis, selects a compact candidate subset that jointly covers them, and then **repeatedly acquires records it
has not seen** — deeper text search, or a complementary entity or session view — until the budget is spent. On
LongMemEval-S it reports judged accuracy **72.4% → 82.2%** and **Turn Hit 91.4%**, against same-store adaptations
of recent agent-memory systems. It also proposes the two metrics that make coverage measurable: **Gold Hit** and
**Turn Hit**. Grade **B**: academic, same-store comparison, but reader and judge are not reported in a form this
arm can reproduce without a harness change.

**QEMem** (arXiv 2610.22668) is the same idea with a different unit: search several granularities at once,
organise what comes back into cards that keep each piece's evidential role and its source, then check the set for
sufficiency and go back for what is missing. **91.43%** LLM-judge on LoCoMo with Claude Opus 4.5, 7.6 points
above MemR³. Grade **C**: vendor-run.

**xMemory** (*Beyond RAG for Agent Memory*, Hu et al. 2026) argues the failure is the retrieval unit: turn-level
similarity over a dialogue collapses into one dense region of the embedding space, so it decouples memory into
components and retrieves top-down through a four-level hierarchy. Grade **C** on the numbers, **A** on the
diagnosis — the diagnosis is a mechanism, and a mechanism can be tested here without adopting anyone's score.

| what this campaign already measured | what this family adds |
| --- | --- |
| `pool < total` on **133 of 241** partial-evidence questions: the gold turn was never a candidate | the word for it: relevance is not sufficiency, and the repair is acquisition, not ranking |
| `MR` 12 partial-evidence failures at 64.7% against 87 full-evidence at 83.9% | an instrument: restore the missing turn and rerun the same reader, so recoverable / irreversible / residual are measured |
| a `goldOverlap` block with `carried`, `total`, `pool`, `goldRanks` | `Gold Hit` and `Turn Hit` as the two published names for it, which makes our figures quotable |

Two costs are honest to state. Acquisition needs a **stopping rule**, and BFR's is the budget, which means the
mechanism spends the budget it is given rather than proving it needed to. And this family's published gains are
measured with judges, so a comparison against our exact-match figures is a comparison of two metrics.

The one thing here that is *not* a competitor claim, and is worth more than the numbers: **the restore
counterfactual** (arXiv 2609.08279) — reinstate the question's gold evidence in the read-time context, rerun the
same reader, and classify by the change. It reports an irreversible share of **0.67–0.73** at an 80k budget under
top-k retrieval, and it states that recoverable errors exist under top-k and are absent under forced-gold
injection **by construction**, so budget-accuracy results are not comparable unless the retrieval regime is
reported. That sentence belongs in every table in this file.

## 10. What changed on 2026-11-06, and what it costs the plan

1. **The gap now has a name and a population.** 133 of 241 partial-evidence questions had a gold turn the ranking
   never offered; `MR`'s 26 failures split 12 partial / 14 full. Before this the campaign read the same defect as
   "aggregation" (§13.264), which addressed the smaller half.
2. **§4.10's mechanism is the next experiment, not §4.1's compression.** Compression buys tokens; acquisition
   buys reach, and reach is the measured deficit. The order in §9 changes accordingly.
3. **The width diagnostic is a diagnostic.** `relevanceTopK` 256 → 512 (§13.266) settles whether the pool cut is
   the constraint. It is not the mechanism: xMemory's argument is that a wider top-k fills with near-duplicates,
   and §13.257 already lost eight MR questions to displacement at a smaller widening.
4. **The restore counterfactual is now the blocking instrument.** Its input is the gold turn text, which the
   record did not carry; `goldTurns` was added for it and the field is pinned by a test. Until a run carries it,
   "twelve failures are retrieval-shaped" stays an inference.
5. **One comparability rule tightened.** BFR reports judged accuracy and Turn Hit; this arm reports exact match.
   No figure from §4.10 may be set beside an `S` row here without the metric named, for the same reason
   arXiv 2609.08279 refuses cross-regime budget comparisons.

## 11. What changed on 2026-11-06 with the assembly round, and which competitor each entry prices

Four censuses over the archived artifacts, none of which called a provider, and one experiment whose premise
they retired. The entries below replace readings that were in this file.

1. **The reference pipeline and this arm now differ in one prompt property, not three.** §13.246 named the
   schema, Step 2 and the terminator; §13.248 adopted all three, and §13.278 records that the sections citing
   them as missing were reading a superseded audit row. What is left is the **order** of the same segments --
   reference above the context, this arm below the evidence -- and §13.279 measures it. This matters for §4
   because it means the reference's 5.99–9.50 point `MR` lead, the only same-reader same-corpus comparison in
   this file, has exactly one unmeasured cause left on the prompt side.
2. **The derivation route is not where the reference wins.** The reference classifies `MR` questions and sends
   derivation shapes to `buildDerivationQaPrompt`; this arm sends them to `operands`. Measured at `top_k=256`,
   the arm reads **88.89%** on derivation shapes against **77.66%** on enumeration ones (85.19% / 73.40% at 512).
   A port therefore aims at the arm's strongest subpopulation, and its ceiling is three questions. The
   `operands` block (§13.166/§13.193) is doing more than the reference's split does for us.
3. **MemCog's family is not refuted, and its target moved.** With 24 of 29 `MR` failures carrying the gold value
   inside the delivered prompt, a second and third retrieval step cannot be justified by reach on this failure
   set. It has to be justified by what the reader does with what it already has -- which is a claim about
   *reading*, and the paper's own numbers do not separate the two. §4.10's ordering stands, with its
   justification rewritten.
4. **A wider top-k is not free on `MR`, and the failure is ranking stability.** §13.268 read 256 → 512 as free
   on the aggregate; the paired flip counts are **7 down / 2 up, exact McNemar p = 0.039**, and `1a8a66a6` lost
   gold coverage (22/22 → 16/22) *while the pool was being widened*. This is the same shape xMemory describes
   for near-duplicate dilution, arriving here as a delivery loss rather than as a token cost, so §4's argument
   against width no longer rests on that citation alone.
5. **One comparison rule this file has been violating.** The arm-versus-reference `MR` gap is **13:8 (p = 0.383)
   at `top_k=256`** and **18:7 (p = 0.043) at `top_k=512`**. The campaign has quoted the gap as a fact since
   §13.243; on the narrower pool it is not distinguishable from noise. Every table in this file that sets cortex
   beside the reference must say which pool the pair was drawn from.

## 12. Chain on Demand's own configuration, read against our port, and what it says about the repair

The mechanism this arm's ranking layer is ported from is arXiv:2611.02480, and until now this file cited it
by name and by its reported accuracies without reading its allocation section. Read, it prices three things
it was not printing: our anchor budget is **15x smaller** than theirs, our stability question is one their
limitation section explicitly declines, and their one experiment on how to protect a ranking prefix does not
mean what a reader will assume it means here.

| | CoD (arXiv:2611.02480, §4.1 and App. A.2) | cortex (`retrieval-anchored`) |
| --- | --- | --- |
| candidate pool | `K_cand = 200`, fixed | `top_k` 256 or 512 |
| anchor budget | **60** | **4** (`ANCHOR_COUNT`) |
| reconstruction window | 2 turns each side, from the **full memory** `M`, not from the pool | 3 each side, from the flat context |
| restored turns, upper bound | 240 | **24** |
| selection rule | additive: `R + 0.06 D + 0.10 C`, recomputed after every pick | **lexicographic**: coverage, then score, then novelty, then rank |
| pool-size ablation | **none**; §7 lists the fixed pool as a limitation | §13.280: 63 of 500 questions changed their delivered gold set |
| anchor stability under a changing pool | **not studied** | measured, then repaired (§13.280.6) |

Three consequences.

1. **The anchor budget is the largest unexplained difference between the two, and it is a capability gap, not a
   stability question.** CoD allocates 60 anchors and restores up to 240 turns; this arm allocates 4 and restores
   at most 24, against a delivered window whose median is 129 turns. Their evidence budget is roughly what a
   60-anchor restoration produces. That is a 15x difference in the mechanism's own parameter, and no archived
   reading of this arm isolates it: every dispatch since `41990597116` held `ANCHOR_COUNT` at 4.
2. **Their rule is why they do not see our defect, and they do not see it by accident.** With `R` in `[0, 1]` and
   `beta = 0.10`, a newly covered query term can only promote a candidate over one that leads on relevance when
   the two are within a tenth of a point -- their coverage term reorders near-ties. Our lexicographic order makes
   coverage dominate *absolutely*, so a rank-300 hit naming two question terms displaces a rank-3 hit naming one,
   and the displaced anchor's neighbourhood leaves the window. CoD is not immune to width-dependence (a deep
   candidate within 0.10 of `R` still wins a slot); it has simply never measured it, which §7 states outright:
   *"We do not systematically study how these choices scale with longer histories or different evidence
   budgets."*
3. **Their Table 13 is not a refutation of the repair, and the difference has to be stated or it will be read as
   one.** CoD's *protected coverage* variant (72.0%) and *protected D+C* (73.0%) keep a prefix of the dense
   ranking as mandatory anchors and spend the remaining budget with the extra criteria; both lose to the
   unprotected rule (77.0%). That is a statement about **allocation quality at a fixed pool**. The repair here
   bounds the **scan** at the registered width, where it is a no-op by construction (`min(256, 256)`), so it
   changes no allocation at `top_k = 256` and its purpose is to stop a *wider* pool from reallocating. The two
   experiments share a word and nothing else -- but the resemblance predicts that if this arm ever widens the
   pinned scan, CoD's result says the extra slots may not buy accuracy.

What that changes in §4's ordering: nothing about which competitor sets the `MR` ceiling (MemCog, 92.5%, still
does), and one new entry above the anchor-count experiment -- **raise `ANCHOR_COUNT` toward 60 and price the room
before dispatching**, because their configuration says the mechanism has been run at a fifteenth of its own
budget for every reading this campaign has published.

## 13. Granularity and denoising: what three 2025 results say about the room this arm spends on ids

§13.283 removes a 38-character identifier from in front of every turn. That is a small, mechanical change, and
four published results say whether the *direction* is plausible and what the field has already measured about
it. None of them measures our quantity, and two of them cut against the naive version of the claim.

| source | what it measured | relation to this increment |
| --- | --- | --- |
| **SeCom** (arXiv:2502.05589, MSRA) | memory-unit granularity on `LOCOMO` / `Long-MT-Bench+`: turn-level is too fine (incomplete context), session-level too coarse (irrelevant content), summarisation loses information -- **segment-level plus LLMLingua-2 compression as denoising** beats all three | the closest published argument to ours. Their "compression is denoising" is our rendering change one level down: we remove 13.8% of tokens that carry no task information and spend the characters on turns. The difference worth stating is that they compress *memory units before retrieval* and we change *what is rendered at the reader*, so the two compose rather than compete |
| **Context Rot** (Chroma, 2025-07) | 18 models; even a **single distractor** degraded the answer, and four compounded it; accuracy falls with input length on every task tested | predicts that *replacing* provenance with evidence should help and that *adding* evidence to an already-full prompt could hurt -- which is exactly the difference between a substitution (this increment) and the anchor-budget question §13.281 priced |
| **"Context length alone hurts"** (arXiv, 2025-10) | with **100% perfect retrieval**, performance still degrades 13.9% to 85% as input length grows; reciting retrieved evidence before answering recovered ~4% on RULER | the reason a fix that changes *no* prompt length can still move accuracy: what changes is the ratio of task-bearing to non-task-bearing tokens. It also predicts that the Step 1 enumeration `ask=verbatim` adopted (§13.248) is doing the "recite first" work already |
| **EMem** (arXiv:2511.17208) | event-centric memory with **turn-level source attributions** kept "to support downstream agentic behaviors" | the counter-argument, and it is a real one: provenance is valuable to *tooling* (our `AdmittedTurn.id` stays in the record and in the artifact), not necessarily to *the reader*. The treatment withholds the marker from the rendered prompt only, and §13.283.4's second refutation branch is the one that would prove the reader wanted it |

Three consequences for the roadmap.

1. **Granularity is the axis SeCom already won on, and this arm has only ever tested its two endpoints.**
   §13.34 reported `session-fill` as retired, but §13.286.2 found that the value never reached the product —
   the runner forwarded `session` and nothing else, so that dispatch ran the **turn** unit under a
   session-shaped label. `session-fill` is therefore unrun rather than refuted, and the segment-level unit
   SeCom argues for is a third value again, not the same experiment twice.
2. **Recall is the quantity to publish against them.** `LongMemEval` scores retrieval with `Recall@k`/`NDCG@k`
   against labelled evidence turns, and this arm has never printed the equivalent. It reads **86.75%** overall
   (6,520 of 7,516 gold turns), 97.11% on `MR`. Any claim that this arm is competitive has to be made on that
   number alongside accuracy, because a reader-side improvement that lowered recall would be indistinguishable
   from a memory regression.
3. **Nothing here sets the `MR` ceiling.** MemCog (92.5%, multi-step) and CoD (86.6%, anchor allocation) remain
   the two published numbers above this arm, and both differ from it on *which* evidence arrives. That is the
   same conclusion §13.282.2 reached from three null results, now with three external results pointing the same
   way.

### 12.1 The same question answered from the source instead of the paper

§12 priced this arm against CoD's *reported* configuration. The repository is public
(`github.com/Renkiroo/chainondemand`), and reading `cod/` changes three of the rows above and adds one
mechanism the paper does not foreground.

**Main entry, verbatim.** `run_cod.py:150` is `select_greedy_unprotected(pool, question, final_k)` followed by
`expand_seeds(store, cid, seeds, expand_window)`; the CLI defaults are `--pool-k 200`, `--final-k 60`,
`lambda_div=0.06`, `beta_ent=0.10`; `config.cod.yaml` fixes `expand_window: 2`. So the additive rule is
**recomputed after every pick** over the whole remaining pool — not a re-ranking of a fixed shortlist — and
the window is exactly two turns each side.

**Their window is cut at the session boundary by construction.** `store.expand_context` filters entries to the
seed's session *before* slicing `index ± window` (`cod/store.py:161`), so a window cannot cross into the next
session. Ours restores from the flat context, where the concatenation makes that crossing possible.

**Their assembly is not chronological.** `merge_evidence(seeds, expanded)` puts the anchors first in **score
order** and appends each seed's window afterwards; the prompt carries a timestamp per line so the reader can
reconstruct order. We print arrival order and rely on it, because TR's relative-date questions are the ones a
rank-ordered log costs. This is the one place §12's comparison row was flattering to us by omission: we are
not "the same shape with a different tie rule", we differ on presentation too, and the divergence is
deliberate.

**A mechanism the paper omits.** `select_seeds_rescue` keeps `core_k` anchors and fills the rest from a
**mid-rank window** `[rescue_rank_lo, rescue_rank_hi]` — `[11, 30]` in `cod/tests/test_seed_rescue.py` —
deliberately **skipping** the ranks immediately below the core. The stated reason is in the test: the hits
just under a cut are near-duplicates of the ones above it, so the informative ones sit further down. That is
a cheaper answer to the same problem as their ±2 restoration and worth its own dispatch, because it costs
four slots of room rather than a window per anchor.

**What this changes in §12's table.**

| row | as reported | as implemented |
| --- | --- | --- |
| restored turns, upper bound | 240 | `≤ 5 × 60 = 300` raw, deduped by id; 240 is the observed figure, not a bound |
| reconstruction window | 2 turns each side | same, and **session-clamped** — it cannot enter the neighbouring session |
| selection rule | additive, recomputed per pick | same, over the full remaining pool (`greedy_unprotected`), with two alternative selectors in the file that the main entry does not use |
| presentation | not stated | anchors in score order, windows after them; **not** chronological |

The consequence for our own next increment is §13.286: the shape to copy is *bounded anchors plus local
restoration, budget spent on the anchor*, not "sessions" and not "a wider prefix". `retrieval-anchored` was
the pool-side half of that idea — restore into the pool and let the neighbours compete — and §13.257 is the
record of what competition costs. The unit-side half, where neighbours are bought **with** their anchor and
never ranked, is the part that had not been built.

## 14. The October 2026 board, the reader axis priced from outside, and three papers that name our failure

Gathered on 2026-11-07 while §13.290 runs. Two things make this round different from §2's table: the board now
has a **cost column** that changes what "ahead" means, and one competitor published a diagnosis of its own
failures that is **structurally identical to §13.291's**.

### 14.1 The board, with context length beside the score

LongMemEval-S, all 500 questions, answer accuracy, gpt-4o judge unless stated. Figures as each vendor
publishes them.

| system | accuracy | context per question | reader | honesty flags |
| --- | ---: | ---: | --- | --- |
| Maximem Synap | **95.6%** | **7.4K** (content only; ~13.4K all-in) | Gemini 3.8 Flash | run data + harness public; the 7.4K excludes its 21.5 kB answering prompt — §13.340.3 |
| Mastra Observational Memory | **94.87%** | ~30K (4.1×) | gpt-5-mini | harness public, run data not found |
| Hindsight | 94.6% | ~43.6K (5.9×) | Gemini 3.1 Pro | judge is Gemini 2.5 Flash-Lite, not the official one |
| Mem0 (managed) | 94.4% | **6.8K (0.9×)** | not stated | run data not public; open-source SDK measures ~32% |
| Honcho | 90.4% | ~11.6K | Claude Haiku 4.5 | run data public |
| Zep | 90.2% | **4.4K (0.6×)** | gpt-5.4 | run data and harness not public |
| Supermemory | 85.2% | not published | Gemini 3 Pro | — |
| **cortex (this arm)** | **90.20% mixed / 83.45% S1** | **11.7K** | deepseek-chat | every artifact public |

Three facts this table states that §2's did not:

1. **The table is not one board, it is two.** Seven of the eight rows above run a reasoning-class reader
   (gpt-5-mini, gpt-5.5, Gemini 3.x, Opus 5.5) and this arm runs `deepseek-chat`, which is not one. §14.6
   re-groups it by reader, and the re-grouping changes the conclusion: against a same-class reader this arm is
   **0.78 points behind the strongest observational-memory system on the board**, not 12. Quoting the headline
   number against ours is a comparison between two different readers, and §14.2 measures what that difference
   is worth. What survives unambiguously is the **cost** half: 11.7K against Mem0's 6.8K and Zep's 4.4K is a
   real deficit on a comparable axis, and §13.292.4 turns it into acceptance row `C1`.
2. **The two self-declared "leaderboard parodies" are a real methodological warning.** Supermemory published
   `~99` explicitly labelled a parody of boards that omit cost and latency; AgentMemory's 96.2 is self-flagged
   as **46 tuning iterations on the test set with no held-out split**, and OmegaMax's 95.4 as **eight
   iterations on the test set targeting failure modes**. Two of the top four numbers on the board are the
   authors' own admissions of test-set fitting. Any plan that reads "we are 12 points behind" without that
   discount is reading a benchmark that does not exist.
3. **The oracle ceiling is 82.4%** (gpt-4o, evidence sessions only). Our S1 83.45% exceeds it, and the reason
   is not that we beat an oracle: it is a different reader and a different judge. Recorded because the
   coincidence is exactly the kind of number that gets quoted without its condition.

### 14.2 The reader axis, priced five times over, from outside

§13.192 priced this arm's reader at **−7.20** (§13.192: `deepseek-v4-pro` against `deepseek-chat`), and
§13.232 priced the compliant half at **+6.25**. Five independent parties now publish the same axis:

| source | same memory, reader changed | movement |
| --- | --- | ---: |
| Perpetuity (own axis, stated) | Sonnet 5 → Opus 5, same code and frame | +2.6 |
| Perpetuity (own summary) | "up to **22.6 points** on identical memory in our own axis" | ≤ +22.6 |
| Mastra OM | gpt-4o → gpt-5-mini | **+10.64** |
| Membase, LongMemEval 100-question sample | gpt-4.1-mini → gpt-5.5, **fixed stores** | **+13.0** |
| Membase, LoCoMo | the same swap, same stores | **+0.06** |
| Recallium | GPT-4o → Claude Opus 5.5 | **+8.2** |

The Membase pair is the one that constrains us, because it is the only **controlled** substitution: **the same
reader change is worth +13.0 on one workload and +0.06 on another.** Their own conclusion is that this "argues
for diagnosing answer failures on the intended workload before allocating more computation to either retrieval
or generation" — i.e. a reader axis has no portable sign.

That is what this arm measured and did not have a name for. `deepseek-v4-pro` lost 7.20 here (§13.192) while
`gpt-5-mini` gains 10.64 for Mastra. **The difference is not the model's strength, it is compliance with the
contract** — and §13.111 had already written the sentence for our own case: *"reader strength and reader
compliance are different quantities and the second dominates here."* The external board cannot adjudicate that distinction, which is why it is written
here rather than inferred from a ranking: the latest published scores say a stronger reader helps, and this
arm's own −7.20 says a stronger reader hurt. Both are true of the contract each was measured under.

Recallium's per-category table is the one number in this round that points somewhere specific:

| category | GPT-4o | Opus 5.5 | Δ |
| --- | ---: | ---: | ---: |
| multi-session | 85.0 | 98.5 | **+13.5** |
| temporal-reasoning | 88.0 | 96.2 | +8.2 |
| abstention (inside type) | 76.7 | 93.3 | **+16.6** |
| single-session-preference | 80.0 | 100.0 | +20.0 |
| knowledge-update | 94.9 | 100.0 | +5.1 |
| **overall** | **90.2** | **98.4** | +8.2 |

Our `MR` is 77.69% and their GPT-4o is 85.0% on the same category: **7.3 points below a model we do not use**,
before any reader upgrade. `ABS` is our strongest capability (30/30) and theirs is 76.7% — so the one category
where a better reader buys 16.6 points for them is the one where we have nothing to gain. **The categories
where a reader swap pays most are, for us, already closed by the contract.** That is a claim this table can
support and §13.232's −16-on-`IE` result independently confirms from the other side.

### 14.3 Membase published our diagnosis, independently and first

Their full LongMemEval_S run reports **99.95% retrieval recall** and **all gold sessions present for 99.8% of
questions**, and attributes **all 37 incorrect answers to the reading stage with gold evidence in context**.
The three failure modes they name: *cross-session aggregation*, *distinguishing a user action from an assistant
suggestion*, *temporal calculations*.

Against §13.291:

| | Membase | cortex (§13.291) |
| --- | --- | --- |
| gold evidence delivered | 99.8% of questions | **120 of 121** |
| errors attributed to reading | 37 of 37 | 9 of 9 newly-complete failures repaired: **0** |
| first named failure mode | cross-session aggregation | 26 of 27 failures are counting questions |

Two independent systems, two datasets, one conclusion: **once the gold evidence is in the window, the score is
decided at the reader, and the largest single class is aggregation.** This is the strongest external support
this campaign has had for a negative result, and it is worth stating plainly because §13.291's 0-of-9 is
otherwise a lonely number.

### 14.4 Three papers that name the mechanism §13.93 could only describe

§13.93 falsified `sweep` with a mechanism sentence: *"the reader's enumeration is not limited by how much of the
document it looks at. It is limited by what it recognises as an instance of the question's action."* Three
2026 results say what that is and what to do about it.

**1. Judging is not enumerating (`arXiv:2608.01000`).** Across four reference constructions, models **judge**
membership far better than they **author** the set: +0.34 to +0.29 F1 on an algorithmic construction over a
**24× parameter range, and the gap does not close**. The control is the finding: *"asked to emit the predicate
rather than its extension, the same models reach F1 about 0.99."* So the deficit is not knowledge and not
specification — it is **materialising the region a specification induces**.

And the asymmetry that makes it hard to fix: models detect planted **over-inclusions 6–7× more often** than
planted omissions, because *"an over-inclusion is a token a reviewer can challenge, a missing member an absence
whose discovery is the authoring problem itself."* A production deployment of 43,227 items failed
omission-first at **10:1**.

Our census is **18 below the gold against 4 above**. That is 4.5:1 on the same side, on a different task,
produced by a different reader. §13.289 measured the direction; this paper says the direction is a property of
the class of models, not of `deepseek-chat`.

**2. When agents stop counting (IEEE 11737128).** A deterministic benchmark over paginated aggregation with an
exact programmatic oracle: accuracy **collapses as N grows**, and **self-reported completeness does not fall
with it** — "*agents keep asserting they covered every page while silently miscounting*". They name the shape
the **"accuracy–completeness scissors"**, and the conclusion is the one §13.291 reached from the other end:
*"because agents fetch every page yet still miscount, the failure is one of aggregation, not retrieval."*

**3. Exhaustive retrieval for listing questions (agentpatterns.ai, 2026).** The design rule that follows, in
their words: *"Structural extraction, a stated count, and model self-assessment are **not interchangeable**, and
only the first two hold up when the model is miscalibrated."* Their working example uses a **cardinality cue** —
a document that states its own count — to decide whether to loop; neither run *"asked the model to certify its
own completeness"*.

### 14.5 What this round changes, and the one increment it names

Three consequences, ordered by how soon they bind.

1. **§13.290's mechanism now has a name and a published magnitude.** Its replacement rule is exactly "emit the
   predicate, not the extension" applied to one line: *a mention counts when the evidence describes the same
   act under a different verb.* The paper's +0.29–0.34 F1 is the outside estimate of what that class of change
   is worth, and §13.290's registered ceiling of +5.0 points (six reachable questions of 121) is well inside it.
2. **The next increment after it is judgement-shaped, not enumeration-shaped.** If §13.290's six questions do
   not convert, the evidence says the reader still cannot *materialise* the extension — and the fix is to stop
   asking it to. `sweep` failed because each of its 44 lines still required the model to **generate** the
   candidates for that session before judging them. The shape that has not been tried is the one the paper's
   control used: **present each candidate and ask for a verdict**, so the model judges a given turn rather than
   enumerating a region. §13.290.4's refutation branch already names "a second consultation that re-reads the
   evidence against its own list"; this is the same mechanism with the cost priced.
3. **No self-assessment anywhere, ever.** All three sources agree, and this arm has one measurement of its own
   that agrees: `--final` (§13.93.5) found 4 of 22 correct `sweep` answers ending on a different number than the
   one they were scored against, i.e. the transcript contained the gold and the reply's own closing line did
   not. A gate that asks a reader "did you get them all" would report complete on that run.

**What this round does not change.** It does not move the SOTA claim: on published numbers our 90.20% mixed /
83.45% S1 is below Maximem (95.6), Mastra (94.87), Hindsight (94.6), Mem0 (94.4), Honcho (90.4) and Zep
(90.2), and above Supermemory (85.2). **cortex is not SOTA.** What changed is that the reason is now
attributable in three independent places rather than one — evidence delivery (§13.291), the reader's
aggregation (§14.3), and the model class's omission bias (§14.4.1) — and that §14.6 separates the part of the
gap that is a mechanism from the part that is a reader.

### 14.6 The same board grouped by reader, which is the only grouping that compares anything

§14.1's table puts seven reasoning-class readers in one column and `deepseek-chat` in another. Mastra publishes
the missing half of that comparison, and it is decisive: **their Observational Memory reads 84.23% with gpt-4o
and 94.87% with gpt-5-mini.** Same memory, same observer model (`gemini-2.5-flash`), same 500 questions, only
the answering model changes. That is §14.2's axis measured on the system we are compared against.

So the board splits:

| reader class | system | accuracy | context |
| --- | --- | ---: | ---: |
| **non-reasoning** | Recallium (GPT-4o, 3.8 results/question) | 90.2% | 3.8 items |
| | **Mastra OM (gpt-4o)** | **84.23%** | ~30K |
| | **cortex (`deepseek-chat`)** | **83.45% S1 / 90.20% mixed** | **11.7K** |
| | EmergenceMem Simple (gpt-4o) | 82.40% | not stated |
| | oracle (gpt-4o, gold sessions only) | 82.40% | 1–3 sessions |
| | Mastra RAG topK-20 (gpt-4o) | 80.05% | — |
| | Zep (gpt-4o, 2025) | 71.20% | — |
| | full context (gpt-4o) | 60.20% | 115K |
| reasoning | Mastra OM (gpt-5-mini) | 94.87% | ~30K |
| | Hindsight (Gemini 3 Pro) | 91.40% | ~43.6K |
| | Supermemory (Gemini 3 Pro) | 85.20% | — |

**In the non-reasoning class this arm is 0.78 points behind the strongest observational-memory system on the
board, and inside the run-to-run spread that Mastra itself says the oracle gap falls in.** Against the oracle
row we are +1.05, against the gpt-4o full-context baseline +23.25, against Mastra's own RAG arm +3.40, against
Zep 2025 +12.25.

Per category, with the caveat that the two datasets are partitioned differently (we use 5 capabilities
IE 150 / MR 121 / KU 72 / TR 127 / ABS 30; they use 6 categories 156 / 133 / 78 / 133 / — / 30), so only the
totals are strictly comparable and the rows below are indicative:

| category | Mastra OM (gpt-4o) | cortex (`deepseek-chat`) | reading |
| --- | ---: | ---: | --- |
| multi-session | 79.7% | **77.69%** | −2.0, and this is our worst capability |
| temporal-reasoning | 85.7% | **95.28%** | **+9.6**, our second strongest |
| knowledge-update | 85.9% | **88.89%** | +3.0 |
| single-session | 82.1–98.6% | 94.67% (IE) | partition differs |

Three consequences, and the third is a plan change rather than an observation.

1. **The memory mechanism is not where the gap is.** Two systems with entirely different designs — one streams
   every message through an observer and a reflector and shows the actor a compressed observation log; the
   other retrieves individual turns into a character budget — land within 0.78 points at the same reader class.
   §13.291's 0-of-9 and §13.93's `sweep` null say the same thing from inside: what the arm does with the
   evidence stopped mattering before this round began.
2. **The cost half is a real deficit on a comparable axis, and it is the opposite direction from the accuracy
   half.** 11.7K against their ~30K is **39% of their bill** for the same reader class and the same accuracy.
   So the arm is cheaper than the system it is level with and more expensive than two systems it beats. That is
   a defensible position and `C1` is the row that keeps it from drifting.
3. **The reader is the whole remaining gap, and it is now a procurement question rather than a design one.**
   Mastra's +10.64 from gpt-5-mini, Membase's +13.0 on LongMemEval, Recallium's +8.2, Perpetuity's ceiling of
   22.6 — every one says the same thing, and this arm cannot act on it by designing better memory. It can act
   on it in exactly one way: **find a reader it can call that is both stronger and compliant, and check that
   compliance did not get traded for strength.** `deepseek-v4-pro` was stronger and non-compliant (−7.20,
   §13.192); the route-scoped thinking switch was the same reader made compliant and bought +6.25 (§13.232).

   That makes `zhipu:glm-4.6` the highest-value remaining reader experiment, above reranking. Reranking's
   outside price is RAW-RAG's −3.92 ablation on their own corpus; the reader's outside price is +8 to +13 on
   four independent systems. §13.115 stays queued because it closes two acceptance rows and is the one
   published mechanism this arm lacks, but it is no longer the next dispatch.

**What this section corrects.** An earlier draft of §14.1 read the headline column against our number and
concluded we are "dominated on both axes". That comparison used a reasoning-class reader for them and a
non-reasoning one for us, which is §14.2's own subject. The corrected statement is narrower and more useful:
**on accuracy this arm is level with the best system it can be fairly compared to, and on cost it is cheaper
than that system and dearer than two it beats.** The SOTA claim does not change — 95.6% at 7.4K exists and is
not ours — but the reason it is not ours is now a single named quantity, and it is not memory.

### 14.7 Our own column on that table, and the unit it is written in

`C1` was `unrun` while §14.1 was written, so the board had a cost column for seven competitors and none for
this arm. It is no longer empty: **12,105 prompt tokens per question per repetition** on `42310779222`
(`tools/cost-ledger.py`, evidence at `cortex-docs/evidence/longmemeval/cost.json`).

**The unit had to be chosen before the number meant anything.** One token count, three defensible divisions,
4.14x apart — 11,690 per call, 12,105 per question per repetition, 48,420 per question across all four
repetitions. The primary is the per-question one because the competitor recipes in `acceptance.ts` are written
per question ("about 4.4K context tokens per question", "about 6.8K tokens per question", "about 7.4K memory
tokens per question"), and the 3.5% between it and the per-call reading is this arm's 71 retries — a cost of
answering that question rather than of a separate one.

| | prompt tokens per question | accuracy | ours |
| --- | ---: | ---: | --- |
| **cortex (this arm)** | **12,105** | 83.45% | — |
| Zep | 4,400 | 90.2% | 2.75x the prompt, 6.75 points behind |
| Mem0 (managed) | 6,800 | 94.4% | 1.78x the prompt, 10.95 behind |
| Maximem Synap | 7,400 content-only / ~13,400 all-in | 95.6% | **~1.0x all-in, 12.15 behind** — the 1.64x this row used to show compared their content count with our prompt count (§13.340.3) |
| Mastra OM (gpt-4o reader) | ~30,000 | 84.23% | **0.39x the context, 0.78 behind** |
| Hindsight | 43,600 | 94.6% | 0.28x the context, the counter-example |

**What the reading actually measures is the window.** The arm ran under `maxPromptChars: 48000` and
`48000 / 11690 = 4.11 characters per token`, the density of English prose — the delivery fills its character
cap. So this row currently prices a configuration constant rather than a retrieval selection: improving
retrieval will not move it, changing the cap will. §13.291 is the measurement that cuts against the obvious
repair: bringing every gold turn into the `MR` prompts (98 of 121 questions to 120 of 121) moved accuracy by
**+0.00**, which is evidence that *adding* evidence to a full window buys nothing — **not** evidence that
removing it is free. No run has taken the cap down and looked, so the cap experiment is registered behind the
reader change rather than in front of it.

**Round 59 divides the row, which is what this table could not do.** The prompt decomposes into
**97.18%** evidence and **2.82%** instructions, header and question, so the two bases are 8,941 and 9,201
tokens and every row above can be restated on whichever one its competitor published. The result is a split
verdict rather than a ranking — dearer than all five on the content basis, 0.69x of the one all-in figure
anyone has measured — and [`MEASURE-TOKEN-BASIS.md`](MEASURE-TOKEN-BASIS.md) is the table, `tools/token-basis.py`
the arithmetic, and `pnpm check` recomputes it. The 2.82% is also the answer to the question this section
leaves open: there is no prompt-engineering saving hiding in the overhead, so the only lever on the row is
the cap.

The honest sentence for the board is that this arm is **mid-table on cost and behind the leaders on accuracy**,
and that the two facts are connected by §13.291 rather than by the cost number: the tokens are not buying
accuracy, and more evidence did not either. Hindsight at 43.6K for 94.6% is the row that keeps "cheaper" and
"better" from being read as the same axis.

**A number that is not on this table and must not be added to it.** `42337560027` (`ask=verbatim-acts`) reads
**91.20% overall** on the artifact's own `correct` scale against 90.20% for the shipped arm — a +1.00 gain, with
`MR` 77.69% → 81.82% (§13.294). The figures in §14.1 are the official judge's readings of a different artifact,
on which this arm is 83.45%; 91.20 is therefore not comparable to Zep's 90.2 or Mastra's 84.23 and is not entered
in the table. The delta is what the run supports, and even the delta is not yet attributable to the rule: that run
also changed the delivered evidence on all 94 questions it reached (§13.294.3), which is what §13.295 re-runs.

## 15. MEME at its actual evidence grade, and what the target is now

Three external reviews on 2026-11-07 proposed MEME as the next arena. The adjudication is in
`docs/DECISION-MEME-AND-TARGETS.md`; this section records the two things that belong in a landscape
document — what MEME's numbers are worth, and what the project now compares itself against.

### 15.1 What MEME measures, and how low the floor is

MEME (`arXiv:2605.12477v1`) defines six tasks on two axes, entity scope and temporal dynamics, and its
multi-entity evolving quadrant is `Cas` (propagate an upstream change under a rule) and `Abs` (answer
"unknown" when no rule applies). Data is 100 controlled episodes generated from two hand-built DAGs,
with `trivial-pass` filtering so that a system which remembers nothing cannot be scored as having
updated correctly.

Under one `gpt-4.1-mini` reader across six systems and three paradigms:

| | score |
| --- | --- |
| Cascade, mean across systems | **0.03** |
| Absence, mean across systems | **0.01** |
| static entity retrieval, mean | 0.62 |
| best MD-flat | 0.06 / 0.05 |
| MD-flat with Claude Opus 4.7 as the **internal memory LLM**, 20-episode ablation | 0.32 / 0.59, at ≈70x baseline cost, with ER and Tr falling |

The two readings a decision has to survive: **the floor is 3% and 1%**, which is a genuinely
unsaturated arena; and **the only published improvement came from paying 70x for a stronger model
inside the write path**, not from a stronger answering model. The mechanism story is that a reader can
re-derive `A→B→C` from raw context only when the raw context is there, so query-time reasoning
substitutes for missing materialisation only while the evidence is present.

### 15.2 Why it is not a title, and why the coverage band was misquoted

The aggregated board for MEME carries eight rows and **all eight are self-reported**; the current top
is another system's flat baseline. Whoever runs first is first. That is the same defect §14.1 was
written to avoid, and it is why MEME cannot be entered for a title.

The direction card caught a real error here, and it is worth recording because it was our own number
being used the wrong way round. `cortex-docs/docs/05-competitor-analysis.md` §1.17.4 already said:

> 论文说的那个"覆盖不足"的区间（19%–76%）我们已经走出了，而我们还差 4 分——所以剩下的 4 分不在覆盖率上，在排序质量上

Our coverage, from `tools/evidence-depth.py`, is **69.7%–100%** with three of five routes above 84%.
So `35.69–76.35%` is **the other systems'** coverage in the MEME paper. It is not a statement that
MEME is unsaturated for us, and a roadmap that cites it as the reason to change arenas has the
direction of the inference backwards. §1.17.5 states the rule that was broken: the expected gain of
one mechanism cannot be carried between two coverage bands.

### 15.3 The one external hook, at its grade

RAW-RAG's phase-visible oracle is quoted at **82.32 / 91.54** for DeepSeek-V4-Flash and **1.83 /
36.15** for GPT-4o-mini on Cas / Abs. If that is true it says MEME's floor is an assembly-and-reader
problem, not a graph problem — and the cortex reader is in the DeepSeek family.

It is second-hand coverage of `arXiv:2610.30755` in both upstream documents, so it enters this
document as **a hypothesis with a cheap test**: 10–20 episodes, existing raw-turn retrieval,
chronological assembly, no graph. That test is specified in §13.297.4 and it is not run until three
settlements complete, because each of the three is cheaper and each changes what the test would mean.

### 15.4 What the project compares itself against now

| line | reading | status | rule |
| --- | --- | --- | --- |
| **T1** reproducible A-grade first | 90.15% vs memoricai 85.8% | **met** | same-harness, A grade only |
| **T2** parity at the same reader grade | 90.15 / 90.40 vs Recallium 90.2 (GPT-4o) | **met** | judge differs — "not behind", not "ahead" |
| **T3** `MR` inside the reference-pipeline pair | 81.82% vs 85.12%, **−3.30** | **open** | one artifact, one reader, one judge, one question set |

T1 and T2 are met and were already met when the reviews were written; neither review noticed, because
both measured against the self-reported headline rather than against the grade. T3 is the only line
where this project is behind something it controls end to end, and it is where the campaign's weight
now sits.

What this retires is the per-round required field "are we SOTA". It could not be computed — `--gap`
refuses to rank across differing six-tuples, which the project wrote itself — and a required field
that cannot be computed gets filled with prose.

### 15.5 The two numbers the reviews had that are now stale

Recorded here rather than only in the decision doc, because a landscape document that a later round
quotes will be quoted with these figures:

- **`MR` gap: −7.43 is now −3.30.** `42337560027` (`ask=verbatim-acts`) moved `MR` from 77.69% to
  81.82% against the same 85.12% reference (§13.294.4).
- **per-question cost: 14.1K is now 12,105.** `42310779222` through `tools/cost-ledger.py`, three
  divisions at 11,690 / 12,105 / 48,420 (§13.293.1). The 4.14x spread is why the denominator has to be
  named before the number is compared with Zep's 4.4K.

## 16. Two 2026 papers that move the board without moving any score

Round 27 went looking for mechanisms and came back with something more useful: a **measurement** result. A
paper that reports its own numbers under two grading protocols, and a paper that ablates the reader across
eight backbones with everything else held fixed. Between them they re-price three rows on this page, and one of
them — `C1` — was being read against the wrong competition.

### 16.1 MemStrata: 2.4 points of the "gap" is the protocol, inside one paper's own artifact

`arXiv:2610.05343` (MemStrata, Oct 2026) evaluates the same 500 questions twice: once with the benchmark's
original reference-only grading, and once with **source-aware** grading, in which the judge checks the reference
against the full source before assessing a system-blinded answer. Same answers, same system, same reader.

| reading | reference-only | source-aware | delta |
| --- | ---: | ---: | ---: |
| MemStrata CL1 | 463/500 = **92.6%** | 475/500 = **95.0%** | **+2.4** |
| its full-history control (4.7x evidence) | 464/500 = 92.8% | 470/500 = **94.0%** | **+1.2** |

Two things follow, and the second is the one that costs.

1. **A 2.4-point difference between two published "LongMemEval scores" can be a judge-side change with no
   system change at all.** Every vendor row above 95% on this page is quoted as if the number were a property
   of the system. On this paper's own evidence, roughly two points of it is a property of the adjudication.
2. **The direction is not always favourable, and the paper says so**: under source-aware grading the
   full-history control *loses* five questions to the bounded packet (470 against 475), while under
   reference-only it *gains* one (464 against 463). The system ordering flips between protocols. A leaderboard
   that mixes them is not a leaderboard.

### 16.2 The number this project actually has to beat, and it is not 95

MemStrata's bounded packet reads **463/500 at a 24,000-token ceiling** under the original protocol, with a
local `Qwen 3.8 27B Q4_K_M` reader. The registered `cortex-memory` configuration reads **457 / 466 / 457 / 459**
across four repetitions — mean **459.75/500 = 91.95%**, first repetition 91.40% — at **12,137 prompt tokens per
question**.

| | cortex | MemStrata CL1 | difference |
| --- | ---: | ---: | ---: |
| accuracy, original protocol | 91.95% (mean of 4) | 92.6% (1 run) | **−0.65** |
| evidence per question | 12,137 tokens | 24,000-token ceiling | **0.51x** |
| reader | DeepSeek `deepseek-chat` | Qwen 3.8 27B Q4_K_M, local | — |

**−0.65 points is three questions, and the same paper measures its own label noise at 1.5–2.3% of 500 on a
same-seed replay of unchanged requests — 7.5 to 11.5 questions.** So the only defensible statement is that the
two are **indistinguishable at half the evidence**, and that neither is distinguishable from the other on this
axis at this sample size. That is a better position than any previous round could claim, and it is *not* a SOTA
claim: 95.0% (MemStrata, source-aware), 95.6% (Synap), 95.60% (Agent Zero), 96.8% (ContextStream) and
98.4% (Recallium) all sit above it, and none of them is on the same protocol as our number.

**And the protocol that differs is now measured rather than asserted.** `MEASURE-JUDGE-SENSITIVITY.md`
re-reads this arm's own 467 recorded answers with a second judge at `scorer=full`: **427 → 412 correct,
−3.21 points, 13 down and 0 up** against a 0.43% same-judge flip rate, with **ten of the thirteen lost
questions in `IE`** (93.3% → 86.7%). So the band on our headline is ±3.2 points and capability-shaped, which
puts Synap's 95.6% (4.35 points above this arm's 91.25%) and Mastra's 94.87% (3.62 above) **inside one judge
swap**. Recallium (+7.15) and ContextStream (+5.55) stay outside it. Synap is also the only one of those five
that publishes per-question answers and verdicts (§4.1 of `COMPETITOR-CODE-AVAILABILITY.md`), i.e. the only
one where the comparison can be settled by re-grading instead of by running.

Three of MemStrata's other arms are worth recording because they bound what selection is worth at a fixed budget:

| arm | score | what it prices |
| --- | ---: | --- |
| keyword-only selection, same budget | 425/500 = 85.0% | ranking is worth **7.6 points** over lexical matching |
| matched-reader Letta | 438/500 = 87.6% | a whole competing memory design, same reader, **−4.4** against the packet |
| full-history, 4.7x evidence | 464/500 = 92.8% | evidence volume is worth **+0.2**, i.e. nothing |

The third row is the one `C2` is read against (§13.301.2), with the caveat recorded there: a curve that is flat
*above* the vertex can still fall below it, and nobody has published the cut side.

### 16.3 Agent Zero Memory: quality is retrieval-dominated, and that re-prices `M1`

`arXiv:2608.29606` reports **95.60%** on LongMemEval and a controlled backbone study: eight model families, the
memory, retriever and control logic held fixed, and

| quantity | spread across eight backbones |
| --- | --- |
| LongMemEval accuracy | **3.4 points** |
| per-query cost | **~30x** |

with `deepseek-v4-pro` within 3.4 points of the best system at about **1/20 the cost**, and `glm5.2fast` the
fastest at 6.16 s median latency. Its own reading of that result is the sentence this campaign has spent
twenty-seven rounds trying to earn: *"quality is retrieval-dominated"* — once the right provenance-tagged
evidence is surfaced, compact backbones answer correctly.

That has three consequences here.

1. **`M1`'s threshold is re-priced, and `PREREG-READER-AXIS.md` §7 records the amendment.** A 5-point bar asks
   this pipeline to be *more* reader-sensitive than the strongest published system's entire eight-backbone
   spread. The row reads 3.0 and now carries this number as a competitor row — as a **bound, not a pair**, and
   the recipe says so.
2. **`P1` stops having an empty competitor field.** MemStrata reports its own second-provider reading on
   byte-identical packets: `GLM 5.3 flash` at **462 against 463** — one question, −0.2 points — with a stated
   non-inferiority bound of 3 points, and a second provider (`Muse Spark 1.3`) that **failed** that bound on 269
   questions. So portability is now a value with a recipe, not a vendor sentence, and `P1`'s 2.0-point bar sits
   between the success and the failure.
3. **A cost claim and an accuracy claim are the same claim only at a fixed reader.** Agent Zero's 30x cost
   spread at 3.4 points of accuracy means any "cheaper than X" sentence has to name the reader, or it is
   comparing two different economic objects.

### 16.4 The board, per axis, with the competition named

The per-round question "is cortex SOTA" has one honest answer per axis and no single answer, which is what
`§15.4` established. Restated with this round's readings:

| axis | cortex | leader | verdict |
| --- | ---: | --- | --- |
| accuracy, original protocol, same 500 | 91.95% (mean of 4) | MemStrata **92.6%** at 24k tokens | **not SOTA, and not behind** — inside the leader's own label noise, at 0.51x the evidence |
| accuracy, source-aware grading | not measured | MemStrata **95.0%** | **unmeasured** — we do not report this protocol, so the comparison does not exist |
| accuracy, self-reported headline | 91.95% | Recallium **98.4%** (Claude Opus 5.5), ContextStream **96.8%**, Agent Zero **95.60%** | **not SOTA**, and none of the three is a grade-A comparison |
| cost per question | 12,137 tokens | Zep ~4,400 published, MemStrata 24,000 | **not SOTA**; `C1` aims at 6,000 and `C2` is dispatched to price the cut |
| memory pollution (reversal) | `V1` 0.0pp, `K1` +64.7pp | TEPA **−9.9pp** for append-only, 0.950 with revocation | **at least as good as the field's counter-example**, on a 17-case fixture rather than a 50-seed stream |
| provider portability | `P1` unrun | MemStrata −0.2pp, bound 3 | **unmeasured** |
| reader strength | `M1` unrun | Agent Zero 3.4pp across 8 backbones | **unmeasured**, and the bar is now calibrated against that bound |

No cell in this table is a SOTA claim, and four of the seven are `unrun`. That is the state of the project, and
it is a better state than the previous round, because three of the cells now have a number where they had a
sentence.

## 17. The cost axis has a number, and the number is bought with an accuracy row

Round 28's §16.4 marked cost as `not SOTA` with an unmeasured cut behind it. `42373407439` measured it,
and the result is the first two-sided reading on this board: both cost rows clear their thresholds and
the accuracy registration beside them refuses the same run.

### 17.1 The two rows, and the row that says no

| row | threshold | 48,000 room (`42355323615`) | 24,000 room (`42373407439`) | verdict |
| --- | --- | ---: | ---: | --- |
| `C1` prompt tokens per question | ≤ 6,000 | 11,558 | **6,077** | **not met**, by 1.3%; the 5,623 this row used to print is a median of evidence characters — `MEASURE-COST-FLOOR.md` §1 |
| `C2` median evidence ratio | ≤ 0.70 | 1.000 (denominator) | **0.487** | **pass** |
| `A` accuracy within 2.0 of the control | ≥ 89.4 | 91.40 | **88.20** | **fail**, by 1.20 |

So `C2`'s bar is reachable and `C1`'s is not, even at the smaller room: the ledger reads **6,077**. The price
of trying is `-3.20`. `docs/PROMPT-ROOM-IS-LOAD-BEARING.md` has the reading and
[`MEASURE-COST-FLOOR.md`](MEASURE-COST-FLOOR.md) has the bound that closes the family — at the allocation that
ships, the two load-bearing capabilities bill **6,167** on their own, so no setting of the other four routes
reaches 6,000. The number this page needs is that **cost is measured, and it is not met at any dispatched
setting.**

Against the board, the smaller room is the closest this product has come to a cost win:

| | cortex at 24,000 | MemStrata CL1 | difference |
| --- | ---: | ---: | ---: |
| accuracy, original protocol | **88.20%** | 92.6% | **-4.40** |
| evidence per question | **5,623 tokens** (median; 5,775 mean) | 24,000-token ceiling | **0.23x** |

Twenty-three percent of the evidence for four and a half points. That is not a win, and it is the first
time the trade is a number rather than an argument.

### 17.2 `B` failed in the direction that matters, and it named the repair

The registration predicted the loss would land in `ABS`, `IE` and `KU` — the three capabilities
`tools/gold-room.py` priced as exposed — and that `MR` and `TR` would be free. The measurement is the
mirror image: `ABS 0.00`, `IE -0.67`, `KU -1.39`, against **`MR -6.61` and `TR -4.72`**.

The mechanism is in the two artifacts and needs no model call to see. Every capability lost about half
its delivered turns (`MR 199 → 102`, `TR 205 → 109`, `IE 64 → 32`, `KU 67 → 28`). Only the two that
**aggregate** lost accuracy, because `IE`, `KU` and `ABS` ask for one fact in one turn and half a packet
still holds that turn, while `MR` and `TR` ask for a count over turns — and a count over a sample is not
the count. The failure signature is literal: `gpt4_a56e767c` answers `3` against four festivals,
`gpt4_7fce9456` answers `5` against four properties.

**Therefore `tools/gold-room.py`'s `room` column is a lower bound on exposure, not an estimate of it.**
A gold-coverage model is sufficient for a single-turn question and irrelevant for an aggregation,
because an aggregation's requirement is not its gold turn but the complete set of turns the gold counts.
This is the fourth instrument in this campaign to predict safety and be contradicted, and the first whose
*model* rather than whose *reading* was the defect.

### 17.3 What the board looks like now, per axis

| axis | cortex | leader | verdict |
| --- | ---: | --- | --- |
| accuracy · original protocol · same 500 | **91.40%** (1 rep) / 91.95% (4-rep mean of the previous batch) | MemStrata **92.6%** at 24k tokens | **not SOTA, not behind** — inside the leader's own 7.5–11.5-question label noise, at 0.51x the evidence |
| accuracy · source-aware grading | **screened, not scored** | MemStrata **95.0%** | **still unmeasured**, but the screen now exists: `tools/source-aware-audit.mjs` splits reader from retrieval on any artifact, and `auditReference` is the protocol. This moved from "no implementation" to "implementation, dispatch pending" |
| accuracy · self-reported headline | 91.40% | **Recallium 98.4%**, ContextStream 96.8%, Agent Zero 95.60% | **not SOTA**, and none of the three has public code (§`COMPETITOR-CODE-AVAILABILITY.md`) |
| cost per question | **11,558** registered / **6,077** at the smaller room | Zep ~4,400 published; MemStrata 24,000 | **not SOTA**; the trade is now quantified at `-3.20` for `0.487x`, and the smaller room still misses `C1` by 1.3% |
| memory pollution | `V1` 0.0pp, `K1` +64.7pp | TEPA **-9.9pp** append-only | at least as good as the field's counter-example, on 17 cases rather than a 50-seed stream |
| provider portability | `P1` **no reading** | MemStrata -0.2pp | **unmeasured**; the run that would have read it (`42368550937`) died on a provider content filter and that defect is fixed (`ProviderContentRefusal`) |
| reader strength | `M1` unmeasured | Agent Zero 3.4pp / 8 backbones | **unmeasured** |

Four of seven cells still carry no number, and `P1`'s run is now known to have died for a reason that
had nothing to do with the arm — which is the second thing this round changed: the pass is 5 hours and
one refused prompt used to destroy it.

### 17.4 The one number that changed the plan

`252 questions whose answer lives in one turn` read `92.86%` at 48,000 and `92.06%` at 24,000. The
`248 that aggregate` read `89.92%` and `84.27%`. That split is the whole product roadmap for cost: the
free half is half the questions, and no published competitor has reported a per-route budget at all.

## 18. The October board re-read, the reader axis priced at 22.6 points from outside, and the reasoning literature that makes `T1` two-sided

§17 left seven cells, four of them `unrun`, and one lever unmeasured: the 45% of the bill that is reasoning.
This section re-reads the board at its own check date, adds the outside reading of the reader axis that §14.2
could only bound from vendor pairs, and states the literature's prediction for `T1` **before** our number
exists.

### 18.1 The board, as published on 2026-10-28

| system | LongMemEval_S | context/question | answer model | judge | verdict on the row |
| --- | ---: | ---: | --- | --- | --- |
| Maximem Synap | **95.6%** | 7.4K | Gemini 3.8 Flash | gpt-4o | self-reported, per-question data public |
| Mastra OM | 94.87% | ~30K | gpt-5-mini | gpt-4o | self-reported, **84.23% with gpt-4o** |
| Hindsight | 94.6% | ~43.6K | Gemini 3.1 Pro | its own family | judged in-family |
| Mem0 platform | 94.4% | ~6.8K | not stated | not stated | **open-source config measures ~32%** |
| Honcho | 90.4% | ~11.6K | Claude Haiku 4.5 | gpt-4o | self-reported |
| Zep | 90.2% | ~4.4K | gpt-5.4 | gpt-5.4 | self-judged |
| cortex | **91.20%** | **9,201** | deepseek-chat | deepseek-chat | 4 repetitions, artifact public (`42533236864`) |

Two rows moved in a direction that matters more than the ranking. **Mastra publishes 84.23% with `gpt-4o` and
94.87% with `gpt-5-mini`** — 10.6 points from the answer model alone, on a memory that did not change — and
**Mem0's 94.4% belongs to the managed platform while a third-party re-test of its open-source configuration
reads about 32%**, which is the same "two products, one name" defect this document caught in §12 and §14.
Neither is a reason to doubt the systems; both are reasons to keep the reader column beside the score, which
our own table does.

Against our position the honest reading: **91.20% is 4.40 points behind the headline**, at **1.24x** Synap's
published context and 0.21x Hindsight's — and on the all-in basis §1.45 established for the Synap row (its
7.4K counts `memory` plus `source_evidence` and excludes the field skeleton and the answer prompt, whose own
lower bound is ≥12.4K), **this row is the cheaper of the two and it is the one that is behind.** The one cell this board makes worse is cost: Mem0's ~6.8K and Zep's ~4.4K are both below our
12,137, and neither is reachable by cutting the room (§17.1 measures that trade at −3.20 for 0.487x).

### 18.2 The reader axis, priced five times over with the memory held fixed

§14.2 priced the reader from vendor pairs and got 1.8 points across three frontier readers on one packet.
An independent roundup now publishes the other direction: **one memory, five readers, 22.6 points.**

| what was held fixed | what moved | spread |
| --- | --- | ---: |
| Perpetuity's frame on the same 500 | reader only | **22.6 points** |
| Mastra's memory | answer model `gpt-4o` → `gpt-5-mini` | **10.6 points** |
| Synap's memory + prompt | `gpt-5-mini` → Gemini 3.8 Flash | 3.6 points |
| Agent Zero's memory | eight backbones | 3.4 points |
| our packet (`M1` arm A/B) | `deepseek-flash` vs `deepseek-v4-pro` | **1.35 points** |

The last row is why this is a section and not a footnote. **Our own reader spread is the smallest of the five,
and it is the only one measured on a single provider.** A 4.40-point gap sits inside what the field reports
for a reader change over identical memory, so "cortex is 3.65 behind" and "cortex's reader is 3.65 behind"
are not distinguishable from anything this campaign has run. `M1` remains the one arm that would separate
them, it remains unrun for a reason that is not scientific (the two frontier readers in the board's rows are
not reachable from this repository's org secrets), and every memory-side arm is now read with that caveat
attached: **a memory-side win of less than 3 points cannot be separated from a reader effect by this
pipeline's own instruments.**

### 18.3 What the reasoning literature predicts for `T1`, stated before the number

`T1` drops the `multi-session+temporal` thinking reach and asks what it was worth. Four published results
bound the answer, and they do not agree:

| source | intervention | finding |
| --- | --- | --- |
| TALE (ACL 2025 Findings) | model-estimated token budget in the prompt | **67% fewer output tokens, <3 points lost**; a budget set *too tight* is ignored and reasoning grows again (258 → 86 at 50 tokens, 157 at 10) |
| Chain of Draft (2024) | each reasoning step ≤ 5 words | commonsense and symbolic unchanged, **arithmetic loses ~4 points for an 80% cut** |
| NoWait (EMNLP 2025) | suppress reflection tokens (`Wait`, `Hmm`) | 27–51% shorter, negligible loss on RL-trained models, **>12 points lost on distilled ones** |
| Price of Thinking (arXiv 2608.16956) | explicit `high` effort vs omitted, Sonnet 5, AIME | cost **+$0.0103/call**, accuracy **+0.0133 [−0.0267, +0.0467]** — no detected gain |

So the prediction, written here before run `42617201299` is read:

- **`MR` should be the route that suffers**, because counting is the arithmetic-adjacent case where every one
  of the four sources that separates task families finds the loss, and `MR` is also where the answer is not
  in any single turn.
- **`TR` should suffer less**, because its questions are arithmetic over a window the turns already carry
  dates for — closer to the symbolic case that survived trimming.
- **A flat result on `MR` is a surprise, not a win.** If the reasoning turns out to be worth nothing on the
  one route whose task shape the literature says needs it, the more likely explanation is that the reach was
  not reaching the request on this arm, which is why §13.343.3 makes `completionTokens` falling by more than
  half a precondition of reading the accuracy at all.

### 18.4 The per-route budget no competitor reports

`§17.4`'s split — **252 questions whose answer lives in one turn, 248 that aggregate** — is already the shipped
configuration: `abstention/assistant/flat/knowledge-update` at 24,000 characters and `multi-session/temporal`
at 48,460 and 48,000 (`INPUTS`, §10.3). It is worth stating on this page because no published competitor
reports a per-route budget at all: the board's context column is one number per system, and both of ours are
below Hindsight's and above Zep's *by route* rather than on average. That is a product fact the leaderboard
cannot express, and it is the only column on which this project is ahead by construction rather than by
measurement.

## 19. The reader axis has two names, and the cheaper one is not the smarter one

§18.2 priced the reader five times from outside and got a spread of 1.35 points on this project's own packet
against 22.6 on Perpetuity's. Round 60 added three things to that column, and together they say the axis the
plan has been treating as one axis is two, with opposite signs.

### 19.1 Two interventions, one column, and they disagree

| intervention | pair | Δ | prompts | verdict |
| --- | --- | ---: | --- | --- |
| reasoning **mode**, same model, same provider | `41222844945` → `41254359622` | **+4.70 pt** | byte-identical, 500/500 | the mode buys points |
| reasoning **mode**, shipped reach, current configuration | `42600727738` → `42621461902` (`T1r`) | **+0.5 pt** | byte-identical, 200/200 | the mode buys nothing measurable, and the shipped value costs 2.14x the bill for it (2.021 against 0.944 CNY) |
| model **tier**, same mode, same provider | `40698867439` → `40698883428` | **−7.20 pt** | byte-identical, 500/500 | the larger model loses |

The first and second rows are the same knob read at two points in the campaign's history, and they do not agree
— which is why §13.360.6 registered the third reading (500 questions, current configuration) **before** its
artifact existed rather than narrating the difference afterwards. The third row is a different axis entirely:
`deepseek-v4-pro` is not "more reasoning", it is a different model, and on this arm and this prompt it loses
58 questions while winning 22, with the loss concentrated in `TR` (−14) and `IE` (−12).

### 19.2 The frontier prices the same axis lower than the field's own anecdotes

Synap publishes three readers over one unchanged memory — which is the only kind of row that belongs in this
column: **95.6%** with Gemini 3.8 Flash, **95.2%** with `gpt-5.4`, **97.0%** (485/500) with Gemini 4 Argon. The
spread is **+1.4 points**, and the frontier tier is *below* the flash tier on the middle row. Mastra's
**+10.64** remains the largest published reader effect and it is a `gpt-4o` baseline, which §14.6 already
argued is a weak-reader story rather than a strong-reader one.

So the board's reader column now reads: 22.6 (one memory, five readers, third-party frame) > 10.64 (Mastra,
weak baseline) > 4.70 (this arm, thinking on the shipped prompt) > 1.4 (Synap, frontier) > 0.5 (this arm, the
current configuration) > −7.20 (this arm, larger model). **The effect shrinks as the baseline gets stronger**,
which is the one pattern in this column that is consistent across four independent systems.

### 19.3 Three rows refreshed, and one more vendor that publishes two numbers for itself

Checked against the vendors' own pages on 2026-11-10, in the spirit of §2's rule that a score without its
reader and judge is a press release:

- **Honcho 90.4% at ~11.6K context**, Claude Haiku 4.5 reader, `gpt-4o` judge — a *cheap* reader at 1.6x our
  context, which makes it the closest architectural comparator in the field rather than a headline.
- **Zep 90.2% at ~4.4K** with a `gpt-5.4` reader *and* judge, against **71.2%** on the same benchmark under a
  `gpt-4o` judge in a third-party comparison. That is a 19-point spread on one system, and it is the same
  defect this ledger already records for `mem0-v3-context` — one number, two pairings. Neither row is adopted;
  both are recorded, because a ledger that quietly picks the favourable pairing produces a table identical to
  one that picked the other.
- **Hindsight**: 94.6% (Gemini 3.1 Pro) in the vendor's own table against **91.40%** (Gemini 3 Pro,
  `GPT-OSS-120B` judge) in an independent roundup. Two readers, two judges, 3.2 points.

**MemPalace's 96.6%** appears in a ranking blog with no harness, no judge and no per-question data; it is
grade **C** at best and is not added to §2's table, which is the rule that keeps that table from becoming a
list of announcements.

### 19.4 What this changes about the plan

Nothing about accuracy, and that is the point. Three independent sources now say the reader swap is worth
1.4–4.7 points once the baseline reader is competent, and this arm's own reader swap is worth **−7.20** in the
wrong direction. The next mechanism therefore cannot be a reader change.

**The 500-question confirmation landed, and it answered the mode question in the direction the 200-question pair
did not:** `42533236864` against `42826272421` reads **91.05% → 86.70%**, **−4.35 points** on 500 questions and
500 of 500 byte-identical prompts, with `TR` −12.40 and `MR` −4.13 carrying all of it and `IE`/`KU`/`ABS`
answering **identically on all 252 questions**. So the mode buys 4.35 points for 53% of the bill at steady state,
the default does not move, and `M1` — the row this section's §19.1 third column is about — **passes at 4.3pp**.

The general lesson is in the two readings of the same knob: a 200-question sample said **+0.5** and the full pass
said **−4.35**. §19.1's third row (`deepseek-v4-pro`, −7.20) and this one are therefore the same story told at
two scales — **on this arm, the reader moves are large enough to see and small enough to be hidden by a sample**,
which is why every row in this section that is quoted carries its N.
