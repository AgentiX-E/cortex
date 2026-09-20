# Cortex — Measure B1: Cross-Encoder Reranking

Implementation record for the first roadmap measure. Written after reading the
retrieval pipeline rather than before, because two of the roadmap's premises did
not survive that reading; the corrections are recorded here rather than quietly
dropped.

## 0. Summary

Cortex gained a cross-encoder reranking stage. It is implemented as a pure
ordering layer in `cortex-core`, two pluggable adapters in `cortex-llm` (remote
`/rerank` and local cross-encoder), an environment-driven factory in
`cortex-eval`, and it is wired into both retrieval paths of the memory system.

| Layer | Location | Coverage (stmts/branch/funcs/lines) |
| --- | --- | --- |
| Pure ordering | `cortex-core/src/retrieval/rerank.ts` | 100 / 100 / 100 / 100 |
| Adapters | `cortex-llm/src/rerank/rerank.ts` | 100 / 100 / 100 / 100 |
| Factory | `cortex-eval/src/rerank-factory.ts` | 100 / 100 / 100 / 100 |
| Wiring | `cortex-eval/src/natural-language-memory.ts` | 100 / 100 / 100 / 100 |

61 new tests. Workspace total 1048 tests, 0 failures, every coverage dimension
≥95% across all four packages.

## 1. Why this measure

A repository-wide search for `rerank` returned **zero implementations** before
this work. Cortex retrieved with a bi-encoder and fused channels by reciprocal
rank, but never re-scored a candidate against the question with a model that can
see both at once.

That matters because a bi-encoder cannot express interaction: the question and
the passage are encoded independently, so no amount of cosine arithmetic
recovers the joint signal. Every published memory system that reaches ≥95% on
LongMemEval runs a joint re-scoring pass as its final retrieval stage, and
Exabase M-1's third phase is explicitly a coherence rerank.

## 2. Three premises that the code refuted

The roadmap was written from documentation and published results. Reading the
pipeline corrected three claims, all of which would have produced wasted work if
left standing.

### 2.1 The pipeline is not a single shallow channel

The roadmap described retrieval as "top-3 per query, one channel". It is not.
`retrieveSessionsForQuestion` fuses **four** recall channels by reciprocal rank:

1. session-centroid hits from the bare question,
2. session hits from LLM-expanded phrases,
3. deterministic lexical variants (`expandLexicalVariants`),
4. turn-level recall that can admit a session whose evidence turn its centroid
   diluted (`retrieveSessionsByTurns`).

Adding "multi-channel retrieval" as a measure would have built something that
already exists.

### 2.2 The real narrow point is candidate-pool width

`retrieveTopKByQueries` performs reciprocal rank fusion and then **truncates to
`topK` internally**. By the time a reranker sees the pool, everything outside
the bi-encoder's top-K has already been discarded. With the default pool the
reranker can only *permute the survivors*; it cannot rescue a turn the embedding
ranked just below the cut.

This is the constraint that decides whether reranking can do anything at all,
and it is now both:

- fixed by `rerankCandidatePool`, which widens the fetched pool before reranking
  and cuts back to `topK` afterwards, so the answer prompt's width is unchanged;
- **pinned by a test asserting the limitation** —
  `cannot promote beyond the pool when the pool is left at topK`. A deliberate
  assertion on a real constraint, so that if someone later narrows the pool
  again the reason is visible rather than inferred.

### 2.3 The abstention hazard was already fixed

The roadmap flagged the RRF v1 regression as B1's primary failure mode: RRF
re-ordered hits while the single-session path still read `hits[0].score` as
abstention confidence, and IE fell from 95.0% to 87.5%.

Reading the code, `maxHitScore()` already replaced that read: the abstention
signal is the **strongest cosine among the hits**, explicitly documented as
order-independent precisely because fusion reorders the list. So reranking is
already safe with respect to abstention.

`rerankProtectedHead` is still implemented and exported, because a caller may
want to pin the first-hit evidence for other readers, but the roadmap's claim
that this is the measure's main risk was **overstated** and is corrected here.

## 3. Design decisions

### 3.1 Ordering logic is pure and lives in `cortex-core`

`rerankHits` and `fuseRerank` contain no I/O. The model call is injected as
`RerankScoreFn`. This keeps the arithmetic, tie-breaking, deduplication, and
every degradation path under genuine test in both Node and browser hosts, and it
means the ordering can be reasoned about without a provider.

### 3.2 No candidate is ever lost

Reranking reorders; it must not filter. Every failure mode returns the **input
order** rather than a truncated list:

| Failure | Behaviour |
| --- | --- |
| Scorer throws | input order |
| Response is not an array | input order |
| Response length ≠ candidate count | input order |
| Any score non-finite | input order |
| Score valid but negative (logits) | accepted, ranked normally |

A short response is treated as a failure rather than padded, because truncating
would silently convert a ranking bug into a recall bug.

### 3.3 The head is a fixed prefix

`fuseRerank(head, pool, ...)` emits the head's first `headSize` entries in their
original order, then the reranked union of the remainder. Deduplication applies
across all three regions, so an id present in both head and pool is emitted once.
This is what keeps the abstention signal stationary independent of §2.3, and it
is what lets a reranker be added without conflating its effect with a threshold
shift.

### 3.4 Two adapters, neither a single point of lock-in

| Adapter | Transport | Rationale |
| --- | --- | --- |
| `OpenAICompatibleReranker` | `POST /rerank` | The convention shared by Cohere, Jina, Voyage, and self-hosted bge proxies. Base URL and model are both configurable. |
| `CrossEncoderReranker` | local transformers.js | Offline fallback: no provider, no key, no network — the same escape hatch the embedding layer already has. |

The `/rerank` client sets `top_n` to the full document count rather than a
smaller value, because a partial response is indistinguishable from a provider
bug and asking for everything removes the ambiguity at no cost. Results are
scattered back to request order by `index`; a duplicate index, an out-of-range
index, or an unscored document all return `null` so the caller falls back
instead of ranking on a partially-zeroed vector.

### 3.5 The factory is off by default, and fails loudly on misconfiguration

`createRerankerFromEnv` returns `undefined` unless `CORTEX_RERANK` is set to a
truthy value. With it unset the pipeline is behaviourally identical to the
pre-reranker code, which is what makes the ablation arms comparable.

The single misconfiguration — enabled without `RERANK_API_KEY` — **throws**
rather than downgrading to "reranking off". A silently disabled experiment
produces a number that looks like a negative result and is not one.

The factory returns the scoring **function**, not the adapter instance: the
pipeline's option is a call signature, so handing over the instance would force
every call site to unwrap `.score` (and does not type-check under
`exactOptionalPropertyTypes`).

## 4. The bug this work found

The first wiring attempt connected only `retrieveSessionsForQuestion` — the
multi-session path. `answer()`, which most LongMemEval questions take, goes
through `retrieveTurns` and was left unreranked.

The result would have been a stage that is implemented, reachable from one
caller, and **silently absent from the graded path** — the exact defect class
that `docs/AUDIT-CODE-VS-DOCS.md` documents for the cognitive layer. A test
written against the multi-session path passes; the benchmark number would not
have moved.

The fix was not a second copy of the call. A shared private `applyRerank()` now
serves both paths, so "one path forgot to rerank" is unreachable by
construction. `retrieveTurns` also reranks **before** admission, not after,
because the admission window is bounded — a reranker applied afterwards could
only shuffle turns admission had already picked, leaving the evidence it was
meant to promote unadmitted.

## 5. Acceptance criteria

| Criterion | Status |
| --- | --- |
| Pure ordering logic in `cortex-core`, zero I/O | met |
| Provider-agnostic; offline fallback exists | met |
| Default-off; misconfiguration throws | met |
| Both retrieval paths wired through one helper | met |
| Candidate-pool limitation removable and pinned by test | met |
| ≥95% coverage on every dimension, all packages | met (100% on all new modules) |
| No mocks; only the model boundary is faked | met |
| Workspace suite green | met (1048 tests) |

## 6. What is deliberately not claimed

- **No accuracy claim.** No LongMemEval run has been performed with the stage
  enabled. The expected +1.5–3.0pp from the roadmap is a hypothesis; the
  pre-registered A/B in `cortex-docs/docs/07-sota-roadmap.md` is what tests it.
- **No default change.** The stage is off until its ablation is green. This
  project's history is a list of retrieval changes that were reverted for lack
  of a controlled comparison; adding one more unmeasured default would repeat it.
- **The pool-width default is honest, not optimal.** `rerankCandidatePool`
  defaults to `topK`, which is the weakest useful setting. That is stated in the
  option's documentation rather than hidden behind a tuned default that no
  measurement supports.

## 7. Next

1. Run the pre-registered reranking A/B with a widened candidate pool.
2. Record the result as a verdict, including a negative one.
3. Only then consider B3 (specialised extraction channels).

`A6` (controlled reader matrix) remains unrun: it needs provider credentials for
four readers, and the Zhipu embedding quota is exhausted, so it must be run from
an environment with quota.
