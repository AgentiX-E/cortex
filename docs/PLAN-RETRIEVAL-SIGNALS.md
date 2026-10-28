# PLAN-RETRIEVAL-SIGNALS

Closing the 6–9 point recall gap with signals that are already public, one at a time, each with its own
falsifiable prediction.

## 0. Where the gap is, measured rather than assumed

| arm                            | what it scores                                  | number    |
| ------------------------------ | ----------------------------------------------- | --------- |
| `cortex-session`               | recall@10, 100 stratified LongMemEval questions | **87.0%** |
| `lexical-reference`            | recall@10, same questions                       | **89.0%** |
| agentmemory V4 (self-reported) | **R@5**, same benchmark                         | 95.2%     |
| MemPalace (self-reported)      | R@5, vector-only                                | 96.6%     |

Two cautions before this becomes a target. Their figure is R@5 and ours is @10 — a **harder** recall at a
**larger** k is not a like-for-like pair, and the correct interpretation is "there is room", not "we are 8
points behind". And both their numbers are self-reported on a retrieval-only path with no reader, which is
the same class of claim as our own `0.0%` before §6.1 of `COMPETITOR-REPRODUCTION.md`: quotable only beside
its configuration.

What makes this actionable rather than aspirational is that **the signal list is public**. agentmemory V4
scores six of them:

| signal               | weight       | do we have it                                        |
| -------------------- | ------------ | ---------------------------------------------------- |
| semantic             | 0.30         | yes — `relevance-hybrid`                             |
| activation           | 0.18         | **no**                                               |
| graph                | 0.18         | **no**                                               |
| lexical / BM25       | 0.12         | yes — `relevance-hybrid`                             |
| temporal             | 0.12         | partially — date frame renders, nothing scores on it |
| importance           | 0.10         | **no**                                               |
| cross-encoder rerank | after fusion | **no**                                               |

So the plan is not "invent retrieval". It is: three missing signals, one half-built signal, and one
post-fusion stage, each added alone.

## 1. Why one at a time, and what "alone" has to mean

The repository's own record says why. `entityIdentityClause` was carried for months and measured as a
no-op; `relevanceUnits: session` was registered with six predictions and closed the whole "granularity"
family by failing one of them. Both were cheap because they were single-variable. A six-signal fusion
added in one step would produce a number nobody could attribute — and this project has already thrown away
a 500-question run for exactly that reason (`reviewPass: 'bare'`, whose artifact could not say whether the
pass fired).

So each signal lands as its own increment, and each increment carries:

1. a **weight of zero by default** — the shipped configuration reproduces the current prompt byte for byte;
2. a **census** (hits contributed, questions where it changed the order) that renders in the report;
3. a **prediction with a number in it**, registered before the run.

## 2. Package layout and dependency layers

The dependency direction is fixed and must not invert: `cortex-eval` may depend on `cortex-memory`'s
types only, `cortex-memory` owns the strategy, `cortex-ai` owns model access, `cortex-core` owns nothing
but types.

```
cortex-core/                     (no deps)
  src/relevance.ts               RelevanceSignal union gains the new names; no logic

cortex-ai/                       (deps: cortex-core)
  src/rerank.ts                  NEW  cross-encoder over an OpenAI-compatible /rerank endpoint,
                                      behind the same provider-agnostic interface as the embedder

cortex-memory/                   (deps: cortex-core, cortex-ai)
  src/relevance/                 NEW directory — the fusion point
    index.ts                     score(signals) -> ranked; weights are data, not code
    activation.ts                NEW  recency × access-count, from the storage layer's timestamps
    graph.ts                     NEW  co-occurrence edges between turns in one session, BFS depth 1
    importance.ts                NEW  turn-level salience: entity density, not a model call
    temporal.ts                  NEW  scores a turn by |turn date − question date| bucket
  src/retrieval.ts               unchanged public surface; consumes relevance/index.ts

cortex-eval/                     (deps: cortex-core, type-only on cortex-memory)
  src/relevance-signals.ts       NEW  the ablation table: which weight set produced which recall@k
  src/retrieval-diagnostics.ts   extended with a per-signal contribution census
```

Why `cortex-memory/src/relevance/` rather than spreading the signals through `retrieval.ts`: fusion is one
decision over N inputs, and a reader asking "why did this turn rank third" has to be able to see the N
inputs in one place. The current `relevanceFor` callback stays as the seam — no caller changes.

## 3. The increments, in the order they should run

| #       | signal               | cost                                             | prediction                                          | refuted if                                                            |
| ------- | -------------------- | ------------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------- |
| **S-1** | temporal             | zero — dates are already parsed and rendered     | recall@10 **+3** on TR's 20 questions, ≤1 elsewhere | TR moves <2 of 20                                                     |
| **S-2** | activation           | zero — `lastAccessedAt` and `createdAt` exist    | +2 overall; **must not** move ABS                   | ABS moves at all                                                      |
| **S-3** | graph                | one pass over already-admitted turns             | MR +3 of 20 (the cross-session population)          | MR <2 of 20                                                           |
| **S-4** | importance           | zero — entity density is a token count           | +1, or nothing                                      | it moves nothing, and is then **removed**                             |
| **S-5** | cross-encoder rerank | 1 HTTP call per question, top-50 in → top-10 out | +2 overall at equal recall                          | recall drops while accuracy rises, which means it is re-ranking noise |

S-1 first because it is the only one where the information is already in the prompt and only the _ordering_
is missing — the cheapest possible experiment with a real mechanism behind it. S-5 last because it is the
only one with a per-question cost, and the cost has to be justified by the four ahead of it.

## 4. Acceptance, per increment and for the family

Every row is a criterion in `docs/ACCEPTANCE-MATRIX.md`, not a wish in this file.

| level          | what must hold                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **unit**       | 100% statements on the new module; the fusion function's weight table is data, so a zero weight is asserted to reproduce the previous ranking exactly                                                  |
| **controlled** | the ablation table (`assumption-ablation.ts` style) shows the signal moves **only** its targeted capability families                                                                                   |
| **artifact**   | the per-signal census appears in the report and is non-zero when the weight is non-zero — the `attempted: 0` rule, applied to retrieval                                                                |
| **end to end** | 100-question recall@10 ≥ **93%** on `cortex-session`, no capability below its current value, and the 500-question arm's S1 ≥ **81.0%** (a regression here reverts the signal, however good the recall) |

The last clause is the one that matters. **Recall is a means.** A signal that raises recall@10 by 4 points
and leaves S1 flat has spent complexity for a number that the reader does not use — and the only defence
against accumulating such signals is to write down, in advance, that they would be removed.

## 5. What this plan deliberately does not do

- **It does not copy agentmemory's weights.** Their 0.30/0.18/0.18/0.12/0.12/0.10 were tuned on their
  pipeline against their reader. Copying weights across architectures is copying a fitted parameter, which
  is the same error as comparing scores across readers.
- **It does not touch the reader.** Reader is its own axis (`docs/SOTA-LANDSCAPE.md` §8.2) with a 10.6-point
  measured effect; mixing it into a retrieval increment would destroy attribution for both.
- **It does not target R@5 parity with a self-reported number.** The target is our own recall@10, because we
  can re-measure it and they cannot hand us their harness.

## 6. First action

S-1, because it needs no new data: `temporal.ts` scores an admitted turn by the distance between its date
and the question's, the weight ships at zero, and the ablation run is one dispatch against
`39509698041`. Its census reports how many questions changed order, so a zero effect is diagnosable as
"never fired" rather than assumed to be "fired and did nothing" — the distinction this repository has now
paid for twice.
