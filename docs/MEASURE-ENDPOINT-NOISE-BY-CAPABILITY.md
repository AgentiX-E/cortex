# Measuring the endpoint's own noise, per capability and per repetition

    node tools/quantify-endpoint-noise.mjs <report.json> [...]
    # every input must be the SAME configuration: this measures noise

The two runs below are `42452904894` and `42467392736`, 500 questions each, four repetitions each,
`promptDigest` identical on 500 of 500 (`§13.326`). The readout is reproduced verbatim at the bottom.

## Two figures, two questions

| figure | question it answers | where it comes from |
| --- | --- | --- |
| roster movement between runs | how far can the **verdict** move if I re-run? | `questions[].correct`, the post-vote verdict |
| repetition instability within a run | how many questions does the **reader** fail to decide? | `ablation.featureCorrectByRun`, four masks |

The vote absorbs about half. `MR` is where that is most expensive: 15 and 16 questions are unsettled and
7 verdicts still moved, so the 7 is not decisiveness — it is eight questions the vote happened to hide.

## The bar, and the bar at 95%

| capability | n | moved | observed floor | at 95% |
| --- | ---: | ---: | ---: | ---: |
| `ABS` | 30 | 0 | 1 | 5 |
| `IE` | 150 | 5 | 6 | 13 |
| `KU` | 72 | 2 | 3 | 8 |
| `MR` | 121 | 7 | 8 | 15 |
| `TR` | 127 | 2 | 3 | 9 |
| overall | 500 | 16 | 17 | 27 |

Before `§13.330` every capability row printed 17, because the whole-sample movement was substituted into
each one. A bar that can only rise is safe against false positives and blind to true effects.

## Instability

| capability | `42452904894` | `42467392736` |
| --- | ---: | ---: |
| `ABS` | 0 / 30 (0.00%) | 0 / 30 (0.00%) |
| `IE` | 7 / 150 (4.67%) | 6 / 150 (4.00%) |
| `KU` | 3 / 72 (4.17%) | 1 / 72 (1.39%) |
| `MR` | **15 / 121 (12.40%)** | **16 / 121 (13.22%)** |
| `TR` | 5 / 127 (3.94%) | 5 / 127 (3.94%) |
| overall | 30 / 500 (6.00%) | 28 / 500 (5.60%) |

`settledCorrect` (15 and 13) is the half the product gets right by luck — the headroom a stabilising
change converts into durable wins. `settledWrong` (15 and 15) is a harness ceiling.

## How to read a claim

| claim shape | must clear | why |
| --- | --- | --- |
| net delta in correct answers | the roster churn: 17 observed / 27 at 95% overall, 8 / 15 on `MR` | a difference of counts is indistinguishable from re-running |
| paired one-directional movement | the discordant counts: `6-0` is `p = 0.031`, `8-0` is `p = 0.008` | McNemar conditions on the discordant pairs; agreed questions carry no information |

An `MR` claim of 5 questions is neither: 5 net is inside 8, and 5 paired against 12:7 discordant is
`p ≈ 0.36`.

## Verbatim readout

```
--- per-capability floor ---
  ABS  n= 2  min 30, max 30, range: 0 questions (0.00 pp)  roster: 0 (capability)  minQuestionsStrictlyGreaterThan: 1  at95: 5
  IE   n= 2  min 141, max 144, range: 3 questions (2.00 pp)  roster: 5 (capability)  minQuestionsStrictlyGreaterThan: 6  at95: 13
  KU   n= 2  min 64, max 64, range: 0 questions (0.00 pp)  roster: 2 (capability)  minQuestionsStrictlyGreaterThan: 3  at95: 8
  MR   n= 2  min 99, max 100, range: 1 questions (0.83 pp)  roster: 7 (capability)  minQuestionsStrictlyGreaterThan: 8  at95: 15
  TR   n= 2  min 119, max 121, range: 2 questions (1.57 pp)  roster: 2 (capability)  minQuestionsStrictlyGreaterThan: 3  at95: 9

--- repetition instability (questions the vote decided, not the reader) ---
r42452: 4 repetition(s), unstable 30/500 (6.00%), settled correct 15, settled wrong 15
  ABS  unstable  0/ 30 (0.00%)  unanimous 30  settled correct 0, wrong 0
  IE   unstable  7/150 (4.67%)  unanimous 143  settled correct 4, wrong 3
  KU   unstable  3/ 72 (4.17%)  unanimous 69  settled correct 2, wrong 1
  MR   unstable 15/121 (12.40%)  unanimous 106  settled correct 7, wrong 8
  TR   unstable  5/127 (3.94%)  unanimous 122  settled correct 2, wrong 3
r42467: 4 repetition(s), unstable 28/500 (5.60%), settled correct 13, settled wrong 15
  ABS  unstable  0/ 30 (0.00%)  unanimous 30  settled correct 0, wrong 0
  IE   unstable  6/150 (4.00%)  unanimous 144  settled correct 2, wrong 4
  KU   unstable  1/ 72 (1.39%)  unanimous 71  settled correct 1, wrong 0
  MR   unstable 16/121 (13.22%)  unanimous 105  settled correct 10, wrong 6
  TR   unstable  5/127 (3.94%)  unanimous 122  settled correct 0, wrong 5

--- required effect size ---
basedOnObservations: 2  minQuestionsStrictlyGreaterThan: 17  floorPp: 0.80  at95: 27
floor source: the ROSTER, not the score (4 question(s) of score range, 16 question(s) of roster movement)
```

## What the tool refuses

- A one-repetition artifact reports `NOT MEASURED`, never `0 unstable`: one sample cannot demonstrate
  stability, and `unstable 0/121` would be read as a reader that decides everything.
- A mask whose length disagrees with the roster is a hard error: the masks are indexed by roster
  position, and a length mismatch aligns unrelated questions.
- A report with no per-question roster is a hard error rather than "0 moved".
- Runs whose question sets differ are refused rather than compared by index.
