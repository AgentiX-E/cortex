# PREREG-CLOCK-AXIS

**Status:** pending — registered before its dispatch: no Result section exists for it.

The act rule's other clock. `verbatim-scope` bought a bound on the period and lost four questions; this buys the
prohibition of that bound, and the reason it is worth buying is the adopted arm's own merged artifact rather than
the symmetry of the two claims.

## 0. What is being tested

One sentence, and it is a claim about the corpus rather than about arithmetic: **a turn is dated by when it was
said, not by when the thing happened**, so the session date is not a licence to leave an item out.

The mechanism is registered on a population that was counted before the dispatch, at zero cost, from the merged
artifact of the adopted arm (`45543010618`: eight shards, 500 of 500 questions, two repetitions, 93.50%).

| reading, `MR` only | value |
| --- | ---: |
| questions | 121 |
| correct | **108** (89.26%) |
| failures carrying **every** gold turn (`goldOverlap.carried == total`) | **9 of 13**, the other four short by 1, 1, 2 and 5 turns |
| replies that exclude nothing | 49, of which **47 correct (95.9%)** |
| replies that exclude something | 72, of which **61 correct (84.7%)** |
| replies citing a period or a date | 50, of which 42 correct (84.0%) |
| failures among those | **8 of 13** |

Nine of the thirteen failures had every gold turn in the window and the other four are short by one to five, so
this is at most a one-turn delivery gap on one question: no ranking change, no budget change and no wider room
reaches it. The reply says what it decided, and three of them were read to
the gold turn:

| question | gold | the reply's stated exclusion | what it lost |
| --- | --- | --- | --- |
| `3a704032` | `3` | snake plant *"received last month, which points to the prior calendar month"* | the third plant |
| `gpt4_731e37d7` | `$720` | two workshops *"outside last four months"* from a `2023/02/26` question | the `$500` |
| `37f165cf` | `856` | both novels *"finished in May, not January or March"* | `440 + 416` |

`$200 + $20 + $500 = $720` and `440 + 416 = 856` close without interpretation, and the plant the reply called
*"prior calendar month"* is the one the evidence dates *"last month"* — the period the question names. The
annotation's clock is the mention's, never the turn's.

## 1. The design

One field, one line, one route. `cortex_memory_ask` moves from the adopted `verbatim-acts` to `verbatim-clock`,
which is that block with a **third line on the act rule** and nothing else: `ask-verbatim-clock.test.ts` holds the
render as a diff (nothing removed, exactly one added, order preserved), and `ask-changes.test.ts` holds the change
set to the multi-session route against the `ASK_CHANGES` registration.

| field | control | treatment |
| --- | --- | --- |
| `cortex_memory_ask` | `verbatim-acts` (the adopted arm) | **`verbatim-clock`** |
| everything else | the registered arm | **identical** |
| population | `capability=MR`, 121 questions | **identical** |
| repetitions | 2 | **identical** |

The control is the **archived** arm rather than a second dispatch: `45543010618` is the same configuration at the
same load, and its eight shards are byte-comparable this round because the merge that was refused at the time
(§190.1, `selfIndex`) now runs — verified by reproducing `feature 0.9350` exactly.

## 2. Predictions, stated so that a failure is a failure

| # | claim | bar |
| --- | --- | --- |
| `C1` | the clock licence is what the failures used | `MR` converts **at least 4** of the 8 clock-citing failures net of regressions (`b − c ≥ 4`) |
| `C2` | and the direction is not noise | exact McNemar `p ≤ 0.05` on the paired verdicts; at `c = 0` that needs `b ≥ 6` |
| `C3` | the mechanism moves the census it names | citations of a period or a date fall from **50 to ≤ 25** of 121 replies |
| `C4` | it is not a licence to count everything | the over-count population does not grow: of the 13 failures, at most **1** may move from below-gold to above-gold |
| `R1` | the route's total | `MR ≥ 112` of 121 |
| `R3` | the prompt bill | paired prompt tokens move **≤ +1.0%** (`usageBySide`), because one 500-character line on 121 of 500 questions is ~0.5% of the file average and the arm's own cache behaviour is not re-measured by a ratio |

## 3. The falsifier, and what a negative reading would mean

`C3` passing with `R1` failing is the interesting negative: the licence disappears and the accuracy does not
move, which says the exclusion was a **symptom** of an incomplete screen rather than its cause. That would close
this axis in both directions — the bound costs four questions (§13.291's `S17`) and the prohibition of the bound
buys nothing — and it would move the remaining `MR` error to the screen itself, which is where `candidates`
(§13.205) already aimed.

`C1` passing while `C4` fails would mean the line trades over-counts for under-counts. That is not adoption
either: the two directions are different questions and the plan's next step would be the actor bound, which
§13.290 measured as annotation-dependent rather than fixable.

## 4. What this registration does not claim

- **Not** that the dataset's dates are wrong in general. It claims the annotation's clock is the mention's, which
  is what three replies' own arithmetic shows, and it states a rule a memory system can hold: a mention of a past
  event arrives later than the event.
- **Not** that every date exclusion is wrong. `gpt4_2f8be40d`'s extra weddings and `gpt4_7fce9456`'s extra
  property are excluded by the gold for act, duplicate and actor reasons, and the line keeps the act rule's bound
  for exactly those.
- **Not** a re-run of `verbatim-scope`. That arm added the bound; this one forbids it. A pair that moved both in
  one field would price neither, which is why the control is `verbatim-acts` rather than `verbatim-scope`.

## 5. Price

**¥5.87** — `MR` at two repetitions at the measured rate (`0.0243 CNY` per question-run, `§13.348.2`'s invoice in
`tools/spend-baseline.json`), quoted by `tools/spend-projection.mjs --capability MR --runs 2` and gated by the
same number the dispatch script reads. The line adds ~500 characters to 121 of 500 prompts, so the bill for the
other four capabilities is unchanged and the projection's only extrapolated axis is repetitions.
