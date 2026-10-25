# Running the competitors ourselves

A reviewer asked the question this document exists to answer:

> Why is Hindsight not comparable? If it is the model or the dataset, can we not build a workflow for Hindsight
> that uses models and datasets we can access, run it, and compare? Same for the others. And then report the
> vendor's own numbers on the same dataset with models we cannot use, as a reference.

The answer is yes, and the previous release was wrong to leave it at "grade C, may not be used to claim a gap".
That was a statement about a **number**, not about a **system**. This document replaces it with a plan, a
contract, and an honest account of what is still hard.

## 1. Why the numbers were incomparable, in four layers

The grade conflated four different obstacles. They decompose, and three of them are solvable.

| Layer | What it is | Can we fix it? |
| --- | --- | --- |
| **L1 recipe** | Different reader, judge, judge prompt, top-k, subset, answer-key version | **Yes, completely.** One harness, one reader, one judge, one depth. |
| **L2 code** | The system is closed (a hosted API or a vendor claim) | **Partly.** Seven of the eight systems below have source. |
| **L3 model** | The published number used GPT-4o or Gemini-3 Pro, which we cannot call | **Yes, by substituting** — and the substitution must be stated, because it changes the number. |
| **L4 cost** | 500 questions × N systems × repeated runs, with LLM extraction on every ingest | **Real, and the binding constraint.** This is why the plan is phased rather than promised. |

The field has already accepted L1 as the main problem. One system reports four LoCoMo scores from one codebase
(65.99 / 84 / 58.44 / 75.14) depending on judge and subset; vendor self-reports diverge from independent runs by
18–24 points. Those are L1 failures, and L1 is exactly what a shared harness removes.

## 2. What is actually runnable

Checked against each project's own documentation, not against summaries of it.

| System | Licence / source | Language | LLM swappable | Embeddings swappable | Local-first | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **Hindsight** (Vectorize) | MIT, server + clients | Python | **Yes** — 25+ providers incl. `deepseek`, any OpenAI-compatible base URL, Ollama/llama.cpp | Yes, defaults to local `bge-small-en-v1.5` | Postgres+pgvector or embedded `pg0` | **Run it.** Best case: open, model-agnostic, local embeddings, and it publishes a per-model leaderboard we can compare against. |
| **Mem0** (OSS) | Apache-2.0 | Python | **Yes** — `configs/*.yaml`, OpenAI-compatible | Yes | Qdrant + its own server | **Run it.** Official `mem0ai/memory-benchmarks` already drives LongMemEval end to end. |
| **Graphiti** (Zep) | Apache-2.0 | Python | **Yes** — OpenAI-compatible LLM client | Yes (embedder configurable) | Neo4j or FalkorDB | **Run it, with care.** Needs a graph database; Zep's published LongMemEval number came from its own graph-service configuration. |
| **Letta** (MemGPT) | Apache-2.0 | Python | Yes | Yes | SQLite/Postgres | Run it, but its memory is agent-loop shaped, so it needs an adapter that respects `search` semantics. |
| **A-MEM** | MIT, research code | Python | Yes | Yes | Local | Run on a subset; research code, no server. |
| **HippoRAG 2** | MIT, research code | Python | Yes | Yes | Local + graph | Run on a subset; it is a retriever, not a memory service, so it maps to `search` cleanly. |
| **Supermemory** | hosted, SDK | — | No (managed) | No | no | **Vendor number only** (grade B at best). |
| **Synap / Graphonomous / agentmemory / OMEGA** | closed or unreproducible | — | No | No | no | Vendor number only, and some are not systems at all — Graphonomous reports a keyword-recall proxy, not the official judge. |

So: **four systems can be run under one harness today** (Hindsight, Mem0, Graphiti, Letta), two more on a
subset (A-MEM, HippoRAG-2), and the rest remain a quoted figure with a stated recipe.

### 2.1 The one number that makes this worth doing

Hindsight's own published comparison contains a result more useful than its headline: with a **20B open-weight
model** it scores **83.6%** on LongMemEval, while the same model reading the full history scores **39.0%**. The
headline 94.6% used Gemini-3 Pro.

That is the experiment we can reproduce almost exactly, because we *have* a model we can call. If our reader is
weaker than Gemini-3 Pro, the honest comparison is not "Cortex 81.0 vs Hindsight 94.6"; it is "Cortex and
Hindsight, both on DeepSeek, same judge, same questions" — plus the vendor's model ladder as a footnote.

## 3. The harness

Five phases, one loop, no per-system prompts:

```
dataset ──> ingest ──> search ──> answer ──> judge ──> report
              │          │          │         │
        provider A..N   top-k   one reader  one judge
```

The contract is `MemoryProvider` in `packages/cortex-eval/src/competitor.ts`:

```ts
ingest(sessions: readonly MemorySession[]): Promise<IngestReport>
search(query: string, options: { limit: number; asOf?: number }): Promise<readonly SearchHit[]>
reset(): Promise<void>
```

Four decisions inside that contract, each of which removes a way for the comparison to be unfair:

1. **A provider returns retrieved text, not an answer.** Generation belongs to the harness, so the reader is one
   variable instead of one per system. A system whose selling point is its own answer prompt can still be
   measured — as a different reader — but then the configuration says so.
2. **`build: 'llm' | 'embedding' | 'none'` is declared.** A store built by a model and a lexical index are not
   the same kind of thing, and a comparison that hides which is which is not a comparison.
3. **`reset()` exists, and the run declares whether it uses it.** Global mode (one shared container, closer to
   production) and isolated mode (a container per question, no cross-contamination) give different numbers, so
   the mode is part of the configuration.
4. **`asOf` is passed to every provider.** Systems with a temporal model use it; systems without ignore it. That
   difference *is* the finding, and it shows up as a per-category difference rather than as an excuse.

### 3.1 Cortex is a provider too

This is the part that costs something. If the harness runs competitors under one pipeline while Cortex keeps its
own, the number measures the pipelines. So Cortex implements `MemoryProvider` as well: same sessions in, same
`search` out. It loses every advantage its own plumbing gave it, which is the point.

The current arm can be wrapped without touching the product: `buildKnowledgeUnit` + `assemble` already produce a
ranked block from a unit and a ranked list, and the arm's retrieval already produces the ranked list. The
adapter is glue, and the glue is testable without a model.

### 3.1.1 What H0 produced, and why a 100% recall is not a result

The loop is `measureRetrieval(dataset, providers, { limit, mode, goldOf, hitsContainGold })`. It ingests,
searches, and scores **retrieval only** — no answer, no judge, no model — and reports recall@k, all-gold
coverage, MRR, per-capability buckets, and four counts that make a partial run visible: unmeasurable
questions, empty retrievals, ingest skips, and the store size.

```
$ node tools/competitor-harness.mjs
retrieval-only comparison — synthetic/40
gold: derived from the expected answer, which is exact for a generated dataset and not for a real one

provider            build      recall@k  all-gold  mrr     found     empty  unmeasurable
lexical-reference   none       100.0%    100.0%    0.630   24/24     0      16
null-floor          none       0.0%      0.0%      0.000   0/24      24     16
```

Three things this table is, and one it is not.

- **It is a floor check.** `null-floor` scores exactly zero. If that row ever moves, the harness is broken,
  and that is a cheaper thing to discover than a wrong leaderboard.
- **It is an exclusion check.** Sixteen questions have no derivable gold and are counted separately rather
  than scored as misses. A harness that folds them into the denominator reports every system as worse than
  it is, by an amount that depends on the dataset.
- **It is a pipeline check.** `lexical-reference` at 100% recall says the generator puts the answer in one
  obvious turn. It says nothing about retrieval quality, and quoting it as a result would be the exact
  mistake this project keeps finding in other people's tables.
- **It is not a comparison.** Both rows share one configuration, so `comparability` returns `A` — and `A`
  between a lexical index and an empty store is a true statement about two things that are both useless.

The value is that H1 now has a shape to fill: swap `LexicalProvider` for a Hindsight adapter, pass the gold
from the LongMemEval loader instead of deriving it, and the same table answers a real question.

### 3.2 Comparability is a function, not an adjective

`comparability(left, right)` takes two run configurations and returns a grade plus the list of fields that
differ:

| Differing | Grade | What may be said |
| --- | --- | --- |
| nothing | **A** | "we are N points behind on this" |
| reader / judge / judge prompt only | **B** | "the direction is the same" |
| dataset / question count / top-k / token budget | **C** | nothing about the gap |

`topK` and `tokenBudget` sit in the hard row on purpose: a run reading 200 hits and one reading 10 are different
experiments, and the deeper one wins for reasons unrelated to memory.

The point of encoding this is that a grade stops being an editorial judgement made after seeing the numbers. It
is computed from the configuration, and the configuration is printed with every score.

## 4. The plan, in the order that produces a usable number soonest

| Phase | What | Produces | Cost |
| --- | --- | --- | --- |
| **H0** | `LexicalProvider` + `toSessions` + `comparability` + `measureRetrieval` + `NullProvider` — **done** | a pipeline that runs with no model, no key, no network; a floor that is provably zero; and a rule that decides what a score may claim | 0 |
| **H1** | Hindsight, 100-question subset, DeepSeek reader, official judge prompt | the first **A-grade** competitor number this project has ever had | one container, ~100 × (ingest + recall), DeepSeek tokens |
| **H2** | + Mem0 OSS, + Graphiti; same 100 questions | a three-system ranking on one axis | three services, three ingests |
| **H3** | full 500 questions × 2 runs, four systems | the table the whitepaper quotes instead of vendor figures | ×5 the H1 cost |
| **H4** | the vendor ladder: same dataset, the models we cannot call, quoted with their recipes | the footnote that explains the distance between 83% and 94% | 0 (reading) |

H0 is the gate for everything else: until the pipeline runs end to end on a lexical control, an adapter that
returns nothing is indistinguishable from a system that retrieves nothing.

### 4.1 What H1 will and will not settle

It will settle whether the 13.6-point gap to Hindsight is real under one reader and one judge. It will not
settle whether Cortex is "better": 100 questions gives a confidence interval of roughly ±8 points at p≈0.8, so
H1 is a direction and H3 is a conclusion. That rule already exists in this repository — one run is a direction,
two runs are a conclusion — and the harness does not repeal it.

### 4.2 Costs, stated before the run

Hindsight's `retain` calls an LLM for every ingested chunk; Mem0 does the same for extraction; Graphiti builds
entity edges with an LLM. On LongMemEval-S each question carries ~40 sessions, so a 500-question run is roughly
**20,000 sessions** of extraction per system. That is the real constraint, and it is why the plan starts at 100
questions with an oracle split before it touches the full set.

## 5. What this does not solve, and will not pretend to

1. **A frozen benchmark still measures a snapshot.** LongMemEval-S fits in a 1M-token window; a system that
   simply reads everything can score well without memory. BEAM (10M tokens) is the scale honest test, and it is
   not in this plan because no system we can run has published a BEAM number we could reproduce yet.
2. **LongMemEval's filler sessions come from other corpora**, so style can leak which sessions are evidence. A
   system that is good at noticing style will look better than it is. Nothing in the harness fixes that; the
   mitigation is to report retrieval recall alongside answer accuracy, which the harness does.
3. **A shared harness favours systems that fit the contract.** A design whose memory is an agent loop (Letta) has
   to be squeezed into `search`, and the squeeze loses something. The alternative — letting each system answer in
   its own way — loses the reader as a controlled variable, which is worse.
4. **Our own adapter is written by us.** It will be written to show Cortex at its best, and the only defence is
   that it is small, reviewed, and testable without a model.

## 6. Where this leaves the grades

| Grade | Old meaning | New meaning |
| --- | --- | --- |
| **A** | "same dataset, judge, reader and metric in the published work" | "**we ran it**, and the configuration matches" |
| **B** | "same dataset, different reader or judge" | "we ran it, the reader differs, and both numbers are printed" |
| **C** | "vendor figure, no reproducible recipe" | "**we have not run it**, and the recipe is not published" |

The change is small in words and large in obligations: a C is no longer a permanent verdict on a competitor, it
is a to-do with a reason attached.
