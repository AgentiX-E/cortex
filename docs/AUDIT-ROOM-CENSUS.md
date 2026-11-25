# AUDIT-ROOM-CENSUS

**What each of the six routes spends its room on, and the one place the answer disagrees with the campaign's
own diagnosis.**

Instruments: `tools/room-census.mjs` (this round, new). Read on `45543010618` — the adopted arm, 500 of 500,
two repetitions, eight shards merged.

## 0. The queue, as the last round left it

`§196` retired the clock axis and left three levers, in this order:

| #   | lever                                 |  population |  CNY |
| --- | ------------------------------------- | ----------: | ---: |
| `⑬` | re-price `verbatim-acts` on `layered` |   `MR`, 121 | 5.87 |
| `⑤` | the `KU` conflict block               |    `KU`, 72 | 1.03 |
| `⑫` | the `IE`/`KU` delivery gap            | 16 failures |  ~10 |

`⑫` was written as a question rather than a lever — _"whose window is it"_ — because the round that produced
it had the coverage numbers and not the mechanism. This audit answers it, and the answer is not the one the
number implied.

## 1. Why a census was needed rather than another reading

Every `PREREGISTRATION`-style criterion in this campaign reads accuracy. That is the right thing to gate a
release on and the wrong thing to locate a failure with, because accuracy is one number per route and the
six routes spend their rooms in three different ways. The arm carries the fields that separate them —
`deliveredPromptChars` per question, `effectivePromptChars` per route, `turns` as the delivered list,
`goldOverlap.carried/total` — and **no instrument divided them**. A `fill` column is the difference between
_"this route has room it never used"_ and _"this route is at 99.8% and its failures are elsewhere"_, and the
second sentence is the one that reprices a lever.

## 2. The table

```
route                n   room  turns   fill       gold  gold%     acc  fail  full
multi-session      121  48460    207  99.8%  1804/1832  98.5%  89.256    13     9
temporal           127  24000     98  99.5%  1376/1615  85.2%  96.062     5     0
flat                94  24000     19  95.9%   595/1182  50.3%  92.553     7     0
knowledge-update    72  24000     18  95.8%   843/1688  49.9%  90.277     7     0
abstention          30  24000     19  96.6%   239/672  35.6%     100     0     0
assistant           56  24000     18  95.5%   402/527  76.3%  96.428     2     0
```

`fill` = `deliveredPromptChars / effectivePromptChars[route]`. `gold` = the gold turns that reached the
reader over the gold turns the dataset names. `full` = failures whose gold arrived **complete** — the reader
had every gold turn and answered wrong anyway.

## 3. Three facts

**No route has idle room.** The range is 95.5%–99.8%. `multi-session` is at 99.8% and `knowledge-update` at
95.8%, and the two points of difference are 18 turns of decoration, not slack. Every route is spending
everything it has, so **"the budget is not being used"** is not a hypothesis this corpus supports for any
route.

**The two orderings disagree, and that is the reading.** Sorting by gold coverage gives

```
multi-session > temporal > assistant > flat > knowledge-update > abstention
```

and sorting by accuracy gives

```
abstention > assistant > temporal > flat > knowledge-update > multi-session
```

`multi-session` is **first** on coverage (98.5%) and **last** on accuracy (89.26%). It is also the only route
with failures that had all their gold — **9 of 13**. `abstention` is **last** on coverage (35.6%) and **first**
on accuracy (100%), which is not a paradox: a question that must be declined is decided on an absence, and
its gold turns are the ones that must _not_ be quoted.

The consequence is a rule this campaign should not have needed and now has: **gold coverage is a mechanism
diagnostic, not a quality metric.** `§196` used it correctly — as the split between a route that fails with
its evidence in hand (`multi-session`) and routes that fail without it (`temporal`, `flat`,
`knowledge-update`, `assistant`, 21 failures, **zero** with full gold) — and this table is what says the
second half of the sentence is about **delivery** and not about **difficulty**.

**Turn count, not characters, is what a room buys.** At the same 24,000 characters:

| route              | `maxTurnChars` | turns delivered |     gold% |
| ------------------ | -------------- | --------------: | --------: |
| `temporal`         | 400            |          **98** | **85.2%** |
| `flat`             | uncapped       |          **19** | **50.3%** |
| `knowledge-update` | uncapped       |          **18** | **49.9%** |
| `assistant`        | uncapped       |          **18** | **76.3%** |

`temporal` and `flat` share the room exactly. The difference is that `temporal` spends it on 98 turns of at
most 400 characters and `flat` spends it on 19 turns of ~1,103. **Same budget, 5.2× the turns, 1.7× the
gold.** `multi-session` — also capped, at 48,460 — rounds it out at 207 turns and 98.5%.

This is the mechanism `⑫` was looking for, and it is visible **without a dispatch**: the control is a route
the arm already runs at the arrangement being proposed for the other three.

## 4. The denominator I got wrong first

Recorded because the wrong number was more dramatic than the right one and reached the draft.

Dividing `deliveredPromptChars` by the scalar `maxPromptChars` (48,460) instead of the route's own room gave
**"379 of 500 questions spend under 60% of the room, median 49.1%"** — a finding that would have justified a
dispatch and that is entirely an artefact of the arithmetic. The scalar is `48_460` and each route's room is
`REGISTERED_ROOMS[route]`; the product reads the table first (`memory.ts`: `named ?? maxPromptChars`) and the
adopted arm names **all six** routes, so the scalar is dead code for every one of them.

The correction is mechanical rather than careful: `room-census.mjs` refuses an artifact with no
`effectivePromptChars`, refuses a route the table does not name, and refuses delivered characters above the
room — three states in which the share would be a number about nothing. Its self-test pins the fixture at
12,000 characters into a 24,000 room so that **the wrong denominator shows up as 25% rather than as 50%**: a
fixture whose two denominators agree cannot catch this class.

The general lesson is `RETRACTIONS`' recurring one, and it is about instruments: a share is a claim about two
numbers, and a tool that accepts one of them as a parameter has not been told which.

## 5. What follows, and it is one dispatch

`PREREG-TRUNCATION-SHORT-ROUTES.md` registers the step the third fact names: cap the four uncapped routes at
400 characters and leave every room untouched.

- **The variable is a route list**, `CORTEX_MEMORY_MAX_TURN_CHARS_ROUTES`, which is already a dispatch input —
  zero code changes, one field.
- **The cost does not move**, because the room does not: `T3` permits +1.0% and the growth is decoration.
- **The mechanism has a free control**: `temporal` already runs at the proposed arrangement on the same
  corpus, and its 98 turns / 85.2% is where `flat` and `knowledge-update` are being asked to arrive.
- **The criterion that comes first is the mechanism's**, not the accuracy's: gold coverage of the three
  touched routes from ~50% to **≥70%**. A delta published for a mechanism that did not run is a delta about
  nothing (`S17`).
- **And the negative is a falsification, not a null.** Coverage up and accuracy flat would mean the
  "delivery institution" diagnosis is wrong — 21 failures on routes whose window was never the constraint —
  and the next lever would be a prompt axis on `flat`/`knowledge-update` rather than any further retrieval
  work.

That is why this dispatch goes before `⑬` (¥5.87) and `⑤` (¥1.03) despite costing more: it is the only one in
the queue that can **close a direction** rather than add a lever, and the other two are priced against a
diagnosis it is testing.

## 6. What this audit does not claim

- **Not that truncation is better.** It is cheaper per turn and it is lossy per turn, and this corpus has one
  route at each arrangement and no third. `T1`/`T2` are the accuracy criteria and they may both fail.
- **Not that the six routes are comparable populations.** `IE` is 94 `flat` + 56 `assistant`; `TR` is 127
  `temporal`; `KU` is 72 `knowledge-update`. The census groups by the route the record took, which is the
  only grouping the room table is defined on, and the accuracy ordering across routes is a fact about **five
  different question kinds** rather than a ranking of five arrangements.
- **Not that `abstention`'s 35.6% is a shortfall.** Its gold is what must be absent; the coverage column is
  printed for completeness and read for nothing.
- **Not that `multi-session`'s 9-of-13 is beyond reach.** It is the decision institution `§13.292` opened and
  `§195`/`§196` spent two dispatches inside; nothing here reprices it.

## 7. Instruments

| tool                                     | refuses                                                                                                           | reads                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `tools/room-census.mjs` (new)            | no `effectivePromptChars`; a route the table omits; delivered > room; an empty population; a record with no route | the table above, both orderings, and the disagreement between them |
| `tools/exclusion-census.mjs` (`§195`)    | a missing capability; an empty population; a missing reply                                                        | which licence a wrong reply used when it dropped an item           |
| `tools/paired-delta-census.mjs` (`§196`) | a population difference; an **undeclared arm drift**; a scoped read with no basis                                 | the paired delta, and which questions moved                        |
| `tools/spend-projection.mjs`             | a report with no `usageBySide`                                                                                    | the lower bound of a dispatch, before it is made                   |

The four are one family and the family's rule is the same in each: **a number is printed only when both of
its arguments are in the artifact**, and the tool refuses rather than computes around a missing one.
