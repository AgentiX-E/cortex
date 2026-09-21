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

| Layer         | Location                                     | Coverage (stmts/branch/funcs/lines) |
| ------------- | -------------------------------------------- | ----------------------------------- |
| Pure ordering | `cortex-core/src/retrieval/rerank.ts`        | 100 / 100 / 100 / 100               |
| Adapters      | `cortex-llm/src/rerank/rerank.ts`            | 100 / 100 / 100 / 100               |
| LLM adapter   | `cortex-llm/src/rerank/llm-reranker.ts`      | 100 / 100 / 100 / 100               |
| Factory       | `cortex-eval/src/rerank-factory.ts`          | 100 / 100 / 100 / 100               |
| Wiring        | `cortex-eval/src/natural-language-memory.ts` | 100 / 98.96 / 100 / 100             |
| A/B arm       | `cortex-eval/src/runner.ts`                  | 98.92 / 94.64 / 100 / 98.92         |

61 tests in the first revision. The second added the LLM adapter, the local
provider branch, the A/B arm and the retry coverage. The third added the fallback
accounting (§7.1) and the stale-artifact guard (§7.3): workspace total **1237
tests**, 0 failures, every coverage dimension ≥95% across all four packages.

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
reranker can only _permute the survivors_; it cannot rescue a turn the embedding
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

| Failure                           | Behaviour                 |
| --------------------------------- | ------------------------- |
| Scorer throws                     | input order               |
| Response is not an array          | input order               |
| Response length ≠ candidate count | input order               |
| Any score non-finite              | input order               |
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

| Adapter                    | Transport             | Credential                        | Rationale                                                                                                                                          |
| -------------------------- | --------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OpenAICompatibleReranker` | `POST /rerank`        | `RERANK_API_KEY`                  | The convention shared by Cohere, Jina, Voyage, and self-hosted bge proxies. Base URL and model are both configurable.                              |
| `CrossEncoderReranker`     | local transformers.js | none                              | Offline fallback: no provider, no key, no network — the same escape hatch the embedding layer already has.                                         |
| `LLMReranker`              | the existing `LLM`    | the chat key (`DEEPSEEK_API_KEY`) | Listwise scoring through the chat endpoint. For providers that ship no `/rerank` surface, and for reusing a credential the pipeline already holds. |

The third adapter was added after a question that exposed a gap in the first two:
_a chat provider with no `/rerank` endpoint is not a rerank provider, so is
reranking blocked on a second vendor?_ The answer is no. DeepSeek publishes no
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

| Criterion                                                       | Status                                    |
| --------------------------------------------------------------- | ----------------------------------------- |
| Pure ordering logic in `cortex-core`, zero I/O                  | met                                       |
| Provider-agnostic; offline fallback **reachable**               | met (was not: see §5.1)                   |
| Provider-agnostic; **credential reuse** without a second vendor | met (`CORTEX_RERANK_PROVIDER=llm`)        |
| Default-off; misconfiguration throws                            | met                                       |
| Both retrieval paths wired through one helper                   | met                                       |
| Candidate-pool limitation removable and pinned by test          | met                                       |
| Protected-head control reachable from the benchmark             | met (was not)                             |
| A dedicated A/B arm exists for the stage                        | met (`runRerankAblation`)                 |
| API values reach the bench process in CI                        | met (was not: see §5.2)                   |
| `hits[0].score` read sites audited                              | met (`docs/AUDIT-B1-HITS0-READ-SITES.md`) |
| ≥95% coverage on every dimension, all packages                  | met (100% on all new modules)             |
| No mocks; only the model boundary is faked                      | met                                       |
| Workspace suite green                                           | met (1228 tests)                          |

### §5.3 Pre-registration: what this run can and cannot decide

Recorded **before** the first B1 run reports, so that the reading cannot be chosen
after the number is known.

**Design.** One dispatch of `.github/workflows/benchmark.yml` yields a _paired_ A/B,
because `runRerankAblation` constructs both arms itself: `rerank-baseline` (no
reranker) and `rerank-feature` (reranker attached), over one instance list, sharing
one answer cache. Sharing the cache is not an optimisation — the hosted endpoint is
not reproducible across calls even at `temperature=0`, so separately-cached arms
would differ for reasons unrelated to the treatment.

**Configuration.** `limit=150`, `ablation_runs=1`, `temperature=0`,
`model=deepseek-chat`, `CORTEX_RERANK_PROVIDER=llm`, `RERANK_CANDIDATE_POOL=60`,
`RERANK_PROTECTED_HEAD` unset.

Two choices carry the whole experiment:

- **`pool=60` and not the default.** `retrieveTopKByQueries` truncates to `topK`
  internally, and `topK` is 15. With the pool left at its default the reranker can
  only _permute the 15 survivors_ — it cannot promote evidence cosine ranked 20th.
  A test run with the default would therefore measure a permutation, report ~0, and
  that ~0 would be about the pool width, not about reranking. 60 is 4x the context
  width, inside the 3-10x band the option's own documentation names.
- **`RERANK_PROTECTED_HEAD` unset, deliberately.** The abstention signal was moved
  off `hits[0].score` to an order-independent `maxHitScore`, so the confound that
  motivated the pin is no longer present. Pinning here would suppress a real effect
  to guard against one that the code no longer has. It stays available as the
  _diagnostic_ if the measured abstention shift turns out non-zero.

### 5.3.1 A cost ceiling this configuration reveals

Calculated before the result arrived, because it bounds what any `llm`-provider run
can configure.

`rerankCandidatePool` uses the same 2000-character truncation as the graded path.
The listwise prompt for one question is therefore approximately `pool x 2000`
characters plus the question. At the chosen `pool=60` that is ~120K characters, or
roughly **30K tokens per question** — inside `deepseek-chat`'s context, which is
why 60 is a defensible setting rather than an over-reach.

But it is not far from the edge, and the failure mode at the edge is a specific one:

| Pool          | Approx. prompt | Expected behaviour                                               |
| ------------- | -------------- | ---------------------------------------------------------------- |
| 15 (default)  | ~7.5K tokens   | Comfortable, but the reranker can only permute the 15 survivors. |
| 60 (this run) | ~30K tokens    | Sized to the task.                                               |
| >= 128        | ~64K+ tokens   | Exceeds the context window; **every** call fails.                |

The last row is the one that matters, because it fails in the way §7.1 exists to
catch. An over-wide pool does not degrade the result — it produces a _total_ parse
failure, so `score` returns an empty array, `rerankHits` returns the input order,
and the arm reports `0.00pp`. That is the correct, safe outcome, and it is only
distinguishable from a genuine null because `fallbackCount` is now reported.

So the counters added in §7.1 are not merely a diagnostic for provider flakiness.
They are the guard on a configuration error that is invisible in the number it
produces.

**Power, stated before the result.** Sampling is stratified round-robin across nine
buckets (IE split into its three sub-types, plus TR, KU, MR, ABS). At `limit=150`
each capability lands near 16-17 questions. For a paired McNemar test that is a
weak instrument: to reach p<0.05 one-sided, the discordant pairs must be roughly
6-to-0 or 7-to-1. So:

| Outcome                               | Permitted reading                                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| p<0.05 with MR and TR both up         | The pre-registered criterion is met.                                                                       |
| p≥0.05                                | **Underpowered, not refuted.** This run cannot separate "no effect" from "effect below detection at n≈16". |
| MR up, TR down by more than MR's gain | Pre-registered reversal condition: no net benefit, roll back.                                              |

The distinction in row 2 is the same one the retry arm already cost this project
(`docs/09-progress-and-delivery-report.md` §7.1): an underpowered zero constrains
what we know, not what the product does.

**What must be read beside the delta, in this order:**

1. `fallbacks` — if non-null and non-zero, the reranker declined to score, the delta
   understates the feature, and no verdict follows from it (§7.1).
2. `abstentionShift` — if non-zero, reordering moved the abstention boundary and the
   delta is confounded; re-run with `RERANK_PROTECTED_HEAD=1` and compare.
3. The MR/TR per-capability pair, not the aggregate. A mechanism that helps one
   capability and hurts another nets to zero in the average, which is exactly the
   failure mode the per-capability split exists to expose.

### 5.3.2 Wiring verified end to end, without claiming a measurement

Before the CI run reported, the arm was executed locally against the synthetic mini
dataset purely to prove the path executes. **This produces no benchmark number and
none may be read from it**: the mini dataset is 13 questions across five
capabilities, so it is a wiring check, not an experiment.

What it established, in order of how much each matters:

| Observation                                            | Why it matters                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| The reranker was invoked **13 times for 13 questions** | One listwise call per question, and the feature side is not silently identical to the baseline.                                             |
| `fallbacks` read `{fallbackCount: 0, bucketCount: 13}` | The counters are reachable _and_ distinguishable from "no data". A `null` here would have meant the verdict could not be attributed at all. |
| Abstention shift was `0`                               | Both sides declined identically, so the delta is not confounded by a moved boundary.                                                        |
| MR reported `total: 2`, TR `total: 3`                  | **The power concern in §5.3 is not hypothetical.** At these sizes a McNemar test cannot reach significance at any realistic effect.         |

The last row is the one worth keeping. It is the measured confirmation that a small
run's `p >= 0.05` means "not detected", and the reason §5.3 fixes the reading rules
before the number exists rather than after.

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
   possible in four ways: offline (`CORTEX_RERANK_PROVIDER=local`, no
   credential), credential-free-in-addition (`=llm`, reusing `DEEPSEEK_API_KEY`),
   the original `/rerank` client once its key exists, or CI
   (`.github/workflows/benchmark.yml`, which needs no manual `LONGMEMEVAL_PATH` —
   the workflow downloads the dataset and exports the path itself).
2. Read `abstentionShift` beside the MR and TR deltas. A non-zero shift means the
   delta is confounded; re-run with `RERANK_PROTECTED_HEAD=1` to separate
   reordering from an abstention-boundary move.
3. Read the fallback line before believing any delta, including a zero one. See
   §7.1.
4. Record the result as a verdict, including a negative one.
5. Only then consider B3 (specialised extraction channels).

### 7.1 The reading that decides whether the other readings mean anything

`LLMReranker` returns a **short array** when a bucket's reply does not parse, and
`rerankHits` reads a short array as a failure and returns the input order. That is
the right failure semantics — padding a failed bucket would reorder candidates on
invented scores — but it has a consequence for measurement that was not visible
until the adapter existed:

> If every bucket fails, the feature arm is behaviourally identical to its
> baseline, and the arm reports `0.00 pp`. That is the same number a genuinely
> ineffective reranker produces.

A negative B1 verdict would therefore have been **unfalsifiable**: "reranking does
not help" and "reranking never ran" were the same output. The arm now reports the
counters (`RerankFallbackReport`), read from the reranker **after** both systems
have run:

| Reading               | Meaning                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `fallbacks: null`     | The reranker exposes no counters (a plain `RerankScoreFn`). The delta is unattributed either way.                                  |
| `fallbackCount === 0` | Every bucket parsed. The delta measures the reranker.                                                                              |
| `fallbackCount > 0`   | The reranker declined to score some buckets. It was **more conservative** than intended, so the delta **understates** the feature. |

`null` rather than `0` is deliberate: a fabricated zero would be an unmeasured
number presented beside measured ones. The partially-instrumented case is treated
the same way — a non-finite counter yields `null` rather than rendering `NaN`
beside plausible figures.

### 7.2 What the sandbox could and could not reach

The first attempt to run the A/B in the agent sandbox failed, and the failure is
recorded because it is a real constraint on how this measure can be executed, not
an incidental inconvenience. All three paths were probed; the results:

| Requirement                                                       | Sandbox result  | Evidence                                                                                 |
| ----------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------- |
| LongMemEval-S dataset                                             | **Absent**      | No `data/` directory in either package; no `longmemeval_s_cleaned.json` anywhere on disk |
| `DEEPSEEK_API_KEY`, `ZHIPU_API_KEY`, `RERANK_API_KEY`, `HF_TOKEN` | **All unset**   | Enumerated from the environment                                                          |
| `huggingface.co`                                                  | **Blackholed**  | `http=000`; DNS answers rewritten to `198.18.0.0/15`                                     |
| `registry.npmjs.org`                                              | Reachable       | `http=200` after the resolver workaround                                                 |
| `hf-mirror.com`                                                   | Reachable       | Model config and tokenizer fetched (`config.json`, 711 KB `tokenizer.json`)              |
| ONNX weights                                                      | **Unreachable** | The mirror 302s to `cas-bridge.xethub.hf.co`, which is `http=000`                        |

So the `local` path fails on exactly one file — the ONNX weights the cross-encoder
needs to run — and the `llm` path fails on its credential. Neither is a defect in
the implementation; both are egress constraints of the sandbox. The CI workflow is
unaffected: it runs on `ubuntu-latest` with the org-level secrets and downloads
the dataset itself.

The consequence for this document is that **no accuracy number appears below, and
none may be inferred.** The measure is implemented, wired, tested and observable;
it is not measured.

### 7.3 A second defect found by trying to measure

Writing this document required running the gates repeatedly, and the gates
reported a defect that did not exist — twice. Chasing it produced a real finding
that has nothing to do with reranking and would have bitten anyone editing an
exported signature.

`bench/run.ts` imports this package **by its own name**:

```ts
import { runRerankAblation /* ... */ } from '@agentix-e/cortex-eval';
```

Under `moduleResolution: NodeNext`, a package's own name resolves through
`package.json#exports` → `dist/index.d.ts`. So the bench typecheck reads a **build
artifact**, not the sources beside it. That was invisible while CI built before it
checked, and it surfaced locally as:

```
bench/run.ts(518,39): error TS2339: Property 'fallbacks' does not exist on
  type '{ report: AblationReport; markdown: string; abstentionShift: number; }'
```

`fallbacks` was in `runner.ts`, in the return type, correct. The message pointed
at `bench/run.ts`, which was also correct. The wrong thing was `dist/index.d.ts`,
stale from before the edit — and nothing in the output said so.

Two fixes were attempted. The first, a `paths` alias mapping the package to its
own source, **did not work and was reverted**: `paths` does not override
self-name resolution under `NodeNext`. It looked right, the tests for it passed
(they only asserted the config text), and a deliberate experiment — overwriting
`dist/index.d.ts` and re-running the bench typecheck — showed the same `TS2306`
error, proving the alias was inert.

The working fix is one character of intent: the `typecheck` script ran

```json
"typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.bench.json"
```

The `--noEmit` is the defect. It asserts a type-check while leaving the artifact
that the very next command consumes untouched, so the second invocation compiles
against whatever `dist` was last written by an unrelated `build`. Removing it
makes the compile own its output, and the stale-artifact class of failure
disappears.

**Verified by experiment rather than by reasoning**, because the first attempt at
this fix was also wrong: an early draft deleted `--noEmit` but the compiler still
skipped emit, because `incremental: true` plus an up-to-date `tsconfig.tsbuildinfo`
made it believe nothing had changed. Deleting the build-info file rebuilt `dist`
(16 bytes → 5657 bytes) and confirmed the mechanism. The regression guard is a
pair of assertions in `dataset.test.ts` — one on the ordering, one that the source
invocation does not contain `--noEmit` — and both were confirmed to fail when the
`--noEmit` was injected back.

The two order-sensitive reads at `natural-language-memory.ts:571` and `:1009` are
deliberately left unchanged — see `docs/AUDIT-B1-HITS0-READ-SITES.md` §6 for why
bundling them into this experiment would make its result unattributable.

`A6` (controlled reader matrix) remains unrun: it needs provider credentials for
four readers, and the Zhipu embedding quota is exhausted, so it must be run from
an environment with quota.
