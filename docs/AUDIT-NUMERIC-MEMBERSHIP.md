# Ten of twelve: the numeric institution on this arm is a membership question

**Status:** decided. Measured on the adopted arm `45543010618` (500 questions, two repetitions,
`layered` + `verbatim-acts`), from the artifact's own `rawOutput` field. No dispatch, no spend.

## 0. In one paragraph

`AUDIT-FAILURE-CLASSES.md` establishes that the numeric institution is the only target left whose
ceiling clears the floor, and the queue's next two mechanisms — `reviewPass: 'tally'` and
`reviewPass: 'spec'` — are both **arithmetic** instruments: they take the list the reader produced
and perform the operation over it. Reading the twelve numeric `MR` failures on the adopted arm one by
one, in the reader's own words, **ten of them are decided before any arithmetic happens**: six dropped
a member the gold keeps, four kept one the gold drops. The reader's counts are not miscomputed, they
are counts of the wrong set. That is why `tally` lost ten questions with "no arithmetic error among
the ten losses, only ten wrong *operands*" — the autopsy named the symptom — and why `spec`'s
reachability is capped at a plan over a ledger whose rows are already the wrong rows. The mechanism
this institution needs is a **membership adjudicator**, and its population is 10 of `MR`'s 121 = 8.26
points against a floor of 4.96, i.e. **six of ten must convert**, not ten of ten.

## 1. The twelve, in the reader's own words

The quoted fragment is the line in the reply that decided the question. Every one of them is a reply
that *enumerated correctly and then judged membership wrongly*; none is a reply that could not add.

### Group A — a member the gold keeps was dropped (6)

| id | gold | answered | the line that decided it |
| --- | --- | --- | --- |
| `gpt4_15e38248` | `4` | `3` | `Casper mattress \| excluded: only described as "my new," no buy/assemble/sell/fix action` |
| `gpt4_a56e767c` | four festivals | `3` | `Duplicate mentions of Austin Film Festival and AFI Fest were counted only once` + `Generic mentions like "film festivals and events" were not counted as additional distinct festivals` |
| `bf659f65` | `3` | `2` | `Tame Impala vinyl \| only described as "got signed," not purchased/downloaded` |
| `gpt4_731e37d7` | `$720` | `$220` | `Digital marketing workshop (Mar 15–16) … outside last four months` — the window, not the sum, removed it |
| `gpt4_31ff4165` | `4` | `3` | `Hearing aids (Phonak BTE) … excluded: evidence describes battery purchase/use, not the act of using the hearing aids in a day` |
| `3a704032` | `3` | `2` | `Snake plant … excluded from the last-month window: described as received "last month," which points to the prior calendar month` |

Three of the six (`15e38248`, `bf659f65`, `31ff4165`) invent an **evidentiary bar**: an item counts
only if the history carries an explicit verb of acquisition. A mattress described as "my new" is
furniture the user acquired; vinyl that "got signed" is a record that arrived. The gold counts
possession, the reader counts verbs.

Two (`a56e767c`, `3a704032`) are the opposite mistake in the same direction — an **over-merge** and an
**over-strict period**. `a56e767c` merged two festivals into one; `3a704032` decided "received last
month" falls outside "in the last month", which is an arithmetic claim about a calendar that the
question date contradicts.

### Group B — a member the gold drops was kept (4)

| id | gold | answered | the line that decided it |
| --- | --- | --- | --- |
| `gpt4_ab202e7f` | `5` | `7` | `Old kitchen faucet \| replaced` **and** `New Moen kitchen faucet \| replacement picked up in exchange` — one replacement, two rows |
| `gpt4_7fce9456` | `4` | `5` | `3-bedroom townhouse in Brookside neighborhood (saw on Feb 22; offer on Feb 25) \| viewed` — the property the offer was **on**, in a question that asks how many were viewed **before** it |
| `gpt4_2f8be40d` | `3` | `4` | `Cousin Rachel's wedding at a vineyard in August` **and** `Cousin's wedding last month` — one wedding, two sessions |
| `d851d5ba` | `$3,750` | `$8,750` | `Music benefit concert … event raised over $5,000; user helped organize` — an amount the **event** raised, in a question that asks what the user raised |

All four are **identity and attribution** errors, and all four are invisible to any arithmetic repair:
the sum is right, the count is right, the rows are wrong. `ab202e7f` and `2f8be40d` are the same
object stated twice; `7fce9456` is a boundary the question states in words ("before"); `d851d5ba` is
whose total it is.

### Group C — not a membership question (2)

| id | gold | answered | what failed |
| --- | --- | --- | --- |
| `9ee3ecd6` | `100` | `300 points` | a single stated value was picked wrongly; the reply quotes `"I just need a total of 300 points"` and the gold is `100`, so two statements exist and the wrong one was taken |
| `a1cc6108` | `11` | `Cannot be determined from the evidence.` | a **derived** value: `he's just 21 and I'm already taking on a mentorship role with him` establishes Alex's age and nothing establishes the user's, so the answer needs a second fact and an inference |

`9ee3ecd6` belongs to the fact-selection institution and `a1cc6108` to the derivation axis
(`question-shape.ts` already routes those to an `operands` block). Neither is repaired by a better
set.

## 2. Why the two mechanisms built for this institution cannot reach them

Both say so in their own source, and neither statement is a hedge — it is a design decision with a
measurement behind it:

> `tally.ts`: *"It does not decide **which** items count. Membership stays the audit's question and the
> mechanism only reads the list it is handed, refusing when a line is not tagged."*

> `MEASURE-REVIEW-TALLY.md`: *"the autopsy showed the operands were wrong, so the belief had been
> tested on a population it did not describe."*

> `MEASURE-SPEC-CEILING.md` §4: *"Every one of the five is a **sum whose operands share a turn with
> distractor numbers** … This is a grain problem."*

Read against §1, the grain claim is too narrow. `d851d5ba` and `gpt4_731e37d7` are in the residual
five and their failure is attribution and window, not grain; the four group-B questions that *were*
reachable by a plan are the ones where the plan could still be **wrong about membership** and the
executor would faithfully sum the wrong rows. The ceiling of 12 was measured by asking "can *a* plan
produce the gold", not "will *the reader's plan* name the gold's set" — and §1 says the second
question is where these twelve live.

## 3. What the next mechanism has to be, and what it must not be

**Must be**: an adjudication of the set before any counting — identity (one object stated twice is one
row), duplication (the old and the new of a replacement are one item), boundary (a member the question
excludes in words, like "before the offer", is out), attribution (an amount the *event* raised is not
an amount the user raised), and inclusion-by-possession (an item acquired but not described with a
verb of acquisition is in).

**Must not be**: a period bound. That axis has been spent. `verbatim-scope` (§13.291) added exactly
the bound that group A's `3a704032` and `gpt4_731e37d7` wanted, and it **lost four questions**
(`PREREG-CLOCK-AXIS.md` §0: *"`verbatim-scope` bought a bound on the period and lost four questions"*),
after which `verbatim-clock` — the arm that *forbids* the bound — read zero and was retired in §197.
That pair is the measurement that says the period is not where these failures are, and it is why this
note names the other four adjudications and leaves the period alone.

**Must not be**: a re-ask of the whole question. `reviewPass: 'audit'` already does that, and its own
history records **22 correct answers destroyed** (`42054107910`), 17 of them on questions whose gold
was a name, a price or a list. An adjudicator that runs only on questions whose answer is a number,
and only on the membership decision, is a different instrument from a general second consultation.

## 4. The population, priced

| reading | value |
| --- | --- |
| numeric `MR` failures on the adopted arm | **12** of 121 |
| of those, membership | **10** (group A 6, group B 4) |
| of those, not membership | 2 (`9ee3ecd6` fact, `a1cc6108` derivation) |
| ceiling of a membership adjudicator | 10 / 121 = **8.26 points** |
| paired floor (McNemar, `c = 0`) | **6 gains** = 4.96 points |
| conversion required | **6 of 10 = 60%** |

Sixty percent, not a hundred. That is the number this round exists to produce: the bundle is what the
floor rewards (`AUDIT-QUEUE-FLOOR.md` §2), and the bundle's required conversion rate is the floor
divided by its size.

## 5. What this does not claim

1. **Not a proof per question.** For a count, the artifact gives the gold as a number and the reply as
   a list plus a number; a reply that answered `gold − 1` after an explicit exclusion is read here as
   an over-exclusion, and the alternative — that it also *included* a wrong member and dropped two —
   cannot be excluded without the corpus. The inference is sound in aggregate (ten independent
   questions would all have to be the alternative case) and it is an inference, not a measurement.
2. **Not a claim that the corpus agrees with the gold.** `gpt4_a56e767c`'s gold counts four festivals
   while the reader found three distinct ones; if the fourth is a festival the gold counts from a
   generic mention, then the gold is counting mentions and the reader is right. That question may be
   unwinnable and is worth excluding from the registered population if a corpus read confirms it.
3. **Not a mechanism yet.** This note names the adjudications and forbids the one axis that has been
   spent. The wording of the block, and the ask value that carries it, are the next round's build —
   `ask` already carries 19 values and adding a 20th before the wording is derived from these ten
   replies would be a name in search of a mechanism.
4. **Not a dispatch.** §4 is the criterion a registration has to meet, and the floor it is measured
   against now comes from the instrument in `AUDIT-QUEUE-FLOOR.md`, not from the unpaired table.
