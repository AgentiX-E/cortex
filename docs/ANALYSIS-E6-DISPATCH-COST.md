# What E6's registered dispatch costs, and whether one job can hold it

**Answer first**: one job can hold it, and my previous sentence — "16,000 calls, one job does not
fit" — was wrong in the only way that matters. It treated the worker count as fixed and the wall
clock as the consequence, when the worker count is an **input** and the wall clock is what it moves.
`workers=32` puts the registered dispatch at **1.2–3.8 hours**, inside both ceilings this workflow
carries (330 minutes of job timeout, 300 of in-run budget). The bill is **25–96 CNY** across the
cache mixes, and the gate now prints **28.53 CNY** off the archived baseline.

The rest of this document is the arithmetic, the three layers of parallelism that are actually
available, and the five levers in the order they should be pulled.

---

## 1. The parallelism question, answered against the code rather than against the ceiling

### 1.1 What a job actually is

A GitHub Actions **job** is one runner VM. Its **steps** run in sequence, and that is the part
everyone remembers. The part that gets forgotten is that a step is an arbitrary process supervisor:
it can fork as many processes and threads as the box will hold.

This repository already runs a pool inside one step. `packages/cortex-eval/src/benchmark.ts:1157`:

```ts
await Promise.all(Array.from({ length: workers }, (_, worker) => runWorker(worker)));
```

`workers` comes from the `workers` input of `semantic-carry.yml` and from
`vars.CORTEX_MEMORY_WORKERS` in `benchmark-cortex-memory.yml`. So "one job" has never meant "one
thread": the carry run that produced `8` ran **four** workers in one job already, and the input's own
description says what it is for — *"Questions in flight. A corpus is answered by one instance at any
width (`Question.corpus`), so this moves the wall clock and not the treatment."* The code has said
this since the input was added. My previous sentence contradicted a field in the workflow.

### 1.2 The three layers, and what each one is good for

| layer | mechanism | what it parallelises | what it does not | exists today |
| --- | --- | --- | --- | --- |
| 1. in-job async workers | `Promise.all` over `runWorker` | the **waiting**: reader and judge calls in flight, `workers` at a time | CPU work in the same process — one Node event loop, one core | yes, `workers` input |
| 2. in-job multiple processes | `node … --shard i/N &` × N, each writing its own partial artifact, merged in a final step | **CPU** as well, up to the runner's cores | nothing about provider rate limits | no |
| 3. cross-job matrix | `strategy.matrix.shard: [0..N-1]`, plus a final job that downloads every shard artifact | CPU **and** wall clock across boxes | needs a merge step, and each job re-pays setup (~40 s) | no |

Only layer 1 is free, and it is the layer that matters, because this workload is **not** CPU-bound.
The evidence is in the artifacts: the carry run spent 7,784 s on 1,293 calls, and
`transportRetry.retried` is `0` with `rateLimited: 0` — the time is one call at a time per worker,
waiting on the provider, not computing.

### 1.3 So what *is* the constraint

| constraint | value | is it binding for E6? |
| --- | --- | --- |
| job wall clock | **330 min** (set in `semantic-carry.yml`) against GitHub's 360 | yes, and it is the only hard one |
| workers | an input, `1..questions` | no — it is the lever |
| `minIntervalMs` | **6000** per worker, recorded in `passShape` | yes, when a call is faster than 6 s |
| provider rate limit | unknown, not hit yet (`rateLimited: 0`) | becomes binding before anything else breaks |
| runner cores | 4 on `ubuntu-latest` | only for layer 2 |
| budget | `DEFAULT_BUDGET_CNY = 3.0` in the dispatcher | **no** — and that is the interesting finding in §3 |

### 1.4 What sharding would actually buy

A matrix shard does not make the run cheaper or faster than raising `workers`, because the provider
is the bottleneck and it sees the same total call rate either way. What it buys is **failure
isolation**: 4 shards of ~2,000 question-runs each means a 429 at hour three costs a quarter of the
run, not all of it.

It also has a real cost that must be paid before it can be used: **there is no merge tool**. Nothing
in `tools/` combines two ablation reports into one population, and the pairing (McNemar on
discordant questions, `deltaQuestions` over the second window) is computed per artifact. A shard
scheme therefore starts with a new tool — `tools/merge-ablation.mjs` — that refuses to merge unless
each shard's `passShape`, `memoryArmConfig` and `population` are byte-identical and the question ids
are disjoint. That is a round of work, not a flag.

---

## 2. What E6's registered population actually is

`S12` is registered on **500 corpora asked twice over one store, four repetitions, carry on against
off, paired on the second window**. `CORTEX_MEMORY_AB=carry` builds both sides from one constructor,
so a dispatch is:

| quantity | arithmetic | value |
| --- | --- | ---: |
| questions | 500 corpora × 2 windows | 1,000 |
| question-runs, one side | 1,000 × 4 repetitions | 4,000 |
| question-runs, both sides | × 2 | **8,000** |
| calls, both sides | × 2.24 calls per question-run (measured, §3.1) | **17,900** |

The `2.24` is not a model. It is `llmUsage.calls / (questions × runs × sides)` on the carry artifact:
`1,293 / 576`.

---

## 3. The bill

Prices are the dated constant this repository already carries
(`tools/spend-projection.mjs`: `deepseek-chat`, 2026-11-09) — **0.2 CNY/M cached input, 2 CNY/M
uncached input, 3 CNY/M output**.

### 3.1 Measured on the screening run, which is the honest unit

Run `43590434060`, 144 questions, 2 repetitions, 2 sides = **576 question-runs**, and it was
**billed**:

| field | value | per question-run |
| --- | ---: | ---: |
| calls | 1,293 | 2.24 |
| prompt tokens | 6,209,756 | 10,781 |
| of which cache hits | 5,939,152 (**95.6%**) | — |
| completion tokens | 34,123 | 59.2 |
| **cost** | **1.83 CNY** | 0.0032 |

That is the whole screening run: 1.83 CNY. It is not comparable to the 2.85 CNY the earlier
screening dispatch (`43465626013`) cost, and the difference is the window rather than the population:
that run was 200 questions at the registered 48,000-character cap, this one is 144 questions at
~22,400 characters (`promptChars` 22,462 on `0ddfec37#w2`). Twice the questions and half the prompt
per question is roughly the same bill.

### 3.2 Scaled to the registered population, under three cache assumptions

The cache-hit share is the only input I cannot derive, because it is a property of how much prompt
prefix repeats across questions — and the two-window population changes it in **both** directions:
repetition 1 is always cold (more questions = more cold), while windows 1 and 2 of one corpus share
the whole evidence block (more sharing). So it is given as a band rather than a point.

| cache-hit share | cached input | uncached input | output | **total** |
| --- | ---: | ---: | ---: | ---: |
| 96% (as measured) | 82.8M → 16.56 | 3.45M → 6.90 | 0.47M → 1.42 | **24.9 CNY** |
| 75% | 64.7M → 12.94 | 21.6M → 43.10 | 0.47M → 1.42 | **57.5 CNY** |
| 50% | 43.1M → 8.62 | 43.1M → 86.20 | 0.47M → 1.42 | **96.3 CNY** |

### 3.3 A second anchor, computed a different way

`tools/spend-baseline.json` records run `42467`: 500 questions, 4 repetitions, both sides, single
window, **14.26 CNY**. The registered population is that population asked twice, and the second
window is another full prompt per corpus, so `2 × 14.26 = **28.5 CNY**`.

It lands inside the band from §3.2 (between the optimistic and the 75% case), from a different
artifact, a different configuration and different questions. Two anchors agreeing to within a factor
of two on a figure of this size is as much as this data supports.

**The bill is not the constraint.** `DEFAULT_BUDGET_CNY = 3.0` in `tools/dispatch-cortex-memory-ab.py`
would refuse this dispatch by default — and that gate is doing exactly what it was written for
("the line between a run that answers a question about a change and a run that publishes a point
estimate"), but `semantic-carry.yml` is a separate workflow that does not go through that gate at
all. If E6 is expected to cost ~30–60 CNY, **the gate should be taught to price it** rather than
bypassed with `--no-budget`.

---

## 4. The wall clock, which is the constraint

Time per dispatch ≈ `(calls / workers) × max(perCall, minIntervalMs)`, because each worker is one
sequential chain and cannot make its next call sooner than 6 s after the previous one.

Two measured `perCall` values bracket the answer:

- **24.1 s** — carry run: 7,784 s × 4 workers / 1,293 calls.
- **7.7 s** — inferred for `42522552589` (500 questions × 4 repetitions, 5,337 s): if that run used 8
  workers, `5,337 / (5,570 / 8) = 7.7 s` per call.

| workers | wall clock at 24.1 s/call | wall clock at 7.7 s/call | inside 300 min in-run budget? |
| ---: | ---: | ---: | --- |
| 4 | 30.1 h | 9.6 h | no |
| 8 | 15.0 h | 4.8 h | no |
| 16 | 7.5 h | 2.4 h | no |
| 24 | 5.0 h | 1.6 h | pessimistic case sits **on** the ceiling |
| **32** | **3.8 h** | **1.2 h** | **yes, both** |

So `workers=24` is the smallest round number that clears the **job timeout** under the pessimistic
per-call rate — and it is not enough, because the job carries a second ceiling: `CORTEX_MEMORY_
BUDGET_MINUTES: '300'` is checked inside the run, so a 5.0 h pass would be cut off with a partial
artifact that reads as a hang. `32` puts the worst case at 3.8 h, forty minutes clear of it, and is
the width the workflow now defaults to.

Two honest caveats. The 24.1 s figure is from a population whose evidence is ~10× the registered
one per corpus (493 K characters against 47.5 K), so it is an **upper** bound on per-call time for
E6 — the real number is probably between the two columns. And `minIntervalMs = 6000` is itself a
ceiling on throughput: at 24 workers it allows at most 4 calls/s, and nothing in this repository
has measured what the provider will accept.

---

## 5. The five levers, in the order they should be pulled

| # | lever | effect | cost / risk | verdict |
| ---: | --- | --- | --- | --- |
| 1 | `workers: 4 → 32` | 30 h → 3.8 h, or 9.6 h → 1.2 h in the fast regime | none: it is an input, and the pool already builds one instance per worker with byte-identical prompts (`benchmark-concurrency.test.ts`) | **pull it** |
| 2 | `minIntervalMs: 6000 → 2000` | only binds when a call is faster than the interval; at 24 workers this is the ceiling on call rate | 429 risk, and a 429 mid-run is a partial artifact; `rateLimited: 0` today means the limit is unmeasured | measure first, then decide |
| 3 | 4 shards × matrix, 8 workers each | same total time, **failure isolation** (a 429 costs 25% not 100%) | needs `tools/merge-ablation.mjs` + a disjointness/identity guard — a round of work | second round, not this one |
| 4 | fewer repetitions | 4 → 2 halves the bill and the time | **changes the registered population**: `S12` is registered at four, and a two-repetition delta cannot fill that row (§ the reason `S12` is `unrun` today) | **no** |
| 5 | narrower prompt room (48,000 → per-route 24,000) | 0.754× the bill — `34 → ~26 CNY` | −1.05 points, measured (`MEASURE-COST-LEVER.md` §2); on a row whose threshold is 5 questions, that trade is not available | **no** |

Lever 1 alone is the whole answer to "can one job hold it". Levers 4 and 5 are listed to be refused
explicitly, because both would make the run cheap enough to be tempting and neither would produce a
number `S12` can read.

---

## 6. What I would do, and what I need from you

**Recommended**: one dispatch, one job, `workers=32`, `capability=all`, `ablation_runs=4`,
`windows=2`, `limit=0`, with the spend gate taught to price it first (so the projection is in the log
rather than in this document). Expected: **1.2–3.8 hours of wall clock, ~28.5 CNY projected at the
baseline's cache mix**, and the first `paired.deltaQuestions` the row has ever had.

`32` rather than `24` because the workflow carries a second ceiling inside the job —
`CORTEX_MEMORY_BUDGET_MINUTES: '300'` — and 24's pessimistic case is 5.0 h, which lands exactly on
it. The in-run budget would fire before the job timeout and leave a partial artifact, which reads as
a hang rather than as a slow run. 32 puts the worst case at 3.8 h, 40 minutes clear of it.

**Before that, one 10-minute calibration** would remove the biggest unknown: the **same population,
same repetitions, only the width changed** — `capability=KU`, `limit=0`, `windows=2`,
`ablation_runs=2`, `workers=32`. That is the 144-question pair `43590434060` already answered in
7,784 s at four workers, so its duration against that run's is a direct measurement of how the wall
clock moves with width — the only number in §4 that is currently inferred. It costs **2.05 CNY** by
this tool's own projection, and it exercises `workers=32` end to end, so a pool defect at that width
fails on 2 CNY instead of 28.

A `limit=40` calibration was the first plan and is refused by the projection: `limit` and
`capability` together are not projectable, because the sampler round-robins over buckets and the
surviving count is a property of the bucket order. Changing two variables (population *and* width)
would also have made the comparison against `43590434060` unreadable.

**If you would rather not spend the calibration**: go straight to `workers=32` with the full
population and accept the 3.8 h worst case.

### 6.1 What the run would read, as a forecast and not a promise

Useful to have in writing before the dispatch, so the result is graded against something:

| reading | forecast | why |
| --- | --- | --- |
| `semanticCarry.matched` | **~55** | 8 matched questions over 144 is 5.6%; the registered population is 1,000 questions, and the census counts questions |
| `paired.deltaQuestions` | **0 ± 3** | the screening pair read 0.0 with a discordant split of 1/1 over 72; at 1,000 questions the McNemar reach is smaller, not the effect larger |
| matrix outcome | `S13` stays `pass`; `S12` becomes `pass` **or** `fail` | either is a result. `fail` would mean the pair moved by more than 5 questions, which `0.0` on 72 makes unlikely but not impossible |
| cost | 25–96 CNY | §3.2; the tool now prints **28.53 CNY** for this shape off the 42467 baseline |
| wall clock | 1.2–3.8 h at `workers=32` | §4 |

A `fail` here is not a setback. It would be the first measurement that says the carry costs accuracy
at scale, which is exactly what `E6`'s `onMiss` reserves the negative-result path for.

---

The gate that prices this shape now exists: `tools/spend-projection.mjs` grew a `--windows` axis,
`tools/dispatch-semantic-carry.py` grew the projection, and `semantic-carry.yml` grew a step that
refuses an over-budget dispatch before the corpus download. The arithmetic in this document is
reproducible from the repository with the two commands in the changelog of that commit.
