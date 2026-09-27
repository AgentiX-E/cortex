# The 429 is a concurrency cap, not a quota exhaustion

**Status:** root cause identified, three compounding defects, none of them billing.
**Scope:** the Zhipu `embedding-3` path used by the LongMemEval benchmark.
**Evidence:** the vendor's own API reference plus the repository's retry code.

## 0. Conclusion first

The 429 was recorded as "quota exhausted, needs a top-up or the offline
fallback." That reading is **wrong**, and the account balance the operator
observes is consistent with it being wrong. Zhipu returns 429 with error code
`1305` for **model concurrency**, not for an empty balance: the Chinese message
is `模型当前访问量过大,请您稍后再试` — "this model's current request volume is too
high, try again later." A funded account with a healthy resource pack returns
exactly this under load.

So the question is not "why is the quota gone" but **"why does a funded account
still see 429, and why does the retry logic fail to absorb it"**. Three defects
answer that, and they compound:

| # | Defect                                                                        | Consequence                                                        |
| - | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1 | Retry budget (31s of sleep) is **shorter than the provider's 60s window**      | every retry lands inside the window that rejected the request       |
| 2 | `Retry-After` is **never read**, so the server's own pacing hint is discarded  | the client cannot know how long to wait and guesses                  |
| 3 | **No client-side pacing** between the 64-input batches                        | the run issues back-to-back maximum-size requests until throttled    |

None is a billing problem, and fixing none of them requires a top-up. The
offline fallback recorded earlier as the remedy would have masked all three.

## 1. What the vendor's limits actually are

From the `embedding-3` API reference at `docs.bigmodel.cn`, verbatim constraints:

| Constraint                     | Value                                   | Cortex setting           | Verdict      |
| ------------------------------ | --------------------------------------- | ------------------------ | ------------ |
| entries per request            | **at most 64**                          | `EMBED_BATCH = 64`       | at the ceiling |
| tokens per single request      | at most 3072                            | not enforced             | **unchecked** |
| output dimensions              | 256 / 512 / 1024 / 2048 (default 2048)  | `1024`                   | valid        |
| 429 error code                 | `1305`, "access volume too high"        | treated as generic retry | misread      |

The batch ceiling being sat exactly is not itself a bug — 64 is the documented
maximum and using it minimises request count, which is the right direction for a
concurrency cap. But a batch of 64 long turns can also exceed the **3072-token**
per-request bound, and nothing in the adapter checks that. That is a separate
latent 400 waiting to happen on a haystack with long turns.

## 2. Defect 1 — the retry budget is shorter than the throttle window

`packages/cortex-llm/src/retry.ts` computes the backoff as
`baseDelayMs * 2 ** (attempt - 1)` with `baseDelayMs = 1000` and
`maxRetries = 5`:

| retry | sleep before the attempt |
| ----- | ------------------------ |
| 1     | 1s                       |
| 2     | 2s                       |
| 3     | 4s                       |
| 4     | 8s                       |
| 5     | 16s                      |

Total sleep across the whole retry budget: **31 seconds**, spread over six
request attempts.

Zhipu's concurrency limits are expressed over a **minute-scale window** (RPM /
TPM, as the platform's own error guidance describes them). A 31-second budget
therefore **cannot outlast a 60-second window**: when the throttle is
window-based rather than a short burst, every one of the five retries is issued
inside the very window that returned the 429, so all six attempts are rejected
and `retryableFetch` throws. The retry logic is not absent — it is **too short to
reach the far side of the window it is retrying against.**

This also explains a symptom that looked like flakiness: a run can pass whenever
the throttle happens to be burst-shaped and fail whenever it is window-shaped,
with the same code and the same balance.

## 3. Defect 2 — `Retry-After` is discarded

A search for `Retry-After` across `packages/cortex-llm/src/` returns **nothing**.
The server's own instruction for how long to wait is never parsed, so the client
substitutes a fixed exponential guess for a value the server already stated.
When a provider sends `Retry-After`, that value is authoritative and almost
always larger than a 1-second first backoff — which is precisely why a fixed
schedule that ignores it undershoots.

## 4. Defect 3 — nothing paces the batches

`embedManyCached` in `packages/cortex-eval/src/retrieval.ts` loops batches with
`await` and **no delay and no concurrency limit**. On a full 500-question run the
haystack is embedded per question; at the measured 47 sessions per question the
volume is on the order of 10⁴–10⁵ texts, i.e. **10²–10³ requests of 64 inputs
each, issued as fast as the network allows.** That is the exact shape that trips
a concurrency cap: not a burst of one, but a sustained maximum-rate stream.

The benchmark's own code comments say a full run "already doubles that upfront
cost and would exhaust the embedding quota" — the framing that produced the
billing hypothesis. Read against the vendor docs, the same sentence describes a
**request-rate** problem, not a balance problem.

## 5. Why the earlier diagnosis was reachable and wrong

Three observations were each true and jointly supported the wrong conclusion:

1. A 429 appeared under a large run — consistent with exhaustion.
2. The run is genuinely large — consistent with exhaustion.
3. The code comment says "exhaust the embedding quota" — a plausible reading.

What was missing is the step that distinguishes the two: **a funded account
cannot be exhausted by definition of the error code.** Error `1305` is a
concurrency signal. Checking the vendor's error table separates the hypotheses in
one step, and that step was skipped — the 429 status alone was read as billing
because the status code is shared between the two causes.

> **Discipline 25: a status code shared by two causes is not evidence for either.**
> 429 means "too many requests"; whether "too many" is caused by a spent balance
> or by a request rate is decided by the vendor's error code and message, not by
> the HTTP status. Before sizing a remedy to a resource (top-up, bigger pack,
> fallback), read the provider's error table — a remedy sized to the wrong cause
> is indistinguishable from no fix, and it costs money.

> **Discipline 26: an atomic step fails as a whole, so its blast radius is set by
> its worst input, not its average one.** `pnpm install` exits 1 if any single
> postinstall fails, and on that exit no workspace `.bin` link is created — so a
> native module reached by one optional adapter removed `eslint` from all four
> packages, and the failure surfaced three steps later as `eslint: not found`.
> Two consequences follow. First, a dependency that is only ever reached through
> `await import()` must not be declared where the whole workspace must resolve
> it; optionality is a property of the declaration, not of the import. Second,
> when an atomic step fails, the step that *reports* the failure is not the step
> that *caused* it — read the failing command's own output before editing the
> code the error message points at.

## 6. Ranking signal

This is not only a reliability issue. A run that fails mid-way has already
embedded part of the haystack, and the persisted cache is what a later run
restores. If the failure lands at a request-rate boundary, **which questions got
their embeddings from the live API and which from the restored cache varies
between runs** — and the report does not record which backend produced a vector.
The diagnostics block carries `embeddingMaxAbsDiff` but no provider, model, or
dimension. Measured on the 2026-09-22 run: `embeddingMaxAbsDiff = 0` with **no
field identifying the provider**.

So the same commit can be measured twice with silently different embedding
provenance and nothing in the artifact says so. This is the same family as the
discordant-identity and persisted-null findings already recorded: **a value that
is not written down cannot be audited, and its absence reads as its absence of a
problem.**

## 7. What a fix has to do

Listed as requirements, not as an implementation, because the shape is
constrained by §2 and §3:

1. **Read `Retry-After` and prefer it over the computed backoff** when present,
   in both the embedding and LLM adapters.
2. **Make the retry budget outlast a minute-scale window** — either by raising
   the cap or by making the ceiling a wall-clock budget rather than an attempt
   count, so a window-shaped throttle is reachable.
3. **Pace the batch loop** so the request rate stays under the provider's limit
   rather than being discovered by rejection.
4. **Bound the token count per request**, not only the entry count, so a batch of
   long turns cannot exceed the 3072-token cap.
5. **Record the embedding provenance** (provider, model, dimensions, and whether
   a vector came from cache or the live API) in the diagnostics artifact, so two
   runs can be compared without assuming.

Items 1–4 are the reliability fix; item 5 is what makes any future benchmark
claim auditable. Item 5 is the one this repository's existing findings say to do
first, because without it a green run and a red run are not comparable.

## 8. Fix status

All five requirements are implemented. Each row names the code that carries it
and the evidence that the fix is reachable from a real run, not only from a unit
test.

| # | Requirement              | Implementation                                                                 | Evidence                                                                                  |
| - | ------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| 1 | Read `Retry-After`       | `parseRetryAfterMs` in `packages/cortex-llm/src/retry.ts`; consulted ahead of the computed backoff | 5 parser tests (delta-seconds, HTTP-date, fractional, malformed rejection) + 6 `retryableFetch` tests |
| 2 | Outlast a minute window  | `DEFAULT_RETRY_BUDGET_MS = 120_000`; the ceiling is a wall-clock budget, not an attempt count | `DEFAULT_RETRY_BUDGET_MS > 60_000` test + fake-timer test asserting the budget stops a 10-retry sequence at exactly 5 requests |
| 3 | Pace the batch loop      | `EMBEDDING_BATCH_INTERVAL_MS` → `setEmbeddingBatchIntervalMs`, read by `embedManyCached` when no per-call value is given | pacing test over two 64-entry batches; the value is printed in the run log and recorded in the artifact |
| 4 | Bound tokens per request | `EMBED_MAX_TOKENS = 3072` and `shapeBatches` in `packages/cortex-eval/src/retrieval.ts` | token-overflow split test, oversized-single-text test, and a small-text test proving the bound does not degenerate to one request per text |
| 5 | Record provenance        | `createEmbeddingWithProvenanceFromEnv`, `EmbeddingSourceStats`, and the `embedding` block on every JSON artifact plus a header on every Markdown report | 9 embedding-provenance tests, 8 source-accounting tests, and an end-to-end run whose artifacts all carry the block |

**Why §3's pacing needed a process-wide setting rather than a parameter.** The
retrieval functions that actually embed (`retrieveTopKByQueries`,
`buildTurnIndex`, `retrieveByQueries`, and five others) take no options object, so
a per-call `batchIntervalMs` was unreachable from the benchmark — the only caller
that has a quota to respect. Threading an options parameter through eight
functions to set one number would put it on every caller that has no opinion
about it. `setEmbeddingBatchIntervalMs` is read by `embedManyCached` only when its
own option is absent, so the per-call contract stays testable without a global
reset.

**Why the provenance block needed a counter rather than the cache snapshot.** An
audit reader has to separate a run that embedded everything live from a run that
restored the persisted cache, and those two produce byte-identical reports. The
snapshot's size cannot answer it: it says how many vectors exist, not how many of
a given call's inputs were already present. The counts are therefore incremented
where the cache lookup and the batch dispatch actually happen, which is also the
only way the pair can disagree with the cache if the code drifts.

## 9. The A/B, and what it has actually shown so far

The audit's requirement is that the pacing fix be confirmed by a real dispatch:
paced versus unpaced, compared on 429 rate and wall-clock. The workflow now
carries `embedding_batch_interval_ms` as a dispatch input, and both arms are
configured as follows.

| Arm     | Input                          | Everything else                       |
| ------- | ------------------------------ | ------------------------------------- |
| paced   | `embedding_batch_interval_ms: 250` | `limit=60`, `diagnostics_limit=100`, `rerank=off`, `thinking=disabled` |
| control | `embedding_batch_interval_ms: 0`   | identical to the paced arm            |

Zero is the control rather than a separate "before" commit: `0` means unpaced, so
the two arms differ in exactly the one value under test and a third variable
cannot enter through a code delta.

**Status: dispatched five times. The install and gate are now cleared; the 429 comparison is not yet made.** The honest sequence:

| Attempt | Commit | Step reached | Outcome |
| ------- | ------ | ------------ | ------- |
| 1 (two arms) | `6863fa2f` | 5. Install dependencies | failure — `ERR_PNPM_OUTDATED_LOCKFILE` |
| 2–4 (two arms, retried) | `42232bfe` | 7. Verify library | failure — `eslint: not found` |
| 5 (two arms, no retries) | `ca40bf99` | 7. Verify library | **success, both arms** — entered the benchmark |

Attempt 5 settles the open question the previous attempt left: the `eslint` failure is not merely fixed in a sandbox copy, it is fixed **on a GitHub runner**, which is the only environment where `better-sqlite3` can build. That is the claim this record could not make locally, and it is now made by the environment that can test it.

Attempt 1's cause is recorded above and was fixed in `42232bfe`. Attempt 2's cause is **not** what this document previously claimed. The correct account:

The lockfile fix worked — `Install dependencies` went green and the failure moved one step later, to `Verify library` (which is `pnpm check`). `pnpm check` then died with `sh: 1: eslint: not found`. The cause was **`@xenova/transformers` being added to the root `devDependencies` in `42232bfe`**: it hard-depends on `sharp@0.32.6`, whose postinstall downloads libvips. `pnpm install` is atomic — one native postinstall failure exits 1 and the workspace `.bin` links are never created, so every package loses `eslint`. A dependency that is only ever reached through `await import()` had been made mandatory for the whole workspace.

The fix, in two parts, is a controlled experiment rather than a plausible edit:

| Arm | Configuration | `sharp` script | `pnpm install` |
| --- | ------------- | -------------- | -------------- |
| A (fix) | `optionalDependencies` + `pnpm.onlyBuiltDependencies` | ignored | `Done in 2.1s` |
| B (control) | root `devDependencies`, no allowlist | ran → `Failed` | exit 1 |

Both arms were run under the pinned `pnpm@9.15.0`, the version CI uses, not the sandbox default.

**What the earlier retry loop got wrong, recorded because it is the same error this document exists to name.** The four dispatch attempts were made by a script that treated HTTP 422 as retryable. It is not: 422 is deterministic, and retrying a deterministic rejection re-issues the request. The dispatcher therefore created 23 runs, 21 of them probes. The 422 itself was never the obstacle — the same request body later returned 204 unchanged, and all 13 inputs were accepted individually. The failure was one step downstream the whole time.

**A second false green, recorded for the same reason.** The first `pnpm check` run reported green because the working tree still held a `dist/` and a `node_modules/` from an earlier build. The command was correct; the tree was not pristine. Every verification after that point was re-run on a freshly materialised copy of the pushed commit. That is the standard this document now holds itself to.

**No 429-rate comparison is claimed here.** A red dispatch that never ran the benchmark is not a negative result about pacing, and reading it as one would repeat the mistake this record exists to correct — sizing a conclusion to a measurement that was never taken.

**What was unproven locally, and how attempt 5 closed it.** The `eslint` failure is fixed, and that claim was verified two ways rather than one. Locally it was verified against a freshly materialised copy of the pushed tree under `pnpm@9.15.0` — the pinned version, not the sandbox default. What could **not** be verified locally was `better-sqlite3`, a required native dependency of `cortex-node` with a static import: its postinstall needs `nodejs.org` for headers and `github.com` for a prebuilt, and this sandbox blackholes both.

That gap is why attempt 5 was treated as the experiment rather than as a formality, and it is now closed: on `ca40bf99` both arms report `Verify library = success` on a real runner. The lesson worth keeping is that the local environment reported the *opposite* of the truth for `better-sqlite3` — it failed there for reasons that do not exist on a runner — so a local red on a native build is not evidence of a repository defect. Distinguishing the two required reading the failing command's own output down to the fetch error, not inferring from the exit code.

**Attempt 5 result: both arms succeeded, and the comparison it was meant to make cannot be made from these artifacts.** Stated first, because it is the finding:

| | paced | control |
| --- | --- | --- |
| `batchIntervalMs` | **250** | **0** |
| provider / model / dimensions | `openai-compatible` / `embedding-3` / 1024 | identical |
| `source.liveRequests` | 80 | 78 |
| `source.batches` | 80 | 78 |
| `source.cachedTexts` | 31947 | 31950 |
| run wall-clock | 816s | 789s |
| `Run benchmark` step | 746s | 725s |

The provenance block did exactly what §6 asked of it: it makes the two arms distinguishable, and it confirms both used the **real Zhipu backend** rather than the hash fallback. That is the block earning its place.

**But there is no 429 rate to compare, because nothing records one.** A scan of all artifacts in both arms finds no retry counter, no 429 count, and no throttle field. This is not a missing measurement that a re-run would produce — `retryableFetch` retries internally and returns only the final response, so a request that was rejected twice and then succeeded is indistinguishable in the output from one that succeeded first time. The pacing overhead is visible (`80` requests × 250ms ≈ 19.8s, against a 21s wall-clock gap), which confirms the setting reached the production path. The thing the A/B was designed to measure is instrumented nowhere.

**So the honest verdict on the original question is: unanswered, and unanswerable from this run's output.** The three defects of §0 remain fixed, and each fix is verified reachable from a real run — but the claim "pacing reduces the 429 rate" is **not** supported by these two runs, and is not refuted by them either. What the runs do show is that both configurations completed the benchmark against the live provider without exhausting retries, which is consistent with the rate being survivable at this sample size either way.

The gap is the same family as §6's: **a value that is not written down cannot be audited.** Adding a retry counter to the same `EmbeddingSourceStats` structure is the prerequisite for the comparison, and until it exists a re-dispatch would produce two more reports that look identical on the axis under test.

**What attempt 5 does settle.** The install and gate path is fixed on a real runner — the step that failed eight consecutive times now passes, on the environment that can build the native dependencies this sandbox cannot.

**One surviving gap, stated rather than rounded away.** `retrieval.ts` lines
631–632 are uncovered. They guard `indexOf(hit) < 0` inside a loop whose hits come
from a map keyed by the same session, so the branch is unreachable for every input
the caller can construct. It is a defensive guard, not a behaviour: no test can
reach it without fabricating a state the function cannot receive, and a test that
did would assert a fiction. Recorded here so the coverage figure reads as measured
rather than as met.

## 10. The instrument §9 asked for

§9 ends on a gap: the A/B could not report a throttling rate because nothing in
the pipeline recorded one. This section is the fix, and it is deliberately narrow
— an instrument, not a behaviour change.

### 10.1 What was added

| Symbol | Package | Role |
| ------ | ------- | ---- |
| `RetryStats` | `cortex-llm` | per-call counters: `attempts`, `retried`, `rateLimited`, `retryAfterHonoured` |
| `RetryOutcome` | `cortex-llm` | `RetryStats` plus the final `Response` |
| `retryableFetchWithStats` | `cortex-llm` | the retry loop, now returning its own counters |
| `retryableFetch` | `cortex-llm` | unchanged signature — a thin wrapper over the above |
| `RetryStatsSnapshot` | `cortex-llm` | the same counters aggregated across calls, plus `retryRate` |
| `RetryStatsAggregate` | `cortex-llm` | `record()` / `snapshot()` / `reset()` |
| `retryStats()` / `resetRetryStats()` | `cortex-llm` | the process-level aggregate's only read path |
| `transportRetryReport()` | `cortex-eval` | formats a snapshot for an artifact |
| `embedding.transportRetry` | artifact field | where the counters land |

`retryableFetch`'s signature and behaviour are **unchanged**. Every existing
caller — the embedding adapter, the OpenAI-compatible LLM — needed no edit, which
is what makes this an instrument rather than a refactor: the only observable
difference is the presence of new numbers.

### 10.2 Two decisions worth their own paragraphs

**`retryRate` is per call, not per retry.** The first implementation computed
`retried / calls`. A test caught it: one call retrying 40 times reported a rate of
**40**. That is not a rate. The numerator is `retriedCalls` — calls that retried at
least once — so the metric answers "what share of calls had to retry", and the
retry *volume* stays in `retried`, where a reader can still tell "many calls each
retrying once" from "one call retrying many times". The two live side by side on
purpose; collapsing them was the bug.

**A refused retry is not counted.** When the wall-clock budget rejects a retry
(§2), the branch returns early and increments nothing. Recording it would report a
request the provider never received, which would inflate `retried` in exactly the
scenario the budget exists to create. The one thing that branch *does* do is
synthesise a `429` when there is no response to return — after a transport failure
`resFromLastAttempt` is cleared, so without the fallback the caller receives
`undefined` and reads `res.ok` off nothing. `rateLimited` stays zero on that path:
no 429 was ever received.

### 10.3 The mutation experiment

A counter that reports the wrong thing is worse than no counter, because it looks
authoritative. `tools/inject-retry-stats.py` injects 16 plausible accounting
errors and requires the suite to catch each one.

| Mutation | Caught by |
| -------- | --------- |
| `retry-not-counted` | retry accounting |
| `rate-limited-counts-5xx` | retry accounting |
| `budget-refusal-counted` | retry accounting (budget) |
| `budget-refusal-status-shifted` | retry accounting (budget) |
| `retry-rate-per-retry` | retry stats aggregation |
| `transport-failure-counted` | retry accounting |
| `retry-after-always-honoured` | retry accounting |
| `retried-call-recorded-clean` | retry stats aggregation |
| `clean-call-recorded-retried` | retry stats aggregation |
| `snapshot-drops-retried-calls` | build (type) then tests |
| `reset-leaves-retried-calls` | retry stats aggregation (reset) |
| `reset-leaves-attempts` | retry stats aggregation (reset) |
| `report-drops-rate-limited` | transport retry report |
| `report-drops-retry-after` | transport retry report |
| `report-relabels-scope` | transport retry report |
| `report-drops-attempts` | transport retry report |

**16 / 16 caught.** Each file is restored from memory and md5-verified after every
mutation, so no mutation can survive in the tree even if the run aborts.

Three of the sixteen are worth calling out because the experiment found them:

1. **Two mutations initially had no test at all.** `reset()` had no coverage — the
   existing test asserted only `calls` after a reset, leaving seven fields free to
   leak. That matters here specifically because the retry *rate* is
   `retriedCalls / calls`: a stale numerator over a fresh denominator reports a
   rate above 100%. A test asserting the whole snapshot now exists.
2. **One mutation survived as a no-op.** `snapshot-not-a-copy` was written as
   `attempts: this.#attempts + 0`, which is behaviourally identical to the
   original. It was a mislabelled mutation, not a test gap — the aggregate's fields
   are private numbers, so a snapshot returning primitives cannot alias mutable
   state. It was replaced with mutations that are actually expressible.
3. **One mutation was caught by the type checker, not a test.** The mutation
   harness runs a build before the eval suite, and the eval package resolves
   `cortex-llm`'s **built** `dist/`. Without that build the eval tests would keep
   passing against pre-mutation code and report survivors that do not exist. This
   was found the hard way: the first run reported `BASELINE RED` for that reason.

### 10.4 Where the number goes

The counters are written to two places, deliberately:

- `benchmark-diagnostics.json`, under `embedding.transportRetry`, alongside
  `source` — `source` says where the vectors **came from**, `transportRetry` says
  what the requests **cost**.
- The step log, as a `=== Transport retries (process scope) ===` line.

A number that requires downloading a ZIP to read is a number that does not get
compared, and this A/B exists to compare one number between two runs. Same value,
two readers.

The field carries `scope: 'process'` because `retryableFetch` is the single choke
point for embedding **and** LLM traffic, so the aggregate is process-wide and
cannot be split after the fact. Naming the scope is the honest alternative to
inventing a per-provider breakdown the counter does not have. `provider:
'embedding'` records what the section is being read for.

### 10.5 Status

**Implemented, verified, and dispatched.** The comparison §9 could not make was
subsequently made — see §11. Both arms report `retryRate = 0.00%`, which is a
measured null rather than a confirmation: at this sample size neither configuration
was throttled at all. The instrument is what turned "unanswerable" into "answered,
with a null".

Gate: **1513 tests** across four packages, every dimension ≥95%.

| Package | Tests | Stmts | Branch | Funcs | Lines |
| ------- | ----- | ----- | ------ | ----- | ----- |
| cortex-core | 127 | 98.48 | 98.34 | 100 | 98.48 |
| cortex-node | 16 | 100 | 98.61 | 100 | 100 |
| cortex-llm | 131 | 99.27 | 98.11 | 100 | 99.27 |
| cortex-eval | 1239 | 99.87 | 99.03 | 100 | 99.87 |

`retry.ts` is at **100 / 100 / 100 / 100**. The branch that was uncovered before
this section — the `??` fallback on the budget-refusal return — now has a test that
reaches it, by refusing a retry after a transport failure rather than after a 429.

## 11. The measurement, taken

§10 left one thing undone: the instrument existed, but no run had produced two
sets of counters to compare. This section is that run.

**Dispatch `b5edea00`, runs `36302416472` (paced) and `36302418319` (control), both
`completed/success`.** Dispatch was `204 × 2` on the first attempt with zero
retries, so the request body that §9's loop kept misreading as a 422 is not a
factor here — that was settled in §9 and it stayed settled.

### 11.1 The numbers

| | paced (`250ms`) | control (`0ms`) |
| --- | --- | --- |
| `batchIntervalMs` | **250** | **0** |
| provider / model / dimensions | `openai-compatible` / `embedding-3` / 1024 | identical |
| `source.liveRequests` | 79 | 79 |
| `source.liveTexts` | 212 | 206 |
| `source.cachedTexts` | 31948 | 31951 |
| `transportRetry.attempts` | **169** | **169** |
| `transportRetry.calls` | 169 | 169 |
| `transportRetry.retried` | **0** | **0** |
| `transportRetry.rateLimited` | **0** | **0** |
| `transportRetry.retryAfterHonoured` | 0 | 0 |
| `transportRetry.retriedCalls` | 0 | 0 |
| `transportRetry.cleanCalls` | 169 | 169 |
| `transportRetry.retryRate` | **0.00%** | **0.00%** |

**Both arms: 169 calls, 169 attempts, zero retries, zero 429s.**

### 11.2 Reading it honestly

**The instrument worked, and it produced a null result.** Stated plainly, because
the temptation here is to read "no 429s" as "the fix worked":

Three cross-checks confirm the counters are measuring what they claim, rather than
being structurally zero:

1. `attempts == calls` in both arms — every call succeeded on its first attempt.
   Had the counter been dead, `attempts` would be `0`, not `169`.
2. `attempts - source.liveRequests = 90` in **both** arms. The embedding backend
   made 79 live requests; the remaining 90 transport calls are the LLM's. That the
   same split appears independently in both arms is what rules out a stuck counter —
   a broken one would not reproduce a 79/90 division from two different runs.
3. `calls == cleanCalls == 169` and `retriedCalls == 0`, which is exactly the shape
   a zero-retry run must have. The two arms agree on all eight fields.

So the counter is live and reports zero. **There is no throttling to reduce at this
sample size, in either configuration.**

### 11.3 What this does and does not settle

**It settles:** at `limit=60` against the live Zhipu backend, with a warm embedding
cache (≈31.9k texts restored, ~210 embedded live per arm), **neither configuration
was throttled at all.** The three defects fixed in §0 remain fixed and reachable,
and the earlier diagnosis that the 429 was a concurrency cap rather than a quota
exhaustion is consistent with what is observed — but it is **not** what this run
proves, since no 429 occurred to characterise.

**It does not settle:** whether pacing reduces the 429 rate **under throttling**.
A zero-vs-zero comparison cannot establish a difference in a rate that was zero in
both arms. Anyone reading "paced = 0, control = 0" as evidence for pacing has read
a null result as a confirmation.

The reason both arms were clean is visible in the provenance: the cache carries
≈31.9k of the ≈32.1k texts, so each arm issued only ~79 live embedding requests.
That is a **much lighter** load than the scenario the pacing fix was designed for.
Producing a throttled arm would require a cold cache, a larger `limit`, or both.

### 11.4 The comparison §9 could not make is now makeable — and was made

This is the difference the instrument bought, and it is worth being precise about
it. §9 could not report a rate because **no number existed in either artifact.**
§11 reports a rate for both arms. The answer is `0.00%` and `0.00%`.

That is a less satisfying answer than a large delta would have been. It is,
however, a **measured** answer, which is the only kind this record accepts. §10's
discipline applies to it directly: the number was written where both runs could
read it, so it could be compared — and the comparison was made.

**Next step, stated rather than left implicit:** to obtain a decision about pacing,
the load has to be heavy enough to elicit a 429. That means a cold embedding cache
and/or a substantially larger `limit`, not another run at the current settings.
Dispatching the same two arms again would reproduce this same pair of zeros.
