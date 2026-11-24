# The anatomy of the 44 remaining failures, and the four axes already spent

> **STATUS: DIAGNOSIS. No dispatch is registered by this file.** It exists because three of this
> campaign's last four plans named a mechanism that the tree had already implemented, dispatched and
> refuted — `aggregate`, `derive`, `candidates` — and the fourth named one whose reading was already
> negative at a larger size (`maxPromptChars: 96000`). Reading those results before writing the next
> registration is cheaper than reproducing them, and this file is the reading.

All numbers are `packages/cortex-memory`'s archived arm `S16` — the 500-question `deepseek-chat` run
that the shipped configuration still reproduces — recomputed for this file with
`tools/evidence-completeness.py /tmp/s16-report.json`.

## 1. Two populations, and they do not overlap

The artifact records, per question, how many of the dataset's gold turns the reader was actually
delivered: `goldOverlap.carried` of `goldOverlap.total`. That splits every wrong answer into one of
two populations, and the split is the most useful thing in the artifact:

| capability | n | full: `carried == total` | full accuracy | partial: `carried < total` | partial accuracy | headroom |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `IE` | 150 | 26 | **100.0%** | 124 | 89.5% | +13.0 |
| `MR` | 121 | 105 | **85.7%** | 16 | 75.0% | +1.7 |
| `TR` | 127 | 38 | **100.0%** | 89 | 92.1% | +7.0 |
| `KU` | 72 | 0 | — | 72 | 93.1% | — |
| `ABS` | 30 | 0 | — | 30 | 100.0% | — |

Three facts come out of it, and the third one is the reason this file exists.

**No gold turn was ever unreachable.** `pool < total` is **0 of 500**: every gold turn the dataset
names was offered to the retrieval at some point. There is no retrieval-miss population to repair, so
a plan that widens `relevanceTopK`, changes the ranking signal or adds an index spends money on a
population with zero members.

**On `IE` and `TR`, a complete window is a perfect window.** 26 of 26 and 38 of 38. Neither
capability has a single wrong answer among the questions that received all their gold turns. Whatever
they are losing, they lose it in delivery, not in reading.

**`MR` is the only capability that fails with the evidence in hand.** 15 of 105. Every full-window
failure in the roster is a `multi-session` question, and `MR`'s 19 wrong answers are 15 of those plus
4 partial ones. This is the one capability whose remaining gap is not a window problem, and §2 shows
that the four asks written for it have all been read.

`headroom` is `(accuracy(full) − accuracy(partial)) × count(partial)` — the questions a repair would
win **if** partial could be lifted to full. The tool prints it so that a plan cannot be written
against a larger number, and the assumption inside it is real: turning a partial question into a full
one is not the same event as answering it correctly.

**The `MR` row above is a mixture, and the mixture is the correction `MEASURE-GOLD-BAND.md` makes.**
`carried == total` is membership in the admitted set, and the renderer then cuts a long turn at
`maxTurnChars` with no marker. Crossed with that cut, `MR`'s 105 "full" questions are **28 at 96.43%
and 77 at 81.82%** — a 14.61-point spread *inside* the bucket this table reports as a single level of
85.7%, which is larger than the 10.71-point gap *between* the buckets that §5 below was written on.
The three other capabilities cannot show it: their routes are not capped, so the zero rows in that
file's §2 are a control rather than a coincidence.

**`TR`'s row was measured, and the assumption was seven times too large.** Run `45323303194` aimed a
window at `temporal` alone — 24,000 → 48,000, the other five routes untouched — which raised `TR`'s
median delivered characters from 23,899 to 47,890 and its median delivered turn count from 98 to 207.
Four of the seven failures went from incomplete evidence to complete. **Two of those four converted.**
The row that says `+7.0` is worth `+1`: `370a8ff4` still answers a year for a gold of `15`, and
`gpt4_f420262c` still counts one airline twice, and no window can fix either.
`PREREGISTRATION-TEMPORAL-BUDGET.md` §8 carries the reading; the number here is not rewritten, because
a headroom that gets edited after it is measured stops being a headroom.

## 2. `MR`'s ask axis is spent, and this is what spent it

| ask | mechanism | control | reading | verdict |
| --- | --- | ---: | ---: | --- |
| `enumerated` (§13.34) | write the list, then compute | — | 87 | the value the campaign adopted |
| `sweep` (§13.93) | one ledger line per session, all 44 | — | unchanged, median list 2.0 | no gain |
| `aggregation` (§13.104) | an exchange rule, a four-form arithmetic mapping, a looser decline condition | 87.5 | 86.2 (`39509698041`) | **−1.3** |
| `silent` (§13.127) | the Step 1 notes made private | 61 | 87 (`40792853362`) | **−26** |
| `answer-line` (§13.130) | a reply shape on a route MR does not read | 39 | 87 (`40807829150`) | **−48**, fallthrough defect |
| `derive` (§13.132) | the combine licence moved to the last position | 87 (`40751394094`) | 83.0 mean (`40859499624`) | **no resolvable movement** |
| `verbatim` (§13.246) | the reference pipeline's aggregation block, unabridged | 92 | ≥ 96 | **adopted** (+4 or more) |

`aggregation` is the value a fresh reading of the 12 aggregation failures would have written, and it
is 1.3 questions *worse* than doing nothing. `derive` is the one a fresh reading would have written
next, and it moved nothing this design can resolve — its MR mean is 83.0 inside the control's own
83–89 range across four passes. `verbatim` is the one that worked, and it is what the arm ships.

So the sentence a plan would naturally write — "the reader has the parts and will not join them, so
change the sentence that licenses joining" — has been administered four times, and the only version
that helped was the one that **stopped proposing a sentence and copied the reference pipeline's**.

## 3. The window axis, read at the size where it was positive

`maxPromptChars` has been raised twice, and the second reading is the one worth keeping:

| run | change | `MR` | `TR` | `KU` | overall | prompt tokens |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `01a0cf0c` → `41144910162` (§13.177) | 48,000 → 96,000 | 89 → 87 | **+12** | **64 → 56** | 417 → 420 | **1.618×** |

The campaign read that as a bad trade — +3 questions for 62% more prompt tokens and eight lost `KU`
questions — and reverted. That reading is correct **for a scalar budget**, and it is the reason the
per-route table exists: the same run bought the temporal route twelve questions and sold
`knowledge-update` eight. A scalar raise forces every route to take both sides of that swap.

`§13.177.2` also states the mechanism behind the `KU` loss, and it is not noise: a larger window
admits more low-value turns, and `knowledge-update` is the capability whose answer depends on *which*
of two contradictory turns is in the window, so more evidence there is a chance to deliver the
superseded fact as well.

## 4. The reader axis, which is negative in the direction the brief expects

`deepseek-v4-pro` against `deepseek-chat`, everything else fixed, one run each (`40698867439` and
`40698883428`): **417 → 381, −7.20 points**. The failure is not distributed: every one of the bare
declines the stronger model adds is an `ABS` question, i.e. it declines on questions where declining
is wrong, because the contract's decline licence reads to it as an instruction it should follow more
carefully.

This is the axis the brief asks to be positive — a stronger model should score better — and on this
contract it does not. Nothing in this file proposes a fix; it records that the finding is about the
licence's wording rather than about the model, because the loss lands entirely on the one capability
where a decline is the wrong answer.

## 5. What is left, split by the population that can pay for it

| population | questions | mechanism the split permits | already read? |
| --- | ---: | --- | --- |
| `TR` partial, gap ≤ 2 | 5 of 7 wrong | route-scoped window, `temporal` only | **no** — §13.177 raised every route at once |
| `TR` partial, gap 5 | 2 of 7 wrong | the same | no |
| `IE` partial | 13 wrong | route-scoped window, `flat` only | **yes in part** — §13.177 read `IE` at +1 on a 4× budget |
| `MR` full-window failures | 15 wrong | aggregation: ask axis spent (§2) | **yes, four times** |
| `KU` partial | 5 wrong | the superseded-fact problem | no, and §13.177 says a window is the wrong instrument |
| `MR` partial | 4 wrong | route-scoped window, `multi-session` only | no |

`TR` is the only row where a positive reading exists at a larger size, the population is small enough
that the whole route can be re-run for a bounded price, and the instrument has never been aimed at it
alone. `docs/PREREGISTRATION-TEMPORAL-BUDGET.md` is that registration and it is the next dispatch.

The `MR` row is where the SOTA gap actually lives, and §2 is why it is not the next dispatch: four
attempts have established that the sentence is not the mechanism there, and the fifth would need a
different *shape* rather than a different sentence. `§13.246.6` names the shape the evidence points
at — session-atomic allocation, where a question receives a session whole or not at all, so there is
no half-served band — and it is registered as a design question rather than a dispatch because it
moves the allocator rather than a string.

**That shape is now priced at four questions, and the row above is corrected rather than dispatched.**
`MEASURE-GOLD-BAND.md` re-reads the same run's gold account in three bands instead of two and finds
that the half-served band this file assumed is not a session-allocation defect at all: on `MR`,
**18 of the 19 failures carry a gold turn that was admitted and then cut at `maxTurnChars: 400` with
no marker**, and only **4** are missing a gold turn entirely. Session-atomic allocation can therefore
reach 4 of 19 — a ceiling of **+0.8 points overall** — while the cut band reaches 18 with a change to
one constant. The `MR` partial row's mechanism is the same finding from the other side: those 4
questions lose gold inside sessions the window already delivered, so a session-level unit cannot
recover it either.

The consequence for this table: `MR`'s two rows collapse into one axis — **the per-turn cap on the two
capped routes** — and that axis is registered in `MEASURE-GOLD-BAND.md` §5 with its population, its
prediction (`MR ≥ +6`) and its falsifier.
