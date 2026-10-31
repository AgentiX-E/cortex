# Measuring the judge: how often does it accept an answer that is wrong?

```bash
# 1. what would be asked, with no model and no key — the reviewable form
node tools/judge-audit.mjs --artifact <report.json> --limit 120 --plan-only

# 2. the audit — the exit code is the gate
node tools/judge-audit.mjs --artifact <report.json> --limit 120 --out readings/judge-audit.json
```

Or dispatch `.github/workflows/judge-audit.yml` with the benchmark run id; the runner holds the key
this instrument needs.

## What it measures

Every accuracy number this repository publishes is the judge's opinion. The audit takes answers the
judge **already accepted** (`correct: true`), perturbs each one so that it is wrong by construction,
and re-submits it with the same template:

| kind          | what moves                                                              |
| ------------- | ----------------------------------------------------------------------- |
| `number-swap` | a number the gold states → a value absent from the conversation          |
| `entity-swap` | a name the gold states → another real name from the corpus, absent here  |
| `cross-gold`  | the whole answer → a different question's gold, same capability         |

Two invariants make a "yes" unambiguous, and both run on every planned case rather than in a test:

1. the perturbed answer no longer mentions the gold;
2. the introduced token appears nowhere in the conversation the model read.

The second is what stops a swapped name from being *another true fact* the judge was right about.

## Why a rate alone would be worthless

A judge that always answered "no" would score a perfect false-accept rate. So the unperturbed answers
are re-judged in the same run — the **control**. Anything below 100% there is judge
non-reproducibility (`§13.135` measured 5.0% on byte-identical prompts), and it is the noise floor the
rate has to be read against.

## The reading: `41159983913`, 120 questions, 160 cases, 280 calls

| bucket | accepts | rate | Wilson 95% upper |
| ------ | ------: | ---: | ---------------: |
| all kinds | **31 / 160** | **19.38%** | **26.19%** |
| `number-swap` | 9 / 61 | 14.75% | 25.72% |
| `entity-swap` | **22 / 49** | **44.90%** | 58.69% |
| `cross-gold` | 0 / 50 | 0.00% | 7.14% |
| **control** | **120 / 120** | **100%** | — |

**The gate fails.** And the shape of the failure is the finding: replacing a **name** is three times
more likely to be accepted than replacing a **number**, and replacing the entire answer is never
accepted. The judge checks that the answer is about the right thing, not that it names the right
entity — which is exactly the error an extracted-atom memory system makes. The judge is blindest where
this system is weakest.

The control at 120/120 is what makes the 19.4% readable: the judge is perfectly reproducible on these
answers, so this is bias, not noise, and `§13.135`'s 5.0% floor belongs to the reader.

Applied to MR: `19.38% × 121 = 23.5 questions`, against a measured gap of 16 questions to the
reference pipeline — **the instrument's error is larger than the effect it reports**, so paired flip
counts become mandatory rather than preferred. Registered reading, five prediction verdicts (one
falsified), and the next step: `§13.184`.

> **Withdrawn in part (`§13.185`, `§13.186`).** That multiplication assumed the rate transfers to MR. It
> does not: 82 of the 84 accepted MR golds name nothing at all, so `entity-swap` cases could not be drawn
> from MR, and the 44.90% is about the 119 accepted answers whose golds do name something — two of which
> are MR. The channel MR does have is the number, and reading it judge-free finds **0 false accepts in 80
> readable accepted answers (upper bound 4.6%)** and one disagreement with the judge in 101 rows, in which
> the judge was wrong. The 19.38% stands; the annotation "MR is judge-limited" does not. See
> [`MEASURE-MR-CHANNEL.md`](MEASURE-MR-CHANNEL.md).

## The gate, and why 5%

Exit 1 when the Wilson 95% upper bound exceeds 5%. The campaign resolves about 1.7 points — two
questions of 121 — so a judge that mis-accepts 5% of wrong answers is already larger than the signal.
Above it the reading is not abandoned: every capability comparison becomes a **paired flip count**
rather than a difference of accuracies.

## What it does not say

- **Not agreement with a human**, and not transferable to answers that are wrong by **omission** — a
  plausible half-answer, which is the shape `§13.96` found in the MR failures.
- **Not the official judge.** `deepseek-chat` with the official templates is this repository's judge.
- **Not a correction.** Nothing here adjusts a published accuracy; it prices the instrument.

The published reference point is LoCoMo's audit: about 6.4% of its gold answers are at risk of a
scoring error, and a standard judge (`gpt-4o-mini`, official prompt) accepted **62.81%** of answers
that were topical but wrong. Registered reading and predictions: `§13.182`.
