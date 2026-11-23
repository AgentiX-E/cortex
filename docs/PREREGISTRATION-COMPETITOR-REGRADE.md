# PREREGISTRATION-COMPETITOR-REGRADE

A pre-registration, written before the dispatch, for putting a competitor's published answers through
this repository's judge.

> **STATUS: REGISTERED, not yet dispatched.** The population is prepared by `data-prep.yml` at no model
> cost; the re-grade is `competitor-regrade.yml`, dispatched only after the preparation census has been
> read. §5 states the precondition that has to hold before the reading is admissible, and §6 states what
> it costs.

## 1. The two numbers, and what each one actually divides by

| system | headline | what the denominator is | evidence |
| --- | --- | --- | --- |
| cortex (registered arm, `S16`) | 91.25% | **2,000 judge verdicts**: 500 questions × 4 passes | `costEfficiency.accuracy` with `accuracySource: all-runs`, run `44017278305` |
| cortex (same arm, per question) | **91.20%** | **500 questions**: `feature.metrics.correct = 456` | same artifact, `feature.metrics.accuracy = 0.912` |
| Maximem Synap | 95.6% | 500 questions, one pass | `manifest_gemini-3.8-flash.json`, `results/longmemeval/` |

The 0.05-point difference between the first two rows is not a rounding error, it is a different
quantity: one averages four verdicts per question, the other counts a question once. Every comparison
in this campaign quotes 91.25% against a single-pass number, and that is a units error however small
it is. **This pre-registration uses 91.20%**, because it is the only one of the two that divides by the
same thing 95.6% divides by.

The size of the correction is not the reason to record it. The reason is that the same mistake, at a
larger size, is what the whole gap is suspected of being.

## 2. Why the 4.35-point gap is not a measurement yet

`91.20 − 95.6 = −4.40` points. Both numbers are the opinion of a judge, and they are two different
judges:

* **theirs** is the official `evaluate_qa.py` per-question-type prompt, under a judge model the
  published manifest does not name;
* **ours** is `deepseek-chat` at temperature 0, under the same prompts
  (`memoryArmConfig.judge = {providerId: deepseek, model: deepseek-chat, temperature: 0}`), plus three
  mechanical channels that never call a model — exact normalised match, structurally absent answer,
  numeric comparison on counting questions.

So the gap is the sum of a system difference and an instrument difference, and this campaign has
measured what an instrument difference of this kind can be: re-grading 467 unchanged answers with
`deepseek-v4-pro` when `deepseek-chat` had graded them moved 15 questions (≈3.2 points) with zero
rescued. A judge substitution is the same order as the entire gap.

## 3. What is re-graded, and what is not

Their **answers** are re-graded. Their **engine** is not re-run: it is a hosted service and the
published repository is an SDK that calls it, so the only instrument available is the per-question
record file (§169.5).

This makes the reading **one-directional**, and the artefact says so: it measures *their answers under
our ruler*. There is no reading of our answers under their ruler, because their ruler's model is not
published. A comparison of the two claims is therefore available only under one ruler, which is enough
to compare two systems and not enough to say which ruler is the correct one.

## 4. Design

1. `data-prep.yml` fetches `question_records_gemini-3.8-flash.json` (23,685,907 B) on a runner, censuses
   it, and reduces it to 500 lined-up answers. The answer field is **identified, not assumed**; if the
   census cannot separate two candidates it writes `null` and refuses to produce a population.
2. `competitor-regrade.yml` downloads that artefact, plans (no model, no key), then grades each answer
   with `judgeScorer(createLlmJudge(createJudgeFromEnv(env)))` — **the same scorer object** that
   produced 91.20%, so the mechanical channels apply to them as they applied to us.
3. Each row records `publishedVerdict` (from their own `correct` field) and `ourVerdict`.
4. Pairing is by `questionId`, which both files carry in the same 8-hex form.

## 5. Admissibility: what has to hold before the reading is quoted

These are not diagnostics to report after the fact; any one of them failing makes the reading
inadmissible and returns it to the preparation step.

| # | condition | why it is not optional |
| --- | --- | --- |
| A1 | the census converged on an answer field (`answerField != null`) | an unconverged guess produces a plausible accuracy rather than an error |
| A2 | their own per-question verdicts reproduce 95.6% within ±0.5 points | if the published headline is not the arithmetic of these 500 rows, the comparison is against a number about a different subset |
| A3 | ≥ 490 of 500 answers are non-empty | a population that lost more than 2% to extraction is a reading about the extractor |
| A4 | `unrecognisedReplies` ≤ 5 | a judge whose replies this parser cannot read produces `false`, and 500 of those look like a very strict judge |
| A5 | the 500 `questionId`s are the ones in `longmemeval_s_cleaned.json` | a different population would make the pairing a comparison of two corpora |

A2 is the interesting one and it is checkable for free: their `correct` field, counted, is either 95.6%
of 500 = 478 or it is not. If it is not, the first thing to establish is how their headline aggregates —
per-category, or excluding a category — before any re-grade is interpretable.

## 6. The decision rules, written before the numbers

Let `S′` be their accuracy under our judge on the paired population, and `C` be ours (456/500 = 91.20%).

**R1 — is the ruler difference larger than the rerun band?** The band for a same-configuration rerun is
±3.21 points. If `|S′ − 95.6| > 3.21`, the two rulers differ on this population and the difference is
reported with its **direction** (`rescued` = we accept what they rejected; `revoked` = the reverse). If
`|S′ − 95.6| ≤ 3.21`, the rulers agree on the aggregate rate and the gap is not attributable to the
instrument.

A direction claim requires the discordant split, not the rate: +2 points is consistent with a stricter
judge and with a lenient one.

**R2 — is the system difference real under one ruler?** Paired, on the questions both instruments
judged, by exact two-sided sign test over discordant pairs (`discordantPValue` in the tool):

* `discordantPValue < 0.05` **and** more questions where theirs is right and ours is wrong → *Synap
  leads under our ruler*, and the gap is a system difference;
* `discordantPValue < 0.05` **and** the reverse → *cortex leads under our ruler*;
* otherwise → **the gap is not established**, and the correct sentence is "4.4 points, not separable
  from the judge at this population size".

**R3 — if pairing fails** (A5 fails, or their ids do not line up), the fallback is a Newcombe interval on
the difference of two independent proportions. At 500 per side its 95% half-width is ≈3.1 points, i.e.
the whole gap is at the edge of resolution. **A pairing failure therefore downgrades any conclusion to
"undetermined"**, not to "a wider interval that happens to exclude zero".

**R4 — how much of the verdict is the model's opinion.** The scorer's channel split is reported with
every reading. The share decided by `judge` is the share of the comparison that is one model's opinion
of two answers, and a conclusion carried by a large `judge` share is weaker than the same p-value
carried by `exact`/`numeric`.

## 7. Cost

| item | amount |
| --- | --- |
| calls | ≤ 500 (one per answer; `--max-calls` refuses above 600) |
| prompt tokens | ≈ 220 k (question + gold + answer, ≈1.7 kB per call at 3.8528 chars/token) |
| money | ≈ **¥0.5–1.5** at any published `deepseek-chat` input price; the tool reports tokens unless a price is passed |
| runner | one job, ≈6 minutes (install + build dominate, not the calls) |

The prep job it depends on is free: no model, no key.

## 8. What cannot be concluded from this

* **that either judge is correct.** This measures agreement, not truth. A judge that accepts everything
  would make both systems 100%.
* **that the competitor's engine is better or worse than its own answers suggest.** Their answers are
  an output of their engine and their reader prompt; a different reader on the same retrieval would
  move them.
* **an abstention rate.** The records carry `retrieval.abstention` and the population counts unknown
  flags, but their published accuracy may exclude abstention questions from a category. If A2 fails,
  this is the first place to look and the reading does not proceed.
* **anything about cost.** The 7,391-token figure is a projection on a different basis (§169.5, and
  `tools/synap-context-census.mjs`), and no token count on our side is measured here.

## 9. What would make this reading invalid after the fact

Recorded now so that a later reader can check rather than trust: a re-grade whose population differs
from the one this file names (a newer `question_records_*.json`), a judge model other than
`deepseek-chat`, a scorer other than `judgeScorer`, a `LIMIT` below 500, or a run whose
`answerFieldSource` is `override` — the last one is admissible, but its provenance has to be stated in
the same sentence as the number.

## 10. Result (dispatched 2026-11-23, run `45229423125`)

The pre-registration above was written before the run and is unchanged. What follows is what came back.

### 10.1 Admissibility, condition by condition

| # | required | observed | verdict |
| --- | --- | --- | --- |
| A1 | answer field converged | `answering.generated_answer` — 472 distinct values over 500 records; the census refused the two high-cardinality neighbours and a person named the column (`answerFieldSource: override`) | ✓ |
| A2 | their verdicts reproduce 95.6% ± 0.5 | **478/500 = 95.60%**, exact to two decimals; the verdict column is `judge.judge_raw`, whose values are `Yes.` ×355, `Yes` ×110, `yes` ×13, `No.` ×11, `No` ×11 | ✓ |
| A3 | ≥ 490 non-empty answers | **500/500** | ✓ |
| A4 | ≤ 5 unreadable judge replies | **0**, and `unjudged: 0` | ✓ |
| A5 | the 500 ids match the corpus | intersection **500/500** | ✓ |

A2 fired usefully before it passed: an earlier parse kept only `Yes`/`No`/`yes` (134 questions) and read
91.79%. The 366 that went missing were `Yes.` — a trailing full stop, against a `cortex-eval` parser that
reads verdicts by prefix and had always accepted them. The instrument was stricter than the instrument it
was measuring with.

### 10.2 The three readings

| reading | pairs | left | right | delta | discordant | p |
| --- | --- | --- | --- | --- | --- | --- |
| **ruler** (their answers, two judges) | 500 | 95.80% ours | 95.60% theirs | **+0.20** | 3 / 2 | **1.0000** |
| **system** (our judge, two answer sets) | 500 | 91.20% cortex | 95.80% Synap | **−4.60** | 14 / 37 | **0.0018** |
| reference (the old headline) | 500 | 91.20% | 95.60% | −4.40 | 14 / 36 | 0.0026 |

**R1 is refuted.** `|0.20| ≪ 3.21` and the discordant split is 3-to-2, which is no direction at all.
Replacing their judge with ours does not move their number. The hypothesis that the 4.4-point gap was an
instrument artefact — the hypothesis this pre-registration was written to test — is false.

**R2 holds.** Under one judge, on one 500-question population, with 500/500 paired ids, Synap leads by
**4.60 points** and the sign test over 51 discordant pairs gives `p = 0.0018`. The gap is larger than the
headline by 0.2 points, because our judge is marginally more lenient and it is lenient on both sides.

### 10.3 What the channel split adds, and one asymmetry in it

`scorerChannelStats` for the re-grade: `judge 500/500 = 100.0%`, `exact 0`, `numeric 0`, `structural 0`.
Cortex's own run reached 42.0% of its verdicts by normalised string equality (210 of 500 answers are
literally the gold). So the comparison is: **210 of cortex's 456 correct answers were decided by a test
that cannot be wrong, and none of Synap's 479 were.**

That does not weaken the result — it strengthens its direction, since Synap reached 95.80% without the
free channel. It does mean the two accuracies lean on the judge by different amounts, which is why the
channel split is recorded beside them rather than summarised.

### 10.4 Answer length, and the one hypothesis it leaves standing

| | median characters |
| --- | --- |
| cortex answers | 14.5 (gold: 9) |
| Synap answers | 181.5 |
| Synap answers on the 44 questions cortex got wrong | **365** |
| Synap answers on the 456 cortex got right | 177 |

Cortex answers in short phrases and Synap in explained paragraphs that double in length where cortex
fails. Of cortex's 44 failures, **20** are shorter than the gold — the shape the official default template
rejects by name ("if the response only contains a subset of the information required by the answer, answer
no") — and 24 are wrong answers of a comparable length. Synap answered 37 of those 44 correctly.

So "answer too short" does not explain the gap, but "answer incomplete" has a **measured upper bound of 20
questions = 4.0 points**, which is the same order as the 4.60-point gap. That is the next experiment, and
its ceiling is not an estimate.

### 10.5 Cost

500 judge calls, 120,284 prompt tokens, **≈¥0.3**. The plan predicted 120,284 before the first call,
because it computes the size with `buildJudgePrompt` rather than with a character heuristic — and the two
agreed exactly, which is the check that the plan and the run graded the same strings.
