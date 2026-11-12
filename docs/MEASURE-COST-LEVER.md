# MEASURE — Which knob actually moves the cost

## 0. One paragraph

A challenge put to this project was that a competitor runs at one-eighth the cost for a better score, and
that the answer should therefore be to copy its implementation. Two of the three premises are wrong, one
is right, and the run that answers them was dispatched for a different reason. `42522552589` cut the
retrieval pool by **eight times** — `relevanceTopK 256 → 32` — and the bill moved by **1.2%**: 12,137 to
11,993 prompt tokens per question. The pool was never what filled the window. **63.5% of the delivered
characters are turns no relevance signal ever scored**, restored as anchor neighbourhoods, and the
remainder is bounded by a configuration constant. So the cost has exactly one lever, and every
measurement of it already exists in this repository — including the one that matters, which the
repository had mis-attributed. The per-route room was measured at **0.754x the bill for 1.05 points**
and the published price of that family was "`MR` −6.61, the room is load-bearing"; **5.75 of those
questions are `ask`**, a second variable inside a pair that was read as one. This document collects the
measurements onto one axis, in the unit a customer pays in — **prompt tokens per correct answer** —
because that is the only axis on which "cheaper" and "better" are the same question.

## 1. `E2`, read: the pool is not the cost

`42522552589`, one variable against the registered configuration: `cortex_memory_relevance_top_k=32`
against `256`. Five hundred questions, four repetitions, `ask=verbatim-acts`, `relevance=retrieval-anchored`,
`evidenceSource=corpus`.

| reading                          | registered (`42521885948`) |    `E2` (`42522552589`) |        delta |
| -------------------------------- | -------------------------: | ----------------------: | -----------: |
| accuracy, first repetition       |           91.90% (460/500) |    **90.80%** (454/500) | −6 questions |
| accuracy, 4-run mean             |                     91.90% |              **90.30%** | −8 questions |
| prompt tokens per question       |                     12,137 |              **11,993** |    **−1.2%** |
| delivered prompt characters      |                     47,468 |                  47,468 |            0 |
| share of the 48,000 cap used     |                      98.9% |               **98.9%** |            0 |
| `goldOverlap` recall             |        87.9% (6,608/7,516) | **83.4%** (6,271/7,516) |  −4.5 points |
| prompt tokens per correct answer |                     13,207 |                  13,281 |        +0.6% |

The registered judgement had three bands. This lands in the **second** (`6–15` questions lost): the
frontier moves and there is no dominance. But the band was not the interesting part, because the band's
own premise — that cutting the pool by eight would cut the bill by eight — **did not happen**. A
hypothesis that predicted an eightfold saving produced a 1.2% one, and an experiment is refuted by its
own mechanism endpoint before it is graded on its accuracy endpoint.

### 1.1 The mechanism, in the artifact's own fields

`windowComposition` is recorded per question and it was already carrying the answer:

| field                                                        | per question |            share |
| ------------------------------------------------------------ | -----------: | ---------------: |
| characters selected by the relevance signal (`offeredChars`) |       18,468 |        **36.5%** |
| characters restored with no score at all (`unscoredChars`)   |       32,160 |        **63.5%** |
| delivered prompt characters                                  |       47,468 | 98.9% of the cap |
| turns in the window                                          |        124.6 |                — |
| turns the signal actually ranked                             |         30.2 |              24% |

`relevanceTopK` bounds the **scored** pool, and the scored pool contributes a third of the prompt. The
other two thirds come from `selectByAnchorWindow` restoring each anchor's same-session neighbourhood —
a mechanism adopted for its recall (`6433.260.7`: 6,520 of 7,516 gold turns reachable) at a measured
accuracy cost of **−1.00 point over 256 paired observations**, against a reader whose own
self-disagreement on byte-identical inputs is −1.20. So the neighbourhoods buy recall that does not
convert into correctness, and they spend two thirds of the budget doing it.

That is why narrowing the pool changes nothing: the pool was never the constraint. It is also why the
character room _is_: `47,468 / 48,000 = 98.9%` means the delivery is not a selection that happens to be
large, it is a window filled to its cap. **The cost is the cap.**

## 2. The lever, and every point already measured on it

Five dispatches have moved the room, and until this round they were not all on one axis. Two of them
differ from their controls in **`ask`** as well, and `ask` is worth `MR` +5.75 questions on its own
(§13.294). Separating that is what makes the curve readable, and it retracts retraction 12's subject:

| arm                  | room                                 | `ask`           | prompt tokens/question | accuracy | `MR` (mean) |
| -------------------- | ------------------------------------ | --------------- | ---------------------: | -------: | ----------: |
| `42310779222`        | 48,000 everywhere                    | `verbatim`      |                 12,137 |   90.85% |   **95.75** |
| `42373407439`        | 24,000 everywhere                    | `verbatim`      |              **5,623** |   88.20% |   **93.00** |
| `42383171765`        | 48,000 on two routes, 24,000 on four | `verbatim`      |              **9,149** |   89.80% |   **94.00** |
| `42355323615`        | `multi-session: 48,460`, rest 48,000 | `verbatim-acts` |                 12,137 |   91.95% |      101.50 |
| `42522552589` (`E2`) | 48,000, pool 32                      | `verbatim-acts` |                 11,993 |   90.30% |           — |

Read down the `ask=verbatim` block only, and the room's price is three numbers rather than one:

| change                                             |     tokens |     accuracy |            `MR` |
| -------------------------------------------------- | ---------: | -----------: | --------------: |
| 48,000 → 24,000 everywhere                         | **0.463x** | **−2.65 pt** | −2.75 questions |
| 48,000 → per-route (two at 48,000, four at 24,000) | **0.754x** | **−1.05 pt** | −1.75 questions |

**The per-route arm is the product answer and it was already measured.** A quarter of the bill for one
point, with the two load-bearing routes untouched. The published price of this family was
"`MR` −6.61, the room is load-bearing", and §13.294's `ask` measurement is 5.75 of those questions:
the room costs 1.75, and the rest was a second variable inside a pair read as one.

Two further readings, and the second is why the curve is not a straight line.

1. **`E1`'s −15.2 questions is a narrow cut, not a wide one.** It moved `multi-session` alone to
   12,000 while the other five routes stayed at 48,000, and lost 15.2 anyway — almost all `MR`. A
   narrow cut that costs more than a wide one is the signature of the route whose room is
   load-bearing, and it is why the per-route allocation above keeps 48,000 there.
2. **Below 24,000 the curve flattens.** 24,000 costs 2.65 points, 12,000 costs 3.04: the second
   halving is nearly free, so the room between them holds text the reader does not use.
   `PROMPT-ROOM-IS-LOAD-BEARING.md` §4 localises it — on the 252 questions whose answer is one turn,
   halving the room costs **0.79 points**; on the 248 that aggregate, more. The price of a cut is a
   property of the capability, not of the pipeline.

## 3. The unit the decision is made in

`C1` prices prompt tokens per question. A customer buys correct answers, and the bill for them is the
ratio. Placing the competitor rows on the same axis requires their accuracy under **their own**
configuration and under a harness that is not theirs, and both are in `tools/competitor-ledger.json`:

| system                             | configuration                                | tokens/question |   accuracy | tokens per correct answer |
| ---------------------------------- | -------------------------------------------- | --------------: | ---------: | ------------------------: |
| cortex, 48,000 room                | own harness                                  |          12,137 |     91.90% |                    13,207 |
| cortex, per-route                  | own harness                                  |       **9,149** |     89.80% |                **10,188** |
| cortex, 24,000 room                | own harness                                  |           5,623 |     88.20% |                 **6,375** |
| Mem0, self-reported                | GPT-5 answers **and** judges, top-200        |           6,800 |     94.40% |                 **7,203** |
| Mem0, OmniMemEval                  | `gpt-4.1-mini` answers, `gpt-4o-mini` judges |           6,800 | **56.00%** |                **12,143** |
| Mem0, third-party OSS reproduction | same public code                             |               — | **49.00%** |                         — |

The two Mem0 rows are the same system. The distance between them is 38.4 points, and it is the single
most expensive number in this repository's competitive record: it is what a self-reported figure is
worth when a stranger's harness is applied to it. `LANDSCAPE-CONTROLLED-BOARD.md` §3 records an
equivalent −22.40 for Hindsight on the same board.

**On the axis that decides a purchase, this arm is not the expensive one.** At the 24,000 room it
delivers a correct answer for **6,375** prompt tokens; Mem0's published configuration costs **7,203**
for one, and its reproducible configuration costs **12,143**. Only the 48,000 room is dearer than
Mem0's published figure, and by 1.83x — not by eight.

### 3.1 The eight-times figure, and where it comes from

It is a denominator, and the repository already names it. `tools/cost-ledger.py` computes three
defensible divisions of one token count, 4.14x apart on `42310779222`:

| reading                       | arithmetic                              |      value |
| ----------------------------- | --------------------------------------- | ---------: |
| per call                      | `promptTokens / calls`                  |     11,690 |
| per question per repetition   | `promptTokens / (questionCount x runs)` | **12,105** |
| per question, all repetitions | `promptTokens / questionCount`          |     48,420 |

`48,420 / 6,800 = 7.1`. **The eight-times comparison divides a four-repetition total by a
single-context competitor figure**, and the factor between it and the primary reading is the repetition
count — a property of this harness, not of this product. `PREREGISTRATION` §13.293 records the trap in
the tool's own docstring, in the sentence that says `perQuestion` "is the number a reader would reach for
to make us look 8x worse than Zep". Every competitive cost claim in this repository is written on
`perQuestionPerRun` for that reason.

## 4. What this does and does not license

**Licensed.** The room has a measured price on a clean pair, and it is smaller than what this
repository published: **−2.65 points for 0.463x the bill** at 24,000 everywhere, **−1.05 for 0.754x**
on the per-route allocation. A product shipping the per-route allocation is competitive on tokens per
correct answer with the published field and ahead of the reproducible one, and the arm that establishes
it is already in the archive.

**Not licensed.** Quoting the per-route number as the registered configuration's. `42383171765` ran
`ask=verbatim`; the arm ships `verbatim-acts`, and §13.294 prices that at +1.00 point overall. The two
effects are additive only if the route contracts are independent, which is a hypothesis and not a
measurement — hence `C5`, one variable, on top of the configuration that would ship.

**Refused.** Copying the competitor's architecture to reach its cost. `40614772262` ran its code
through this repository's own protocol: recall@k **99.0%** and all-gold **4.0%** on the same 100
questions where this arm reads 87.0% and 73.0%. It returns memories it wrote, not the turns it was
given, at 1,942 tokens — and the turn is what a question about a date inside a turn needs. That is a
compression trade, and §2 says this arm's compression has already been priced: the 24,000 room keeps
the turns and costs 2.65 points, against a competitor configuration that loses 69 points of verbatim
evidence to save 3.7k tokens.

## 5. The residue, and it was not the room

`42383171765`'s `MR` of 94 sits beside a 101 baseline at the same 48,000 `multi-session` room, and
that looked like a routing defect. It is not, and the three checks that exclude each explanation are
cheap enough that the next round should not repeat them.

| hypothesis                                  | check                                                   | outcome                                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| the room never reaches the session assembly | the artifact's own `effectivePromptChars`               | `{"multi-session": 48000, "temporal": 48000, ...}` — resolved per route                                                        |
| the same, at the code boundary              | `prompt-room-by-route.test.ts` (7 tests)                | **green**, including the case that raises `multi-session` above the global room and asserts the other five are byte-comparable |
| the model drifted                           | `42452904894` (`S0`): one configuration, two dispatches | `MR` 100.25 against 101.50, band **±1.25** — the 6.25 gap is outside it                                                        |
| **`ask` differs between the pair**          | the two artifacts' `memoryArmConfig.ask`                | **`verbatim` against `verbatim-acts`** — and §13.294 prices that at `MR` **+5.75 questions** alone                             |

The fourth row is the answer, and it is the same defect class as retractions 1–3: a pair read as one
variable that carried two. `42383171765` ran `ask=verbatim`, its 48,000 control ran `verbatim-acts`, and
5.75 of the 6.25-question gap is `ask`. Attributing the remainder to the room gives **−1.75 questions**,
which is the same size as the clean `verbatim`-to-`verbatim` comparison at 24,000 everywhere (−2.75).

So there is no open defect here and no experiment owed. What is owed is a **product decision**, and it
is the only one this document exists to inform: `42383171765`'s allocation — 48,000 on `multi-session`
and `temporal`, 24,000 on the other four — costs **1.05 points and 24.6% of the bill**, and has never
been shipped. The registered configuration stays at `multi-session: 48,460` until that arm is re-run on
top of `verbatim-acts`, which is the one dispatch this round queues:

| id   | claim                                                                                                                                                                                            | falsifier                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `C5` | the per-route allocation on top of the registered `ask=verbatim-acts` reads **≥ 90.80%** (the 48,000 registered control minus the 1.05 measured above) at **≤ 9,300** prompt tokens per question | an accuracy at or below 89.50% — then the per-route price is more than the `verbatim` pair measured, and the allocation is not adoptable |

One variable: the room map. `ask`, the ranking, the contract, the cap and the pool are the registered
values, so the reading is the allocation's own effect on the configuration that would ship.

**Answered.** Run `42533236864` reads **91.05%** (four-repetition mean, 90.60 to 91.40; first draw
91.20%, 456 of 500) at **9,201** prompt tokens per question. Both criteria met, the falsifier missed by
1.55 points. The allocation is therefore **adoptable**, and the shipping decision it was owed is now a
decision rather than a question. `§13.335.3` states the two things this does not license: 9,201 is not a
cost SOTA (`Maximem Synap` is 7,400 at 95.6%), and this reading does not combine with `E3` — the repair
runs in the room the registration held before §13.336, so the configuration that would ship is the allocation **with** the
repair, which is the next dispatch rather than an inference from these two.

## 6. Addendum (round 57): the numbers above are the predecessor configuration's

Everything in §1–§5 was measured against the 48,000-everywhere configuration (`42310779222`) and the
single-route widening (`42355323615`). §13.336 adopted the six-route allocation, and the registered
configuration bills **9,201** prompt tokens per question (`42533236864`), not 12,137 — so the "48,000 room"
rows above are a record of what the room cost, not of what the product costs. `docs/MEASURE-CONFIGURATION-IDENTITY.md`
is the correction, and `C1` now reads the registered configuration because `cost-ledger.py --write` refuses
an artifact of any other one.

The relative comparison survives unchanged, which is why this is an addendum and not a rewrite: the room's
price (−2.65 points for 0.463x, −1.05 for 0.754x) is a property of the pair, and the pair is intact. What
moves is the row that multiplies it against a competitor: **10,105 prompt tokens per correct answer**, against
Maximem Synap's 7,740 and Mem0's published 7,203 — **1.31x** and **1.40x**, where this document's §3 read
1.71x and 1.83x on the same two competitors.

> **§6.1 (round 59) retracts both of those ratios.** They divide this arm's **whole prompt** per correct
> answer by a competitor's **retrieved context** per correct answer, which is the defect §13.340.3 already
> retracted once for Synap. The corrected table is in [`MEASURE-TOKEN-BASIS.md`](MEASURE-TOKEN-BASIS.md),
> and the correction is a tool rather than a sentence: `tools/token-basis.py --check` recomputes every ratio
> from `tools/token-basis.json` and `tools/competitor-ledger.json` in `pnpm check`, and refuses a ledger
> cost that does not declare what it counts.

## 7. The unit a published bill is written in, and the one line that produces it

`LLMSlim`'s BEAM-1M round publishes cost **per thousand questions**, including each system's memory-build
calls, which is the only unit in the competitive record that a reader can compare without knowing the other
system's harness. This repository had no such row: every cost instrument answers "what did that run cost" in
the run's own shape, and a run's shape is not a unit.

`tools/spend-projection.mjs` now prints it, from the observed run's own per-question price and no scale factor:

```
$ node tools/spend-projection.mjs --report <artifact> --limit 500 --runs 4 --side feature
  TOTAL           11.08 CNY   (cache hit 97.8% of input)
  per 1,000 qs    5.54 CNY at list price, reader calls only (embeddings not in the artifact: floor)
```

Three things the line says and one it refuses to.

- **It is exact for the run it came from.** No projection is applied; the factor is 1.
- **It is the feature side.** `--side llmUsage` would print both arms, which is a number about two systems.
- **It is a floor.** Embedding calls are not in the artifact, so the row excludes them and says so. A total
  presented as a floor is the defect every other cost row here was written to prevent.
- **It does not re-price a changed thinking reach.** Output tokens are a property of the questions asked, so
  a dispatch that turns reasoning off cannot be priced by scaling a run that had it on — which is why the
  confirmation in `PREREGISTRATION` §13.360.6 measures spend rather than projecting it.

The composition is the part worth reading beside the total: **6.67 of the 11.08 CNY is output** — 60% of the
bill is the reader thinking, on prompts whose input is 97.8% cache hits. So the mode is not an input-cost
question, and the ledger's context-token rows (8,941 per question) are not where that money is.

## 8. Addendum (round 76): the criterion this document measured was never met, and the floor says why

`MEASURE-COST-FLOOR.md` is the correction, and two of this document's readings are its subject.

**The 5,623 in §2 is not a `C1` reading.** It is the *median* delivered **evidence** characters divided by 4.06,
against a threshold written on *mean billed tokens*; the ledger on the same arm (`42373407439`) reads **6,077**.
So `C1` was never cleared by any dispatched configuration, and the closest miss is 1.3%.

**The per-route allocation cut the bill and raised the floor.** §5 reads `42383171765` as 9,149 tokens for
−1.05 points, which is correct, and this document treats the bill as the quantity the allocation moves. It is not
the only one. The floor — what the load-bearing capabilities bill by themselves — moved **up**, from 6,057 to
6,167, because the four routes the allocation narrowed were 48.4% of the delivered characters in the 48,000-
everywhere arm and the floor is the heavy routes' share of that total. Cutting the light routes removes the
headroom, not only the cost.

The consequence is that `C1` and `S3` cannot both be satisfied here, which no row in this repository said before:
`S3` needs `MR` at a room it already has and does not reach 85% in, and that room alone exceeds `C1`. What the
same document prices is the exit — 3,703 tokens per question for a window sized to its own evidence.
