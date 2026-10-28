# COMPETITOR-REPRODUCTION

Running a competitor's code with our reader on our data, because a published number is not a measurement.

## 0. One paragraph

Three independent third parties now put the reproducible LongMemEval frontier at **85.8%** (memoricai) and
**86.5%** (Redis's reproduction), while self-reports differ from reproductions by **+3 to −28 points** — Vertex's
~70% reproduced at 42.4%. A vendor's number is therefore a hypothesis about their configuration, and the only way
to turn it into a comparison is to run their code with our reader, our judge, our data and our budget. This
document specifies the machinery that makes that a configuration rather than a rewrite, records what running the
first one already established, and states the cost arithmetic that must decide whether a run happens at all.

## 1. The boundary, and why it is a process

`tools/competitor-sut/PROTOCOL.md` defines three operations — `reset`, `ingest`, `search` — over newline-delimited
JSON on stdio, plus a mandatory `manifest`. A competitor runs as a child process because every one of them ships a
Python package with pinned transitive dependencies, and two of those in one environment is a weekend. The boundary
also makes a crash a *reported failure* rather than a stack trace that aborts a 500-question run at question 12.

`tools/competitor-sut.mjs` is the parent: it launches a driver, reads the manifest before the first call, and
enforces the four failure modes.

### 1.1 The three verdicts, which must stay three

| what happened | verdict | because |
| --- | --- | --- |
| process exited / timeout / a line that is not JSON | **the run fails** | the comparison did not happen; a table printed anyway would be read as a result |
| the driver answered `{"ok": false}` | **this question fails** | the system refused this question — a claim about the system |
| the driver answered `{"ok": true, "hits": []}` | **found nothing** | also a claim, and the opposite one |

Collapsing the last two is the defect this repository has recorded four times in its own instruments (a report
that named neither of its two systems; a cache that named no model; a `rawOutput` that is the retry rather than
the first attempt; an admitted set quoted as a rendered one). `refusals` and `emptyResults` are therefore separate
counters on the provider, and the report prints both.

### 1.2 The manifest is not decoration

`name`, `build` and `version` are read before the first call and travel into the report, next to the score. A
competitor's number that arrives without the commit and configuration that produced it is the same failure as a
number that arrived without its own arm name — with an extra party to blame.

`build` is a **cost class** (`llm` / `embedding` / `none`) and the driver declares its own, because a parent that
guessed would be guessing about someone else's architecture.

## 2. The cost arithmetic that decides whether a run happens

| system | ingest cost per turn | 500 questions x ~550 turns | verdict |
| --- | --- | --- | --- |
| lexical / embedding-only | 1 embedding | ~275,000 embeddings | feasible, and the embedding cache makes it repeatable |
| `llm` extraction (`infer=1`) | 1 LLM call | **~275,000 LLM calls** | **not a comparison, a bill** |

This is why `mem0_driver.py` defaults to `MEM0_INFER=0`: the published 94.4% uses LLM extraction *and* a top-200
retrieval budget, so a run at `infer=0` is a **different system** and the manifest says which one ran (`"infer":
false`, `"llm": "unused"`). Comparing our 80.80% with a number produced at `infer=0` and calling the difference
"Mem0 vs Cortex" would be exactly the error both repositories keep a record of.

Ingest is also amortised the way this project amortises its own embeddings: the store is built once per corpus and
reused, and `reset()` isolates questions rather than rebuilding.

## 3. What running Mem0's code established, before any score existed

Four facts that no paper or README states, obtained by driving `mem0ai 2.2.1` through the protocol. Each one
changes what a comparison can claim.

1. **`timestamp=` is rejected by the OSS SDK.** `Memory.add(..., timestamp=...)` raises *"The timestamp parameter
   is not supported by the OSS Memory SDK."* The session instant therefore travels as `metadata`, and the manifest
   counts how many sessions carried one. **A memory system that cannot be told when a turn happened cannot answer
   "last month"** — so on TR, a `mem0` run is not measuring the same capability, and the report must say so rather
   than record the gap as a retrieval difference.
2. **`search` requires `filters={"user_id": ...}`.** The top-level `user_id=` spelling is rejected in 2.x. Both
   spellings were tried against the installed version rather than taken from documentation, which is the general
   rule for this whole file.
3. **The `faiss` store disables hybrid scoring.** Mem0 prints: *"The 'faiss' vector store does not support keyword
   search. Hybrid (BM25) scoring will be disabled and search will use semantic similarity only."* Since the
   published configurations use hybrid retrieval, **a faiss-backed run is semantic-only** and is not the
   configuration behind any published Mem0 figure. `qdrant` is the local store that keeps keyword search.
4. **Telemetry posts on `add` and retries with backoff when egress is blocked**, which presents as an ingest that
   takes minutes for one session — indistinguishable from a slow vector store. The driver sets `MEM0_TELEMETRY`
   before importing Mem0.

Point 1 is the most important and the least obvious: it is a *capability* boundary discovered by running, not a
performance difference discovered by scoring.

## 4. The embedding space is declared, not rented silently

Mem0 validates its embedder provider against a fixed table, so a custom embedder cannot be registered from
outside the package. Two supported configurations, both explicit:

| `MEM0_EMBEDDER` | what it uses | when |
| --- | --- | --- |
| `openai` (default) | Mem0's own OpenAI client pointed at Zhipu's `embedding-3` via `openai_base_url`, using the Runner's `ZHIPU_API_KEY` | the real run: same embedding space as our own arms, no extra package |
| `deterministic` | Mem0's own client pointed at a **local stub endpoint** serving sha256 feature-hash vectors (`tools/competitor-sut/det_embedder.py`) | offline: proves the pipeline end to end, and gives a hash-space comparison whose only differing term is the memory system |

Neither is allowed to be implicit. The `deterministic` manifest says `"comparable_to": "a hash-space run only"`,
so a number produced that way can never be quoted as "Mem0's score".

## 5. What a result will be allowed to say

`comparability()` already computes the grade from two `RunConfig`s, and it must be applied to a competitor run
like any other:

| differs | grade | what may be said |
| --- | --- | --- |
| nothing | **A** | "we are N points behind" |
| reader / judge / judgePolicy | **B** | direction only |
| dataset / question count / top-k / token budget | **C** | nothing about the gap |

The first target is therefore a run whose `RunConfig` matches `40088479628` on every HARD field: 500 questions (or
a stratified 100), the same official judge and policy, the same top-k once Mem0's `top_k` is set to it. `build`
differences (`llm` vs `embedding`) are **not** a comparability failure — they are the cost side of the ledger and
must be printed, not equalised.

## 6. State

| piece | state |
| --- | --- |
| protocol + adapter + reference driver + tests | **done** (`tools/competitor-sut/PROTOCOL.md`, `tools/competitor-sut.mjs`, 17 tests) |
| `mem0` driver | **done and run**: `40519523383` produced `0.0%` and the number was wrong — §6.1 |
| `--sut` wiring into `tools/competitor-harness.mjs` | **done**, and it now prints ingest loss |
| the first quotable reading | **open**: the repaired driver has not been dispatched yet |
| second competitor | `RAW-RAG`, per §6.2 — same shape as this arm, MIT, DeepSeek reader supported, same corpus file |

### 6.1 Run `40519523383`, and the two defects that produced a plausible number

The run printed:

```
mem0                embedding 0.0%    0.0%    0.000   —    0    0
system under test: 100 refusal(s), 0 empty result(s) of 100 question(s).
```

Every element of that row is consistent with "mem0 retrieves nothing on this corpus", and none of it was true.

| defect | what it did | why nothing caught it |
| --- | --- | --- |
| the vector store was never told the embedding width | `FAISSConfig.embedding_model_dims` defaults to **1536**; the configured embedder produces **1024**; faiss rejects every `add` with a bare `AssertionError` from `assert d == self.d` | the driver caught the exception per session and listed it as `skipped`, which is correct for one bad session and fatal for a hundred |
| nothing read the skip list | the store stayed empty, so every `search` raised the same assertion and the parent counted each one as a **refusal** — a claim about the system | `refusals` and `emptyResults` were already separate counters; the third counter did not exist |

The lesson is not "mem0 is hard to configure". It is that **the protocol had three verdicts and needed four**: a
run that fails, a question the system refuses, a question it finds nothing for, and **a corpus that never reached
the store**. The fourth was in the data from the first commit — `ingest` had always returned `skipped` — and no
renderer read it.

What changed, each with a test that runs without a vendor key:

1. the driver passes `embedding_model_dims` to the store, and **refuses to guess** when the embedder does not
   declare a width, because a store left at its default is silently claiming a vector space;
2. a run whose ingest stores nothing is a **failed comparison**, checked in the driver and again in the protocol —
   the rule belongs to every driver, not to the ones that remembered to implement it;
3. the report prints `ingest: N of M session(s) stored, K refused` with reasons whenever the count is not zero.

Verified against `mem0ai 2.2.1` + `faiss-cpu` in the development sandbox: ingest stores 2 turns, search returns 2
hits. The next dispatch of `competitor-retrieval.yml --sut mem0` is the first reading that will be quotable.

### 6.1.1 The same harness, the same driver, before and after

The repair is not argued from the unit tests alone. The full harness — every provider row, the capability table,
the refusal counts — was run end to end on the synthetic corpus with a deterministic hash embedder, which needs no
vendor key:

| | before the repair (`40519523383`, LongMemEval 100) | after (`--sut mem0 --people 3`, synthetic) |
| --- | --- | --- |
| recall@k | 0.0% | **100.0%** |
| all-gold | 0.0% | 88.9% |
| MRR | 0.000 | **1.000** |
| refusals | 100 of 100 | **0 of 15** |
| empty results | 0 | 0 |

Two things this does and does not establish. **It does** establish that the pipeline now moves data in both
directions, which the previous run could not demonstrate for any question. **It does not** produce a Mem0 score:
the embedder is a hash space, the corpus is ours, and the manifest says so
(`"comparable_to": "a hash-space run only"`). The `all-gold` gap at 88.9% against recall's 100.0% is mem0's own
behaviour showing through — it returns extracted memory text rather than the turns it was given, so a hit whose
text does not contain the gold turn verbatim scores as recall but not as all-gold. On the real corpus that
difference is the thing to watch: it is the difference between "mem0 found it" and "mem0 returned something that
made us find it".

The `~tok` column reads **12** here against the lexical arms' ~2,600, because mem0 returns short extracted
memories rather than sessions. That is a real cost advantage on this corpus and an untested one on LongMemEval,
where the published Mem0 configurations report 6.8–7.0k tokens. Recording the difference rather than the number is
the point: the token column is the one a reader will use to argue about efficiency, and it is measured on the
corpus that was run.

### 6.2 Which competitors can actually be run here

The machinery exists so that "can we run it" is a per-competitor fact rather than a project decision. Current
assessment, from each project's own packaging:

| system | package | ingest cost | behind the protocol | note |
| --- | --- | --- | --- | --- |
| Mem0 OSS | `mem0ai` | 1 embedding/turn (`infer=0`) | **yes** — `mem0_driver.py` | driver repaired; first quotable reading pending |
| agentmemory V4 | `pip install -e ".[dense]"` | 1 embedding/turn, optional cross-encoder rerank | **candidate** — `async_recall` / `async_build_context` map onto `search` / `ingest` | highest published figure (96.2%) with individually nameable signals, so a disagreement names *which* signal |
| Graphiti / Zep | `graphiti-core` | LLM entity extraction per episode | needs a graph server or an embedded driver | 0.0% in one independent harness — reproduce the *harness fit* before the score |
| Cognee | `cognee` | LLM extraction | heavy dependency tree | 20.0% in the same harness |
| Mastra OM | `@mastra/memory` (TypeScript) | one LLM call per compression window | not a retrieval interface — a context-assembly policy | the copyable mechanism is window management, not a `search` endpoint |
| Letta / MemGPT | `letta` | LLM extraction | server-oriented | different interaction model: an agent loop, not retrieval |

The ordering rule this table implies, revised this round: **the second competitor is `RAW-RAG`**, not
`agentmemory V4`.

| reason | detail |
| --- | --- |
| **same shape** | raw turns, timestamps, dense retrieval, reranking, no extraction, no rewriting — a reproduction that disagrees points at an implementation detail rather than at an architecture |
| **the reader we already use** | an explicit `DEEPSEEK_*` block beside the OpenAI-compatible `LLM_*`, so the comparison holds the reader fixed by configuration rather than by re-implementation |
| **the same corpus file** | `longmemeval/longmemeval_s_cleaned.json`, 500 questions — no version question to answer first |
| **its own ablations exist** | `rag_atomic_facts`, `rag_raw_summary`, `rag_graph_expanded_raw`: three mechanisms this project is also considering, already measured inside the competitor by its authors |
| **MIT** | no licence argument |

`agentmemory V4` is the better *leaderboard* reproduction — highest published figure, six separately nameable
signals — but it is a different architecture, so a disagreement would be attributable to the architecture and
not to the implementation. Both are worth running; the order changed because the shape-matched one answers the
question this arm currently has ("is the distance to 87.5 the reader or the pipeline?"), and the leaderboard one
answers a question the project is not yet asking.

The one open dependency in `RAW-RAG` is the reranker: the paper uses a Cohere `/v2/rerank` endpoint, and the
Runner holds DeepSeek and Zhipu keys. Two substitutions are possible and both have to be stated in the manifest
rather than assumed — a local cross-encoder, or an OpenAI-compatible rerank endpoint if Zhipu exposes one. A run
with the reranker disabled is a different system and its row must say so.

## 7. What this does not fix

Running their code answers "what does this system score under our conditions". It does not answer "why", because a
competitor's internals are a black box behind `search`. The only diagnosis available across systems is the one this
repository already performs on its own arms — which of the five capabilities moved, and by how much — and that is a
ceiling on what a cross-system comparison can conclude. Stated here so a later round does not read a gap as an
explanation.

## 6.3 The first quotable competitor reading: mem0, 100 questions

Run `40614772262`, `MEM0_INFER=0`, Zhipu `embedding-3` at 1024 dimensions, FAISS:

```
system under test: mem0 2.2.1 (build=embedding) — {"embedder": {... "dims": 1024, "model": "embedding-3"},
  "infer": false, "llm": "unused", "timestamped_sessions": 0, "vector_store": "faiss",
  "vector_store_dims": 1024}
mem0    embedding  99.0%   4.0%   0.846   —   1942   0
system under test: 0 refusal(s), 0 empty result(s) of 100 question(s).
```

Every condition this document's §6.1 added is satisfied: the store width is declared (`vector_store_dims:
1024`), the run is 100 stratified LongMemEval questions, and the refusal count is zero rather than a hundred.

| column | mem0 | `cortex-session` on the same 100 questions | what the difference is |
| --- | --- | --- | --- |
| recall@k | **99.0%** | 87.0% | mem0 finds the gold session **more** often than we do |
| all-gold | **4.0%** | 73.0% | mem0's returned text almost never contains the gold turn |
| MRR | 0.846 | 0.746 | its top hit is more often the right session |
| ~tokens | **1,942** | 33,310 | it returns a fraction of the context |

**The 99.0 against 4.0 is the finding, and it is not a defect in either number.** mem0 does not return the
turns it was given; it returns the memories it wrote. A hit therefore scores as *recall* whenever its session
contains the gold turn — the harness's own rule — but almost never scores as *all-gold*, which asks whether the
returned **text** carries the gold turn verbatim.

This is the mechanism the Raw-RAG paper measured as a 19.62-point loss when atomic facts are extracted: the
evidence is replaced by a description of the evidence. A reader handed 1,942 tokens of mem0's prose is not
reading the conversation, and on a question whose answer is a date inside a turn, the turn is what matters.

**What this may be used for.** Grade **B**: same corpus, same 100 questions, same embedding space, no reader on
either side — so it is a retrieval comparison and must never be written against an accuracy number. What it
says, precisely: *in this configuration, mem0 retrieves the right session more often than this arm and returns
the evidence itself far less often.* That is a real trade, it is the one its architecture makes, and it is the
first competitor statement in this repository that is a measurement rather than a citation.

**What it may not be used for.** It is not "mem0 scores 99%" — there is no reader in it. It is not the
published 94.4% either, which configures LLM extraction (`infer=1`, ~275,000 model calls on this corpus) and a
top-200 budget. The manifest says `infer: false`, and this document's rule is that a number carries its
configuration or it is not quoted.
