# The pass's plans, tabulated: the repairs and the damages are the same shape

**Status.** Run `42930900136`, artifact `13824633060`, against control `42533236864`; 121 graded `MR`
questions on both sides. Every number below is printed by `tools/plan-shape-census.py`, which reads
the plan out of each record's `rawOutput` and joins it with the control's verdict. None of it is
hand-classified, and the tool prints its own caveat beside the table it qualifies.

This file is the follow-up `MEASURE-SPEC-PASS.md` §5 registered: the damage was diagnosed there from
**four** plans quoted by hand, and a diagnosis from four cannot say whether the other 41 look the same.

---

## 1. Five of the fifty-one flips are not the mechanism

`rawOutput` holds the plan for 72 of the 121 questions; the other 49 responses were prose, or a plan
the parser refused. A refused plan leaves the **first** answer standing (`memory.ts`, the `spec`
branch: `answered === null` returns `#recordOutcome(first)`). So a question whose response carries no
plan cannot have been moved by the pass — and five of them moved anyway:

| question        | control         | treatment       | gold            | `promptDigest` |
| --------------- | --------------- | --------------- | --------------- | -------------- |
| `3a704032`      | `2`             | `3`             | `3`             | **identical**  |
| `gpt4_2ba83207` | `Walmart`       | `Thrive Market` | `Thrive Market` | **identical**  |
| `d905b33f`      | `Cannot be det…`| `Cannot be det…`| `20%`           | **identical**  |
| `7405e8b1`      | `Yes`           | `20 percentage points` | `Yes.`   | **identical**  |
| `8e91e7d9`      | `4`             | `3`             | `4`             | **identical**  |

Same prompt bytes, same reader, different sample. Three of them landed on the repair side and two on
the damage side, which makes this the campaign's first **directly measured** variance floor: **5 of
121 = 4.1% of the population flips under an identical prompt**, netting +1 by luck. Earlier rounds
estimated that band at ±2–3 questions from the spread of repeated arms; this is the same number read
from a pair that differs by construction in one place only.

Two consequences, and both are corrections to the reading already published:

1. The mechanism's repair count is **3**, not 6. `6d550036`, `60bf93ed` and `d6062bb9` are the three
   answers the pass computed; the other three "repairs" are the floor.
2. `d905b33f` is worth naming as a **scorer** hazard rather than a mechanism one. The treatment
   answered *"Cannot be determined… no purchase price or discount percentage is stated"* against a
   gold of `20%`, and the judge accepted it. It sits in the floor, so it changes no conclusion here,
   but it is one accepted non-answer in 500 and it belongs in whatever counts the judge's own errors.

The treatment's net against the control is therefore **3 − 43 = −40 questions**, not −39.

## 2. The 46 mechanism flips share one shape

| column                            | value            | repair | damage | neutral |
| --------------------------------- | ---------------- | -----: | -----: | ------: |
| `operation`                       | `sum`            |      3 |     37 |      19 |
|                                   | `count`          |      0 |      6 |       7 |
| `scope` span ≥ 200 steps          | yes              |      3 |  **43** |     26 |
|                                   | no               |      0 |      0 |       0 |
| text predicates in the conjunction| 1                |      2 |     34 |      13 |
|                                   | 2                |      1 |      8 |       8 |
| a keyword naming a category       | yes              |      0 |      4 |       1 |

**Every mechanism flip — repair and damage alike — came from a plan whose `scope` covered the whole
ledger.** Not one of the 46 narrowed the range it asked to look at; the narrowing, where it exists at
all, lives entirely in the conjunction. That is why §3's diagnosis holds and why the numbers above
have no separating column in them: the three plans that computed a better answer and the 43 that
computed a worse one are the *same plans* as far as shape is concerned.

## 3. The damage has two directions, and only one of them was in the original reading

`MEASURE-SPEC-PASS.md` §3 described the four quoted damages as "semantically too wide" — a `sum` over
a predicate that matched too much. That is 37 of the 43. The other six are `count` plans that went
the **other** way:

| question        | control | treatment | gold  | the plan                                  |
| --------------- | ------- | --------- | ----- | ----------------------------------------- |
| `2e6d26dc`      | `5`     | `1`       | `5`   | `count` where `text contains "babies"`    |
| `4f54b7c9`      | `5`     | `1`       | `5`   | `count` over 4 keywords: `antique`, `item`, `inherit`, `family` |
| `60159905`      | `3`       | `2`       | three | `count` over `dinner` + `attend` + a role |
| `00ca467f`      | `2`     | `1`       | `2`   | `count` over `appointment` + `march`      |
| `gpt4_15e38248` | `4`     | `3`       | `4`   | `count` over `furniture`                  |
| `80ec1f4f`      | `2`     | `3`       | `2`   | `count` over a month name                 |

Five of six under-count and one over-counts. Read beside the `sum` side, the two directions are one
failure: a predicate's **extension** — the set of rows it admits — is chosen by the model from the
question's words, and nothing in the contract ties that extension to the evidence the first answer
rested on. A category noun admits rows the reader never used, so the sum is too large; a conjunction
of three or four words excludes rows the reader did use, so the count is too small. The executor is
faithful in both directions, which is exactly the property that makes it useless as a check on this.

## 4. Every candidate gate is priced, and the best one reaches the noise floor

`tools/plan-shape-census.py` prices eight gates that could have been written before the census ran.
Each is a predicate that **refuses** a plan; a refused plan keeps the first answer.

| gate                            | damage blocked | repair lost | net questions vs control |
| ------------------------------- | -------------: | ----------: | -----------------------: |
| `span-wide`                     |             43 |           3 |                     **+1** |
| `single-text-predicate`         |             34 |           2 |                       −7 |
| `sum`                           |             37 |           3 |                       −5 |
| `no-number-predicate`           |             23 |           0 |                      −16 |
| `sum-without-number-predicate`  |             17 |           0 |                      −22 |
| `count`                         |              6 |           0 |                      −33 |
| `kind-noun`                     |              4 |           0 |                      −35 |
| `no-text-predicate`             |              0 |           0 |                      −39 |

`span-wide` blocks **43 of the 43** mechanism damages and loses **all 3** mechanism repairs, and the
`+1` it shows is the variance floor from §1 — the two planless flips it cannot reach. So the best
member of the family does not return the arm to the control; it returns the arm to the control *plus
the luck*, which is the same statement.

**This is the family's ceiling, not a tuning problem.** The gates are ordered the way they are
because a gate that blocks more damage also blocks more repairs: `span-wide` and `sum` are almost the
same gate, `count` and `kind-noun` are the narrow-plan gates and they block almost nothing on the
damage side. No conjunction of shape predicates moves up this table, because the row that would have
to move — "damages are wide, repairs are not" — is false in the data: the repairs are wide too.

## 5. What is left, and the one measurement this artifact cannot make

The remaining candidate is not a property of the plan. It is a property of the **relation between the
two answers**: whether the first answer's evidence appears inside the rows the plan selected. A plan
that sums every row mentioning `items` and gets `2` where the reader said `3` is not distinguishable
from a plan that is right by its shape — it is distinguishable only by whether row `3` is in its
support.

That number is not in this artifact. `support` is a field of `AggregationResult`, computed by the
executor on every call, and **it is dropped at `memory.ts`**: the branch renders the value, keeps the
string, and never persists the ids. `retrievedContexts` — the roster that would let a reader
reconstruct the ledger — is not in this report either. So the registered next signal is measurable
only after one change, and the change is an instrument change, not a mechanism one:

> persist, per question, the plan's selected row count, the ledger's row count, and whether the
> first answer's own token appears among the selected rows — three integers and a boolean, computed
> where the ledger already exists, carried by the census channel the recovery and audit traces
> already use.

Until that exists, a guard built on the relation would be a guess about a distribution nobody has
looked at, which is the mistake this campaign has already paid for twice (`tally` −9.5, `spec` −7.8).

## 6. What this round refuses

It refuses to dispatch a `spec` arm with a shape gate. The table above is not "a promising gate at
+1"; it is the measured statement that the gate family cannot pay for itself on this population, and
a dispatch is 14 CNY and 2 h 44 m. It also refuses to re-read the −39 as −40 as if the correction
were the finding: the finding is that **5 of 51 flips were noise and 46 were one shape**, so the next
experiment has to be aimed at the relation rather than at the plan.
