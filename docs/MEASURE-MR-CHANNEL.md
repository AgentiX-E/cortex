# Measuring MR on a channel MR has: the name screen that could not see it, and the number screen that can

```bash
# names — does an accepted answer name something the gold never states?
node tools/mr-entity-recheck.mjs --artifact <report.json> --capability MR --sample 25

# numbers — what does the answer state, against what the gold states? no judge in the loop
node tools/numeric-recheck.mjs --artifact <report.json> --capability MR --sample 20
```

Or dispatch `mr-entity-recheck.yml` / `numeric-recheck.yml` with a benchmark run id. Neither needs a key
or a credit: both read strings out of an artifact that already exists.

## Why these exist

`§13.184` measured the judge accepting **19.38%** of answers that were wrong by construction, split
`entity-swap` **44.90%** / `number-swap` **14.75%** / `cross-gold` **0/50**, and the previous iteration
turned that into an annotation: `19.38% × 121 = 23.5` questions of MR headroom, larger than the 16-question
gap to the reference arm, therefore *MR is judge-limited*.

That multiplication had an unexamined premise — that the rate transfers to MR. A rate over 160 sampled
cases does not say which capability carries it. These two instruments test the premise from inside the
artifact, and the second one replaces the annotation with a measurement.

## The name screen, and why it fails on MR

`nameScreen` compares the names an answer states with the names its gold states. Four relations, and two
of them are deliberately *not* verdicts:

| relation | test | what it licenses |
| --- | --- | --- |
| `shared-name` | the answer states at least one name the gold states | nothing; the screen is silent |
| `names-disjoint` | both sides name something, nothing in common | a **candidate** false accept |
| `unnamed-gold` | the gold names nothing (`18 days`, `3`) | nothing; the screen cannot reach it |
| `unnamed-answer` | the gold names something, the answer names nothing (`2`) | nothing, and that is a limit |

It imports `entitiesIn` from the audit rather than restating it, so the pool `entity-swap` draws from and
the set the screen compares are one set.

### Reading: `41159983913`, MR, 121 rows

| population | rows | shared | disjoint | gold unnamed | answer unnamed |
| --- | ---: | ---: | ---: | ---: | ---: |
| accepted | 84 | 1 | **0** | **82** | 1 |
| rejected | 37 | 0 | 0 | 33 | 4 |

**Candidates 0. Reach 2 of 84.** The registered prediction (`§13.184.5`: at most `84 − 5 = 79`, i.e. at
least five accepted answers name something the gold does not) is **falsified**, and the reason is worth
more than the prediction: 82 of the 84 accepted MR golds name nothing at all. The golds are `2`, `$50`,
`20%`, `3 days`, `$5,850`, `140 hours`, `an hour and a half`. Multi-session reasoning on this dataset is
arithmetic across sessions.

So the audit's 44.90% is a statement about the **119 of 419** accepted answers whose golds name anything,
of which MR contributes **two**. It cannot be multiplied by 121.

Across all five capabilities the screen is not simply blind — it fires on 5 of 81 rejected answers (6.2%)
and 5 of 419 accepted ones (1.2%), a factor of 5.2 — and one of those five is a correct abridged answer
against a gold naming an `iPhone 13 Pro`. The list is for adjudication; it is not a subtraction.

## The number screen, and what it can see

`numericScreen` reads the value the answer commits to. The arm ends its replies with its answer
(`$60 / 5 = $12 per mug. 12`), so the **last** numeric token is that value, and comparing it with the
gold's numbers needs no judge. Five relations:

| relation | meaning |
| --- | --- |
| `agrees` | the stated value is one of the gold's values |
| `agrees-early` | the gold's value appears, but the answer commits to a different one |
| `differs` | neither |
| `gold-unreachable` | the gold has no digits (`an hour and a half`) |
| `answer-unreachable` | the answer states no number — a **decline** lands here |

`agrees-early` is its own relation because it is the failure that most resembles success: the reader
computed `$12` and then answered `$13`.

### Reading: the same artifact, MR, 121 rows

| population | rows | agrees | agrees-early | differs | gold unreachable | answer unreachable |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| accepted | 84 | **80** | 0 | **0** | 4 | 0 |
| rejected | 37 | 1 | 0 | 20 | 8 | 8 |

- **False accepts: 0 of 80 readable accepted answers (0.0%, Wilson 95% upper 4.6%).**
- **False rejects: 1** — `92a0aa75`, gold `1,5`, the answer stated `1`.
- Judge-free accuracy **81/101 (80.2%)**; the judge, on the same 101 rows, says **80/101**.

**The two instruments disagree on one MR question out of 101, and the judge is the one that is wrong.**
The audit's bound is 5% and MR reads 4.6% — under it. The 19.38% is real, but it is a property of a channel
the real answers barely exercise, not of MR's answers.

Per capability, with the same rule:

| capability | accepted | readable accepted | false accepts | Wilson 95% upper | false rejects |
| --- | ---: | ---: | ---: | ---: | ---: |
| **MR** | 84 | 80 | **0** | **4.6%** | 1 |
| TR | 105 | 54 | 1 | 9.8% | 0 |
| IE | 141 | 43 | 0 | 8.2% | 0 |
| KU | 60 | 32 | 1 | 15.7% | 1 |
| ABS | 29 | 0 | — | — | 0 |
| all | 419 | 209 | 2 | 3.4% | 2 |

The two false accepts in 209 are outside MR. A judge that misses a swapped name at 44.90% is not a judge
that accepts wrong numbers — and the two statements are only in tension if the audit's rate is read as a
per-answer property, which it never was.

## The gate, and the two ways it can lie

Exit 1 when the capability has no row the instrument can read. `0 false accepts` and `the instrument read
nothing` print the same number, and the first dispatch of the name screen shipped that ambiguity for one
run: 0 of 84 looked like a clean arm.

Two defects were found by running these on a real artifact rather than on the test corpus, and both are
fixed with the case as a test:

1. **`Five` was read as a name.** Gold `Five months ago` against an answer naming a city produced a
   candidate on a question about duration. Number words, pronouns (`They` in `They adopted a Labrador`)
   and discourse markers are excluded from `NOT_A_NAME` — a change that also removes nonsense
   `entity-swap` substitutions from the audit, since it draws from the same pool.
2. **A silent denominator.** `sourcesFrom` filtered on `typeof question.answer === 'string'`, which drops
   every **decline**. MR lost 8 of its 121 rows and nothing said so; the numerator was untouched because a
   decline is never correct. The tools now print `N of M unusable, no verdict`, keep declines as
   `answer-unreachable` / `unnamed-answer`, and the reading counts 121 rows.

## What these do not say

- **The name screen does not measure the judge.** It measures which real answers exercise the channel the
  judge was shown to miss.
- **The number screen cannot see a wrong answer that keeps the gold's number** — `3 people` against a gold
  of `3 days` agrees here and was accepted by the judge. It bounds the number channel, not the capability.
- **Units are ignored** (`3 days` against `72 hours` differs) and percentages are their number (`20%`
  against `0.2` differs). Both are stated in the module and both move a small class.
- **The stated-answer semantics hold where the answer is a value.** On TR the same rule reads 28.3%
  judge-free accuracy, which is not a claim about TR: those replies end with reasoning. Only MR is read as
  an accuracy.
- **Not a correction of any published number.** MR's 84/121 stands, and so does the 16-question gap to the
  reference arm. What changes is that the gap is now a **memory** finding rather than a grading one.

Registered readings, prediction verdicts and the withdrawal: `§13.185` (names) and `§13.186` (numbers).
