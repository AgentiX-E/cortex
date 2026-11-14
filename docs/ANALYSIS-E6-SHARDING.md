# Splitting E6's population across jobs: why width did nothing, and what the split actually buys

**Answer first**: a wider pool does not move the wall clock on this arm, and the reason is not CPU.
`CORTEX_LLM_MIN_INTERVAL_MS=6000` is enforced by `sharedRequestGate`, which is **one schedule per
process** — so every reader call in a job waits six seconds after the previous one regardless of how
many workers are in flight. Two dispatches of the same 144-question population, one at 4 workers and
one at 32, took **7784 s and 7819 s**: eight times the width bought a 0.45 % *slowdown*. Both are
`calls x 6 s` to within 0.4 %.

That makes the split the right lever and changes why it is right: sixteen jobs are sixteen
**processes**, so sixteen gates, so the six-second gap is paid sixteen times in parallel rather than
once. It is not a core-count argument. The measurement below is what turned the previous round's
"the time is CPU" into a wrong answer, and the earlier round's "one job cannot hold it" into a right
conclusion reached for the wrong reason.

---

## 1. The two dispatches, side by side

Same workflow, same population (`CORTEX_WINDOWS=2`, `capability=KU`, 72 corpora, 144 questions), same
two repetitions, same reader, same 6 s pace. The only input that differs is `workers`.

| | run `43590434060` | run `43609290786` |
| --- | --- | --- |
| `workers` | 4 | 32 |
| `Run the two-window carry pair` | **7784 s** (2 h 09 m 44 s) | **7819 s** (2 h 10 m 19 s) |
| `transportRetry.calls` | 1293 | 1298 |
| `transportRetry.retried` | 0 | 0 |
| `transportRetry.rateLimited` | 0 | 0 |
| `promptTokens` | 6,209,756 | 6,206,487 |
| cache-hit share | 95.6 % | 95.8 % |
| `passShape.minIntervalMs` | 6000 | 6000 |
| `calls x 6 s` | 7758 s | 7788 s |
| **unexplained by the pace** | **26 s** | **31 s** |
| `semanticCarry.matched` | 8 | 9 |
| `ablation.delta` | −0.0035 | −0.0104 |

Per call: **6.019 s** and **6.023 s**. The two agree to four thousandths of a second, and both sit
0.3 % above the configured floor. So the wall clock of this arm is `calls x minIntervalMs` plus
setup, and nothing else in the run is on the critical path.

## 2. Where the six seconds come from

`packages/cortex-ai/src/pacing.ts`'s `sharedRequestGate` is memoised per interval: two adapters built
by two factories share one schedule, which is the property that makes a retry and its original
request stay inside one budget. The consequence is that the pace is **per process**, not per worker
and not per connection. `packages/cortex-eval/src/reader-transport.ts:312` prints the value on the
configuration line, and `passShape.minIntervalMs` carries it onto the artifact — which is how the two
runs above can be compared at all.

`rateLimited: 0` on both runs is the other half of the reading: 2,591 calls across two dispatches and
not one 429. The 6 s floor is therefore **not** being tested by this arm's load; it is a value chosen
for safety and never lowered. That is a lever, and §6 prices it, but it is not the lever this round
pulls — a pace change needs its own measurement, because the failure mode it risks (a 429 storm
turning a two-hour run into a two-hour run with forty retries) is exactly what the floor exists to
prevent.

## 3. Three layers of parallelism, and which one this needs

| layer | mechanism | what it parallelises | needs a merge | state before this round |
| --- | --- | --- | --- | --- |
| 1 | `Promise.all` over N workers in one process | **waiting** — time spent blocked on a response | no | present, and useless here: the gate serialises the starts |
| 2 | N child processes in one job, merged in-process | CPU | yes, in-job | absent |
| 3 | N jobs in a matrix, merged after | CPU **and** the per-process pace | yes, across artifacts | absent, and now built |

Layer 3 is the only one that buys anything on this arm, and it buys it through the pace rather than
through cores. 16 jobs means 16 `sharedRequestGate` instances, so 16 six-second gaps run concurrently.

## 4. The split is by corpus, and it has to be

`Question.corpus` is a contract: a corpus's windows are contiguous in the dataset, answered by **one
instance on one store**, and `benchmark.ts`'s `claimRun` claims a whole corpus atomically. A split
taken after `withWindows` would put `#w1` in one job and `#w2` in another — the first window would
absorb an update into a store the second never reads, and the reach would be zero for a reason that
has nothing to do with the semantic layer. That is the same defect class the population itself was
built to avoid, one layer out.

So `shard.ts` cuts the **corpus population** and the selector order is
`limit` → `capability` → `shard` → `windows`:

| selector | question it answers | must see |
| --- | --- | --- |
| `limit` | how many | the file |
| `CORTEX_CAPABILITY` | which | the sampled corpora |
| `CORTEX_SHARD` / `CORTEX_SHARDS` | which part of the dispatch | the selected corpora |
| `CORTEX_WINDOWS` | how many times each is asked | one shard's corpora |

`shardDataset` refuses a dataset that already carries `corpus`, so the wrong order fails at the
harness rather than producing sixteen artifacts whose second windows read stores that never absorbed
anything.

## 5. Reading the parts back as one population

Sixteen artifacts are not a population. `tools/merge-ablation.mjs` concatenates the per-question
vectors in shard order and sums the censuses, and it refuses the three defects that each produce a
plausible-looking document:

1. **Different layers** — a shard whose `passShape`, `memoryArmConfig`, `featureConfig`,
   `datasetFingerprint` or `runs` differs was not the same dispatch.
2. **A missing shard** — fifteen of sixteen is a population with a hole, quoted with the full
   denominator. The missing indices are named.
3. **Overlapping shards** — the same question counted twice. Two jobs given one index and a
   duplicated download are the same document.

What it does **not** do is recompute `ablation.delta`, the p-values, the intervals or
`perCapability`. Those are `runAblation`'s and it answers questions rather than summarising verdicts;
a second implementation here would agree with the first until one of them was edited. They are named
in `merged.notRecomputed` with that reason, and the rows are read off the vectors:
`semantic_carry_analysis.py` needs `featureCorrectByRun`, `baselineCorrectByRun`, the ids and the
census, all of which the merged document carries. What the merge *does* publish is
`merged.readings` — per-repetition accuracy for each side and their mean difference — labelled so it
cannot be mistaken for the arm's paired statistic.

The delta is taken from the questions, not from sixteen shard-level deltas. The test that pins this
uses unequal shards on purpose: 2 corpora with one wrong (−0.25) and 4 corpora with one wrong
(−0.125). Averaging the two per-shard deltas gives −0.1875; the difference over the merged questions
is −0.1667. Equal shards could not have shown the difference, and an implementation that averaged
would pass a suite written with equal ones.

## 6. Sixteen first, twelve second

The registered population is 500 corpora × 2 windows = 1,000 questions × 4 repetitions × 2 sides =
8,000 question-runs, and 2.24 calls per question-run, so **17,900 calls**.

| shards | calls per job | at 6 s | at 2 s | notes |
| ---: | ---: | ---: | ---: | --- |
| 1 | 17,900 | 29.8 h | 9.9 h | what the width alone gives — does not fit |
| 4 | 4,475 | 7.5 h | 2.5 h | fine only if the pace is lowered |
| 8 | 2,238 | 3.7 h | 1.2 h | 3.7 h is at the job ceiling |
| **16** | **1,119** | **1.9 h** | **37 m** | first attempt |
| 12 | 1,492 | 2.5 h | 50 m | second attempt, fewer concurrent jobs |
| 32 | 559 | 56 m | 19 m | more concurrency against one provider |

At the measured 6 s pace, **16 shards is 1 h 52 m of reader time per job** plus setup — inside the
200-minute ceiling the workflow now sets, with margin for a slow job. Twelve is 2 h 29 m: also
inside, at 75 % of the ceiling rather than 56 %. The reason to try 16 first is not speed; it is that
16 keeps every job under an hour and fifty minutes, so a single slow shard does not approach the
timeout that would fail the whole merge.

Sixteen concurrent jobs against one provider is the untested quantity. Each holds its own 6 s gate,
so the aggregate start rate rises from 1 per 6 s to 16 per 6 s — still far below what 2,591 clean
calls suggest the provider tolerates, but the observation is indirect and `fail-fast: false` means a
widespread 429 costs sixteen artifacts rather than one. `shards` is an input for exactly this reason:
if 16 draws a 429 storm, the repair is a dispatch with 12, not a commit.

## 7. What the spend gate does now, and what it deliberately does not

Every shard runs the gate and every shard prints the **whole dispatch's** projection (28.53 CNY off
the archived baseline). That is deliberate: the split divides the work, not the bill, and a per-shard
fraction would let sixteen jobs each pass a ceiling the dispatch as a whole fails. `budget_cny`
therefore means the dispatch, and its description says so.

## 8. The mutation table

Twenty mutations across the split, the wiring and the merge; nineteen killed.

| # | mutation | outcome |
| ---: | --- | --- |
| 1 | partition inverted (`% shards === shard` → `!==`) | killed |
| 2 | index one past the end allowed | killed |
| 3 | `shards === 1` returns a copy instead of the argument | killed |
| 4 | a multiplied population accepted by the cut | killed |
| 5 | an empty shard allowed | killed |
| 6 | index and count both optional | killed |
| 7 | a shard count of zero allowed | killed |
| 8 | the reader accepts a non-digit | **equivalent** — see below |
| 9 | a negative index allowed | killed |
| 10 | a count with no index accepted | killed |
| 11 | the Markdown drops the word `SHARD` | killed |
| 12 | the population recorded only when multiplied | killed |
| 13 | the slice never applied | killed |
| 14 | the oracle annotated before the cut | killed |
| 15 | overlapping shards allowed | killed |
| 16 | a missing shard allowed | killed |
| 17 | layers not compared | killed |
| 18 | per-shard vector alignment not checked | killed |
| 19 | the census overwritten rather than summed | killed |
| 20 | a duplicated question not detected | killed |

**#8 is an equivalent mutation, not a gap.** Changing `readWhole`'s `^\d+$` to `^\d*$` admits only
the empty string, and `readShardPartition` has already returned or thrown on an empty value before
`readWhole` is reached — the two variables need different messages, which is why the early return
exists. A behavioural test cannot distinguish the two readers because the inputs on which they differ
cannot reach the function. The two mutations that first looked equivalent and were **not** (#9, #10)
were real gaps and were closed: `shardDataset` had no negative-index test, and the "count alone"
assertion matched `CORTEX_SHARD\b`, which the wrong message also satisfies.

## 9. What this does not claim

1. **That 16 shards will finish the registered dispatch inside the ceiling.** It claims 1 h 52 m of
   reader time per job at the measured pace, and that the ceiling is 200 minutes. The first shard to
   exceed it is the measurement that refutes this.
2. **That the pace can be lowered safely.** `rateLimited: 0` over 2,591 calls is evidence that 6 s is
   conservative, not evidence that 2 s is safe. Lowering it is a separate dispatch with its own
   readback.
3. **That the merged delta equals what a single 500-corpus run would have produced.** The merge
   reproduces the population and the pairing; it does not reproduce a single job's cache state,
   worker count or ordering. `merged.parts` records what it was made of so the two can be compared.
4. **That 16 concurrent jobs cannot draw a 429 storm.** Untested, and the reason `shards` is an
   input rather than a constant.
