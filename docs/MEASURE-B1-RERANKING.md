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
| LLM adapter | `cortex-llm/src/rerank/llm-reranker.ts` | 100 / 100 / 100 / 100 |
| Factory | `cortex-eval/src/rerank-factory.ts` | 100 / 100 / 100 / 100 |
| Wiring | `cortex-eval/src/natural-language-memory.ts` | 100 / 98.96 / 100 / 100 |
| A/B arm | `cortex-eval/src/runner.ts` | 99.32 / 95.23 / 100 / 99.32 |

61 tests in the first revision. The second added the LLM adapter, the local
provider branch, the A/B arm and the retry coverage: workspace total 1228 tests,
0 failures, every coverage dimension ≥95% across all four packages.

The second revision exists because three acceptance claims in the first were
**not true**, and one of them had been carried into the roadmap as a planning
assumption. They are recorded below rather than corrected silently — §5.1 and
§5.2 for the two that affected reachability, and `docs/AUDIT-B1-HITS0-READ-SITES.md`
for the ordering hazard.

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

### 3.4 Three adapters, none a single point of lock-in

| Adapter | Transport | Credential | Rationale |
| --- | --- | --- | --- |
| `OpenAICompatibleReranker` | `POST /rerank` | `RERANK_API_KEY` | The convention shared by Cohere, Jina, Voyage, and self-hosted bge proxies. Base URL and model are both configurable. |
| `CrossEncoderReranker` | local transformers.js | none | Offline fallback: no provider, no key, no network — the same escape hatch the embedding layer already has. |
| `LLMReranker` | the existing `LLM` | the chat key (`DEEPSEEK_API_KEY`) | Listwise scoring through the chat endpoint. For providers that ship no `/rerank` surface, and for reusing a credential the pipeline already holds. |

The third adapter was added after a question that exposed a gap in the first two:
*a chat provider with no `/rerank` endpoint is not a rerank provider, so is
reranking blocked on a second vendor?* The answer is no. DeepSeek publishes no
dedicated reranking model and no `/rerank` endpoint — verified against its
endpoint list — but it does not need to, because reranking is not a protocol, it
is a scoring function. Routed through the same `LLM` abstraction the judge and
the answerer already use, the chat credential scores passages without a second
secret, and the rerank path inherits the provider's retry, backoff and timeout
policy instead of reimplementing it.

`LLMReranker` scores **listwise**: one completion per distinct question returning
a JSON array of scores, the same bucketing the `/rerank` client uses for its
per-question posts. Per-pair scoring was rejected because its call count is
`questions × candidates`, and the widest candidate pool is exactly the
configuration the A/B must test — the one design that cannot afford its own
experiment.

Its failure semantics are intentionally strict in one direction and tolerant in
the other. Locating the array tolerates prose and code fences, because models
wrap JSON in those often enough that rejecting them wastes calls for no benefit.
Accepting it is exact: length and finiteness are enforced, an object-wrapped
`{"scores": [...]}` is rejected even when the inner array is well-formed (a keyed
payload carries no positional guarantee, so the mapping from array position to
candidate is no longer something the adapter can rely on), and a bucket that
fails to parse contributes **no** scores rather than a padded constant. The short
array is what `rerankHits` reads as a failure, so the candidates are returned in
input order. Padding would instead reorder them on invented data, turning a
provider hiccup into an apparent experimental result.

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

The backend is chosen by a **separate** `CORTEX_RERANK_PROVIDER`
(`openai` | `llm` | `local`, default `openai`). The two switches are kept apart
because collapsing them would create an unresolvable question: under the LLM
backend the credential is the chat key, so `RERANK_API_KEY` would have to be
sometimes-required and sometimes-forbidden in the same variable, and the
"enabled without credentials" error could no longer name the variable the
operator actually has to set. The LLM backend therefore refuses a
`RERANK_API_KEY` — accepting one would move the failure from startup to the first
request. An unrecognised provider value throws by name rather than falling back
to the default, because a typo would run the A/B against a different reranker
than the operator named and then report the resulting accuracy as a fact about
the named one.

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
| Provider-agnostic; offline fallback **reachable** | met (was not: see §5.1) |
| Provider-agnostic; **credential reuse** without a second vendor | met (`CORTEX_RERANK_PROVIDER=llm`) |
| Default-off; misconfiguration throws | met |
| Both retrieval paths wired through one helper | met |
| Candidate-pool limitation removable and pinned by test | met |
| Protected-head control reachable from the benchmark | met (was not) |
| A dedicated A/B arm exists for the stage | met (`runRerankAblation`) |
| API values reach the bench process in CI | met (was not: see §5.2) |
| `hits[0].score` read sites audited | met (`docs/AUDIT-B1-HITS0-READ-SITES.md`) |
| ≥95% coverage on every dimension, all packages | met (100% on all new modules) |
| No mocks; only the model boundary is faked | met |
| Workspace suite green | met (1228 tests) |

### 5.1 "Offline fallback exists" was not true

The earlier revision of this table marked the offline fallback met because
`CrossEncoderReranker` was implemented, exported, and covered by tests. All three
were true, and the claim was still false in the only sense that matters: **the
factory never constructed it.** `createRerankerFromEnv` had exactly one return
path — `new OpenAICompatibleReranker(...)` — and `CrossEncoderReranker` was
referenced only by the package index and its own tests. `@xenova/transformers`
appeared in no `package.json`.

So the fallback was existent, tested, and unreachable. This is the same defect
class as the one §4 records for the cognitive layer: present in the tree, absent
from every path that would ever run. It is now a real branch
(`CORTEX_RERANK_PROVIDER=local`), with a lazy memoised pipeline loader mirroring
the embedding layer's shim, and a test that drives the closure to first scoring
rather than asserting only that a function was returned.

### 5.2 The CI passthrough was missing entirely

`benchmark.yml` contained **zero** occurrences of `CORTEX_RERANK` or `RERANK_*`.
An operator could set every credential the stage needs and the stage would still
stay off, because no value ever reached the bench process. Four dispatch inputs
and their `env:` entries now exist (`rerank`, `rerank_provider`,
`rerank_candidate_pool`, `rerank_protected_head`).

The roadmap stated that "workflow 的 5 个透传变量已就位". They were not. The
claim is corrected there rather than only here, because a reader planning a
dispatch from the roadmap would otherwise expect a secret to be sufficient.


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

The wiring is complete; the measurement is not. What remains:

1. Run the pre-registered reranking A/B with a widened candidate pool — now
   possible in three ways that did not exist before: offline
   (`CORTEX_RERANK_PROVIDER=local`, no credential), credential-free-in-addition
   (`=llm`, reusing `DEEPSEEK_API_KEY`), or the original `/rerank` client once its
   key exists.
2. Read `abstentionShift` beside the MR and TR deltas. A non-zero shift means the
   delta is confounded; re-run with `RERANK_PROTECTED_HEAD=1` to separate
   reordering from an abstention-boundary move.
3. Record the result as a verdict, including a negative one.
4. Only then consider B3 (specialised extraction channels).

The two order-sensitive reads at `natural-language-memory.ts:571` and `:1009` are
deliberately left unchanged — see `docs/AUDIT-B1-HITS0-READ-SITES.md` §6 for why
bundling them into this experiment would make its result unattributable.

`A6` (controlled reader matrix) remains unrun: it needs provider credentials for
four readers, and the Zhipu embedding quota is exhausted, so it must be run from
an environment with quota.
