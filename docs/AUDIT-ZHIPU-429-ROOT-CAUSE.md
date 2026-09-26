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
