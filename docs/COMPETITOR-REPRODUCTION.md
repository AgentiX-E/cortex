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
| protocol + adapter + reference driver + tests | **done** (`tools/competitor-sut/PROTOCOL.md`, `tools/competitor-sut.mjs`, 9 tests) |
| `mem0` driver | **done and partially exercised**: manifest verified against `mem0ai 2.2.1`; ingest does not complete in the development sandbox within 90 s (offline telemetry retries) |
| `--sut` wiring into `tools/competitor-harness.mjs` | next |
| the first real run (mem0, `infer=0`, Zhipu embeddings, 100 stratified questions) | needs a Runner, one dispatch |
| second competitor | after the first produces a number, because the second one's cost is only knowable once the machinery has been through one end to end |

## 7. What this does not fix

Running their code answers "what does this system score under our conditions". It does not answer "why", because a
competitor's internals are a black box behind `search`. The only diagnosis available across systems is the one this
repository already performs on its own arms — which of the five capabilities moved, and by how much — and that is a
ceiling on what a cross-system comparison can conclude. Stated here so a later round does not read a gap as an
explanation.
