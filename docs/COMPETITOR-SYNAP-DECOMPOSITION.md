# Maximem Synap: what is replicable, what is not, and what the number counts

Status: read of the vendor's published artefacts, 2026-11-09. Every figure below is either quoted
from a file in the vendor's public repository or computed from one by
`tools/synap-context-census.mjs`; the command that recomputes each is given beside it.

## 1. The answer in one paragraph

There is **no code to replicate**. The published repository is a client SDK for a hosted service:
`adapters/synap_adapter.py` in their own harness calls `sdk.user.context.fetch()` and nothing else,
so ingestion, entity resolution and retrieval run in a process nobody outside the company can read.
The **paper does not contain a system either** — `arXiv:2607.21503` is a framework paper: no
ablation table, no token accounting (`§6.3`: *"We deliberately report no latency numbers here"*), no
recall metric, and no statement of what is ingested or what is retrieved per question. It reports
**92.0%** with `gpt-5-mini`, not the 95.6% in the blog. What *is* published is the part that
actually moves the score — a **21.5 kB answering prompt**, **500 per-question records**, and the
harness — and taking it apart changes the question from "should we clone this" to "**the 7,400-token
figure is not counting what our 12,137 counts**".

## 2. Code availability, line by line

| evidence | what it establishes |
| --- | --- |
| `maximem-ai/maximem_synap_sdk`, Apache-2.0, 79 stars | the SDK, 24 framework integrations, MCP adapter — **all client-side** |
| the vendor's own README: *"The Synap memory engine itself — ingestion, entity resolution, retrieval, anticipation — runs as a fully managed cloud service… and is not open source"* | the three components that produce the score are the three that are closed |
| `memory_and_context_eval_harness/adapters/synap_adapter.py` | 400 lines of retry/backoff around `sdk.memories.create()` and `sdk.user.context.fetch()`; no ranking, no extraction, no storage |
| the same repo's `adapters/` holds `mem0_adapter.py`, `zep_adapter.py`, `supermemory_adapter.py` | the harness is the reusable artefact, and it is the only one |

So the replication question is not "can we read their code". It is whether the mechanism is
recoverable from the published behaviour, and §5 answers that it partly is — **but not in the
direction the 7,400-token figure suggests**.

## 3. What the paper does and does not contain

`arXiv:2607.21503v1`, *Agentic Context Management*, 23 pages, 6 figures, 4 tables, single author,
submitted 2026-07-23. It names five primitives — architecting, ingesting, scoping, anticipating,
compacting & consolidation — and reports one configuration per benchmark.

| what a replication would need | in the paper | consequence |
| --- | --- | --- |
| ingestion unit and granularity | **absent**; §4 says extraction is "governed by the per-agent architecture" | cannot reproduce the store |
| what is retrieved per question (verbatim turns / facts / summaries) | **absent** | cannot reproduce the packet |
| token budget | **absent**; retrieval is "token-budgeted" with no value | cannot reproduce the cost |
| ablation of any component | **absent** — no table, no numbers, anywhere | **cannot attribute the score to any mechanism** |
| recall metric | **absent**; the paper argues *against* hit-rate metrics in §3.3 | — |
| run artefacts | *"available on request rather than published"* | — |

The paper's own best number is **92.0% (460/500)** with `gpt-5-mini` as answer model **and** judge,
and its category breakdown is the informative part:

| category | paper (gpt-5-mini) | blog run (Gemini 3.8 Flash) |
| --- | ---: | ---: |
| single-session-preference | 100.0% (30/30) | 96.7% (29/30) |
| single-session-user | 100.0% (70/70) | 95.7% (67/70) |
| knowledge-update | 100.0% (78/78) | 97.4% (76/78) |
| temporal-reasoning | 100.0% (133/133) | 97.7% (130/133) |
| single-session-assistant | 87.5% (49/56) | 96.4% (54/56) |
| **multi-session** | **75.2% (100/133)** | **91.7% (122/133)** |

Five perfect categories on one reader and 75.2% on the one that aggregates. The paper calls this
residual error. **It is the shape of the problem**, and it is the same category this repository
finds hardest.

## 4. What the 95.6% is made of

Three separable things, and only one of them is a memory system.

### 4.1 The reader, measured by the vendor

Their own README runs the same memory and the same prompt under three answer models, `gpt-4o`
judging all three: **95.2%** (`gpt-5.4`), **95.6%** (Gemini 3.8 Flash), **97.0%** (Gemini 4 Argon).
A 1.8-point spread across frontier models. That is the vendor's own measurement of how much their
number is the model — and it is small *because all three are strong*.

This repository's reader is `deepseek-chat`. **It has never been compared with a frontier reader on
identical context.** That is the single largest untested variable between 91.95% and 95.6%, and it
is one arm, not a mechanism.

### 4.2 The representation: mostly verbatim, not summarised

The intuition "7,400 tokens because they compress" is wrong, and the published records say so:

```
$ node tools/synap-context-census.mjs <question_records_gemini-3.8-flash.json>
records parsed          342 (file was truncated; tail dropped)
median items/question   18
median content chars    26881
median serialised chars 39327
items with an excerpt   58.3%
excerpt length median   2259 chars

headline                7391 tokens/question
  as content            3.64 chars/token -> content-only
  as whole record       5.32 chars/token -> implausible
```

- **60.3% of the serialised context is `source_evidence`** — verbatim excerpts.
- **6.2% is `memory`**, the LLM-written summary.
- **42% of the 6,699 items carry no excerpt at all**, so those reach the reader as a summary with
  nothing to check it against. Their own prompt concedes the risk: *"prefer the value that appears
  verbatim inside the quote over the summarized phrasing"* — which is an instruction that cannot be
  followed on the 42%.

Excerpt lengths cluster at 1,570–2,474 characters around a 2,259 median. That is a **fixed
truncation window**, not natural turn length: the system stores a summary plus up to ~2.3 kB of the
turn it came from.

### 4.3 The prompt, which is 5,900 tokens of the 13,400

`LME_answering_prompt.md` is **21.5 kB** — larger than the retrieved content of a typical question's
summary field by an order of magnitude. It is a seven-step scaffold with named rules for exactly the
failures this benchmark contains: unit-before-counting, speaker attribution, `event_precision`
windows, "most recent means latest `said_at` not latest `event_date`", and a three-part abstention
test that distinguishes *a named particular is missing* from *the wording differs*.

**The 7,391 does not include it**, and that survives a loose reading of the ratio. Even at the most
generous 4.3 characters per token an English tokenizer will give, 21.5 kB is **≥5,000 tokens**, so a
single call to their reader is **≥12,400** before the field prefixes are counted — at or above this
repository's 12,137. At the census's own 3.64 it is ≈13,400.

Two tokenizers are in play (Gemini 3.8 Flash versus DeepSeek), so the honest claim is not "we are
cheaper": it is that **"7,400 versus 12,137" compares a content-only count with a whole-prompt
count, and the 40% price advantage it appears to show does not exist.** The lower bound above is
the part that does not depend on any conversion rate.

## 5. Where the 3.65 points actually are

Both systems, mapped onto the six LongMemEval categories, answerable-question scope so the 30
abstention items are compared as their own row:

| capability | n | cortex (48,000 room, five runs) | Synap (Gemini 3.8 Flash, answerable table) | delta |
| --- | ---: | ---: | ---: | ---: |
| `ABS` | 30 | **100.00%** | 93.3% (28/30) | **+6.7 us** |
| `IE` (pref 30 + assistant 56 + user 64) | 150 | 93.33% | 96.0% (144/150) | −2.67 |
| `KU` | 72 | 88.89% | **97.2%** (70/72) | **−8.33** |
| `MR` | 121 | 83.47% | **92.6%** (112/121) | **−9.13** |
| `TR` | 127 | 96.06% | 97.6% (124/127) | −1.54 |

The left column is the five-run 48,000-character configuration (`417.25/500 = 83.45%`,
`docs/ACCEPTANCE-MATRIX.md` §3.2), which is the only configuration with a published per-capability
table. The **shipping** arm (`route-room`, 91.95%) reads `MR` **83.88%** against 79.13% for the
configuration it replaced (`42355323615`); its other five rows are not recorded per capability, so
they are not quoted here rather than being carried across from a different configuration.

Two rows carry almost all of it, and they share one property: **they are the two that aggregate.**
`IE`, `TR` and `ABS` ask for one fact in one place; `KU` asks which of several statements is current,
`MR` asks for a count over turns. The repository already measured this asymmetry from the other
side: halving the room from 48,000 to 24,000 costs `MR` −6.61 and `TR` −4.72 while `IE`, `KU` and
`ABS` lose under 1.4 (`docs/PROMPT-ROOM-IS-LOAD-BEARING.md`).

Synap's advantage in those two rows is **not more evidence** — it sends less. It is **structure the
reader can count with**:

| Synap field | what it does | this repository |
| --- | --- | --- |
| `[thing N]` marker | tells the reader two entries are the same thing, so a count does not double-count | **absent** |
| `event_date` + `event_precision` | absolute date of the event, with a named window (`day`/`week`/`month`/`season`/`year`/`range`/`approximate`) | **absent** — only the utterance date |
| `valid_until` | a stated expiry | **absent** |
| `said_at` | the authority for "most recent" | **present** (`readTurnStamp`, `packages/cortex-eval/src/turn-clock.ts`) |

`MR` is a counting question; `KU` is a supersession question. Both need a per-item property the
reader can compare across items. This repository sends the reader the turn and asks it to build that
property in its head, 121 and 72 times respectively, at 18–40 items per question.

## 6. What is worth taking, and what each one costs

Three candidates, ordered by cost, not by appeal.

### A. Same context, different reader (zero mechanism risk)

Run the adopted arm's archived prompts through a frontier reader and re-judge. This is the only
experiment that can attribute the gap to the model rather than to the system, and Synap's own table
shows a frontier reader is worth 1.8 points **to them** — the question is what it is worth to
`deepseek-chat`.

- cost: one reader call per question per repetition, no ingest, no code change beyond a provider id
- judgement: if a frontier reader moves `S1` by ≥2 points, the gap was never a memory-mechanism gap
  and every mechanism experiment designed against 95.6% was aimed at the wrong target
- artefact: the archived prompt bytes already exist (`promptDigest` per question), so the arm is
  reproducible without re-running retrieval

### B. Add the per-item properties, keep the turn verbatim

`[thing N]`, `event_date`, `event_precision`, `valid_until` — derived, not retrieved. This is the
part that can be done **without an LLM in the ingest path**, which is what separates it from
replicating their ingestion pipeline:

| property | derivable without a model? |
| --- | --- |
| `said_at` | **yes**, already parsed (`turn-clock.ts`) |
| `event_date`/`event_precision` | **partly** — "last week", "in October", "three years ago" resolve against the session date by rule; their prompt spells out the arithmetic |
| `valid_until` | **partly** — "until", "no longer", "I switched to" |
| `[thing N]` | **no** — needs entity resolution; this is the one component that costs an ingest-side model call |

- cost: one model call per session for the entity grouping (the Graphiti-shaped cost this repository
  already priced at a 1:1 amortisation on LongMemEval, `tools/amortization-crossover.mjs`), and
  nothing for the date properties
- **zero-cost pre-judgement**, in the shape `G1.1` already established: recompute `goldOverlap` with
  the date properties supplied, and count how many `KU`/`MR` failures change. If the count is zero,
  the representation is not the lever and the reader arm is the whole answer.

### C. Take the prompt's rules, not its text

The answering prompt contains rules this repository does not state, and the ones with the clearest
mechanism are:

- **unit fixed before counting** — "occasions" versus "objects", stated before the enumeration
- **`said_at` decides recency, `event_date` does not** — the exact confusion `KU` is built from
- **a named particular missing versus the wording differing** — the abstention test the repository's
  `ABS` already scores 30/30 on, but stated as two opposite cases rather than one
- **multi-part questions answer the parts they have** — never a bare decline when any part is
  answerable

- cost: a prompt diff on one route at a time, no retraining
- caution: `MR`'s prompt here is already migrated verbatim from the reference pipeline and tuned
  against measured failures (`§13.246`, `§13.289` — 8 of 18 below-gold `MR` losses traced to one
  calibrated line). **Copying an unmeasured prompt over a measured one would lose more than it gains.**
  Rules are candidates; the text is not.

## 7. What is explicitly not worth taking

| mechanism | why not |
| --- | --- |
| compaction / context summarisation | this repository measured the budget as **clean**: 95.9% of gold turns are in the pool and 91.7% of those reach the reader. There is no 8% of evidence to win back by compressing harder, and `validated compaction` is what Synap claims, not something their artefacts demonstrate |
| anticipatory retrieval (15 ms P75) | LongMemEval never asks for a second query; latency is invisible to every number in this document |
| scoping hierarchy (user → customer → client) | a multi-tenant product property; a single-user benchmark cannot see it |
| the 92.0% configuration as a target | their `MR` **92.6%** is **8.7 points** above this repository's shipping 83.88% on the same category at half the evidence — that gap is real and is §6B's job — but the *headline* gap is a unit error, and chasing 95.6% as a number would spend the next rounds on the model rather than on the structure |

## 8. The claim this document refuses to make

It does not claim Synap's 95.6% is inflated. Every number in it is published, the per-question
records can be recounted, and the harness ships adapters for their competitors too. What it does
claim is narrower and checkable:

> **95.6% at 7,391 tokens is not comparable with 91.95% at 12,137.** The first counts
> `memory + source_evidence`; the second counts the system prompt, the context and the question.
> Corrected onto one basis the two are the same order of size, and the remaining 3.65 points sit in
> `KU` (−8.3) and `MR` (−9.1), the two categories where the vendor supplies per-item structure this
> repository does not.

## 9. Reproducing

```bash
# the census (§4.2). The records file is 23 MB and is not vendored.
curl -L -o qr.json \
  https://raw.githubusercontent.com/maximem-ai/eval_benchmark_runs_output/HEAD/results/longmemeval/question_records_gemini-3.8-flash.json
node tools/synap-context-census.mjs qr.json
SYNAP_RECORDS=qr.json python3 -m pytest tools/__tests__/test_synap_context_census.py

# the classification table (§5) against this repository's own readings
python3 -m pytest tools/__tests__/test_acceptance_matrix.py
```

## 10. Sources

- `maximem-ai/maximem_synap_sdk` — README (SDK scope, the closure statement), `packages/`
- `maximem-ai/memory_and_context_eval_harness` — `adapters/synap_adapter.py`, `runner/phases/answer.py`, `docs/DEVIATIONS.md`
- `maximem-ai/eval_benchmark_runs_output` — `METHODOLOGY.md`, `RESULTS.md`, `manifest_gemini-3.8-flash.json`, `results/longmemeval/LME_answering_prompt.md`, `results/longmemeval/question_records_gemini-3.8-flash.json`
- `arXiv:2607.21503v1` — *Agentic Context Management*, §4, §6.1–6.3, Table 2, Table 3
- this repository — `docs/ACCEPTANCE-MATRIX.md` §3.2, `docs/SOTA-LANDSCAPE.md` §16.2, `evidence/longmemeval/frontier.json`
