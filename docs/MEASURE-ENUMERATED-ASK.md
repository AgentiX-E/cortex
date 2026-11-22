# MEASURE — The `enumerated` ask, and what an output shape costs

## 0. One paragraph

`ask=enumerated` was dispatched to convert the largest single failure family this repository had
identified: of 19 wrong `MR` questions in run `44768451597`, **18 had their gold number absent from
the delivered block** — the reader was never shown the arithmetic it was asked to perform. Asking it
to enumerate was supposed to fix that, and the projection written into five documents was **+2.00 on
`MR`, +2.60 overall, 93.85%**. Run `44962474136` measured it: **89.70%** over four repetitions against
the registered arm's **91.25%**, and `MR` fell from **102 to 95.8** of 121. The mechanism did not
fail to work; it worked, and it is negative. The reason is the same one that made `deepseek-v4-pro`
lose 7.20 points in an earlier round: **the judge is exact match with a judge fallback, so an answer
that arrives in a longer shape is a wrong answer more often, whatever it knows.** `ask` is not a
reasoning knob. It is an output-shape knob, and this run prices one shape at −1.55 points.

## 1. The reading

`44962474136`, one field against the registered configuration (`ask=verbatim-acts` → `ask=enumerated`),
500 questions, four repetitions.

| reading               | registered (`43140878641`) |                    `enumerated` (`44962474136`) |                             delta |
| --------------------- | -------------------------: | ----------------------------------------------: | --------------------------------: |
| overall, mean of four |  456.25 / 500 = **91.25%** | 448.6 / 500 = **89.70%** (min 89.20, max 90.00) | **−7.65 questions, −1.53 points** |
| `MR`                  |          102 / 121 = 84.3% |                             95.8 / 121 = 79.17% |  **−6.2 questions, −5.12 points** |
| `TR`                  |       122.25 / 127 = 96.3% |                            119.5 / 127 = 94.09% | **−2.75 questions, −2.17 points** |
| `IE`                  |        138.5 / 150 = 92.3% |                            137.8 / 150 = 91.87% |      −0.7 questions, −0.46 points |
| `KU`                  |          63.5 / 72 = 88.2% |                              66.5 / 72 = 92.36% |      +3.0 questions, +4.17 points |
| `ABS`                 |             30 / 30 = 100% |                                29 / 30 = 96.67% |       −1.0 question, −3.33 points |

The registered figure is the one this repository plots (`456.25/500`); the run's own first repetition
reads 450/500 = 90.00%, and the four-repetition mean is the registered statistic. Both are printed in
the artifact, and neither is the number to compare against a single-repetition competitor claim.

## 2. Which rows the treatment could reach, and which it could not

The artifact's config line says `Evidence ask reached: 3 route(s) — multi-session, flat, temporal`.
`evidenceRouteOf` maps `MR → multi-session`, `TR → temporal`, `IE → flat`, `KU → knowledge-update`,
`ABS → abstention`. So two of the five rows were **never treated**, and their movement is the arm's
own four-repetition floor rather than an effect:

| row   | treated? | movement |
| ----- | -------- | -------- |
| `MR`  | yes      | −6.2     |
| `TR`  | yes      | −2.75    |
| `IE`  | yes      | −0.7     |
| `KU`  | **no**   | +3.0     |
| `ABS` | **no**   | −1.0     |

That is the useful half of a losing run: **an untreated row moved by 3 questions and 4.2 points.** Every
future bar on a single capability has to clear ±3 questions before it can be called a mechanism, and
the retraction this document accompanies is the second time in this campaign that a
sub-3-question movement was nearly read as one.

## 3. Why the projection was wrong

The failure census behind it was sound and is unchanged: 18 of 19 wrong `MR` golds in `44768451597`
had no copy of their number in the delivered block, and 16 of 19 delivered every gold turn (84%). What
was wrong was the inference. _The number is absent from the block_ has two remedies — show the reader
more evidence, or make the reader compute from what it has — and the census cannot tell them apart.
The projection chose the second and read the first as impossible.

The run then chose for us. `ask=enumerated` changes what the reader is asked to produce, not what it
is shown; the evidence block was byte-identical in shape, and two of the three treated rows fell. The
mechanism is the one §155.6 recorded for `deepseek-v4-pro` (417 → 381, −7.20): a model asked for a
number and given room for prose returns prose, and a longer reply is wrong more often under exact
match. **Two independent dispatches, one rule.**

## 4. What this closes, and what it leaves

**Closed.** `ask=enumerated` on the registered arm. The registered bar was `≥ 92.75%`; the reading is
`89.70%`. The axis is retired in `RETRACTIONS.md` #23 and not retried on a subset — a mechanism that
lost 6.2 questions on its own target row does not become viable at a smaller sample.

**Open, and now better aimed.** `MR` is 102/121 and the reference pipeline is 103.75/121; published
competitors read 92.5–93.7 on the same row. The gap is ~10 questions, and the two things known about
it are:

1. **71 of 121 questions have gold found by the loop and not carried** (`44867629266`, `maxSteps=1`).
   The probe's own reading was `gold seed/selected/carried/total = 862/1448/1377/3663`: the reader's
   own search added 586 gold turns over the seed, and the room then refused 71 questions' worth.
2. **The room is not the remedy.** `multi-session` 48,460 → 62,000 was measured negative, and 48,460 →
   24,000 costs only 2.75 questions. A window that is not short of characters and still refuses a
   third of its golds is a **ranking** result, not a room result.

So the next axis is not "show more" and not "ask differently". It is **let the reader look twice**:
`multiStep` is built (`cortex-ai/agent`), measured offline (586 gold turns), and has never been in an
evaluation arm. §157 is the pre-registration.

## 4a. A second hypothesis, tested offline and refuted in one hour

The archive made one more reading possible without a dispatch, and it is worth recording because it
was the cheapest explanation on the shelf: `maxTurnChars = 400` clips every turn, and a clipped turn
still counts as `carried`. So "the gold turn was delivered and its number was not" could have been one
mechanism with one fix.

It is not. For the 22 wrong numeric `MR` questions of `44962474136`, the position of each gold number
inside its gold turn reads:

| first occurrence of the gold number     | questions |
| --------------------------------------- | --------: |
| inside the first 400 characters         |    **15** |
| beyond 400 characters                   |     **0** |
| no gold turn contains the number at all |     **7** |

Fifteen of the twenty-two **had the number inside the clip**, and not one of them was a clipping
casualty. A window constant cannot be the remedy for a reader that was shown the number and answered
something else, and the axis is closed before it cost a dispatch.

The seven with no hit are the arithmetic family, and they are the ones where the gold is a **sum**:
`d851d5ba` `$3,750`, `gpt4_731e37d7` `$720` (= 700 + 20), `2b8f3739` `$495` (= 375 + 120),
`d6062bb9` `1,998` (= 1456 + 542), `a1cc6108` `11`, `37f165cf` `856`, `9ee3ecd6` `100`. None of these
numbers is printed anywhere in the corpus, which is `tools/mr-arithmetic-census.py`'s `absent` column
read from the other side.

## 4b. What the fifteen actually did

Three raw outputs, quoted because the taxonomy is the whole result of this run:

| question                                                                      | reader's own step 1                                        | answer | gold | defect                                                           |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------- | -----: | ---: | ---------------------------------------------------------------- |
| `0a995998` — "how many items of clothing do I need to pick up or return"      | two items: a blazer at the dry cleaner and a pair of boots |      2 |    3 | **listed two of three**, and `goldOverlap` reads 17/17 delivered |
| `2ce6a0f2` — "how many art-related events did I attend"                       | two events: a gallery lecture and an exhibition            |      2 |    4 | **listed two of four**                                           |
| `gpt4_372c3eed` — "years of formal education, high school through bachelor's" | four years at UCLA, 2010–2014 at high school               |      8 |   10 | **arithmetic on correctly retrieved facts**                      |

So the failure is not that the reader was not asked to enumerate — it enumerated, twice, and both
times the list was short while the evidence block held every gold turn. The reader was **looking at
194 turns and finding two of them**, which no ask can repair and no window can shorten: the block at
`46,758` delivered characters is already the whole haystack for those questions, ranked, and the
missing items were inside it.

**This is the first evidence in this campaign that the `MR` gap is an attention result rather than a
retrieval, room or contract result** — and it reframes every one of the three plans written against
`MR` so far. A ranked haystack that fits in the room is a haystack the ranking does not shrink; to
shrink it, the reader has to look twice, or the ranking has to cut. That is §157's subject.

## 5. Cost, read from the same artifact

| reading                              |                       `enumerated` |
| ------------------------------------ | ---------------------------------: |
| prompt tokens per question           |                              7,501 |
| prompt tokens per correct answer     |                              8,362 |
| provider spend, attributions closing | 17,899,612 + 207,744 prompt tokens |
| transport losses                     |                           0 of 500 |
| judge share of scoring               |              1,527 / 4,000 = 38.2% |

Against the 7,448 prompt tokens per question this repository plots for the registered form, the ask
costs **+0.7%**. It is not a cost lever either, so nothing recommends it on the second axis while it
loses 1.53 points on the first.
