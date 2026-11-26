# Two witnesses for one ceiling, and the queue's bar in the units of the test that is run

**Status:** decided. Zero model calls. The two code defects are found by reading the instrument against the
record it reads; the arithmetic in §3 is exact combinatorics over class sizes the register already states.

## 0. In one paragraph

Three findings, all in instruments rather than in the arm.

`tools/failure-classes.mjs` drew the `misselected` / `absent` split — the one distinction its own docblock
says the file exists to draw — on `goldOverlap.goldTurns`, which `question-record.ts:1160` writes as *"the
text of every gold turn, **delivered or not**"*. A question whose gold the window dropped was therefore
filed as a **decision** fault and priced against a decision mechanism that cannot reach it. It now reads
`goldDelivered`, and refuses only the state where a missing map changes the class.

`tools/ceiling-witnesses.mjs` adds the second witness for the reachability the `96.00` ceiling is built on.
That ceiling says *"no pipeline in this repository answers it"*; the artifact has also said, since
`goldDelivered` was added, *"this arm's own prompt carried the gold"* — and no reading in the campaign
consulted the second one.

And restated in the units of the test every dispatch is actually read by, the queue is smaller than it
looked: **five of its six mechanisms cannot reach the rejection region at any conversion rate**, and the
sixth was dispatched twice and read 5 up, 5 down against a bar of 88%.

## 1. The split, drawn on text the reader never saw

The table at the top of `failure-classes.mjs` is explicit about what two of its classes mean:

| class | the file's own rule | institution |
| --- | --- | --- |
| `number-misselected` | the gold's number **is** in the delivered turns and the reply used another | decision |
| `text-misselected` | the gold's terms are present and the reply named something else | decision |
| `number-absent` | no delivered turn states the gold's number | delivery |
| `text-absent` | the gold's content terms are mostly absent from the delivered turns | delivery |

and equally explicit that this split is the point: *"it is the difference between 'the reader never saw it'
and 'the reader saw it and answered something else'."*

The code searched `goldOverlap.goldTurns`. That field is written by `goldOverlapOf`
(`question-record.ts:1129`) as `goldTurns: [...goldTurns]` under the comment *"The text of every gold turn,
delivered or not. Without it the restore counterfactual of §13.267 has nothing to reinstate."* The delivery
question was therefore decided on a text the budget may never have reached.

The artifact has carried the answer to the question that was actually being asked since the same function
was extended: `goldDelivered: goldTurns.map((gold) => retrieved.includes(gold))`, one boolean per gold turn.
This tool never read it. Two other tools do (`gold-room.py` refuses a record whose `goldDelivered` disagrees
with `total`, `gold-recall-census.py` reads it as its population), which is what makes it a defect of this
file rather than a missing field.

### The repair, and why the refusal is narrower than the field

`operandReach(truth, overlap, questionId)` asks the map, and has three states rather than two:

| state | when | what it means |
| --- | --- | --- |
| `absent` | the operand is in no gold turn | it cannot have been shown, whatever the budget did — attributable **without** the map |
| `delivered` | it is in a gold turn `goldDelivered` marks carried | the evidence arrived and the reader decided wrongly |
| `unknown` | the gold has no searchable operand at all | "was it shown" is a question about a text with nothing in it |

An operand that appears in **no** gold turn needs no map, so the refusal cannot be "this record has no
`goldDelivered`" without refusing records that are perfectly readable. It fires on exactly the state where
the missing field changes the class: the operand is in some gold turn, the budget carried only part of the
gold, and nothing says which part. That is the same narrowness `classify` already applies to a missing
reply — *"a blank answer cannot be told from a missing reply"* — and for the same reason.

`carried === total` is a third exemption, and it is not a convenience: when every gold turn was carried the
map is redundant, so an artifact predating the field stays readable rather than being refused wholesale.

`unknown` is new as a distinct state and it deliberately **does not change any count**. `classify` still
files an operand-less gold as a decision fault, because collapsing it to `absent` would move counts this
round did not measure; what changes is that the ceiling tool below can decline to read it as a witness.

**Tests:** seven cases at the tool boundary (`tools/__tests__/test_queue_census.py`,
`TestTheOperandQuestionIsAskedOfTheGoldThatWasShown`) — an operand in a dropped turn reads `absent`, the
same record with the turn carried reads `misselected`, the text half reads the same map, a record that
cannot attribute is refused, a full delivery needs no map, a miss needs no map, and a map whose length
disagrees with the turns is refused. Four cases in `--self-test`, plus one that pins `unknown` as reachable
— a three-state predicate with an unreachable third state is the `declined` class over again.

## 2. The second witness

`MEASURE-REACHABLE-HEADROOM.md` §2 states the harness ceiling as

```
1 - (never - demonstrated) / n
```

where `never` is the questions this arm answers wrongly in every repetition and `demonstrated` is how many
of those the **control** answers at least once — `96.00` on the 500. The sentence that follows it is
*"twenty of the twenty-six questions this arm never answers are questions the reference pipeline never
answers either ... no amount of work on this arm moves them"*, i.e. it treats one witness as the only
witness.

`tools/ceiling-witnesses.mjs` prints both, per capability and for the suite:

```
ceiling: what a mechanism can reach, by the control and by this arm's own prompt
capability          n  never  control  shown  unknown  ceiling(c)  ceiling(s)
```

| witness | field | what it establishes |
| --- | --- | --- |
| control | `ablation.*CorrectByRun` | a pipeline in this repository answered it, so the corpus admits an answer |
| own prompt | `goldOverlap.goldDelivered` | the gold's operand was in the window **this arm** built, so delivery is not what failed |

Neither is a promise that a mechanism exists, and the tool says so at the top rather than in a footnote: the
first is evidence the question is answerable, the second is evidence the evidence arrived, and a question
can satisfy both and still be beyond every mechanism in the queue. What the pair does is replace one number
with a range, and name how much of the gap between the two is **unmeasurable** rather than reached — which
is what the `unknown` column is for.

The `unknown` column is printed and **not** subtracted from the second ceiling. A gold that states no
operand has not been reached, and counting it as reached would make the second witness a rubber stamp; a
witness that answers "yes" for a gold with nothing in it is not a witness.

**Tests:** `tools/__tests__/test_ceiling_witnesses.py` — nine cases, of which three carry the arithmetic: a
fixture where the two witnesses disagree at the question level (the totals agree, so a total-level check
would pass), an operand-less gold that must not lift the ceiling, and the suite row being the sum of the
parts rather than a third number. The four refusals are asserted too: a record with no `goldOverlap`, a
record whose delivery map disagrees with its turns, an artifact with no per-repetition masks, and a usage
error.

## 3. The bar, in the units of the test that is actually run

Round `§204`'s detectability table compared each mechanism's **ceiling in points** against a **floor in
points** of `2.8016 * sqrt(p(1-p)/n)` — 9.37 on `MR`, 10.52 on `KU` — and marked all nine rows `no`. That
formula is the yardstick `MEASURE-PAIRED-POWER.md` §1 exists to separate from the one the campaign uses: it
answers *"how large a difference between two independent samples is visible 80% of the time"*, while every
dispatch here is **paired** and read by an exact McNemar, whose rejection region starts at six discordant
questions all one way (`2 * 0.5**6 = 0.03125`; `tools/queue-floor.mjs --self-test` pins `(6,0) = 0.03125`
and `(5,0) = 0.0625`, and prints *"six certifies and five does not"*).

Restated in the registered test's own units, the question is not *"is the ceiling above the floor"* but
**"how completely must the mechanism work"**: with `R` conversions available and no leaks, the reading is
significant at 80% power when `P(Bin(R, q) >= 6) >= 0.8`.

| mechanism | population | conversions available | conversion needed | status |
| --- | --- | ---: | ---: | --- |
| stale-value + the decline (`H2`) | `KU` | 7.00 | **88.0%** | dispatched twice: **5 up, 5 down** |
| stale-value (`H2`) alone | `KU` | 6.00 | **96.3%** | the same dispatch, read without the decline |
| under-count repair | `MR` | 3.00 reachable of 6.00 | — | cancelled on reach before it was priced |
| entity grouping (`H3`) | `MR` | 4.00 | — | not dispatched |
| decline repair (`E3.2`) | `MR` | 3.75 | — | not dispatched |
| deterministic summation | `MR` | 2.25 | — | not dispatched |

Five of the six cannot reach the rejection region **at any conversion rate**: `Bin(R, q) >= 6` is false at
`q = 1` when `R < 6`, so no outcome of those dispatches could have produced `p <= 0.05` whatever the
mechanism did. That is a fact about the class size and not a power calculation, and it is the sharper
version of what `§204` was reaching for.

The sixth is the one that matters, because it *was* certifiable and it was **dispatched twice**. It needed
88% conversion of seven questions; it converted five and broke five. And the noise floor of this population
under a byte-identical prompt is already **5 of 121 questions** (`MEASURE-PAIRED-POWER.md` §1), so a
five-question movement in the right direction would not have been distinguishable from nothing.

**What this changes.** `§204` read the nineteen nulls as evidence that the instrument could not see, and
apologised for them. Under the criterion the campaign is registered on, five of the six queue rows could not
be seen and **one could**, and that one failed on its own terms. The nulls are not uniform: five are
unreadable and one is real. The real one is the row the queue has been built on since `§14`, and this round
does not have a replacement for it.

## 4. What this cancels: the ¥3 dispatch at the head of the queue

`§204.7` put the `verbatim`-against-`route` reading first at **≈¥3.0**, on the prediction in
`MEASURE-ASK-PRICE.md` §3 that it is worth **+4.1 points on `MR`**.

`+4.1` of 121 is **5 questions**, and `tools/queue-floor.mjs --self-test` asserts that five does not certify
while six does. So the best possible outcome of that dispatch — every one of the five questions moving in the
predicted direction and nothing breaking — is `b = 5, c = 0`, `p = 0.0625`. **The reading is arithmetic-
capped below the bar before the money is spent.** Buying it would add a seventh row to a table of nulls that
are indistinguishable from each other, and the honest description of that row would be *"the population
could not have shown this"* rather than *"the block is not worth 4.1 points"*.

The ¥3 is not spent. The rung stays unmeasured, and it is recorded as **uncertifiable at this denominator**
rather than as **pending** — which is the same disposition `tools/queue-floor.mjs` gives a decayed group,
and for the same reason.

## 5. What this does not say, and what it does not fix

- **It does not say the ceiling is 96.00 or that it is not.** §2 gives a second witness and its count; the
  control witness's `96.00` stands as the control witness's statement. A larger second ceiling is a *bound*
  under the assumption that a decision the reader can be made to get right exists, not a measurement of one.
- **It does not reprice the delivery split's counts.** The class counts in `tools/failure-census.json` move
  only when the census is regenerated from a merged artifact, and that artifact is 63 MB over a proxy that
  moves at about 10 KB/s. The counts are therefore **stale at the time of writing** and this note claims
  nothing about their new values. `AUDIT-FAILURE-CLASSES.md`'s per-class table is stale for the same reason.
- **It does not fix `unpairedFloor`'s formula, and the defect is real.** `tools/queue-floor.mjs`'s
  `unpairedFloor` is documented as *"the unpaired **two-proportion** minimum detectable effect"* but computes
  `2.8016 * sqrt(p(1-p)/n)`, which is the **one-sample** form; two independent samples of size `n` have
  variance `2p(1-p)/n`, so the printed figure is low by a factor of `sqrt(2)` — 7.87 points where the
  two-proportion answer is 11.13. It is left in place this round because no verdict depends on it (the
  verdict uses the paired branch, which is correct and pinned), and because the same expression is quoted as
  the "resolution floor" in `MEASURE-RESOLUTION-WALL.md`, `MEASURE-FAILURE-STABILITY.md` and
  `MEASURE-PAIRED-POWER.md`, so correcting it is three records and one pinned self-test rather than one
  line. What §3 does is remove the need to read those tables for a verdict at all.
- **It does not say the queue is empty.** It says the queue is empty **at this denominator**, and that the
  largest coherent block on it — the decision institution, `misselected` on both halves — is the one whose
  size this round's fix changes.

## 6. Re-deriving it

```
node tools/failure-classes.mjs --self-test
node tools/queue-floor.mjs --self-test                    # pins (6,0)=0.03125, (5,0)=0.0625
node tools/ceiling-witnesses.mjs <report.json>            # the two witnesses, per capability
node tools/ceiling-witnesses.mjs <report.json> --list     # and which question each reaches
python3 -m pytest tools/__tests__/test_queue_census.py tools/__tests__/test_ceiling_witnesses.py -q
```

The artifact the census is frozen against is `45760081761`, 62,955,757 bytes zipped, SHA-256
`5e08f353c1b4bac39a7a7fe8f9bc6f4de15eb7ae91e9b69c1c2940965c1f30a1`; `tools/fetch-artifact-chunked.py`
downloads it in resumable 2 MB ranges because the artifact API answers 303 with a fresh signature on every
call.
