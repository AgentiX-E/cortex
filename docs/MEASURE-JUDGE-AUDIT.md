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
