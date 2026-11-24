# The cap is solved, not chosen: 600 characters

`maxTurnChars = 400` is the shipped value, and `FAILURE-ANATOMY.md` §1 priced it: 487 of 7,516
annotated gold turns are admitted and then cut, and 18 of `MR`'s 19 failures carry at least one. The
next question looks like arithmetic -- the longest gold turn among those failures is 1,058
characters, so 1,200 covers the population -- and that arithmetic is wrong, because **the room is
spent to within one turn**.

On run `44017278305` the median `multi-session` question leaves **117** characters of its 48,460
unspent (p10: 29). A turn allowed 1,200 characters instead of 400 does not arrive in extra room; it
takes 800 characters from the turn behind it, and the turn behind it is the tail of the ranking. The
width trades truncated gold for evicted gold, and the crossing point is an empirical property of
this dataset's turn lengths rather than a matter of taste.

`tools/turn-width.mjs` prices that trade. It replays the allocator on one archived report and
re-admits the same ranked list at every candidate width.

## 1. The replayer is checked before it is used

A counterfactual over a model of the allocator is worth exactly what the model is worth, so the tool
prints its fidelity first:

> the prefix rule at 400 reproduces the delivered set on **247/248** capped-route questions
> (miss: `bcbe585f`, the one `temporal` question recorded with no room left)

The model is three lines: turns in delivery order, each costing `min(length, width)` plus the
per-turn rendering overhead that the artifact's own `deliveredPromptChars` implies; the pass **stops**
at the first turn that does not fit rather than skipping it. The stop-rather-than-skip rule is not an
assumption either -- it is what the 117-character leftover measures, since a skipping rule would
leave less than one turn unspent only by coincidence.

## 2. The sweep, on the arm that shipped

`MR` carries 1,832 annotated gold turns; `TR` carries 1,615. Coverage is `whole / total`, the
quantity §13.26 measured accuracy against (14.3%, 33.3%, 41.5%, 66.7% across the first four bands of
gold-overlap coverage).

| width | `MR` whole | cut | absent | coverage | whole questions | `TR` whole | cut | absent | coverage |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 400 | 1,557 | 245 | 30 | 84.99% | 28/121 | 1,134 | 242 | 239 | 70.22% |
| 450 | 1,654 | 137 | 41 | 90.28% | 53/121 | 1,229 | 135 | 251 | 76.10% |
| 500 | 1,701 | 77 | 54 | 92.85% | 66/121 | 1,271 | 82 | 262 | 78.70% |
| 550 | 1,723 | 47 | 62 | 94.05% | 76/121 | 1,294 | 45 | 276 | 80.12% |
| **600** | **1,725** | **28** | **79** | **94.16%** | **76/121** | **1,295** | **32** | **288** | **80.19%** |
| 650 | 1,712 | 21 | 99 | 93.45% | 75/121 | 1,294 | 26 | 295 | 80.12% |
| 700 | 1,702 | 13 | 117 | 92.90% | 78/121 | 1,288 | 25 | 302 | 79.75% |
| 800 | 1,686 | 13 | 133 | 92.03% | 78/121 | 1,279 | 20 | 316 | 79.20% |
| 1,000 | 1,670 | 5 | 157 | 91.16% | 80/121 | 1,263 | 10 | 342 | 78.20% |
| 1,200 | 1,667 | 1 | 164 | 90.99% | 81/121 | 1,259 | 0 | 356 | 77.96% |
| 1,600 | 1,653 | 0 | 179 | 90.23% | 78/121 | 1,234 | 0 | 381 | 76.41% |
| 2,400 | 1,606 | 0 | 226 | 87.66% | 70/121 | 1,189 | 0 | 426 | 73.62% |

Three facts come out of it, and the third is the one that changes the plan.

**600 is the unique maximum of coverage on both routes.** `MR` rises 84.99% → 94.16% and then falls
away; `TR` rises 70.22% → 80.19% and then falls away. The maximum is not a plateau: 650 is 0.7
points worse on `MR` and 800 is 2.1 points worse.

**Past the peak, widening is a net loss on both axes that matter.** 1,200 covers 100% of the cut
band -- 1 cut turn left out of 1,832 -- and holds **58 fewer whole gold turns** than 600 does, because
the 164 evicted turns include short gold turns that were whole at 600. At 2,400 the arm gives up
226 gold turns to reach a cut band of zero.

**The cut band collapses early.** 88.6% of `MR`'s 245 cut turns are at or under 600 characters, so
the half of the population that a width can fix is fixed by the first 200 characters of headroom,
and everything after that is buying the tail at the front's expense.

## 3. The one quantity a width can transport, and the capability where it is zero

The tool also reports a projection, and it is deliberately modest about what it is. One rate per cell
over a partition of the same questions is a **saturated** fit: it reproduces the run it was fitted on
exactly, so nothing about it is validated by that. What it transports is a single number -- the
accuracy gap between a question whose gold arrived complete and uncut and one whose gold arrived
complete and cut:

| capability | complete, uncut | complete, cut | gap |
| --- | ---: | ---: | ---: |
| `MR` | 96.43% (27/28) | 81.82% (63/77) | **14.61 pts** |
| `TR` | 100.00% (10/10) | 100.00% (28/28) | **0.00 pts** |

`MR`'s gap is the mechanism the width is aimed at: converting a cut question into an uncut one is
predicted to be worth 14.6 points on that question. `TR`'s gap is **zero** in the strongest possible
form -- **all 38** `TR` questions whose gold arrived complete were answered correctly, 10 of 10
uncut and **28 of 28 cut** -- so truncation is not `TR`'s failure mode at all, and its 7 failures
sit entirely in the partial row (82/89 = 92.1%). A width that converts a cut `TR` question into an
uncut one is predicted to do nothing there. That is consistent with what happened when the temporal room was doubled (`+1` question) and
it is the reason the registration below treats `TR` as a guard rather than a target.

The projection inherits the gap and nothing else, so its number is a linear re-weighting:

| width | 400 | 500 | 550 | 600 | 700 | 1,000 | 1,200 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `MR` projected | 102.00 | 106.87 | **108.33** | 107.92 | 107.87 | 108.03 | 108.18 |

It reproduces the recorded 102 of 121 at the shipped width by construction, and it is flat to within
0.9 questions across 550–1,200. **A curve that flat cannot pick a width** -- it can only say the
effect should be positive at all -- which is why the width is registered on coverage (a measured
maximum) and the projection is used as a directional check rather than as the decision.

`IE`, `KU` and `ABS` have no projection at all: their complete rows hold 0 to 26 questions, and the
tool refuses a cell under five by name.

## 4. What this does not prove

1. **It does not prove the width causes the 18 failures.** It proves the band those failures sit in
   is the band the width moves. The pairing that would price the mechanism is the dispatch in
   `PREREGISTRATION-TURN-WIDTH.md`.
2. **It does not model the ranking.** The replayer admits a prefix of the delivered list; it cannot
   see the pool behind it. If a wider cap pushes a turn out and the arm backfills from the pool, the
   sweep over-states eviction. The dispatch's `promptChars` gate is what would catch that.
3. **Coverage is an annotation's view.** The dataset names a handful of turns per question; the
   reader also read ~200 others, and the sweep says nothing about those.
4. **600 is dataset-specific.** It is the crossing point of this corpus's turn-length distribution
   against these rooms. A different corpus would cross somewhere else, which is an argument for
   deriving the width per corpus rather than shipping a magic number -- and `tools/turn-width.mjs`
   is the derivation.

## Reproducing

```bash
node tools/turn-width.mjs --self-test                 # 13 assertions, hermetic
node tools/turn-width.mjs <report.json>               # the ladder above
node tools/turn-width.mjs <report.json> --widths 400,600 --json
```

The reading is committed at `packages/cortex-memory/test/turn-width/result.json` and pinned by
`packages/cortex-memory/src/__tests__/turn-width-reading.test.ts` (10 assertions), so a document that
quotes one of these numbers cannot quote it differently from the file.
