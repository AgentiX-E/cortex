# MEASURE — Retrieval on LongMemEval-S, and the Two Defects the Real Corpus Found

## 0. One paragraph

The competition harness could only run on a corpus this repository generates. Adding `--data` let it meet
LongMemEval-S, where the gold is **annotated** (`answer_session_ids` → `Question.goldTurns`) rather than derived
from the answer text. The first run read `recall@k 25.4%` for Cortex's adapter against `93.6%` for a lexical
reference — and that number was not a product result, it was a unit error in the adapter. After the repair, on
500 questions, the adapter reads `94.0% / 82.2% / 0.818` against the reference's `93.6% / 81.0% / 0.781`: level,
not ahead. The same run produced a second finding that matters more than the ranking — a **turn-denominated
session budget costs 86 points**, because a ten-turn session cannot fit an eight-turn prompt.

## 1. Why a real corpus was necessary, in one measurement

|                               | synthetic                                  | LongMemEval-S                    |
| ----------------------------- | ------------------------------------------ | -------------------------------- |
| gold                          | derived from the answer text               | annotated (`answer_session_ids`) |
| turns per session             | 1                                          | ~10                              |
| questions                     | 40                                         | 500                              |
| can separate lexical systems? | no (the gold scores `1.0` by construction) | yes                              |

The second row is the one that found a bug. Everything below follows from it.

## 2. Reading one: the adapter compared hits to turns

`CortexSessionProvider.search` computed

```ts
const ceiling = Math.min(this.#budget, options.limit);
const selected = selectSessionBudget(admitted, ceiling, relevance);
```

`options.limit` is the harness's **top-k on hits**. `selectSessionBudget`'s second parameter is a **count of
turns**. With one turn per synthetic session the two numbers coincide and the error cannot appear. On
LongMemEval-S a session carries about ten turns, so:

- `limit: 10` → `ceiling = 10 turns` → **one** session admitted per question;
- a question whose gold spans two or three sessions could then never be fully covered.

Measured, 500 questions, top-10:

```
provider            build   recall@k  all-gold  mrr
lexical-reference   none    93.6%     81.0%     0.781
cortex-session      none    25.4%      8.4%     0.254
```

The all-gold figure is the diagnosis: 8.4% is roughly "one session in ten happened to contain everything",
which is what admitting exactly one session produces.

**Why the first table could not show it.** The synthetic generator writes one turn per session, so
`min(budget, limit)` and `limit` are the same number on every question. A test that used a one-turn session
could not distinguish the units either — which is why the two tests added with the fix both use **six-turn**
sessions, and why restoring `min(budget, limit)` turns exactly one of them red (verified).

## 3. Reading two: the ranking was fine, the units were not

After the repair — the top-k applied to hits, the turn budget left in turns — the same command:

```
provider            build   recall@k  all-gold  mrr      found
lexical-reference   none    93.6%     81.0%     0.781    468/500
cortex-session      none    94.0%     82.2%     0.818    470/500
null-floor          none     0.0%      0.0%     0.000      0/500
```

Per capability (found / measured):

| capability | lexical-reference | cortex-session |
| ---------- | ----------------- | -------------- |
| ABS        | 29/30             | 28/30          |
| IE         | 130/150           | 133/150        |
| KU         | 71/72             | 72/72          |
| MR         | 118/121           | 117/121        |
| TR         | 120/127           | 120/127        |

**This is parity, not a win, and the arithmetic says so.** recall differs by two questions out of five
hundred; all-gold by six; MRR by 0.037. Under a paired test on 500 items a two-question difference is not
distinguishable from zero, and the per-capability columns move in both directions (IE +3, ABS −1, MR −1, KU +1,
TR 0). Anyone reading "94.0 > 93.6" as a lead is reading noise.

What it does establish is narrower and worth having: **Cortex's session selection is as good as a lexical index
on real multi-session data.** Before the previous round it was not a ranking at all, and before this round it
was a ranking compared in the wrong unit. Two defects, both found by a corpus rather than by review.

## 4. Reading three: a turn-denominated budget is the real constraint

The third row of the same table:

```
cortex-session      none     8.0%      6.6%     0.080    (sessionBudget 8)
```

`sessionBudget` is a ceiling on **turns**, and a session is admitted whole or not at all. At eight turns, a
ten-turn session exceeds the budget, `selectSessionBudget` skips it, and the "admit the highest-value session
anyway" rule returns exactly one. So an eight-turn prompt budget costs **86 points of recall** relative to an
unbounded one.

That is not an adapter artifact. It is a property of the product's design: **the session is the allocation unit,
and real sessions are bigger than a tight prompt.** Two consequences, both testable:

1. **Sessions need a turn-level trim inside the boundary**, not just an all-or-nothing admission. The
   measurement to run is whether trimming to the best turns inside a session beats dropping the session.
2. **The budget should probably be denominated in tokens, not turns.** A ten-turn session of short turns and a
   ten-turn session of long ones are not the same cost, and the current rule treats them as equal.

Neither is implemented here, because both change what the product does and both need an A/B. What this round
does is put a number on the current design's cost, which did not exist before: **8.0% against 94.0%.**

## 5. What these numbers are not

1. **Not answer accuracy.** There is no reader and no judge on this path. A hit counts when its session text
   contains a gold turn, so these are evidence-recall numbers. The end-to-end reading (`S1 81.0%`) comes from a
   different retrieval path — the memory arm's own `NaturalLanguageMemory`, not this adapter — and the two must
   not be quoted as one system.
2. **Not a competitor comparison.** `lexical-reference` is our own control, not a rival product. H1 (Hindsight)
   is still the first real competitor number, and it needs a container and a reader.
3. **Not a significance claim.** Two questions on five hundred is not a difference.

## 6. What the run cost, and what it did not

Runs on a GitHub runner, needs no reader, no judge and no key, and finishes in about six minutes for both the
100-question subset and the full file. The development sandbox reaches `api.github.com` and nothing else, so a
runner is the only place this tool can meet the corpus — that is the whole reason the workflow exists.

## 7. The known limit that shaped all of the above

`sessionsOf` stamps every session with the **question** date:

```ts
const at = questionDateMs(question) ?? 0;
return groups.map((turns, index) => ({ id: `${question.id}#${index}`, at, turns: ... }));
```

So per-session timestamps do not survive into the provider contract. `asOf` cannot filter (`at` is equal for
every session of a question, so a filter either passes all or none), and time reaches the relevance signal only
through the loader's `[date]` prefix in the rendered text — which is a token the tokeniser happens to keep.

Fixing it means adding a per-session timestamp to `Question`, which is a change to the evaluation contract
rather than to one adapter. It is the first thing the TR column will tell us the cost of: TR is where
`lexical-reference` and `cortex-session` are already tied at 120/127, so the next TR movement has to come from
somewhere other than ranking.

## 8. What changed in the code

| file                                                    | change                                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/cortex-memory/src/provider.ts`                | top-k applied to hits; turn budget left in turns; `build: 'none'`                       |
| `packages/cortex-memory/src/__tests__/provider.test.ts` | two six-turn-session tests that distinguish the units, plus the ranking and query tests |
| `tools/competitor-harness.mjs`                          | `--data` / `LONGMEMEVAL_PATH`, stratified subset, annotated gold                        |
| `tools/__tests__/test_competitor_harness.py`            | eight tests, including the one a derived gold cannot pass                               |
| `.github/workflows/competitor-retrieval.yml`            | runs both subsets on a runner, retrieval only                                           |
| `package.json`                                          | `build` before `test:tools`, because the tools tests read `dist/`                       |
