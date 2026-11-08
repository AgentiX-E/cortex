# The oracle ceiling: splitting the distance to 100% into what retrieval lost and what the reader lost

Status: **pre-registered, dispatch pending**. Registered 2026-11-08, before the first run of either
condition. Written against `05-competitor-analysis.md` §1.38.5 (`O1`) and `§1.38.4` (`E1`).

## 1. The question

Every number this project has published is a **system** number: a reader, a prompt, an admission
gate and a retriever, all moving together. That is the right number to ship and the wrong number to
steer by, because it cannot say which component to spend the next round on. Two components account
for almost all of the remaining 8.4 points and there has never been a measurement that separated
them:

| Component | What it decides | Never measured here as |
| --- | --- | --- |
| **Retrieval** | which turns reach the prompt at all | the gap between the shipped score and the score with the gold sessions supplied |
| **Reading** | whether the reader answers correctly from what it was handed | the gap between that score and 100% |

The closest thing this repository has is the **pool ceiling** (`recall-curve`, 93.02%), which answers
"what if this retrieved pool were perfectly re-ordered". That is a different quantity: a perfect
re-ordering of a pool that does not contain the answer still cannot answer, so 93.02% is a bound on
the ranking stage and not on the system. `MEASURE-READING-STAGE.md` §5.2 says so in its own words —
*"not the oracle ceiling ... it cannot separate 'the reader is weak' from 'this reader is weak on
this context'"*.

A rival publishes both halves of the split. `Caura` reports 92.2% shipped and **94.6% under an
oracle condition** on the same 500 questions, which reads as **2.4 points of retrieval loss and 5.4
of reading loss**. If our split has the same shape, every future round belongs on the reader; if it
is inverted, the `MR` axis (the nine-question ceiling §1.37 registers) is not the main front at all.

## 2. The design

**One variable: the evidence pool.** Each question's `context` and `sessions` are replaced by its
gold sessions — every turn of the sessions named by the dataset's `answer_session_ids`, which is the
same set LongMemEval's official oracle file ships. Nothing else moves: the reader, the judge, the
temperature, the prompt contract, the ask, the admission gate, the per-turn cap, the prompt budget,
the answer cache and the four repetitions are all read from the same environment by the same code.

Both ablation sides are handed the oracle dataset. That is deliberate: it keeps the comparison
*paired* (same evidence, two systems), and it yields a second free reading — the reference pipeline's
own ceiling — which tells us whether our reader or our assembly is the limit.

Implementation: `packages/cortex-eval/src/oracle-evidence.ts`, armed by `CORTEX_MEMORY_ORACLE=1`
(a repository variable rather than a dispatch input; the workflow sits at 24 of GitHub's 25 inputs
and `test_dispatch_inputs.py` refuses a workflow that reaches the limit).

### 2.1 What this condition cannot separate, stated before the number exists

The gold pool is **~12 turns against ~550**. So the oracle run differs from a shipped run in two
ways at once: the evidence is correct, and there is 40× less of it. A high ceiling therefore cannot
be read as "retrieval is the only problem" — it may be reading "the reader does well when the
context is short". Caura's published oracle condition has exactly the same property; it is the
definition of the condition rather than a defect in this implementation. `E1` (§5) is the
measurement that separates the two, which is why both are registered in the same round.

Two further asymmetries, both in the reader's favour and both stated now:

1. **Per-turn truncation stops binding.** `maxTurnChars=400` reaches `multi-session` and `temporal`;
   with a 12-turn pool the room is 40× larger than the material, so no gold turn is cut. The shipped
   prompt does cut some.
2. **The 48,460-character room stops binding.** Every gold pool fits. The shipped run sometimes
   does not.

So the ceiling is an **upper** bound on "perfect retrieval, same everything else", not a central
estimate of it. A *low* ceiling is therefore strong evidence — it cannot be explained by either
asymmetry — while a *high* one is weak evidence. That asymmetry is the reason the judgement below is
written as a one-sided test.

## 3. Population, census, and the checks the artifact must pass

| Item | Value | Check |
| --- | --- | --- |
| Questions | 500 (LongMemEval-S, `limit=0`) | `questionCount == 500` |
| Gold annotation | **500 / 500** (`goldOverlap.total > 0` on every record of run `42373407439`, median 12, mean 15.0, max 48) | `census.unsourced == 0` |
| Roster | `IE 150 / TR 127 / MR 121 / KU 72 / ABS 30` | per-capability table reproduces |
| Dataset name | `longmemeval+oracle` | `assertOracleReached` throws otherwise |
| Pool vs shipped | `turns` and `chars` printed at load time, with the ratio | log line `Oracle evidence: …` |

The `unsourced == 0` check is the load-bearing one. A question without gold evidence keeps its
shipped context, so a ceiling computed over a mixed population would be a shipped score and an
oracle score averaged with unknown weights. If a future dataset annotates fewer questions, the
sourced subset becomes its own denominator and the run reports both — it does not silently average.

## 4. Judgement, registered before the run

Let `S` = the registered configuration's shipped score on the same 500 questions, and `C` = the
feature accuracy of the oracle run (the ceiling). The difference `C − S` is retrieval's loss; `100 − C`
is the reader's.

**`S` is not the published headline, and the correction matters.** The number this project has quoted
as its own — 91.60% (458/500) — belongs to a configuration that was superseded on 2026-11-07: it
predates the `retrieval-anchored` ranking and the `evidence-blocks-unsourced` contract. The latest
500-question run of the **registered** configuration is `42337560027`, **456/500 = 91.20%**, and its
per-capability column (`IE 143/150, MR 99/121, KU 64/72, TR 120/127, ABS 30/30`) is the one every
later table has been quoting. It differs from the registered form in one field: `maxPromptChars` was
48,000 on all six routes rather than 48,460 on `multi-session`, which is 460 characters — 0.95% of one
route's room — adopted to pay back the extra instruction text `verbatim-acts` writes. **That form has
never been measured at 500 questions.** The control dispatch of this round measures it, so `S` becomes
a number from this round rather than a number carried forward.

The judgement is written in **questions**, not points, because the question is the unit the noise
floor is stated in and a point-denominated threshold invites arithmetic that hides it.

| # | Reading | Verdict | Consequence |
| --- | --- | --- | --- |
| 1 | `C − S ≤ 8 questions` (≤ 1.6 pp) | retrieval is nearly lossless: even the optimistic ceiling buys almost nothing over what retrieval already delivers | **`MR` stops being the main front.** Every round moves to the reader — contract, ask, second consultation, the audit. Retrieval work is re-scoped to what it costs, not what it might gain |
| 2 | `9 – 27 questions` | inside the floor — unreadable in either direction | **do not conclude.** The registered recovery is `C3`: four repeated oracle dispatches, whose pooled paired test has the power this single draw lacks. Reading a number in this band as a verdict is the defect the floor exists to prevent |
| 3 | `C − S ≥ 28 questions` (≥ 5.6 pp) | retrieval is the binding constraint, above the floor's 95% upper bound | the retrieval axis is re-opened with a budget: the pool, the ranking, and the 48,460-character room re-examined against `E1` |

Why those bands: the noise floor on this arm is **17 questions observed, 27 at 95%** (`§1.37.1`).
Band 1 is below the *lower* bound — a difference that small is not readable as a difference, but its
direction is the one that survives the ceiling's optimism (both asymmetries in §2.1 inflate `C`), so a
small `C − S` is evidence *against* retrieval being the problem even though a small negative one would
not be evidence for anything. Band 3 is above the *upper* bound. Band 2 is the region where the honest
answer is "repeat", and it is registered as a band rather than as a tie-break because a tie-break
chosen after seeing the number is not a rule.

**Falsifiers, and what each would refute:**

| Observation | Refutes |
| --- | --- |
| `census.unsourced > 0` | the population claim — the run is not an oracle measurement and must not be read as one |
| `dataset` lacking `+oracle` | the wiring — a shipped score would be published as a ceiling |
| feature accuracy identical to `S` to the digit | the transform (a 40× pool change that moves nothing is a defect, not a result) |
| `goldOverlap.carried < goldOverlap.total` on > 5% of sourced questions | the pool claim: the reader's own assembly dropped turns it was handed |
| transport retries > 0 or any refused call | the measurement — a throttled run reads low for a reason unrelated to the ceiling |

## 5. `E1`: the budget curve (registered in the same round)

`48,460 / 24,000 / 12,000` characters on `multi-session`, everything else at the registered
configuration, on the shipped corpus.

| Reading | Verdict |
| --- | --- |
| 12,000 loses **≤ 2 questions** against 48,460 | half of the last thirty rounds' tokens bought nothing; the budget becomes a cost axis with a measured knee, and the product default moves |
| 12,000 loses **3–9** | the knee is between the two, and the curve is refined at 18,000 before any adoption |
| 12,000 loses **≥ 10** | the room is load-bearing and the cost axis is closed for now |

The two conditions share one property that makes them readable together: if `C` is high **and**
12,000 loses nothing, then the shipped prompt is buying neither correctness nor necessity, and the
mechanism is over-provisioned on both axes. Neither number alone says that.

## 6. Cost and stopping rule

| Condition | Dispatches | Reader tokens (estimate) | Wall clock (measured on 4 workers) |
| --- | --- | --- | --- |
| `O1` oracle | 1 × 500 questions × 4 repetitions × 2 sides | ~2–4 M prompt (the pool is 40× smaller) | ~1 h |
| `E1` at 12,000 | 1 × 500 × 4 × 2 | ~14 M prompt (half the room) | ~3 h |

One dispatch each, no peeking, no re-running for a better draw. A run that dies on transport is
cancelled and re-dispatched once; a run that completes is final even if the number is unflattering.
## 7. The reading

### 7.1 Three numbers, and the band they land in

| Run           | Condition                                                                   | Accuracy (mean of 4)     | Pass 1           | Per capability (pass 1)             |
| ------------- | --------------------------------------------------------------------------- | ------------------------ | ---------------- | ----------------------------------- |
| `42500867182` | **`S`** — the registered configuration, shipped corpus                      | **91.90%** (91.40–92.40) | 92.00% (460/500) | `IE 144 MR 100 KU 63 TR 123 ABS 30` |
| `42500412709` | **`C`** — the same configuration, gold sessions                             | **92.90%** (92.40–93.60) | 93.00% (465/500) | `IE 141 MR 102 KU 67 TR 125 ABS 30` |
| `42500965819` | `E1` — the registered configuration at 12,000 characters on `multi-session` | 88.85% (88.60–89.20)     | 88.60% (443/500) | `IE 142 MR 84 TR 119` at pass 1     |

`C − S = 5 questions` (465 against 460 on the paired pass, 1.00 point on the means), which is **band 1**:
retrieval is nearly lossless. The paired table is `both 449, oracle-only 16, control-only 11, neither 24`,
McNemar exact `p = 0.44` — the difference is _not_ significant, and that is consistent with band 1 rather
than an objection to it. Band 1's claim is about size, and it holds in the only direction that survives
the ceiling's optimism: both asymmetries in §2.1 inflate `C`, so a ceiling within 5 questions of `S` cannot
be read as "retrieval has room left".

The decomposition the measurement was built for:

|                            | Questions | Points |
| -------------------------- | --------- | ------ |
| Retrieval's loss (`C − S`) | **5**     | 1.00   |
| Reader's loss (`100 − C`)  | **35.5**  | 7.10   |

### 7.2 Perfect evidence redistributes rather than lifts

`IE` **fell** three questions with strictly better evidence (`144 → 141`), while `KU` gained four and `MR`
and `TR` two each. Only one reading explains a route getting worse when its input gets strictly better:
the shipped arm is not delivering _less_ evidence than the gold sessions, it is delivering _ranked_
evidence, and the ranking is doing work that the oracle condition removes. §7.3 prices that work.

The per-capability paired table, which is what the next round's route choice has to be made from:

| Capability | `S` | `C` | Δ      | gained by oracle | lost by oracle | reading                                                                 |
| ---------- | --- | --- | ------ | ---------------- | -------------- | ----------------------------------------------------------------------- |
| `IE`       | 144 | 141 | **−3** | 2                | 5              | ranking is load-bearing here; the gold session is longer than what wins |
| `MR`       | 100 | 102 | +2     | 6                | 4              | retrieval is not `MR`'s problem                                         |
| `KU`       | 63  | 67  | +4     | 5                | 1              | newest-fact selection survives better on a clean pool                   |
| `TR`       | 123 | 125 | +2     | 3                | 1              | near ceiling either way                                                 |
| `ABS`      | 30  | 30  | 0      | 0                | 0              | saturated; 30/30 on both sides                                          |

### 7.3 What the reader is actually fed, measured on the same two artifacts

`goldOverlap` was built as a self-check on the transform. It is also a **precision** measurement of the
shipped arm, because the same field on the corpus side says how much of what the reader read came from a
session the dataset names as containing the answer.

| Arm          | Gold turns available | Carried (recall) | Turns delivered | **Precision** | Delivered per question |
| ------------ | -------------------- | ---------------- | --------------- | ------------- | ---------------------- |
| corpus (`S`) | 7,516                | 6,608 (87.9%)    | 185,520         | **3.6%**      | **371.0**              |
| oracle (`C`) | 7,516                | 7,503 (99.8%)    | 7,516           | 99.8%         | 15.0                   |

Per route on the corpus side, which is where the asymmetry lives:

| Capability | Recall    | Precision | Delivered per question | Gold per question |
| ---------- | --------- | --------- | ---------------------- | ----------------- |
| `IE`       | 84.7%     | **1.9%**  | 499.2                  | 11.4              |
| `ABS`      | 66.5%     | 3.0%      | 504.8                  | 22.4              |
| `KU`       | 79.0%     | 3.8%      | 488.9                  | 23.4              |
| `MR`       | **98.4%** | **6.1%**  | 242.4                  | 15.1              |
| `TR`       | 97.6%     | 5.1%      | 243.7                  | 12.7              |

Three facts follow, and the third is the round's real product:

1. **The reader is robust.** 96.4% of its input comes from sessions the dataset says are irrelevant, and
   removing all of it is worth one point. Any mechanism proposed on the grounds that "the model is
   distracted by noise" has to explain this table first.
2. **Retrieval's recall is not the problem on `MR`/`TR`** (98.4% / 97.6%): the gold turns are already in
   the window on almost every question. It is on `IE`/`KU`/`ABS` (84.7 / 79.0 / 66.5) where turns are
   actually missing — and those three routes are the ones with ~500 delivered turns each, i.e. the room is
   full and the ranker still did not surface them.
3. **The cost axis has a measured 24.7× redundancy**: 371 turns per question to carry 13, at **12,137
   prompt tokens per question** against **2,940** for the 15-turn oracle pool. The 9,197 tokens per
   question between them buy `−1.0` point.

### 7.4 The taxonomy of the 35 questions the reader loses

Every one of the 35 was read. The mechanical half of the table carries its own limit: "numeral present"
means the gold's numeral appears somewhere in the delivered evidence, which is **necessary and not
sufficient** for the question to be answerable. It is used only to separate "the reader had the number and
gave another" from "the number the gold asks for is nowhere in the text".

| Class | n | Routes | Examples | What it would take |
| --- | --- | --- | --- | --- |
| **Declined with the answer in the window** | **8** | `MR 4, IE 3, TR 1` | "Not specified in the evidence" (`a4996e51`, where the turn is cut at `maxTurnChars`), "Cannot be determined" (`d6062bb9`), `None` (`60bf93ed`, `37f165cf`, `75832dbd`, `778164c6`), "No items in the evidence match" (`0edc2aef`, `71017277`) | a commitment rule and truncation-aware evidence; the reader's own refusal rate is 6.8% and the abstention route is 30/30, so the instrument is not miscalibrated — these are the cases where it is wrong |
| **Count/enumeration miss, numeral present** | **8** | `MR` | `1` for `2` (`6d550036`), `2` for `3` (`46a3abf7`), `3` for `4` (`8e91e7d9`), `5` for `4` (`gpt4_7fce9456`), `22` for `23` (`gpt4_2f91af09`), `8` years for `10` | a screen that makes an omission visible — `candidates` asked for exactly this and was falsified (`§13.205`) |
| **Shape failure: a list of quotations instead of an answer** | **6** | `MR 2, IE 4` | `d905b33f`, `c18a7dc8`, `09d032c9`, `57f827a0`, `d6233ab6`, `1da05512` | a reply-shape guard on the routes that lack one (`answer-line` exists for the flat route) |
| **Knowledge update not applied: the superseded value won** | **5** | `KU` | `$350,000` for `$400,000` (`852ce960`), `30` for `20` dozen (`ed4ddc30`), `7:00 pm` for `6:00 pm` (`59524333`), `37` for `38` (`69fee5aa`), "under my bed" for "in a shoe rack in my closet" (`07741c45`) | the `KU` route has no date frame; `temporal` does. Five of five KU misses are one mechanism, and it is not counting |
| **Count where the gold is stated as a phrase** | **3** | `MR` | "I visited three different doctors" answered `2` (`gpt4_f2262a51`), "three weddings" answered `4`, "five items" answered `7` | as the count row — the phrase names the answer, the window does not contain the numeral |
| **Aggregation over operands, total never stated** | **2** | `MR` | `$700` for `$720` (`gpt4_731e37d7`), `$375` for `$495` (`2b8f3739`) | arithmetic the prompt cannot do by quotation |
| **Partial answer: the qualifier was dropped** | **1** | `IE` | "Dark Souls 3" for "Dark Souls 3 DLC" (`a82c026e`) | nothing structural; one question |
| **Unit conversion** | **1** | `TR` | 81 days / 11 weeks for 15 weeks (`370a8ff4`) | the answer was computed correctly in the wrong unit |
| **Preference answered as a suggestion, judged against the rubric** | **1** | `IE` | `a89d7624` | preference questions are 29 of 500 and 22 are correct on the flat route, so this is the tail of a route that mostly works |

Two readings dominate, and neither is the one this project has been building toward for ten rounds:

1. **14 of the 35 (40%) are not reasoning failures.** Eight refusals and six quotation dumps are the reader
   declining to commit or failing to take a shape, and both have deterministic repairs that do not touch the
   instruction content.
2. **`KU`'s five misses are one mechanism** — the superseded value wins on all five — and `KU` is the route
   that has no date frame. That is a route contract, not a prompt-wording question.

`MR` holds 19 of the 35 and only 2 of those are attributable to retrieval. §4's band-1 consequence says the
*retrieval* campaign on `MR` stops; this table says why, and it also says `MR` is not where the cheapest
points are: 8 of its 19 are enumeration, which is the axis with the most falsified attempts in this
repository's history, while `KU`'s 5 are a missing frame and the shape/commitment 14 are ceilings on how the
reader replies.

### 7.5 `E1`: the room is load-bearing

| Reading                    | Registered verdict                                               | Measured                           |
| -------------------------- | ---------------------------------------------------------------- | ---------------------------------- |
| 12,000 loses ≤ 2 questions | half the tokens bought nothing; the budget becomes a cost axis   |                                    |
| 12,000 loses 3–9           | the knee is between them; refine at 18,000                       |                                    |
| 12,000 loses **≥ 10**      | **the room is load-bearing and the cost axis is closed for now** | **−15.2 questions (−3.04 points)** |

The loss is almost entirely `MR` (`−14.5`), with `TR −1.0`, `IE +0.3`, `KU 0`. That is the mechanism
behaving as described: multi-session questions are the ones whose answers live across sessions, so the
route whose room was cut is the route that paid.

This replicates `42373407439` (`§` efficiency frontier: 6,077 prompt tokens per question against 12,137,
`−3.20` overall and `MR −6.61`) under the registered configuration and with four repetitions. Two
independent cuts, same direction, same route. **Truncation is not a cost lever for this mechanism**, and
§7.3 says why: the turns are not redundant, they are _unranked_.

### 7.6 Why the oracle run was red, and why that is not the measurement's fault

`42500412709` produced a complete 500-question artifact and then failed its post-run gate with
_`--departs names ['oracleEvidence'], which the dispatch table does not send`_. The dispatcher had
declared the repository variable's name, which appears in no artifact. The gate was right — and the
defect it exposed is worse than the declaration: with the name removed, all twenty field comparisons
agreed and the gate would have printed _"this run is the registered configuration, field for field, so
its numbers are quotable as the arm's"_ about the one artifact whose number means something different
from the arm's, because `evidenceSource` was in **neither** the dispatch table nor any comparison.

The repair is a fourth comparison category, `REGISTERED_CONDITIONS`: a value the registration implies, that
no dispatch input carries, and that changes what the number means rather than what the run did. It is
compared on every artifact and declareable by the name of the artifact's field. Absence reads as `corpus`
and that is a dated claim rather than an assumption — `toMemoryArmConfig` has written the field on every
run since `0ed3541` and the transform cannot produce an artifact that omits it, so an oracle artifact can
never be silent about being one.

The numbers in §7.1 are from the artifact that run produced. A second dispatch of the same condition
(`42521885948`, same commit, now declaring `evidenceSource`) is the confirmation draw; if it lands more
than the 17-question floor away from 92.90%, §7.1's band is revisited rather than averaged.

## 8. `E2`: the precision probe, registered before the run

§7.3 is the reason this exists. The arm carries 13 gold turns inside 371 and pays 12,137 prompt tokens per
question for it; the oracle arm carries 15 turns for 2,940 and scores one point higher. The room cannot be
shrunk (§7.5), so the only remaining cost lever is **selection**: deliver fewer turns, chosen better.

`relevanceTopK=32` against the registered configuration, one variable, 500 questions, four repetitions,
both sides. 32 is two times the oracle pool's 15 turns — a number the ceiling run measured rather than
guessed.

| Reading                                | Verdict                                                                                                                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| loses **≤ 5 questions** against 91.90% | 87% of the delivered evidence was dead weight; adopt, and the arm ships at roughly an eighth of its prompt tokens for the same accuracy                                 |
| loses **6–15**                         | the frontier moves and there is no dominance: read `goldOverlap` recall at 32 turns from the same artifact and decide whether to invest in the ranker or in compression |
| loses **≥ 16**                         | volume _is_ the mechanism. Selection at 32 cannot substitute for it, and the cost axis has to be attacked by compressing turns rather than by dropping them             |

The free measurement inside that judgement is the recall column: the artifact's own `goldOverlap` reports
how many gold turns survived the cut, so the run answers "what is the ranker's recall at 32 turns" whether
or not it answers the accuracy question. Falsifier: if `goldOverlap.carried/total` at 32 turns is above
90% while accuracy falls by more than 15 questions, then the gold turns were not the binding evidence and
§7.3's precision reading is a coincidence rather than a cause.

### 7.7 The confirmation draw, and what it says about the floor

`42521885948` is the same condition on the same commit, re-dispatched after the gate learned to
declare `evidenceSource`. It is green end to end, and the gate now says what it could not say before:

```
  registration: 21 field(s) compared, 2 derived, 3 harness, 1 presence
  same         20 field(s)
    declared    evidenceSource: "corpus" (registered) -> "gold-sessions" (ran)
  verdict: 1 field(s) departed and every one of them is declared — the run is an experiment whose
           registration is its departure list
```

The number:

| Draw | Mean of 4 | Pass 1 | Per capability (mean of 4) |
| --- | --- | --- | --- |
| `42500412709` | 92.90% (92.40–93.60) | 465/500 | `IE 141.8 MR 103.5 KU 66.0 TR 123.3 ABS 30` |
| `42521885948` | **92.90%** (92.20–93.60) | 468/500 | `IE 140.5 MR 102.8 KU 66.8 TR 124.5 ABS 30` |

Two independent dispatches agree to **0.0 points** on the mean, and their pass-1 answers agree on
**491 of 500 questions** (`both 462, only-draw-1 3, only-draw-2 6, neither 29`, 98.2% agreement). The
9 discordant questions are the reader's own sampling, and they are the number §7.1's band should be
read against: **a 5-question difference between `C` and `S` is smaller than the 9-question
disagreement between two runs of `C`**, which is a second and independent reason not to call
retrieval "better than it looks" on the strength of this measurement.

It also puts a bound on how conservative the 17-question floor is. That floor was derived for
comparing two *different* configurations one draw each; two draws of the *same* configuration
disagree on 9 questions. Neither number licenses a smaller experiment — they measure different
things — but a reader who wants to know how much of a 5-question difference is machinery now has an
answer from the same artifact pair, and it is "none of it is resolvable at this n".
