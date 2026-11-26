# Seven of eight, and the seventh is a coincidence

**Status:** decided. Measured on the adopted arm `45543010618` (500 questions, two repetitions,
`layered` + `verbatim-acts`), from the artifact's own `rawOutput`. No dispatch, no model call, **¥0**.

## 0. In one paragraph

`AUDIT-NUMERIC-MEMBERSHIP.md` priced a membership adjudicator at a ceiling of ten questions — 8.26
points against a paired floor of 4.96, i.e. **six of ten must convert**. That price was computed over a
population the same document forbids: its §3 rules the period axis out with two measurements, and **two
of the ten are period questions**. On the eight the mechanism may address, the five adjudications reach
**seven** at ideal execution and damage **none** of the ninety-five correct replies — and yet the
mechanism is **priced out**, because six of the seven must convert (86%) and the seventh reaches by
_count only_: the reply lands on the gold's number while a member of the gold is still missing and an
extra row is still counted. A margin of one question that arrives by coincidence is not a margin.

## 1. What this measures, and why it is a census rather than a scorer

`tools/membership-reach.mjs` reads a merged artifact and, for each `MR` question, prints the rows the
reply counted, the rows it excluded, and which of the five adjudications applies to which row. The
adjudicated value is `answered + Σ delta`, where a count delta moves by one and a total delta moves by the
amount the row states.

Four properties make it a census rather than a second judge:

1. **It compares only what compares.** A gold parses to a comparison only when it states its answer
   unambiguously: the first number in reading order, with a word before the first digit taken as the lead
   count of a prose gold (`I viewed four properties before …2-bedroom…`) and a digit first with more
   numbers behind it refused (`$1,000 and $200`). Everything else prints `uncompared`.
2. **It reports the loss side.** A census that counts only repairs is the shape of every over-claim this
   campaign has written down, so the same predicates run over the correct replies too. **Zero of
   ninety-five** move off their gold — and that number is the most useful thing in this document, because
   the same rules with broader predicates moved **six**.
3. **It refuses to over-credit.** A count can land on the gold while the set does not, so the gold's own
   comma-separated items are looked for among the retained rows and a `reached` that covers fewer than all
   of them prints as `reached*`. One question is in that state.
4. **Its predicates are narrow on purpose**, and every narrowing was forced by a reply — §4.

## 2. The reading

```
121 questions, 13 wrong, 11 of them with a comparable gold and answer
reach at ideal execution: 7 of 11
damage at ideal execution: 0 of 95 correct replies with a comparable gold

  id                    gold    ans    adj   set  verdict     deltas
  gpt4_15e38248            4      3      4     —  reached     possession+1
  gpt4_a56e767c            4      3      3     —  short       —
  gpt4_ab202e7f            5      7      5   80%  reached*    duplication-1 duplication-1
  a1cc6108                11      ?      ?     —  uncompared  —
  bf659f65                 3      2      3     —  reached     possession+1
  9ee3ecd6               100    300    300     —  short       —
  3a704032                 3      2      2     —  short       —
  gpt4_731e37d7          720    220    220     —  short       —
  gpt4_7fce9456            4      5      4  100%  reached     boundary-1
  37f165cf               856      ?      ?     —  uncompared  —
  gpt4_2f8be40d            3      4      3     —  reached     identity-1
  gpt4_31ff4165            4      3      4     —  reached     possession+1
  d851d5ba              3750   8750   3750     —  reached     attribution-1

  adjudication    deltas  questions
  identity             1          1
  duplication          2          1
  boundary             1          1
  attribution          1          1
  possession           3          3
```

Five numbers have to be kept apart, and the verdict turns on which one is the population:

| reading                           |  count | what it is                                                                       |
| --------------------------------- | -----: | -------------------------------------------------------------------------------- |
| `MR` failures                     | **13** | every wrong answer on the route                                                  |
| with a comparable gold and answer | **11** | the two that abstained (`a1cc6108`, `37f165cf`) cannot be counted at all         |
| membership-shaped                 |  **8** | 11 minus the two period questions (`3a704032`, `gpt4_731e37d7`) minus `9ee3ecd6` |
| reach at ideal execution          |  **7** | of the 8; `ab202e7f` reaches by count only                                       |
| reach on a set as well as a count |  **6** | `ab202e7f` falls out                                                             |

## 3. The arithmetic

| quantity                                                  | value                                                                   |
| --------------------------------------------------------- | ----------------------------------------------------------------------- |
| ceiling on the population the mechanism may address       | **7 / 121 = 5.79 points**                                               |
| …on a set as well as a count                              | **6 / 121 = 4.96 points**                                               |
| paired floor (exact McNemar, six gains at zero losses)    | **4.96 points**                                                         |
| conversion required                                       | **6 of 7 = 86%**, at zero net loss                                      |
| best single-variable conversion observed in this campaign | **60%**                                                                 |
| the two asks whose populations were decomposed            | `verbatim-acts` 8 of 27, `verbatim-scope` 2 of 8 with **6 regressions** |

The bundle must convert 86% of what it can reach. The two members of its own family, measured on
populations the same way, converted **30%** and **25%**. So the expected conversion of a stated rule over
these seven questions is two to four, against a floor of six: the mechanism is **priced out**, not
disproved, and the reading that would settle it is worth its ¥5.87 only if a mechanism first raises the
ceiling above the floor by more than the one question that arrives by coincidence.

`AUDIT-NUMERIC-MEMBERSHIP.md`'s diagnosis was not wrong. Its **denominator** was: a ceiling computed over
ten includes two questions whose repair is the axis the same document forbids.

## 4. Every correction this file needed, and the reply that forced it

Each is a claim about the replies, not about the mechanism. Two of them changed the **verdict**, and the
second changed it in the direction that is hardest to notice — a tool that was too generous.

| correction                                                             | the reply that forced it                                                                                                | what the uncorrected version did                                                                                                                                         |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a row must separate its fields                                         | `gpt4_a56e767c` writes `- Duplicate mentions of Austin Film Festival and AFI Fest were counted only once.` as a bullet  | `identity` collapsed two real rows into that sentence and read 3 → 1                                                                                                     |
| a total's delta is the row's amount                                    | `d851d5ba` answered `$8,750` against a gold of `$3,750`                                                                 | subtracted one, printing `$8,749`                                                                                                                                        |
| the gold's first number is its answer                                  | `gpt4_7fce9456`'s gold says `four` and writes `2-bedroom`; `aae3761f`'s says `15 hours` and writes `three destinations` | refused the first and read the second as three, reporting a correct reply as damaged                                                                                     |
| possession's third form needs the exclusion note                       | `gpt4_31ff4165` has three excluded rows tagged `use`, one of them the hearing aids                                      | added three members to a question whose gold adds one, reading 3 → 6                                                                                                     |
| a typographic quote is a quote                                         | `gpt4_15e38248` writes `“my new,”`                                                                                      | the straight-quote idiom missed it and the question read short                                                                                                           |
| `identity` is a relation phrase, not any subset                        | `c2ac3c61`, `8979f9ec`, `2788b940`, `a3332713` — four **correct** replies                                               | merged a hedge against three courses, a soup against a row titled `duplicate mention`, and a class against a class-list mention; 6 of 95 correct replies read as damaged |
| a row the reply says is not a member is not one                        | `dd2973ad` writes `context only; not a bedtime event`                                                                   | `boundary` subtracted from a correct answer of `2 AM`                                                                                                                    |
| the set check is undecidable when the gold names another kind of thing | `gpt4_2f8be40d`'s gold enumerates **couples**, its rows enumerate **weddings**                                          | reported 17% coverage for a reply that named every couple                                                                                                                |

The sixth is the one worth reading twice. The broad `identity` predicate reached the same seven questions
and **destroyed six correct answers**, and all six destructions were the same mistake: an item string
contained in another item string is not the same object when the shorter one is a hedge (`some courses`),
a duplicate note (`Lentil soup duplicate mention`), a mention inside a list (`Zumba, Hip Hop Abs, yoga`), or
an object the reply already deduplicated in its own words (`counted once`). What the gold actually merges
is the relation phrase — `Cousin's wedding last month` against `Cousin Rachel's wedding at a vineyard in
August` — so the predicate now requires a possessive of at most three content tokens and a capitalised
token only the longer row has.

Also recorded, because it was invisible until a consumer parsed the output: `process.exit()` after a large
`--json` print **truncates the pipe mid-string**. The tool sets `process.exitCode` now. The symptom was a
JSON parse error downstream, which is where a defect like that always surfaces first.

## 5. Why the four that fall out fall out

**`gpt4_a56e767c`** (gold four festivals, answered three). There is no fourth row to keep: the reply
counted three distinct festivals and refused generic mentions in a sentence of its own. An adjudicator
that reorders rows cannot add a member the reader never enumerated, and the gold's fourth member may be a
generic mention — which the audit's §5.2 already flags as possibly unwinnable.

**`9ee3ecd6`** (gold `100`, answered `300 points`). Two numbers exist and the reply took the wrong one.
That is fact selection: no set is being adjudicated.

**`3a704032`** and **`gpt4_731e37d7`** (period). Both are excluded from the population because the
mechanism may not touch the period axis, and both are exactly what that axis would have to repair — the
snake plant "received last month" and the marketing workshop's `$500` whose _event_ date the reply put
outside a window computed from the session date.

## 6. What this does not claim

1. **Not a rejection of the diagnosis.** Ten of twelve being membership questions stands; what changed is
   that two of the ten belong to a spent axis, one has no member to add, and one of the seven that reach
   does so by count.
2. **Not a claim that no adjudicator can work.** It is a claim about _this_ one — five stated rules whose
   ideal execution is one question above the floor. A mechanism that reads the corpus rather than the
   reply (§13.205's `candidates`) is a different instrument with a different ceiling, and nothing here
   prices it.
3. **Not a measurement of what a reader would do.** Every number here is the ideal execution of the five
   rules against rows the _unruled_ reader wrote. It is a ceiling in exactly the sense `spec`'s was in
   §200, and it is read the same way: a ceiling below what the floor demands closes the direction.
4. **Not a claim that the seven are easy.** Three of them are one claim — possession — and a single-claim
   mechanism over three questions cannot clear a floor of six by construction.

## 7. Where the residual actually is

The three possessions are the only group larger than one question, and they are three. The four remaining
`MR` failures are two period questions and two that are not membership at all. So the honest statement is
the one this document exists to make: **the membership institution has no mechanism that can clear the
floor at the conversion rates this arm produces**, and the next candidate is not a sixth adjudication but
a different institution — the delivery shortfall on `TR`/`IE`/`KU` (48–77% of gold turns carried), where
the reader never saw the rows to adjudicate.

The one durable product of this round is the _shape_ of a safe adjudicator: five predicates, each narrow
enough to fire once, and zero damage on ninety-five correct replies. If a future mechanism needs one of
them, the form is here and the evidence is that the obvious broad version destroys six answers to gain
seven.
