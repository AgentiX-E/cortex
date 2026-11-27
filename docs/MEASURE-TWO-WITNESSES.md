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
looked: **five of its seven mechanisms cannot reach the rejection region at any conversion rate**; of the
two that can, one was dispatched twice and read 5 up, 5 down against a bar of 88%, and the other — the
delivery institution — became visible only once §1's split was drawn on the right text.

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

### The reading, on `45760081761`

```
ceiling: what a mechanism can reach, by the control and by this arm's own prompt
capability          n  never  control  shown  unknown  ceiling(c)  ceiling(s)
ABS                30      0        0      0        0      100.00      100.00
IE                150      6        0      2        0       96.00       97.33
KU                 72      5        0      3        1       93.06       97.22
MR                121     10        5      2        0       95.87       93.39
TR                127      5        1      2        0       96.85       97.64
suite             500     26        6      9        1       96.00       96.60
the two witnesses disagree about 8 of the 26 never-right questions: the prompt carried the gold and the
control never answered it.
```

The control column reproduces `96.00` exactly, which is the check that says this instrument is reading the
same artifact the published ceiling was taken from.

Three things follow, and the third is the one that matters.

**The two witnesses are almost disjoint.** Of the six questions the control demonstrates and the nine this
arm's prompt delivered, **one** is in both. Eight of the nine the control has never answered. So "a pipeline
in this repository can answer it" and "the evidence arrived" are not two measurements of one set — they are
two different sets, and a ceiling built on either alone is a ceiling over half the reachable questions.

**The second witness is not uniformly larger.** It adds `4.16` points on `KU`, `1.33` on `IE` and `0.79` on
`TR`, and it **subtracts `2.48` on `MR`**: of `MR`'s ten never-right questions the control demonstrates five
and this arm's prompt delivers the gold to two. That is the route every mechanism in this campaign was aimed
at, and on it the delivery story is *worse* than the control story. It is also the arithmetic behind `§203`'s
finding that `MR` holds four convertible questions: the prompt does not carry what the control can find.

**`KU` is where the gap is.** Its control ceiling is `93.06` — the lowest of the five, and the one the queue
was built on — and its prompt ceiling is `97.22`, a `4.16`-point difference on five questions where the gold
was delivered three times and the control answered none. `KU` is also the home of the queue's only certifiable
mechanism (§3), which is a coincidence this round did not plan and cannot yet explain.

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
| delivery institution | suite | 6.00 | **96.3%** | invisible before §1: the class read empty |
| under-count repair | `MR` | 3.00 reachable of 6.00 | — | cancelled on reach before it was priced |
| entity grouping (`H3`) | `MR` | 4.00 | — | not dispatched |
| decline repair (`E3.2`) | `MR` | 3.75 | — | not dispatched |
| deterministic summation | `MR` | 2.25 | — | not dispatched |

Five of the seven cannot reach the rejection region **at any conversion rate**: `Bin(R, q) >= 6` is false at
`q = 1` when `R < 6`, so no outcome of those dispatches could have produced `p <= 0.05` whatever the
mechanism did. That is a fact about the class size and not a power calculation, and it is the sharper
version of what `§204` was reaching for.

Of the two that clear the bar, one is `H2` on `KU` and it *was* certifiable and it was **dispatched twice**.
It needed 88% conversion of seven questions; it converted five and broke five. And the noise floor of this population
under a byte-identical prompt is already **5 of 121 questions** (`MEASURE-PAIRED-POWER.md` §1), so a
five-question movement in the right direction would not have been distinguishable from nothing.

### What the corrected split does to the census

The fix in §1 is not cosmetic, and the re-frozen census says how much. On `45760081761`:

| class | before | after | what moved |
| --- | ---: | ---: | --- |
| `text-misselected` | 8 | **5** | three questions whose gold the window dropped |
| `text-absent` | **0** | **3** | the same three, arriving in the class that means *"the reader never saw it"* |
| `number-misselected` | 7 | 7 | unchanged: every one of the seven had its number in a turn that was carried |

`text-absent` was **absent from the census entirely** — a class the taxonomy names, that the tool could not
emit, and that `AUDIT-FAILURE-CLASSES.md` §5 concluded was empty: *"the delivery institution is empty on this
arm under both renderings, so the queue's remaining..."*. It held three questions. The route they live on is
`temporal 2, assistant 1` — not `multi-session`, which is where every mechanism has been aimed.

Two rows of the queue change verdict, and both were **asserted in `tools/__tests__/test_queue_census.py`**:

| row | before | after | why |
| --- | --- | --- | --- |
| `delivery on TR/IE/KU` | `empty` | **`refused`** | three members on 349 questions is 0.86 points against a floor of 1.72 — still refused, but refused **by the floor** rather than for having nothing to reach |
| `delivery, suite` | `refused` | **`certifiable`** | six members on 500 is `1.20` against a floor of `1.20`: exactly the rejection region, and not one question more |

A test that pins a verdict inherits the instrument that produced the verdict. Those two assertions were
green, passing and wrong for as long as the classifier decided delivery on undelivered text — the same shape
as the `declined` fixture that fed a token into a field `parseAnswer` maps to `null`. They are rewritten in
this round to assert the corrected reading and to say in their docstrings that they were the defect's
signature rather than its detector.

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
- **It does not rewrite `AUDIT-FAILURE-CLASSES.md` §2's table.** That table is a reading of `45543010618`,
  an earlier arm, and the artifact for it is not in this checkout; rewriting a record of a run this round
  cannot re-read would be inventing it. What is written instead is an amendment against the run this round
  *can* read, and the census `tools/failure-census.json` is re-frozen against `45760081761` with the
  artifact's SHA-256 unchanged.
- **It does not fix `unpairedFloor`'s formula, and the defect is real.** *(Fixed in §211 --
  `AUDIT-QUEUE-FLOOR.md` §1.1 records the correction: the function now writes the variance as the sum
  of two sample variances, the `MR` floor reads 11.13 points rather than 7.87, and the self-test
  asserts the identity against an independently written one-sample expression instead of pinning the
  constant that was wrong.)* `tools/queue-floor.mjs`'s
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
