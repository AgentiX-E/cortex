# The gold account was two bands and the arm has three

**What this file is.** A census over an archived artifact, costing no model call, that splits every
annotated gold turn three ways instead of two, and prices the shape `§13.246.6` named as `MR`'s next
dispatch. It reports one correction to how this campaign reads coverage, one refutation, and one
registered candidate with a population attached.

Run: `44017278305`, the shipping arm at `456/500 = 91.20%`, `MR` 102/121, `TR` 120/127, `IE` 137/150,
`KU` 67/72, `ABS` 30/30. Reproduce with:

```
node tools/gold-band-census.mjs <report.json>
```

## 1. `carried` means "admitted", and the reader is not handed what is admitted

`goldOverlapOf` counts a gold turn as carried when its text is one of the units in `retrieved`.
`retrieved` is the **unbounded** context — `question-record.ts` says so where it documents
`turns[].text`. The renderer then cuts each turn at `maxTurnChars` on the routes
`maxTurnCharsRoutes` names, and `turnCutMarker` is `'none'`, so nothing in the prompt says a turn
ended early.

So a gold turn longer than the cap is counted as delivered, and the reader receives its first 400
characters. `types.ts` recorded the anecdote that first made this visible — `a4996e51`, whose
decisive turn arrived and was cut at `…I increase my work hours`, with the coverage count calling it
delivered, "which is true and does not help". An anecdote names a defect; it does not size it. This
is the size.

## 2. The three bands, on the shipping arm

| capability | gold turns | whole | cut at the cap | absent | cut share of delivered |
| --- | ---: | ---: | ---: | ---: | ---: |
| `ABS` | 672 | 239 | **0** | 433 | 0.00% |
| `IE` | 1,709 | 997 | **0** | 712 | 0.00% |
| `KU` | 1,688 | 843 | **0** | 845 | 0.00% |
| `MR` | 1,832 | 1,557 | **245** | 30 | 13.60% |
| `TR` | 1,615 | 1,134 | **242** | 239 | 17.59% |
| **all** | **7,516** | **4,770** | **487** | **2,259** | **9.26%** |

The zero rows are the control: the cap reaches `multi-session` and `temporal` only, so the three
uncapped routes cannot band as cut whatever their gold turns measure. Their 1,990 absent turns are a
room question, and the two capped routes' 487 cut turns are a different one.

Two readings this table fixes:

1. **The coverage figure the file quotes is a two-configuration figure.** 7,516 − 2,259 = 5,257
   carried, i.e. **69.94%**, which is what the shipping arm at 24,000 characters reaches. The
   `6,520 / 7,516 = 86.75%` in `§13.257.4` belongs to the 48,000-character `retrieval-anchored`
   pair, not to this run. Both are true of their own configuration and neither may be quoted as the
   other — the same rule `SOTA-LANDSCAPE.md` §1 applies to every number in it.
2. **Halving the room lost 1,263 gold turns and gained 1.05 points of accuracy** (90.15% at
   `41546569106` on the 48,000 arm against 91.20% here). The 24,000 budget is not under-delivering
   evidence; it is declining to deliver distractors. That is the first reading in this campaign
   where the cost lever and the accuracy lever moved in the same direction, and it is why `C1`'s
   remaining room has to be argued on the cut band rather than on recall.

## 3. The stratum, and the confound that keeps it a stratification

| stratum | questions | correct |
| --- | ---: | ---: |
| every gold turn arrived whole | 64 | **98.44%** |
| at least one gold turn cut | 186 | **87.63%** |
| at least one gold turn absent, none cut | 250 | 92.00% |

Per capability, the cut stratum is not a uniform effect:

| capability | all whole | has a cut gold turn | gap |
| --- | ---: | ---: | ---: |
| `MR` | 27/28 = **96.43%** | 74/92 = **80.43%** | **−16.00** |
| `TR` | 10/10 = 100.00% | 89/94 = 94.68% | −5.32 |
| `IE`, `KU`, `ABS` | — | no cut turns by construction | — |

**18 of `MR`'s 19 failures sit in the cut stratum** (92 − 74 = 18), one in the absent stratum, and
none among the 28 questions whose gold arrived whole. On `TR` the same band moves by 5.3 points,
which is why this is a claim about `MR` rather than about the cap.

The confound has to be stated or the table will be read as an experiment: **a question with a long
gold turn is a question with a long history**, and long histories are harder for reasons that have
nothing to do with the cap. This is a stratification of a population, not a paired comparison, and
the dispatch below is the only thing that can price the mechanism.

### 3.1 The two-band split's "full" bucket is two populations, and the cut axis is the larger one

`FAILURE-ANATOMY.md` §1 splits `MR` at `carried == total`: 105 full, 16 partial, 85.7% and 75.0%.
Crossed with the cut band, the fuller picture is a 2×2 and it changes which axis is the big one:

| | every gold turn whole | at least one gold turn cut | row |
| --- | ---: | ---: | ---: |
| `carried == total` (105) | 27/28 = **96.43%** | 63/77 = **81.82%** | 90/105 = 85.71% |
| `carried < total` (16) | 1/1 = 100.00% | 11/15 = **73.33%** | 12/16 = 75.00% |
| column | 28/29 = 96.55% | **74/92 = 80.43%** | 102/121 = 84.30% |

Three consequences, and the first is a correction to this campaign's own diagnosis:

1. **The 85.7% of the "full window" population is a mixture, not a level.** It is 28 questions at
   96.4% and 77 questions at 81.8%. The **within-full** spread is **14.61 points**, which is larger
   than the **between-band** spread (85.71 − 75.00 = **10.71**) that §1 read as the reason `MR` "is
   the only capability that fails with the evidence in hand". The evidence is in hand in both halves;
   in the 77 it is in hand *and truncated*.
2. **The `headroom` of +1.7 questions was measuring the smaller axis.** §1's headroom multiplies the
   between-band gap by the partial count; the same arithmetic on the cut axis is
   `(96.43% − 81.82%) × 77 = 11.3` questions, and it is available without moving a single turn from
   outside the window.
3. **The partial bucket behaves the same way**, which is why this is a property of the reading rather
   than of the window: 73.3% with a cut, 100.0% (n=1) without. One question is not a rate and the row
   is quoted only so that the direction is visible in both halves.

The 2×2 is the reason the next registration is a constant rather than an allocator. Three of the four
cells are already fed their gold. The fourth (`carried < total`) holds 16 questions and 12 correct
answers, and **its 4 failures are all in the cut column beside it** — so the questions a session-level
unit could reach are, once the cap is accounted for, the same questions the cap reaches.

## 4. What it refutes: session-atomic allocation has four questions, not fifteen

`§13.246.6` names, as `MR`'s next shape once the ask axis is spent, *session-atomic allocation* —
"a question either receives a session whole or not at all, so there is no half-served band to read
badly". `FAILURE-ANATOMY.md` §5 carries that forward as the row where the SOTA gap lives.

The population says otherwise. Of `MR`'s 19 failures:

| what the failures are missing | questions |
| --- | ---: |
| nothing — every gold turn was admitted | **15** |
| at least one gold turn not admitted | 4 |
| of those, the missing turns sit in sessions the window partly delivered | 4 |
| gold turns missing across all four | 10 |

A fix that changes the **allocation unit** can only reach the questions whose gold was never fully
admitted, and that is 4 of 19. Its ceiling is **+0.8 points overall** before counting what dropping
a partially funded session costs the other 116 `MR` questions — and the room it reclaims is taken
from sessions that currently carry gold. §13.257 already measured that direction once: widening the
pool cost 8 `MR` questions.

Against that, the cut band reaches 18 of 19 with a change to one constant. The ordering in
`FAILURE-ANATOMY.md` §5 is therefore corrected here rather than dispatched and then corrected.

## 5. What it licenses: the cap width on `multi-session`, registered as the next candidate

Two levers exist and they are not the same experiment.

| lever | what it changes | population | what it can buy | price |
| --- | --- | --- | --- | --- |
| `maxTurnChars` 400 → 1,200 on `multi-session` | how much of a long turn is shown | 91 cut gold turns on the 19 failures (245 across all `MR`) | the missing sentence, in the same room | displacement: a longer turn spends room a lower-ranked turn had |
| `turnCutMarker: 'none'` → `'ellipsis'` | whether the reader is told | the same 245 turns | honesty, not accuracy: a reader told an operand is missing declines, and a decline scores as wrong | `~3` characters per cut turn |

The width is the lever that can convert a failure, and it is bounded by measurement rather than by
taste: on the 340 gold turns of the wrong `MR` questions, the median length is **309** characters,
p90 is **537**, and the maximum is **1,058**. A cap of 1,200 covers every one of them, and it costs
no token — the room is fixed, so the change is in *which* turns fill it.

The registration this implies, before any dispatch:

1. **Treatment**: `maxTurnChars` 400 → 1,200, `maxTurnCharsRoutes` unchanged. One variable.
2. **Population**: all 121 `MR` questions, four repetitions, paired by question against the same
   commit.
3. **Prediction**: `MR` ≥ **+6** of 121 (from 102 to 108), which is the size the 18-question band
   makes plausible and **above** the +1 the last two `MR`-shaped readings bought.
4. **Falsified by**: `MR` ≤ +2, or any other capability down by 3 or more. Both mean the cut is a
   marker of difficulty rather than a cause, and the band closes as an axis.
5. **Cost gate**: median `promptChars` moves by ≤ 2%, and the bill stays inside 1.05× of the
   control — a longer turn in a fixed room must not become a longer prompt.

The marker is not dispatched with it, and the reason is that it cannot show a positive effect on a
scored set: it converts a wrong answer into a decline, and a decline on a non-abstention question is
also wrong. It is an honesty lever, and honesty is measured by a different row (`ABS` precision and
the `MEASURE-ABSTENTION-RECOVERY` family), not by accuracy on `MR`.

## 6. What this does not establish

1. **That the cap causes those 18 failures.** §3's confound is real and unaddressed until a paired
   run exists.
2. **That 1,200 is the right width.** It is the smallest round number above the population's maximum
   (1,058). A width that covers the population is the only kind this census can justify; whether a
   tighter one keeps the gain is a second reading.
3. **That the absent band is out of reach.** 2,259 gold turns were never admitted, 1,990 of them on
   routes whose room is 24,000. This file says nothing about that band except that it is not the cut
   band, and `PREREGISTRATION-TEMPORAL-BUDGET.md` §8 is the most recent attempt to move a piece of
   it: the window doubled, the room reached the route, and the net was **+1** question.
4. **That 69.94% is the arm's recall in a comparable sense.** It is recall **at 24,000 characters**,
   on the cleaned file, over the annotations this dataset carries. Any competitor figure set beside
   it must name its own budget, which is the rule `SOTA-LANDSCAPE.md` §1 already imposes.
