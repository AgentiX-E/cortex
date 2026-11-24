# What an experiment is allowed to cost

A dispatch of the `cortex-memory` A/B at its registered shape — 500 questions, four repetitions, two
arms — bills **15.64 CNY**. That figure has been quoted as the price of _buying a mechanism_: one
measurement per candidate, three candidates, forty-seven yuan. It is not that. It is the price of one
thing only: **re-reading the registry**, which is a claim about all 500 questions at once and therefore
has to ask all 500.

Everything else — the question "does this mechanism help, and by how much" — can be asked for between
**0.21 and 3.91 CNY**, and the reason that was not visible before is that no instrument priced a
_different_ design. `spend-projection.mjs` prices a dispatch along two axes and refuses the third, with
the refusal written down: §13.348's first capability-scoped dispatch was projected at 1.73 CNY, billed
5.87, and lost its case to a census assumption. This document is the third axis done as composition
rather than as scaling.

## 1. The ladder, priced from a bill

`tools/scoped-spend.mjs` reads one billed artifact, takes `costPerCapability`'s own per-capability rows,
and prices a design as the sum of the parts it names. Nothing is extrapolated along the population axis,
because the population is made of the parts. The instrument is trusted to the extent that it reproduces
the bill it was priced from, and it does, exactly:

```
whole file   500   4   2    15.64 CNY  100.0%     <- the artifact's own total: 15.636
```

The rest of the ladder, cheapest first, on the 600-character reading (`45340177345`):

| design     | questions | reps | arms |   CNY |  share |
| ---------- | --------: | ---: | ---: | ----: | -----: |
| `ABS`      |        30 |    1 |    1 |  0.18 |   1.2% |
| `KU`       |        72 |    1 |    2 |  0.49 |   3.2% |
| `TR`       |       127 |    1 |    2 |  0.89 |   5.7% |
| `IE`       |       150 |    1 |    2 |  1.03 |   6.6% |
| `MR`       |       121 |    1 |    2 |  1.29 |   8.2% |
| whole file |       500 |    1 |    2 |  3.91 |  25.0% |
| `MR`       |       121 |    4 |    2 |  5.14 |  32.9% |
| whole file |       500 |    4 |    1 | 13.82 |  88.4% |
| whole file |       500 |    4 |    2 | 15.64 | 100.0% |

Two rows of that table are the whole argument. A mechanism whose reach is one capability costs **3% to
8%** of a registry pass to test, and a registry pass at one repetition costs **25%** of itself. The
factor between "measure it" and "re-read everything" is between 4x and 30x, and it was never a
budget decision — it was the only design anyone had typed.

## 2. What each axis buys, and why it is not all the same kind of claim

| axis            | claim                                                                                        | evidence                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **capability**  | composition: each question's prompt is its own, so a subset's bill is the sum of its rows    | exact; the ladder closes on the artifact                                                   |
| **repetitions** | linear in tokens, because each repetition is a separate call                                 | `40722772896`: 2.87x **wall clock** for 4 against 1 — so tokens scale but latency does not |
| **arms**        | the baseline side is priced at **13.5%** of the feature side, measured on the same questions | pricing both arms at the feature rate overstates a two-arm run by 11.6 of 15.6 CNY         |

The arm axis is where a plausible mistake is most expensive. `costPerCapability` splits the **feature**
side only, so "two arms" looks like "twice the row". On the artifact this was written against the
feature side is 13.44 CNY and the baseline is 1.82 — raw retrieval against a reasoning reader — so
doubling the row would have overpriced every design in this document by 74%.

The judge is the third line, and it is **0.37 CNY, 2.4%** of the bill. It is apportioned by
question-runs rather than by arm, because it grades one answer per question-run regardless of how many
sides produced one.

## 3. The rule that keeps a scoped run honest

A narrow run is cheap and therefore tempting, and it has one failure mode that the full pass does not:
**nothing in it can show that the treatment could not have moved the thing it moved.** §181 measured
that failure at 3.75 questions — an uncapped capability gaining 3.75 between two runs that were supposed
to differ only in a cap the capability cannot reach. A single-capability run has no such control built
in, so it has to buy one:

> Every scoped dispatch names at least one capability the treatment **cannot** reach, and reports its
> delta beside the treated one. The cheapest such capability is `ABS` at **0.21 CNY**.

Without that row, a scoped delta of +5 is indistinguishable from a drift of +4, and the saving has been
spent on an unreadable number.

## 4. The stopping rule

1. **Screen at the cheapest design that can reject the hypothesis**, which is the treated capability or
   capabilities plus one unreachable control, at one repetition: 0.5–2.5 CNY.
2. **Confirm once, at the registry shape**, and only for mechanisms that have survived step 1. This is
   the 15.64 and it is not avoidable for a mechanism that changes what the product ships, because the
   published number is defined at 500 x 4 and a mechanism that moves bytes moves every published number.
3. **Batch the confirmation.** Two mechanisms that are route-disjoint — proven by a prompt byte gate,
   the way §181's 400/600 pair was not — can land in one pass. Two mechanisms whose reach overlaps
   cannot, and their interaction is a third mechanism nobody registered.

A three-mechanism campaign under this rule is **one** registry pass plus two or three screenings:
roughly **17–21 CNY**, not 47.

## 5. What this document does not claim

1. **A screening is not an adoption reading.** The number it produces is a delta on a population, and
   the registry records accuracy over 500 questions. Adopting on a screening alone would publish a
   figure no run measured.
2. **One repetition cannot price a range.** The four repetitions exist because the range is what the
   acceptance matrix's `min` column reads; a 1-rep screening answers "did it move", not "how stable is
   the move".
3. **These are list prices, not an invoice.** The provider bills what it bills; the projection's own
   record is a 10% miss in the conservative direction (§181: projected 14.26, billed ~15.6 at the
   artifact's own token counts).
4. **Cheap is not the same as sufficient.** A capability that carries 40% of the bill — `MR`, at 4.45 of
   13.44 — is the one whose mechanisms are worth the most and cost the most to test. The ladder tells
   you the price of asking, not the value of the answer.
