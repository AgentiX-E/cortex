# Where the gold went, and the one axis the cost table only ever turned one way

> Reading: `45760081761` (the published 93.40% @ 7,346), 500 questions, 7,516 annotated gold turns.
> Instrument: `tools/gold-band-census.mjs`, which refused this artifact until this round.
> Zero model calls.

## 1. The instrument refused the only configuration that is ever used

`gold-band-census.mjs` exited with a sentence under `resolution: 'layered'`: a turn's bound there is a
form ceiling computed from the question (`resolveCappedTurn`), so comparing it against `maxTurnChars`
would mis-band every turn. That argument is right and it was applied to the wrong scope.

`bandOf` decides **`absent` before it consults the cap**:

```js
if (!delivered.has(gold)) return 'absent';
if (cap !== undefined && reach && gold.length > cap) return 'cut';
return 'whole';
```

The delivery column never reads the cap. So under `layered` the **width** columns are unmeasurable and
the **delivery** column is exact — and every published artifact is written in `layered`. The refusal
withheld a reading that was always available, which is why no round has ever reported a gold-turn
delivery census for the arm it ships.

The width columns now print `n/a` and the delivery columns print numbers. `n/a` rather than `0`:
zero is a measurement, and this configuration cannot take it.

## 2. Three readings, none of which the queue had

**First: retrieval is not the bottleneck, and that is now a measurement rather than a belief.**

| route | gold segments | delivered | absent | beyond-cut | never-ranked | delivered% |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `multi-session` (48,460) | 1,832 | 1,804 | 28 | 28 | **0** | **98.47%** |
| `temporal` (24,000) | 1,615 | 1,376 | 239 | 239 | **0** | 85.20% |
| `assistant` (24,000) | 527 | 402 | 125 | 125 | **0** | 76.28% |
| `flat` (24,000) | 1,182 | 596 | 586 | 586 | **0** | 50.42% |
| `knowledge-update` (24,000) | 1,688 | 843 | 845 | 845 | **0** | 49.94% |
| `abstention` (24,000) | 672 | 239 | 433 | 433 | **0** | 35.57% |
| **all** | **7,516** | **5,260** | **2,256** | **2,256** | **0** | **69.98%** |

`never-ranked = 0` across every route and every capability: **not one gold turn of the 7,516 was outside
the candidate pool the ranking offered.** Gold recall is 100%. Every missing gold turn was *surfaced and
then cut by the ranked prefix*, which means the repair is a selection repair and never a retrieval one —
and it retires the "is the embedding finding it" question from this campaign's queue for good.

**Second: the absent split is not one institution.** 2,256 segments are missing and they are missing for
one reason only — rank distance. The queue called this a *delivery institution* (`§205.3`), which is
true of the reader and false of the repair: no window sizing reaches a turn the prefix never got to, in
the sense that the prefix is ordered by relevance and the turn is beyond it.

**Third, and the one that changes a decision: the gold that is missing is mostly gold nobody needed.**

| | questions | of which wrong | ceiling if every one were fixed |
| --- | ---: | ---: | ---: |
| wrong **and** at least one gold segment absent | **21** | 21 | **+4.20 points** |
| wrong with every gold segment delivered | **14** | 14 | — |
| right, with at least one absent | 309 | 0 | — |
| right, every gold delivered | 156 | 0 | — |

The arm has **35 wrong questions**, not 617 — `617` is the segment-shaped total the class table prints,
and it counts a question once per missing segment. Of those 35, **21 have a missing gold and 14 do not**,
so the entire delivery axis is worth **at most 4.20 points** and the rest of the error budget is
decision.

And the correlation runs the wrong way for the obvious story: **the 330 questions with an absent gold
read 93.64% correct, the 170 with every gold delivered read 91.76%.** More gold present is not more
questions right. That is what `§204.3`'s five cost knobs kept finding from the other side: halving a
room removes gold and costs points, but only on the routes where the gold it removes is load-bearing.

## 3. What that means for the one axis that was only ever turned down

`§204.3` concluded that "every cost knob on this arm is priced and every one of them loses". Read the
table it rests on — all five rows are **decreases**:

| lever | reading | direction |
| --- | --- | --- |
| `multi-session` 48,000 → 12,000 | −15.2 questions | down |
| 48,000 → 24,000 everywhere | **−2.65 points**, bill 0.463x | down |
| per-route (two 48,000, four 24,000) | **−1.05 points**, bill 0.754x | down |
| `relevanceTopK` 256 → 32 | −1.6 points, bill −1.2% | down |
| `thinking` on → off | −4.35 points, bill −53% | down |

The arithmetic of a monotone knob runs both ways: if 48,000 → 24,000 costs 2.65 points, then 24,000 →
48,000 **buys** them. `§204.3`'s own words are "预算侧已经无解" — and what the table supports is
narrower: **the decreasing direction is priced and loses; the increasing direction has one measurement,
made in `ask=verbatim`, and has never been re-run on the arm that ships.**

`MEASURE-COST-LEVER.md` §5 is the correction that was never carried into the tracker: it establishes
that the `42383171765`-against-its-control gap was **`ask`, not room** (5.75 of 6.25 questions), and
that the residue attributable to the room is **−1.75 questions** — the same size as the clean
`verbatim`-to-`verbatim` comparison at −2.75. It ends by naming the dispatch that is owed:

> the registered configuration stays at `multi-session: 48,460` until that arm is re-run on top of
> `verbatim-acts`.

That dispatch was never run. It is the cheapest row in the queue with a measured ceiling, and this
round's census is an independent estimate of that ceiling: on `temporal` alone, **6 of the 7 wrong
questions have a missing gold**, and the median rank of a missing gold on a wrong question is **75** —
inside the prefix a doubled room would reach.

| configuration | accuracy (`ask=verbatim`) | prompt token/question | CNY per 500-question pass, one repetition |
| --- | ---: | ---: | ---: |
| 24,000 everywhere | 88.20% | 5,623 | 3.57 |
| per-route, 48,000 on two | 89.80% | 9,149 | 5.81 |
| 48,000 everywhere | 90.85% | 12,137 | 7.71 |

The consequence for the queue is a **price**, not a wish: **+1.05 points for 1.63x the bill, or +2.65
points for 2.16x**, both measured on `verbatim` and both unmeasured on `verbatim-acts`. At 500
questions that is **¥5.81 or ¥7.71 a pass** — cheaper than the 431-question population row at ¥10.45
and far more likely to move, because its ceiling is 21 questions and that row's ceiling is a gap nobody
has a mechanism for.

## 4. The queue, restated with this row in it

| # | row | CNY | ceiling | evidence |
| ---: | --- | ---: | ---: | --- |
| 1 | **per-route room on `verbatim-acts`** (re-run `42383171765`'s allocation) | **5.81** | **21 questions / 4.20 points** | this census: 21 wrong questions with a missing gold, median missing rank 75; `MEASURE-COST-LEVER` §5 |
| 2 | 48,000 everywhere on `verbatim-acts` | 7.71 | 21 questions / 4.20 points | the same, at the upper end of the room axis |
| 3 | MemCog on `MR` | 5.87 | 11 questions (`MR` 88.43 → 92.48) | external: the only published `MR` above ours |
| 4 | LoCoMo subset | 7.28 | unknown | second dataset, immunity against one-benchmark strength |
| 5 | 431-question population, one pass | 10.45 | any 4.96-point mechanism | `§206.2` |
| — | ~~2,195-question SOTA verdict~~ | ~~53.20~~ | a yes/no | `§206.9` |

Row 1 is first because it is the **only** paid row whose ceiling is a measurement from this artifact
rather than an external claim or a hypothesis, and because `MEASURE-COST-LEVER` §5 already named it as
owed. Its two repetitions cost **¥11.62**; one pass costs **¥5.81**, and one pass is what a paired
comparison needs.

## 5. What this does not claim

* **That the room increase will reproduce on `verbatim-acts`.** It was measured on `verbatim`, and
  `§13.294` prices `ask` at +1.00 point overall. Two effects are additive only if the route contracts
  are independent, which is a hypothesis. The row is registered as one variable on the shipping
  configuration, not as a sum.
* **That 4.20 points is reachable.** It is the ceiling of "every wrong question with a missing gold
  becomes right", which requires the reader to use the gold correctly once it is present. `MR` already
  delivers 98.47% of its gold and still has 16 wrong questions, so delivery is necessary and not
  sufficient — the 14 wrong-and-complete questions are the proof.
* **That the absent gold is unimportant because the absent questions score higher.** It is confounded:
  `abstention` has the lowest delivery rate and zero wrong questions by construction, and it is 433 of
  the 672 `ABS` segments. The stratified rates are printed so the confound is visible, not so it can be
  quoted as a result.

## 6. Reproducing this

```
node tools/gold-band-census.mjs <report.json>          # delivery and cause, per route
node tools/gold-band-census.mjs <report.json> --json   # the same, machine-readable
node tools/gold-band-census.mjs --self-test            # 20 assertions, hermetic
```

`byRoute` is the table this file was missing. The room is a **per-route** table and the census was
per-capability, so the one unit the budget is set in had no row: `multi-session` at 48,460 delivers
98.47% of its gold and `flat` at 24,000 delivers 50.42%, and those two are the same capability or
different ones depending on the question. A census that cannot separate them cannot price a room.
