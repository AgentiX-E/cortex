# The failures, by class: nothing left in this arm is above its own floor

**Three sentences.**

1. The adopted arm's **34 failures** decompose into **eight deterministic classes** in **three
   institutions**, and the largest single class is **9 questions**.
2. Not one class clears the sample floor of the population it lives in — the closest is `derived-number` on
   `multi-session` at **4.96 points** against a floor of **7.89** — so **no single-class mechanism left in the
   queue can be certified** on this benchmark, which is why five rounds of single-lever dispatches have
   produced no certifiable reading.
3. The **numeric institution bundled** (`derived-number` + `number-misselected` + `number-absent` = 19
   questions) is the only target in this arm whose ceiling exceeds its floor, on both populations it can be
   read on: **3.80 vs 3.15** on the suite and **9.92 vs 7.89** on `multi-session`.

This note is the queue's missing input: every prior round chose a mechanism by plausibility and priced it by
CNY. This one prices it by ceiling.

## 1. Why a class census, and why now

`tools/room-census.mjs` (§197) divided each route's delivered characters by its own room and answered *"is the
room the binding constraint"*. It left the other half of the question — *what are the wrong answers wrong
about* — to prose: `MEASURE-FAILURE-STABILITY.md` reads individual questions, `§13.72.3` reads thirty of them,
and the jump from those readings to a mechanism choice was made by whoever was reading.

`tools/failure-classes.mjs` (this round) makes the jump mechanical. It assigns every wrong answer to one of
eight classes using only the artifact, then prints each class three ways: against its route, against the whole
suite, and rolled up into the three institutions a mechanism is actually dispatched against.

| class | rule | institution |
| --- | --- | --- |
| `empty` | the reply is blank | behaviour |
| `declined` | the reply is the abstain token | behaviour |
| `preference` | the gold is a preference summary (`The user would prefer …`) | behaviour |
| `derived-number` | the gold **is** a number and that number appears nowhere in the delivered turns | numeric |
| `number-absent` | the gold's number is inside a sentence and no delivered turn states it | numeric |
| `number-misselected` | the gold's number **is** delivered and the reply used another | numeric |
| `text-absent` | the gold's content terms are mostly absent from the delivered turns | text |
| `text-misselected` | those terms are present and the reply named something else | text |

`derived-number` is the class this round had to add, and it was not optional. The first draft of the tool had
no such class, so **every one of the eight `MR` counting failures was filed as `number-absent`** — a question
whose gold is `3` and whose reply is `2`, with `carried == total` on all eight, read as *"the operand was never
delivered"*. That is the opposite institution.

The rule that separates them is whether the gold is a **plain integer**: `4` is a total the evidence does not
state anywhere, because nothing in it says "four", so the reader has to compute it; `$720` is an amount some
turn does state, so the reader has to find it. A currency or percent sign therefore makes a number an operand
and an unmarked integer makes it a computation. That rule is asked **before** the delivery search, not after
it, because a count that happened to equal a number printed somewhere in the evidence would otherwise be filed
as "delivered and not chosen" — the one reading that is certainly false for a value nobody stated. Both halves
of that ordering were found by the tool disagreeing with its own fixtures, not by inspection.

## 2. The reading, on `45543010618` (the adopted arm, 500 of 500, two repetitions)

```
500 questions, 34 failures, 6 class(es)

class                   n   share  cov med  routes
derived-number          9   1.80%    94.4%  multi-session 6, knowledge-update 2, temporal 1
number-misselected      7   1.40%    72.2%  multi-session 3, knowledge-update 1, assistant 1, temporal 1, flat 1
text-misselected        7   1.40%    58.3%  knowledge-update 3, temporal 3, assistant 1
preference              6   1.20%    43.3%  flat 6
number-absent           3   0.60%   100.0%  multi-session 3
empty                   2   0.40%    68.8%  knowledge-update 1, multi-session 1
```

`text-absent` and `declined` are **empty classes** on this arm: not one failure has the gold's terms missing
from the delivered turns, and not one question declines. Both facts matter and both contradict a story this
campaign has been telling itself.

**The delivery institution is nearly empty on this arm.** The classes that mean *"the reader never saw it"*
are `text-absent` (**0**) and `number-absent` (**3**), and all three `number-absent` questions are on
`multi-session`, whose gold coverage is 98.5%. Every other failure is `misselected` or `derived`: **the evidence reached the reader
and the reader answered something else.** §196 said this for `MR` from `goldOverlap`; the class census says it
for the arm.

**The decline cascade is dormant.** `declined` is 0 on all six routes. §13.72's mechanism — the unconditional
closing line licensing a decline when the list is long — is still in the prompt text (`prompt.ts`'s blocks) and
is not being taken by this reader.

## 3. Ceiling against floor, which is the only number that decides a dispatch

`MEASURE-RESOLUTION-WALL.md` §1 gives the sample floor `2.8016 · sqrt(p(1−p)/n)` at 80% power. Printed against
every class:

| class | route | class n | route n | ceiling | floor | detectable |
| --- | --- | --: | --: | --: | --: | :--: |
| `derived-number` | `multi-session` | 6 | 121 | 4.96 | 7.89 | **no** |
| `preference` | `flat` | 6 | 94 | 6.38 | 7.59 | **no** |
| `text-misselected` | `knowledge-update` | 3 | 72 | 4.17 | 9.78 | **no** |
| `number-misselected` | `multi-session` | 3 | 121 | 2.48 | 7.89 | **no** |
| `number-absent` | `multi-session` | 3 | 121 | 2.48 | 7.89 | **no** |
| `text-misselected` | `temporal` | 3 | 127 | 2.36 | 4.83 | **no** |
| `derived-number` | `knowledge-update` | 2 | 72 | 2.78 | 9.78 | **no** |
| `number-misselected` | `knowledge-update` | 1 | 72 | 1.39 | 9.78 | **no** |
| … | | | | | | **no** |

Every row is `no`. Against the whole suite the floor is **3.15 points = 16 questions**, and the largest class
is 9.

This is not a defect of the tool; it is the same wall `MEASURE-RESOLUTION-WALL.md` found from the mechanism
side, now measured from the failure side, and it explains the campaign's shape better than any single reading
in it: **a queue of 1.2-point mechanisms measured at a 3.15-point floor cannot produce a certified win, and
five rounds of it produced none.**

## 4. The three institutions, which is the unit a mechanism is dispatched against

```
institution    route            n  population  ceiling   floor  detectable
numeric        -- suite --    19         500     3.80    3.15  yes
               multi-session   12         121     9.92    7.89  yes
               knowledge-update 3          72     4.17    9.78  no
               temporal         2         127     1.57    4.83  no
               assistant        1          56     1.79    6.95  no
               flat             1          94     1.06    7.59  no
text           -- suite --     7         500     1.40    3.15  no
behaviour      -- suite --     8         500     1.60    3.15  no
```

Two rows are `yes` and they are the same mechanism read on two populations: **the numeric institution is the
only certifiable target left in this arm.** A mechanism that improves what the reader does with an operand can
move `derived-number`, `number-misselected` and `number-absent` together — they are three faults of one
faculty — and their sum is 19 questions, above the suite floor of 16. `text` (7) and `behaviour` (8) are each
below it, and `preference`'s 6 on `flat` is 6.38 against 7.59.

The grouping is the whole argument. Pricing `derived-number` (8) alone would file a 3.80-point mechanism as a
1.60-point one; that is precisely how this queue has been mis-ordered for five rounds.

## 5. The prediction this note registers for `45678454743`, before its artifact was read

The truncation dispatch (§0.1 of `PREREG-TRUNCATION-SHORT-ROUTES.md`) was in flight while this census was
written. The census makes a prediction that the registration's own criteria do not: **it will read as the
informative negative.**

Of `knowledge-update`'s 7 failures, **6 are `misselected` or `derived`** (1 `number-misselected`, 3
`text-misselected`, 2 `derived-number`) and 1 is `empty`; **none is `number-absent` or `text-absent`.** So
raising that route's gold coverage from 49.9% to ≥70% has almost no question to convert: the operand those
questions need is *already in the delivered turns*. The registered `T4` should pass (it is deterministic) and
`T1` should fail with a conversion count around `b ≤ 2`.

If that is what the artifact says, `MEASURE-RESOLUTION-WALL.md`'s strongest sentence gets a second reading from
a different direction: **the delivery diagnosis that `§193`–`§197` were built on is false for this arm**, and
the queue is rewritten around §4.

## 6. What this changes about the queue

| target | population | questions | ceiling | floor | verdict |
| --- | --- | --: | --: | --: | --- |
| numeric institution, bundled | suite | 19 | 3.80 | 3.15 | **certifiable** |
| numeric institution, bundled | `multi-session` | 12 | 9.92 | 7.89 | **certifiable** |
| `derived-number` alone | `multi-session` | 6 | 4.96 | 7.89 | not certifiable |
| `preference` alone | `flat` | 6 | 6.38 | 7.59 | not certifiable |
| `text-misselected` | `knowledge-update` | 3 | 4.17 | 9.78 | not certifiable |

The next dispatch is therefore the one the numeric row names, and it is the first in this campaign whose
ceiling clears its floor before it is run.

## 7. Verification

| item | reading |
| --- | --- |
| `tools/failure-classes.mjs --self-test` | **7 classifications** (including a digit answer against a spelled-out gold, which a digit-only extractor misses), **1 absent operand**, **1 derived value**, **3 refusals**, **1 floor** pinned to the resolution-wall note's own 9.37, **5 report rows** |
| mutation check | changing the copied `ABSTAIN_TOKEN` by one character turns `repo-gates.test.ts` red (1 of 29 failing), then green on restore — the copy gate has discriminating power |
| `repo-gates.test.ts` | new describe: the tool prints `TURN_CAP_ROUTES` in the product's order, and its abstain token equals `parse.ts`'s |
| classification of the adopted arm | 34 of 34 failures assigned; **0 unclassified**, **0 refusals** |
