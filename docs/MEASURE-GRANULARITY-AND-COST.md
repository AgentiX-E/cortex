# MEASURE — Granularity and Cost, on 500 Real Questions

## 0. One paragraph

LongMemEval's paper names "session decomposition for value granularity" as the first of its three optimisations
and reports up to +9.4 recall@5. This repository spent its budget in turns but **allocated in whole sessions**,
so a session larger than the budget was dropped. The arm that trims inside the session instead reads
`recall@k 8.0% → 76.2%` and `mrr 0.080 → 0.758` at **the same ~2.7k tokens** — a 68-point improvement from one
rule change at identical cost. The same run produced the more uncomfortable number: the unbounded rows read
94.0% and 93.6% at **~33k tokens**, ten times what the published systems spend, so every earlier comparison in
this repository was between numbers of different sizes.

## 1. The design being tested

Two allocation rules over the same admission and the same relevance signal:

| arm   | function                  | rule                                                              |
| ----- | ------------------------- | ----------------------------------------------------------------- |
| whole | `selectSessionBudget`     | a session is admitted whole or not at all                         |
| trim  | `selectTurnsWithinBudget` | a session that does not fit is trimmed to its most relevant turns |

Everything else is identical: same `admitSessions`, same `lexicalRelevance`, same hit ordering, same corpus,
same top-k. That is what makes the two rows an ablation rather than two systems.

## 2. The reading: 500 questions, top-10, retrieval only

```
provider            build  recall@k  all-gold  mrr     found     ~tok
lexical-reference   none   93.6%     81.0%     0.781   468/500   34277
cortex-session      none   94.0%     82.2%     0.818   470/500   33089
cortex/whole-8t     none    8.0%      6.6%     0.080    40/500    2709
cortex/trim-8t      none   76.2%      6.2%     0.758   381/500    2739
cortex/trim-2.8k    none   80.8%     12.4%     0.782   404/500    2799
cortex/trim-4.4k    none   83.8%     22.6%     0.794   419/500    4400
cortex/trim-6.8k    none   87.4%     36.8%     0.806   437/500    6802
null-floor          none    0.0%      0.0%     0.000     0/500       0
```

`~tok` is `meanContextChars / 4`. The conversion is stated rather than assumed, because the vendor figures
below are tokenizer-measured and ours is not.

### 2.1 The granularity result

`whole-8t` and `trim-8t` receive the same budget, and they spend almost the same amount of text (2,709 vs 2,739
tokens). They differ in one rule. The result:

| metric   | whole-8t | trim-8t | Δ           |
| -------- | -------- | ------- | ----------- |
| recall@k | 8.0%     | 76.2%   | **+68.2pp** |
| MRR      | 0.080    | 0.758   | **×9.5**    |
| all-gold | 6.6%     | 6.2%    | **−0.4pp**  |
| ~tokens  | 2,709    | 2,739   | +1.1%       |

The gap is not "trim spends more". It is **the same budget covering more**: whole-session admission cannot fit a
ten-turn session into an eight-turn budget, so it skips every session and its fallback returns exactly one —
which is why its recall is 8.0%, and why that 8.0% is spent on one conversation.

**And `all-gold` moves the other way**, by 0.4 points. That is not noise to be waved away: a trimmed session
holds 8 turns where a whole session holds 10, so for a question whose gold is entirely inside one session, the
whole rule's fallback can cover all of it while the trim covers 8 of 10. The two metrics are answering
different questions, and this is the one place where the granularity change costs something. It is stated
because a future round that only watches `recall@k` would never see it.

### 2.2 The cost result

The unbounded rows are ten times more expensive than the published systems:

| system                        | metric   | value | context           |
| ----------------------------- | -------- | ----- | ----------------- |
| Cortex (unbounded)            | recall@k | 94.0% | **33,089 tokens** |
| lexical reference (unbounded) | recall@k | 93.6% | **34,277 tokens** |
| Cortex (trim, 6.8k)           | recall@k | 87.4% | 6,802 tokens      |
| Cortex (trim, 2.8k)           | recall@k | 80.8% | 2,799 tokens      |

So `94.0% vs 93.6%` — the parity reported last round — was measured at 33k tokens, and the vendors report
91.6% / 90.2% / 93.4% at 2,807 / 4,408 / 6,787. Subtracting across those is the mistake `comparability()`
exists to prevent, and it took putting the cost in the table to see that the two sides were never on one axis.

**The honest statement is therefore a curve, not a point**: at 2.8k tokens Cortex's retrieval reaches 80.8% of
gold evidence; at 4.4k, 83.8%; at 6.8k, 87.4%. Diminishing, and each step is measured on the same 500 questions.

### 2.3 Per capability, at three budgets

| capability | none (33k) | 6.8k    | 4.4k    | 2.8k    | whole-8t (2.7k) |
| ---------- | ---------- | ------- | ------- | ------- | --------------- |
| ABS        | 28/30      | 24/30   | 23/30   | 22/30   | 2/30            |
| IE         | 133/150    | 123/150 | 119/150 | 116/150 | 33/150          |
| KU         | 72/72      | 71/72   | 71/72   | 71/72   | 0/72            |
| MR         | 117/121    | 105/121 | 98/121  | 94/121  | 2/121           |
| TR         | 120/127    | 114/127 | 108/127 | 101/127 | 3/127           |

Two things worth reading off this table.

**KU is nearly free.** 71/72 at 2.8k against 72/72 unbounded: a knowledge-update question needs the new value,
which lives in one session, so a tight budget barely touches it. That is also why the end-to-end KU reading
(86.8%) already clears its aim while MR and TR do not.

**MR and TR are where the budget bites.** MR loses 23 questions between 33k and 2.8k, TR 19. Both are the
capabilities whose gold spans more than one session, and `all-gold 12.4%` at 2.8k says the same thing in one
number: the budget buys about one session, and these questions need two or three.

## 3. What this changes about the target

The published systems are at 90–93% **answer accuracy** with 2.8k–6.8k tokens. We now have **evidence recall**
80.8–87.4% at the same costs. Those are different metrics — recall is an upper bound on what a reader can
answer, not the answer rate — so the gap between them is not a 5-point deficit, it is an unmeasured distance.

The next experiment is therefore fixed and it is not another retrieval tweak: **put a reader on the 2.8k
context and measure answer accuracy**. Until that number exists, no comparison with Contextier or Mem0 can be
made at all, and the retrieval curve above is the only honest claim available.

## 4. What was built

| file                                         | change                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `cortex-memory/src/sessionize.ts`            | `selectTurnsWithinBudget` — the turn arm, with `spent`/`trimmed`/`dropped` reported   |
| `cortex-memory/src/provider.ts`              | `budgetUnit: 'turns' \| 'chars'`, `trim`, `label`; the arm read in one private method |
| `cortex-eval/src/harness.ts`                 | `ProviderScore.meanContextChars` — cost is now a column                               |
| `tools/competitor-harness.mjs`               | four arms × one corpus; `--budget-tokens`; `~tok` column                              |
| `.github/workflows/competitor-retrieval.yml` | budget sweep at 2.8k / 4.4k / 6.8k                                                    |

Coverage: `sessionize.ts` and `provider.ts` both 100% on statements, branches, functions and lines. 560 memory
tests, 11 harness tests, `pnpm check` exit 0.

## 5. Limitations, including one this round created

1. **`all-gold` regresses by 0.4pp on the trim arm.** Stated in §2.1 and not hidden: a trimmed session covers
   fewer turns than a whole one, so the "all evidence in one session" case can lose.
2. **The token column is an estimate.** `chars / 4` is not `o200k`. A vendor comparison at the same nominal
   budget is a B-grade comparison under `comparability()`, not A.
3. **No reader, so no answer accuracy.** See §3. This is the binding limitation and the next step.
4. **The 8-turn rows are not a budget the product uses.** They exist because they are one session's worth, which
   is the state that makes the granularity difference visible.
5. **`asOf` is still inert** — `sessionsOf` gives every session the question's date, so no temporal filtering is
   possible on this path. Unchanged from the previous round and still the first thing TR needs.
