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

| Layer         | What it is                                                                     | Can we fix it?                                                                                 |
| ------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| **L1 recipe** | Different reader, judge, judge prompt, top-k, subset, answer-key version       | **Yes, completely.** One harness, one reader, one judge, one depth.                            |
| **L2 code**   | The system is closed (a hosted API or a vendor claim)                          | **Partly.** Seven of the eight systems below have source.                                      |
| **L3 model**  | The published number used GPT-4o or Gemini-3 Pro, which we cannot call         | **Yes, by substituting** — and the substitution must be stated, because it changes the number. |
| **L4 cost**   | 500 questions × N systems × repeated runs, with LLM extraction on every ingest | **Real, and the binding constraint.** This is why the plan is phased rather than promised.     |

The field has already accepted L1 as the main problem. One system reports four LoCoMo scores from one codebase
(65.99 / 84 / 58.44 / 75.14) depending on judge and subset; vendor self-reports diverge from independent runs by
18–24 points. Those are L1 failures, and L1 is exactly what a shared harness removes.

## 2. What is actually runnable

Checked against each project's own documentation, not against summaries of it.

| System                                         | Licence / source         | Language | LLM swappable                                                                              | Embeddings swappable                       | Local-first                         | Verdict                                                                                                                          |
| ---------------------------------------------- | ------------------------ | -------- | ------------------------------------------------------------------------------------------ | ------------------------------------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Hindsight** (Vectorize)                      | MIT, server + clients    | Python   | **Yes** — 25+ providers incl. `deepseek`, any OpenAI-compatible base URL, Ollama/llama.cpp | Yes, defaults to local `bge-small-en-v1.5` | Postgres+pgvector or embedded `pg0` | **Run it.** Best case: open, model-agnostic, local embeddings, and it publishes a per-model leaderboard we can compare against.  |
| **Mem0** (OSS)                                 | Apache-2.0               | Python   | **Yes** — `configs/*.yaml`, OpenAI-compatible                                              | Yes                                        | Qdrant + its own server             | **Run it.** Official `mem0ai/memory-benchmarks` already drives LongMemEval end to end.                                           |
| **Graphiti** (Zep)                             | Apache-2.0               | Python   | **Yes** — OpenAI-compatible LLM client                                                     | Yes (embedder configurable)                | Neo4j or FalkorDB                   | **Run it, with care.** Needs a graph database; Zep's published LongMemEval number came from its own graph-service configuration. |
| **Letta** (MemGPT)                             | Apache-2.0               | Python   | Yes                                                                                        | Yes                                        | SQLite/Postgres                     | Run it, but its memory is agent-loop shaped, so it needs an adapter that respects `search` semantics.                            |
| **A-MEM**                                      | MIT, research code       | Python   | Yes                                                                                        | Yes                                        | Local                               | Run on a subset; research code, no server.                                                                                       |
| **HippoRAG 2**                                 | MIT, research code       | Python   | Yes                                                                                        | Yes                                        | Local + graph                       | Run on a subset; it is a retriever, not a memory service, so it maps to `search` cleanly.                                        |
| **Supermemory**                                | hosted, SDK              | —        | No (managed)                                                                               | No                                         | no                                  | **Vendor number only** (grade B at best).                                                                                        |
| **Synap / Graphonomous / agentmemory / OMEGA** | closed or unreproducible | —        | No                                                                                         | No                                         | no                                  | Vendor number only, and some are not systems at all — Graphonomous reports a keyword-recall proxy, not the official judge.       |

So: **four systems can be run under one harness today** (Hindsight, Mem0, Graphiti, Letta), two more on a
subset (A-MEM, HippoRAG-2), and the rest remain a quoted figure with a stated recipe.

### 2.1 The one number that makes this worth doing

Hindsight's own published comparison contains a result more useful than its headline: with a **20B open-weight
model** it scores **83.6%** on LongMemEval, while the same model reading the full history scores **39.0%**. The
headline 94.6% used Gemini-3 Pro.

That is the experiment we can reproduce almost exactly, because we _have_ a model we can call. If our reader is
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
   difference _is_ the finding, and it shows up as a per-category difference rather than as an excuse.

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

### 3.1.2 Cortex as a provider, and the defect the first run found

`CortexSessionProvider` (in `cortex-memory`, deliberately not importing `cortex-eval` — the reverse would put a
measurement package in the product's dependency graph) calls the product's own functions:

```
admitSessions(sessions, gate)  ->  selectSessionBudget(admitted, ceiling, relevance)  ->  hits
```

An invariant test pins it: for one input, the adapter's hits equal those functions applied by hand, including
the relevance key. If the adapter ever grows a private copy of selection logic, that test fails.

The first run, before the repair:

```
provider            build      recall@k  all-gold  mrr     found
lexical-reference   none       100.0%    100.0%    0.630   24/24
cortex-session      embedding   91.7%      8.3%    0.296   22/24
cortex-session      embedding   87.5%      4.2%    0.291   21/24   (session budget 8)
null-floor          none         0.0%      0.0%    0.000    0/24
```

**The gap between any-hit and all-gold was the finding.** A lexical index ranking by the question covers every
gold turn; the product's selection covered at least one for 22 of 24 questions and all of them for 2.

**And the cause was not "recency and length".** That sentence was in this document and it was false.
`bestValue` is `max(turn.value)` and `turn.value` is `confidence * sourceTrust * (0.5 + 0.5 * recency)`;
admission stamps `lastAccessedAt = createdAt = now`, so recency is `1` for every turn, and at the default
`sourceTrust` with no `confidenceFor` every turn carries exactly `0.5`. Measured: 24 turns, **one distinct
value**. The ranking therefore tied everywhere and the sort fell through to `session.index` — arrival order.
Recency did not enter the ranking at all, and length entered only as the capacity check.

### 3.1.3 The repair, and what it moved

Three changes, each with a measurement behind it:

1. **`lexicalRelevance(question, turn)`** in `cortex-memory/src/relevance.ts` — term coverage plus adjacent-pair
   order, no model. It enters at the **session budget** rather than by widening `confidenceFor`, because the
   write gate must not depend on a question that has not been asked yet.
2. **`selectSessionBudget(sessions, budget, relevance?)`** — relevance descends first, `bestValue` second,
   `session.index` last. Absent the signal the behaviour is byte-for-byte the archived one; a `NaN` is rejected
   because it would silently restore the arrival-order defect while the artifact reported a signal in use.
3. **Hits returned in ranked order.** The product re-sorts into arrival order for prompts; a retrieval
   interface is read for rank, and MRR is read from the position of the first hit.

After:

```
provider            build      recall@k  all-gold  mrr     found
lexical-reference   none       100.0%    100.0%    0.630   24/24
cortex-session      none       100.0%    100.0%    1.000   24/24
cortex-session      none       100.0%     50.0%    1.000   24/24   (session budget 8)
null-floor          none         0.0%      0.0%    0.000    0/24
```

`build` moved from `embedding` to `none` in the same edit, because a term-overlap signal is not a model and
the cost column is not decoration.

### 3.1.4 Why this is a wiring reading and not a result

The synthetic generator writes each fact as `name attribute=value`, so `What is alice's city?` scores
`alice city=new york` at exactly `1.0` by construction. `mrr 1.000` means the gold always ranks first, and
there is no corpus left in which it could rank otherwise. The gap to `lexical-reference` is its stopword-free
tokeniser (`what` inflates its denominator), not a difference in quality.

So the table supports three claims and no more: the signal is wired, the adapter equals the product functions
applied by hand, and the arrival-order defect is gone (five tests go red when the key is removed — verified by
removing it). It supports **no** claim about accuracy on real language.

`docs/MEASURE-SESSION-RELEVANCE.md` is the full record, including the four limitations the signal carries and
why each is an experiment rather than an edit.

### 3.2 Comparability is a function, not an adjective

`comparability(left, right)` takes two run configurations and returns a grade plus the list of fields that
differ:

| Differing                                       | Grade | What may be said                 |
| ----------------------------------------------- | ----- | -------------------------------- |
| nothing                                         | **A** | "we are N points behind on this" |
| reader / judge / judge prompt only              | **B** | "the direction is the same"      |
| dataset / question count / top-k / token budget | **C** | nothing about the gap            |

`topK` and `tokenBudget` sit in the hard row on purpose: a run reading 200 hits and one reading 10 are different
experiments, and the deeper one wins for reasons unrelated to memory.

The point of encoding this is that a grade stops being an editorial judgement made after seeing the numbers. It
is computed from the configuration, and the configuration is printed with every score.

## 4. The plan, in the order that produces a usable number soonest

| Phase   | What                                                                                                                | Produces                                                                                                                              | Cost                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **H0**  | `LexicalProvider` + `toSessions` + `comparability` + `measureRetrieval` + `NullProvider` — **done**                 | a pipeline that runs with no model, no key, no network; a floor that is provably zero; and a rule that decides what a score may claim | 0                                                        |
| **H1a** | the tool meets LongMemEval-S: `--data` loads it, gold comes from `answer_session_ids`, subset stratified — **done** | retrieval-only readings on a corpus this repository did not write, for every provider including Cortex's own adapter                  | one runner, no key, no reader                            |
| **H1**  | Hindsight, 100-question subset, DeepSeek reader, official judge prompt                                              | the first **A-grade** competitor number this project has ever had                                                                     | one container, ~100 × (ingest + recall), DeepSeek tokens |
| **H2**  | + Mem0 OSS, + Graphiti; same 100 questions                                                                          | a three-system ranking on one axis                                                                                                    | three services, three ingests                            |
| **H3**  | full 500 questions × 2 runs, four systems                                                                           | the table the whitepaper quotes instead of vendor figures                                                                             | ×5 the H1 cost                                           |
| **H4**  | the vendor ladder: same dataset, the models we cannot call, quoted with their recipes                               | the footnote that explains the distance between 83% and 94%                                                                           | 0 (reading)                                              |

H0 is the gate for everything else: until the pipeline runs end to end on a lexical control, an adapter that
returns nothing is indistinguishable from a system that retrieves nothing.

### 3.5 The October 2026 field, and why `comparability()` is not pedantry

A survey of the published numbers as of October 2026, with each row's own caveat, because the caveats are the
finding:

| system                          | score           | what the row actually is                                                 |
| ------------------------------- | --------------- | ------------------------------------------------------------------------ |
| Agent Zero Memory (Zero Labs)   | 95.6%           | gpt-5.5; the paper states neither its setting nor its judge model        |
| Mastra Observational Memory     | 94.87%          | gpt-5-mini; **84.23% with gpt-4o** — same memory, different answerer     |
| Mem0                            | 94.4% (472/500) | top-200 retrieval budget, GPT-5 as answerer _and_ judge, cleaned file    |
| Perpetuity (NeuraWeave)         | 94.0%           | self-measured, 3.6k-token median frame, official judge, nothing excluded |
| Backboard                       | 93.4%           | unofficial judge                                                         |
| ByteRover                       | 92.8%           | **30 questions excluded**                                                |
| Hindsight                       | 91.4%           | self-graded with GPT-OSS-120B                                            |
| Zep                             | 90.2%           | gpt-5.4; **63.8% in a third-party roundup**                              |
| GPT-4o on the full 115k history | 60.6%           | the benchmark's own baseline                                             |
| Supermemory                     | "97%"           | Recall@20 with aggregation — a retrieval metric, not answer accuracy     |

Three observations, and each one is why this repository reports a cost column and a comparability grade rather
than a rank.

1. **The answer model is worth about ten points.** Mastra reports the same memory system at 84.23% with gpt-4o and
   94.87% with gpt-5-mini. Any comparison across rows with different readers is therefore comparing readers, and
   our reader is `deepseek-chat`.
2. **Self-reporting is not a rounding difference.** Zep publishes 90.2% and a third-party roundup puts it at
   63.8%. Both can be honestly produced — different reader, judge and retrieval depth — and the gap is larger than
   the entire distance between most rows on the table.
3. **The costs are all reported, and ours is the smallest.** Mem0 6.8–7.0k tokens, Zep 4,408–5,760, Perpetuity
   3,600 median, Contextier 2,807. Our 2.8k arm reads 2,799 and our unbounded arm reads 33,089. A row without its
   cost is not comparable with any row on this table, which is the argument `ProviderScore.meanContextChars`
   exists to make.

What this changes in our own reporting: nothing about the numbers, and everything about the claim. **At 2.8k
tokens we are leaner than every published system and answer 55% of the questions with a `deepseek-chat` reader**;
their 90–95% is a different answer model, a different judge, and in one case a different question set. The honest
sentence is the one `comparability()` produces, and its grade for these comparisons is **C**.

### 4.0 What H1a added, and why it had to come first

H1 as written assumed the harness could meet a corpus. It could not: `tools/competitor-harness.mjs` generated its
own dataset, and the gold it used was **derived** — "the context turns that state the expected answer" — which is
true by construction for a generated corpus and false for any other.

Two changes, both in the tool:

1. `--data <path>` (or `LONGMEMEVAL_PATH`) loads LongMemEval-S through the existing loader and takes the gold
   from `Question.goldTurns`, which the loader resolves from `answer_session_ids`. An annotation, not an
   inference.
2. The subset is **stratified**: questions round-robin across capabilities in a fixed order, sorted by id within
   each. Taking the first N rows would take whatever capability the file happens to start with, and a subset
   that depends on file order makes every number taken on it unusable for a later comparison.

The distinction between derived and annotated gold is invisible in a score, so it is pinned by a fixture whose
`ie-001` answer is a locker combination discussed in no turn: under derivation that question is _unmeasurable_,
under annotation it is _measurable_. Reverting `goldOf` to the derived form marks 3 of 4 fixture questions
unmeasurable and the test goes red — the mutation was run, not asserted.

`.github/workflows/competitor-retrieval.yml` runs it, because the development sandbox reaches `api.github.com`
and nothing else: the only place this tool can meet the corpus is a runner. It needs no reader, no judge and no
key, so its output is evidence recall and its own summary says it must not be quoted as answer accuracy.

**The budget sweep, once the granularity arm existed.** 500 questions, same corpus, same top-k:

```
provider            recall@k  all-gold  mrr     ~tok
lexical-reference   93.6%     81.0%     0.781   34277
cortex-session      94.0%     82.2%     0.818   33089
cortex/whole-8t      8.0%      6.6%     0.080    2709
cortex/trim-8t      76.2%      6.2%     0.758    2739
cortex/trim-2.8k    80.8%     12.4%     0.782    2799
cortex/trim-4.4k    83.8%     22.6%     0.794    4400
cortex/trim-6.8k    87.4%     36.8%     0.806    6802
```

Two rows carry the argument. `whole-8t` and `trim-8t` get the same budget and spend the same text; one reads
8.0% and the other 76.2%. And the unbounded rows spend 33k tokens, ten times Contextier's 2,807 — which means
the parity reported before this sweep was measured on an axis no vendor reports. The comparison with a
competitor has to be made at a stated budget or not at all.

**The first run found two defects, and neither was in the ranking.** `recall@k 25.4%` against the lexical
reference's `93.6%` was a unit error: `min(sessionBudget, limit)` folded the harness's top-k on hits into the
product's budget on turns, which is invisible while a session is one turn. After the repair the same 500
questions read `94.0% / 82.2% / 0.818` against `93.6% / 81.0% / 0.781` — **parity**. The third row is the one
worth acting on: `sessionBudget 8` reads `8.0%`, because a real session is about ten turns and the product
admits a session whole or not at all, so a tight prompt budget drops the evidence entirely.
`docs/MEASURE-RETRIEVAL-BASELINE.md` is the record, including why the two readings are not answer accuracy and
why `asOf` is currently inert.

**One limit recorded rather than fixed.** `sessionsOf` stamps every session with the _question_ date, so
per-session timestamps do not survive into the provider contract — `asOf` cannot filter, and time reaches the
signal only through the loader's `[date]` prefix in the rendered text. Fixing it means adding a per-session
timestamp to `Question`, which is a change to the evaluation contract rather than to one adapter, and it is the
first thing H1a's readings will tell us the cost of.

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

| Grade | Old meaning                                                    | New meaning                                                   |
| ----- | -------------------------------------------------------------- | ------------------------------------------------------------- |
| **A** | "same dataset, judge, reader and metric in the published work" | "**we ran it**, and the configuration matches"                |
| **B** | "same dataset, different reader or judge"                      | "we ran it, the reader differs, and both numbers are printed" |
| **C** | "vendor figure, no reproducible recipe"                        | "**we have not run it**, and the recipe is not published"     |

The change is small in words and large in obligations: a C is no longer a permanent verdict on a competitor, it
is a to-do with a reason attached.

## 7. One instrument, many harnesses: the arrangement this campaign runs on

Four rounds went into estimating the instrument instead of using it: a second judge was swapped onto our
answers, the band it produces was priced, and a third judge was proposed as the thing that would settle the
cross-vendor rows. That was the wrong lever, and the reasoning is short.

**A judge is a component of the measuring instrument, not a variable of the experiment.** Adding a fourth grader
to our answers does not tell us whether Synap's system is better — it tells us how much our own score moves when
someone else grades it, which is a fact about the instrument and is now bounded at −3.2 points. The question
"are we behind" is answered by putting *their software* under *our instrument*, where the grader is inside the
constant and the band has nothing to cancel. `gpt-4o` is therefore out of scope permanently, not for cost
reasons alone but because it is the wrong side of the comparison.

### 7.1 The fixed half (`A`), as a list a script could check

| slot | value | where it comes from |
| --- | --- | --- |
| reader model | `deepseek-chat` | Org secret `DEEPSEEK_API_KEY`; `DEEPSEEK_MODEL` may pin it, and the value used is printed |
| reader prompt | `con` (official Chain-of-Note: note silently, then answer with the phrase only) | `competitor-reader.ts`, one function for every arm |
| judge model | `deepseek-chat` — **the same model as the reader**, so no arm gets a grader it did not answer under | `llm-factory.ts` + `judge.ts` |
| judge policy | `longmemeval-official-per-type` | `judge.ts`; the policy name is printed beside every score |
| embedding model | Zhipu `embedding-3` (Org secret `ZHIPU_API_KEY`), offline `@agentix-e/embed-code-node` only as a declared fallback | `embedding-factory.ts` |
| dataset | LongMemEval-S cleaned, 500 questions, `sha256:d6f21ea9…` | `dataset-fingerprint.ts`; the fingerprint travels in the artifact |
| subset rule | round-robin across capabilities, within a capability sorted by `id` | `stratify()` in `tools/competitor-harness.mjs` |
| top-k | 10 | `--limit 10` |
| scoring | `single` (one answer per question, no `pass@k`, no majority) | `RunConfig.scoring` |

Two consequences follow, and both are obligations rather than remarks.

**The product's headline is not in the A-grade table, and must never be subtracted from a row that is.** The
memory arm reads through the product's own contract, route by route; the harness reads every system through
`con`. Those are two tables:

| table | what answers | what it is for |
| --- | --- | --- |
| **T1** — harness table | `con` reader, one judge, `cortex-session` + every competitor adapter | "whose memory is better, at one reader" — the only table a gap may be quoted from |
| **T2** — product table | the product's own reader and routes, judged by the same judge | "what the product scores", 91.25% on `43140878641` |

A cross-table subtraction is what `comparability()` grades `B` at best, and the campaign will not make one.

**GLM is an embedding slot, not a reader slot.** It is fixed where it is used — every arm embeds with the same
model, so a vector-space difference cannot masquerade as a design difference — and it is never asked to answer or
to judge. If the embedding quota fails, the run records the fallback in the manifest and the row is quoted with
that named; a silent substitution is the defect this project has found three times.

### 7.2 What a run must show before its number may be quoted (H1–H9)

| # | criterion | threshold | fails as |
| --- | --- | --- | --- |
| **H1** | identity | dataset fingerprint, question-id set, `k`, reader prompt digest and judge prompt digest all identical across the paired arms, and all five carried in the artifact | the rows are not a pair |
| **H2** | smoke gate | 20 questions: `ingest.skipped` empty **and** `found > 0` on ≥ 18 of 20 | "not comparable this round", no score quoted, next competitor |
| **H3** | pairing, not subtraction | `wins / losses / ties` plus the named question ids and an exact McNemar p | `93.6% − 91.2% = +2.4` is not evidence |
| **H4** | cost column | prompt tokens per question per arm, from one accounting, plus each arm's `build` class and ingest model-call count | a cheap row that is cheap because it read less |
| **H5** | repeatability | two 20-question runs of the same arm agree on ≥ 90% of per-question verdicts | the arm's noise is larger than the effect at n = 20 |
| **H6** | manifest | `name`, `build`, `version` printed beside the score | the number cannot be attributed |
| **H7** | cost gate | no arm is read on 500 questions at `build: llm` (~275,000 model calls) | a bill mistaken for a comparison |
| **H8** | budget parity | a **cost-accuracy** claim needs at least one pair whose delivered context is within **2×**; a pair outside it may be quoted on accuracy or on cost, never on both | `19×` the tokens for `+2` questions read as "we win" — which is the vendor's own mistake in the other direction |
| **H9** | the cost denominator | a cost comparison between arms of **different accuracy** must be `promptTokens / correct`, carried in the artifact beside `promptTokens / question`; the per-question figure may only be quoted between arms whose accuracy differs by less than the run's own resolution | "we cut 25% of the tokens" while answering fewer questions — the bill fell and each useful answer got dearer |

H2 and H5 exist because this repository has already published one competitor row that was a plumbing failure
(`0.0%`, run `40519523383`) and one table that disagreed with itself by five questions per arm. Both were caught
by reading the instrument, which is the only thing that has ever caught them.

**H8 is the one this round added, and it was added because the first measured pair failed it.** `43199357450` reads
`cortex-session` at **33,556** prompt tokens per question against `mem0`'s **1,768** — 19.0× — for `13/20` against
`11/20` (`p = 0.50`). An equal-`k` pair with a 19× budget gap is not a cost-accuracy comparison in either direction;
it is two systems being asked different questions about what they can afford. The same artifact already carries the
arm that can clear this bar: `cortex/trim-2.8k` at **2,799** tokens is **1.58×** `mem0`, so reading
`mem0,cortex/trim-2.8k` is the pair H8 admits — and it is also the cheapest pair to run, because a 12× smaller
context is a 12× shorter read stage.

**H9 was added in the same round, and it is the criterion that stops a cheaper arm from being read as a better one.**
Two sources force it. `arXiv:2608.11879` benchmarks three memory systems against a rolling window and against
resubmitting the transcript, on 665 LoCoMo questions and up to 400 turns, and reports three facts that bind here:
accuracy spans **21–54%**; a cost model fitted on conversation length and message size misses the memory systems by
**18–69%**, because their bill is set by internal extraction, retrieval and consolidation rather than by the
conversation; and **no system wins on both axes**. `arXiv:2610.20675` supplies the arithmetic that makes the second
fact quotable: when accuracy falls, output per execution falls while **output per correct answer rises**.

`tools/cost-ledger.py` has carried the fourth reading since it was written — `perCorrectAnswerPromptTokens`, **10,105**
on the registered arm against **9,201** per question — and `C1` quotes only the second. H9 is the rule that closes
that gap: the two numbers are allowed to move in opposite directions, so a run that quotes one of them without the
other is quoting the cheaper half of a pair of facts.

This does not make `C1` wrong. It makes `C1` a statement about the bill and not about value, and "we are on the cost
frontier" a separate assertion that has to be made in `per-correct-answer` — which is the unit Zep's published
**4,878** is written in, and the unit in which our **10,105** is a 2.07× deficit rather than the 1.0× the two
per-question figures would suggest.

### 7.3 The queue, in the order that produces a quotable number soonest

| # | system | why this position | runnable now | cost per dispatch |
| --- | --- | --- | --- | --- |
| 1 | `mem0` OSS | driver exists, installs by name, and it is the field's reference baseline | **yes** — `--sut mem0`, `sut_infer=0` | 20 q: one ingest (~10k embeddings) + 40 model calls |
| 2 | `letta` @ `0.16.8` | **the only competitor with a published same-reader number** (MemStrata's 438/500) | yes — archived V1 server, driver refuses the successor product | 20 q: one container + 40 model calls |
| 3 | `langmem` (MIT) | the `3.26M`-token arm MRAgent compares against; pure Python, no service | yes, adapter needed | 20 q: no ingest model calls |
| 4 | `MemOS` | vendor `89.20`, and OmniMemEval independently measured `89.20` — a row where self-report and reproduction agree, so a difference from it is a difference from something real | yes, adapter needed | 20 q |
| 5 | `Hindsight` | publishes its own model ladder: 83.6% with a 20B open-weight model against 39.0% full-context — the one published experiment whose reader substitution we can reproduce | yes, needs Postgres/pg0 | 20 q + one service |
| 6 | `Graphiti` (Zep) | the **cost** SOTA we have to beat: 4,878 tokens per correct answer | needs Neo4j or FalkorDB | 20 q + one graph database |
| — | Recallium, ContextStream, Agent Zero, MemStrata | **no code** | no | reading only, never a row |

The first two are one dispatch each and they are the whole difference between a campaign that quotes vendors and
one that measures them. Nothing below the first two is worth scheduling until they exist.

### 7.4 What each row is expected to teach, so the run is not just a score

| row | mechanism worth taking if it wins | what would falsify it |
| --- | --- | --- |
| `mem0` | LLM-extracted atomic facts instead of turns: 1,942 tokens per question against our ~35,000 delivered characters | its `all-gold` was 4.0% against our 73.0% (`COMPETITOR-REPRODUCTION.md` §6.3) — if accuracy also loses, extraction is a compression, not a memory |
| `letta` | the agent-loop store: paging a fixed-size core memory instead of retrieving | the `search` squeeze loses the loop, so a loss may be the adapter's |
| `langmem` | background consolidation of a store between sessions | consolidation that cannot be pointed at is a cost, not a mechanism |
| `MemOS` | the `89.20`-reproduced pipeline: what its retrieval does that survives an independent harness | — |
| `Hindsight` | the 20B-model ladder: memory gains **shrink** as the reader weakens (83.6 → 39.0 is full-context, not memory) | if our DeepSeek reader halves every arm's separation, the memory axis is reader-dependent and every published gap is too |
| `Graphiti` | graph traversal + edge validity windows, which is where its token economy comes from | 4,878 tokens per correct answer may be bought with ingestion cost that its own numbers do not count |

### 7.5 What this replaces

| withdrawn | replaced by |
| --- | --- |
| "a third judge (`gpt-4o`) would settle the 3-point rows" | run their code under our judge (§7.1); the band cancels instead of being estimated |
| `J9`'s full form (both `M1` arms, one pinned judge, 500 questions) | the same dispatch budget spent on a competitor arm, which produces a number the campaign can use |
| "grade C means the number may not be used" | grade C means **we have not run it**; §7.3 is the queue that turns each C into an A or a stated refusal |
