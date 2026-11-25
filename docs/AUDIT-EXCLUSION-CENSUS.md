# AUDIT-EXCLUSION-CENSUS

What the adopted arm's own artifact says about its last 34 failures, and why the step the last audit recommended is
not the step that comes next.

The reading in one sentence: **`MR`'s remaining error is a decision the reader makes and writes down, not a
delivery it does not get** — nine of the route's thirteen failures carry every gold turn and the other four are
short by one to five — and the decision is narrow enough to name, price and register as one line.

## 0. Two readings this round took without a dispatch

### 0.1 The step §193.7 recommended has no object

§193 read a reader-axis pair, found that a reply which copies the contract's generic `Step 1` heading is wrong
twice as often as one that instantiates it, and recommended changing the heading. That reading was taken on
`enumerated`, whose `Step 1` is the sentence *"list every item in the evidence that matches the question"* — a
predicate over the answer that a reader can paste back.

`enumerated` is **not** what the adopted arm reads. `45543010618` carries `ask: verbatim-acts`, whose multi-session
`Step 1` is *"Enumerate every item matching the question's EXACT action, one per line"*. Over the 63 replies of
shard 0:

| literal from the instruction | replies containing it |
| --- | ---: |
| `EXACT action` | **0** |
| `Enumerate every item` | **0** |
| `substitute or infer` | **0** |

and the headings readers actually write are `Step 1:` bare (7) or their own (`Step 1 — candidate feed purchases`,
5), with 51 replies writing no `Step 1` line at all because four of the five other routes never receive that block.
On the adopted arm the discriminant's prevalence is **zero**, so its separation is undefined rather than small, and
the cost of the recommended dispatch (¥5.87) would have bought a measurement of nothing. `RETRACTIONS.md` §27
records it as a retracted **recommendation**, not as a retracted reading: the `enumerated` result stands and is
about a retired contract.

This is the second time a lever has been nominated without its object being checked. §191.8 priced one ¥8 and found
it had no object after measuring 105 `MR` pairs for a shared first turn. The check is now the first step of a
round rather than a discovery inside it: **does the mechanism name a population that exists in the configuration
being shipped?**

### 0.2 The merge that was refused, recovered

`45543010618`'s `merge the shards` job failed: `refusing: shard 1 differs from shard 0 in memoryArmConfig`. §190.1
diagnosed it (`selfIndex` is a reading folded into the configuration block and absent from the merge tool's census
list), fixed it with `tools/arm-config-census.json`, and quoted a merged result in prose without archiving the
document. This round re-downloaded the eight artifacts and re-ran the tool against them:

```
merged 8 shards -> 500 questions (500 corpora x 1 windows), 2 repetition(s)
  accuracy per run: baseline 0.9180, 0.9160 | feature 0.9320, 0.9380
  mean: baseline 0.9170 | feature 0.9350 | difference 0.0180
```

`feature 0.9350` is the published number to four places, so the reading is verified rather than quoted, and the
fix is exercised against **archived artifacts** — the case its own docblock says the fallback list exists for,
because those artifacts predate `memoryArmConfig.censusKeys`.

## 1. The map: 500 questions, 32.5 wrong, and where they are

Per capability on the feature side, merged, first repetition (the mean over two repetitions is the 93.50 above):

| capability | n | correct | accuracy | wrong | failures carrying **every** gold turn | gold turns carried by the failures |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `MR` | 121 | 108 | 89.26% | 13 | **9** | 249 / 258 (97%) |
| `TR` | 127 | 122 | 96.06% | 5 | **0** | 59 / 77 (77%) |
| `IE` | 150 | 141 | 94.00% | 9 | **0** | 53 / 110 (48%) |
| `KU` | 72 | 65 | 90.28% | 7 | **0** | 83 / 162 (51%) |
| `ABS` | 30 | 30 | 100.00% | 0 | — | — |
| all | 500 | 466 | 93.20% | 34 | **9** | 444 / 607 (73%) |

`goldOverlap.carried` against `goldOverlap.total` is the column that decides what kind of mechanism can pay, and it
splits the five capabilities into two regimes that no single change can address:

- **`MR` is a decision regime.** Nine of its thirteen failures carried every gold turn and the other four were
  short by 1, 1, 2 and 5 — 97% of the route's failing gold turns were on the page. A reader that reads carefully
  and still chooses wrong is not fixed by retrieval, by a wider window or by a better index.
- **`TR`, `IE` and `KU` are delivery regimes.** Not one of their 21 failures carried all of the gold, and the
  three capabilities carry 77%, 48% and 51% of their gold turns respectively. Those are ranking, room and budget
  questions, and the arm has already measured the knobs that move them (`§13.79`'s pool, `§193`'s width).
- **The split is a fact about this artifact, not a claim about the capabilities.** `TR` at 77% is close enough to
  `MR` that a wider window could move it into the decision regime; `IE` at 48% is not.

`ABS` at 30 of 30 is a floor, not a strength: the gold is a decline on all thirty, so the capability is graded on a
one-sided criterion.

## 2. The census: what a reply says when it leaves something out

`tools/exclusion-census.mjs` reads every `excluded` line in a reply and buckets the reason it states. On the
`MR` population:

```
MR  121 questions, 108 correct (89.3%), 13 wrong

  reply                      replies  correct    acc
  excludes nothing                49       47  95.9%
  excludes something              72       61  84.7%

  reason it cites            replies  correct    acc  lines in wrong
  period                          50       42  84.0%    119        8
  verb                            10        7  70.0%     12        3
  category                         2        1  50.0%      4        1
  planning                        21       19  90.5%     32        2
  absence                         10        7  70.0%     10        3
  duplicate                       10        8  80.0%     13        2
```

Three readings, and the third is the one that decides:

1. **Excluding is the marker.** 95.9% against 84.7% is an eleven-point gap on a 49/72 split, and eight of the
   thirteen failures are in the lower row. A reader that finds nothing to drop is a reader that found the answer.
2. **The gap is not proof that excluding is wrong.** 61 of the 72 are correct. The question is which licence the
   wrong ones used, and 119 of the population's 190 exclusion lines cite a period or a date.
3. **A bucket is not a cause.** `period` at 84.0% is nearly the population rate, so the bucket alone would not
   justify a line. What justifies it is the three replies below, where the gold counts what the period-screen threw
   away — arithmetic, not correlation.

## 3. Three replies read to the gold turn

### 3.1 `3a704032` — "How many plants did I acquire in the last month?" (gold `3`, answered `2`)

```
- Snake plant | acquired (got) | 2023/05/25 — excluded from the last-month window: described as received
  "last month," which points to the prior calendar month rather than the recent 30-day period
```

The evidence line is *"my snake plant, which I got from my sister last month"*, and the question asks for *"the last
month"*. The reply resolved the question's relative period against the session dates, landed on April, and dropped
the one item whose own words are the period the question names. The gold counts it.

### 3.2 `gpt4_731e37d7` — "How much total money did I spend on attending workshops in the last four months?" (gold `$720`, answered `$220`)

```
- Digital marketing workshop (Mar 15–16) | ... | 2023/02/26 — outside last four months; no cost stated.
- Workshop with Jane (Mar 22) | ... | 2023/02/26 — outside last four months; no cost stated.
```

*"Mar 15–16"* is a date the **evidence** states, in a session dated `2023/02/26` — before it. The reply applied the
question's window to the session date, called a future-dated mention "outside", and lost the `$500` the mention
names. `$200 + $20 + $500 = $720` closes on the gold exactly.

### 3.3 `37f165cf` — "What was the page count of the two novels I finished in January and March?" (gold `856`, answered `INSUFFICIENT_EVIDENCE`)

```
- The Nightingale | finished | 2023/05/22 — page count 440; described as "just finished" in May, not January or March.
- Unnamed 416-page novel | finished | 2023/05/27 — page count 416; described as "just finished" in May, not January or March.
```

Both items are in the list, both page counts are in the list, and `440 + 416 = 856` is the gold. The reply wrote the
answer down and then declined because the session dates did not match the question's months.

### 3.4 What the three have in common

Every one is a **date** exclusion of an item the gold counts, and in every one the exclusion is settled by the
**session's** date rather than by the mention's words. That is the axis `verbatim-scope` moved in the other
direction: §13.291 added *"the act must fall inside the period the question names"*, `S17` read 98 of 121 against
the control's 102 (two conversions, six regressions, exact McNemar p = 0.070), and one of the six regressions is
`3a704032` — the first reply above. The axis has a measured price at one end, which is why the other end is worth a
dispatch.

## 4. What this does not say

- **Not** that the four over-counting failures are dated. `gpt4_2f8be40d` counts one cousin's wedding twice,
  `gpt4_7fce9456` counts *"fell in love with"* as a viewing, and `d851d5ba` sums *"the event raised over $5,000"*
  into a total the gold bounds to the speaker. None of the three invokes a turn date, so a line about the clock
  cannot make them worse and is not expected to make them better.
- **Not** that `TR`, `IE` and `KU` are close. Their twenty-one failures carry 77%, 48% and 51% of their gold
  turns, which is a different regime and a different plan.
- **Not** that the header reading was wrong. `enumerated`'s heading result is intact; what was wrong was applying it
  to an arm that does not render that sentence.

## 5. The instrument

`tools/exclusion-census.mjs`, 11 self-test assertions over a constructed population:

- the capability filter keeps its own population, and an absent capability is **refused** rather than printed as
  zeros, because a table of zeros reads as a finding;
- a reply that excludes nothing is counted in its own row, which is the comparison the mechanism rests on;
- a line that cites two vocabularies lands in both buckets, because forcing one would hide whichever it dropped;
- several shards of one dispatch concatenate into one population, since a per-shard accuracy is a number about a
  shard.

It is wired as `guard:exclusion-census` and runs its self-test only: a guard that needs a 15 MB artifact cannot run
in CI, which is the same arrangement `guard:paired-delta` has.

## 6. What follows

`PREREG-CLOCK-AXIS.md` registers one line on the act rule — a turn is dated by when it was said, not by when the
thing happened — at **¥5.87** (`MR` × 2 at the measured `0.0243 CNY` per question-run), with `C1`–`C4` and `R1`/`R3`
stated before the dispatch and `C3`-passing-with-`R1`-failing written as the negative that closes the axis in both
directions.
