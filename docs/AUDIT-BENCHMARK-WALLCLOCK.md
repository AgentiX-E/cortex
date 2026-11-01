# Audit: why a four-hour benchmark is normal, and why its protection was not

Run `41284575092` was dispatched at 07:23Z on 2026-11-01 and was still inside its benchmark step at
11:44Z. The question was whether that is a fault. It is not — the arithmetic is exactly what the
configuration predicts — and the investigation found two things that are.

1. **The in-run ceiling could not fire.** It bounded one pass; a dispatch is eight passes; so it
   permitted 2.06 times the job that contained it. `41259622431` finished **fifteen minutes** before
   a kill that would have written no artifact, and nothing recorded the margin.
2. **The evaluation loop is serial**, so the wall clock is the sum of 4000 requests, and the
   obvious repair — concurrency — is blocked by an interface that returns four of its outputs
   through shared mutable state rather than through the call's return value.

§9.4 of `AUDIT-MODEL-PORTABILITY.md` describes the same shape one level down, in the degradation
guard: a protection whose safety came from the failure never arriving rather than from the rule being
adequate. This document is that finding applied to the thing that produces the numbers.

---

## 1. The arithmetic, and why 4h20m is the predicted number rather than a slow one

One dispatch is `2 arms x 4 repetitions = 8` passes over 500 questions, i.e. **4000 reader calls**.

| run | configuration | wall clock | per pass | per call |
| --- | --- | --- | --- | --- |
| `41222844945` | 96k, `thinking=disabled` | 117.5 min | 14.7 | 1.76 s |
| `41203245999` | 48k, `thinking=disabled` | 122.6 min | 15.3 | 1.84 s |
| `41254359622` | 96k, thinking on `multi-session+temporal` | 305.9 min | 38.2 | 4.59 s |
| `41259622431` | the same plus `candidates` | 334.8 min | 41.9 | 5.02 s |
| `41284575092` | 48k, thinking on the same routes | 280 min at 12:04Z, still running | — | — |

So a thinking-enabled dispatch costs **2.60x** a thinking-disabled one (305.9 / 117.5) and the
candidate arm **2.85x** (334.8 / 117.5). At 5.0 s per call, 4000 calls is 5h34m of pure provider
time before any local work; 334.8 minutes means the local pipeline — retrieval, budget, rendering,
scoring — is **under 1% of the wall clock**. There is nothing to optimise in this repository's own
code. The run is exactly as long as the provider makes it.

That is worth stating plainly because it kills three plausible-looking repairs at once: caching the
retrieval index, warming embeddings, and parallelising the local stages. All three are already
noise. The only lever is the number of requests in flight.

## 2. The ceiling that could not fire

`CORTEX_MEMORY_BUDGET_MINUTES` was `90` and `AblationOptions.budgetMs` was documented as *the
wall-clock ceiling for each pass* — `evaluateWithScorerDetailed` restarted its clock on every call.
The workflow's job is killed at 350 minutes. So:

```
budget ceiling = passes x budget + overhead = 8 x 90 + 1 = 721 minutes
job ceiling                                                = 350 minutes
```

`721 > 350` by a factor of **2.06**, which means: for every timing where the job kills the run, the
budget was still quiet. The one case it could catch is a single pass running 90 minutes — which
requires the other seven to be fast, and therefore a *different* failure than the one the runs
actually approach.

The failure mode this leaves is the one the option was added to prevent. A job timeout kills the
remaining steps, including the two that carry `if: always()` — the artifact upload and the error
log. Run `41259622431` had **15 minutes** of margin and no artifact recorded that number, so the
next draw 5% slower would not have produced a slower artifact; it would have produced none.

`tools/job-budget.py` is the instrument. It reads `timeout-minutes` and the budget out of the
workflow and answers whether the inner ceiling can fire:

```
$ python3 tools/job-budget.py --workflow .github/workflows/benchmark-cortex-memory.yml \
      --scope pass --budget-minutes 90 --measured-pass-minutes 41.85
job 350 min, 8 passes, 90 min per pass
  the ceiling permits 721 min of run (2.06x the job) -> IT CANNOT BIND
...
passes 8, measured 41.85 min each, budget 90 min per pass, job 350 min
  budget ceiling   8 x 90 + 1 = 721 min (2.06x the job)
  usable in job    349.0 min, so 8 complete passes fit (8.34 passes' worth of time)
  this run         8 of 8 passes, 335.8 min, headroom +14.2 min (4.1% of the job)
  budget fires     never: a pass costs 41.9 and the budget is 90, so its protection is the job
                   ceiling alone
  outcome          fits, and the margin is the only thing between this dispatch and a kill that
                   writes no artifact
```

### 2.1 Why the repair is not a smaller number

The binding per-pass budget is `(350 - 1) / 8 = 43.6` minutes. A thinking-enabled pass already costs
**41.85**. The gap is one slow draw, so narrowing the budget alone converts *a lost run* into *a
false failure* — strictly worse, because a false failure also costs the dispatch.

The repair moved the unit instead: `AblationOptions.budgetMs` is now a **deadline shared by every
pass**, so the tool reports

```
budget ceiling = 340 + 1 = 341 minutes   <=   360-minute job   -> it binds
```

340 sits above the largest measured run (334.8) and below GitHub's 360-minute ceiling for a hosted
job, so the same slow draw that used to vanish now produces `BenchmarkBudgetExceeded`, a partial
artifact and a log naming the question. 24 minutes of headroom to the job, and the mechanism that
fails first is the one that leaves evidence.

**What still bounds a hang.** The per-attempt timeout in `cortex-ai`, which is the layer that can
see a single request. A run-level deadline does not replace it and does not claim to: it bounds the
total, and the two are different quantities.

### 2.2 The five tests that would have caught it

`ablation-budget.test.ts` pins the semantics from both directions, because a per-run deadline and a
per-pass ceiling are indistinguishable inside one pass:

| test | what it distinguishes |
| --- | --- |
| eight passes each far below the budget, whose total is not | accumulation across passes |
| the same work with a budget that covers all of it | a failure cannot be blamed on a slow reader |
| a run with no budget at all | every archived artifact's path |
| a partial record that names the repetition | the budget's only product is evidence |
| `budgetMs: 0` still fires on the second call | a clamped deadline is not a disabled one |

The first one fails under the old semantics and passes under the new one, which is the only
definition of "the repair happened" a test can give.

## 3. Why the obvious 8x is blocked

4000 calls at 5 s each, one at a time. Concurrency 8 would make the run 42 minutes instead of 336,
which is the difference between five hours per iteration and one. It cannot be switched on, and the
reason is not the provider.

`runBenchmark`'s loop reads four quantities **after** the call that produced them:

```ts
record(await system.answerSessions(q.question, q.sessions));
// then, from the same function scope, on the same `system` object:
rawOutput?.();          // #lastRawOutput
retrievedContext?.();   // #lastRetrievedContext
promptEvidence?.();     // #lastPromptEvidenceChars
admittedEvidence?.();   // #lastAdmittedEvidence
promptText?.();         // #lastPromptText
```

These are single-slot side channels (`memory.ts` keeps one `#lastRawOutput`), and `answer` itself
writes them several times per call — `#recordOutcome` on a retry, once per sample under
self-consistency, and once more when the vote is replaced. Under concurrency the slot belongs to
whichever call wrote it **last**, so question A's artifact record can carry question B's prompt.
Nothing throws, nothing looks wrong, and the artifact is silently mislabelled.

This is the precise reason the gain is not free, and it is worth being unambiguous about the shape
of the repair: the accessors have to become the call's **return value** — an optional
`answerWithTrace` returning `{answer, raw, prompt, retrieved, ...}` — after which the side channels
can be deleted rather than kept in parallel. A guard, a lock or a "read it immediately after the
await" convention does not work: `await` resumes the interleaved call at an arbitrary point, and the
convention is exactly the kind of invariant this repository has decided it will not rely on.

**Priority.** This is a research-throughput change, not a product change: it does not move a single
number in the artifact. It is therefore P2 behind the product axis, and it needs its own round
because the equality proof is the hard part — the acceptance criterion is byte-identical per-question
answers for the same configuration at concurrency 1 and concurrency c, on a 60-question arm, which
costs about ten minutes and is the only evidence that would justify changing the default.

## 4. What the literature says, and what it changed

Two findings from outside were load-bearing rather than decorative.

**A timeout is a scoring policy, not reliability plumbing.** A constructed example with exact
arithmetic: 311 items, 124 answerable correctly given unlimited time; scoring timeouts as failures
gives 0.30868 at a 60-second threshold, 0.35370 at 120, 0.38264 at 180 and 0.39871 unbounded — **the
timeout knob alone spans nine points of measured capability**, more than most model-to-model
differences under test. The three policies (scored-as-failure, excluded-from-denominator,
retried-and-scored-late) estimate different quantities, and the exclusion policy can *flatter* a slow
model because it drops its incorrect slow attempts along with its correct ones.

Applied here: `BenchmarkBudgetExceeded` is **fail-loud**, and `attachPartial` guarantees a partial
result reports no delta. That is the right policy and it was already right — but the audit surfaced
that the policy was unreachable, because the job killed the run before the policy could apply. A
scoring policy that cannot execute is not a policy; it is a comment.

**Aggregation order is part of the measurement.** Summing per-item scores in completion order rather
than a canonical order produces last-digit differences that propagate through tie-breaking. This is
pre-registered for the concurrency work above: answers are placed by question index, never by
completion order, and the twin-run digest is the instrument. It is the same rule that makes
`commonPrefixByPass` compare bytes rather than hashes.

## 5. What this round did not fix

- **The dataset is not pinned by content.** The workflow downloads
  `longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json`, which is a **mutable** pointer, and
  nothing verifies the bytes. Haki's harness checks a sha256 before every run and refuses a
  different file; this one would silently measure a different population under the same name. The
  repair is a `datasetFingerprint` in the artifact (so two artifacts can prove comparability without
  anyone having recorded a hash in advance) plus an optional pinned digest that refuses a mismatch.
  Not done here because the file is not present in this environment, so no real digest could be
  recorded — writing one from guesswork is the failure this repository keeps refusing.
- **Concurrency.** §3.
- **Repeat artifacts are not cached.** lm-evaluation-harness keeps responses in SQLite and a crashed
  run resumes without recomputing; this harness re-asks all 4000 questions every time. Deliberate,
  and it should stay deliberate: a response cache at `temperature: 0` would make the second
  repetition free **and** make the artifact unable to distinguish a deterministic reader from a
  replay — which is the question the four repetitions exist to answer (run `40722772896`: totals
  407 / 414.5 / 414.5 / 423). Caching is therefore a change to what the arm measures, not a
  performance tweak, and it would need a registration rather than a commit.

## 6. One-line version

A four-hour run is the provider's arithmetic, not a defect: 4000 sequential calls at 5 s each. The
defect is that the only ceiling guarding it permitted 2.06 times the job containing it, so the run
that finally ran long would have died silently — and the repair had to change the unit rather than
the number, because the number that binds sits below what a working pass already costs.
