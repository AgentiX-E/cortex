# End-to-end baseline drift: 81.0% → 44.2%, and what it blocks

> **Superseded in its premise by §8.** The two numbers belong to two different systems — 81.0% is
> `cortex-memory` (`benchmark-cortex-memory.yml`), 44.2% is the reference pipeline
> (`benchmark.yml`) — and run `40088479628` measures both in one invocation at 80.80% and 43.40%.
> Sections 0–7 are kept as written, because the measurements in them are correct and the reasoning
> that failed is the subject of §8.5. Read §8 first.

## 0. One paragraph

Two 500-question end-to-end runs were dispatched to decide whether a per-line critique beats a
recall-based one. Both returned **44.20% overall**, against the archived baseline's **81.0%**, and both
returned **exactly the same per-capability numbers** — including `MR 85.95%` in each. The difference
between the two modes is therefore not measurable in this run, and worse, the run itself does not
reproduce the baseline it was supposed to be compared against. The control arm failed identically,
which localises the cause outside this round's changes but leaves it **unidentified**. This document
records what was measured, what was ruled out, and the four checks that would localise it.

## 1. What was run

| | |
| --- | --- |
| workflow | `benchmark.yml`, `limit=0` (all 500), `runs=1`, `temperature=0` |
| reader | `deepseek-chat`, thinking disabled |
| judge | official per-type templates |
| embedding | `openai-compatible`, `embedding-3`, 1024 dims, determinism check `max abs diff 0` |
| switches | `ENTITY_IDENTITY_CLAUSE=1`, `CANDIDATE_DISCRIMINATION=0`, `RETRIEVAL_SIDES=0` |
| arms | `AGGREGATION_CRITIQUE=1` with `MODE=recall`, and again with `MODE=per-item` |

Both artifacts completed successfully. The environment was healthy by every counter the run reports:
`Transport retries: calls=232, retried=0, rateLimited=0`, embedding determinism exact, embedding cache
restored.

## 2. What came back

| capability | archived baseline | `recall` run | `per-item` run |
| --- | --- | --- | --- |
| IE | 89.5% (134/150) | **0.67%** (1/150) | **0.67%** (1/150) |
| MR | ~69.6% | **85.95%** (104/121) | **85.95%** (104/121) |
| KU | ~86.8% | **0.00%** (0/72) | **0.00%** (0/72) |
| TR | 74.6% | 67.72% (86/127) | 67.72% (86/127) |
| ABS | 97.5% | 100.00% (30/30) | 100.00% (30/30) |
| **overall** | **81.0%** (405/500) | **44.20%** | **44.20%** |

Three facts, and the third is the one that makes this a blocker rather than a result.

1. **The two arms are identical, digit for digit.** `per-item` produced not one different verdict on 500
   questions, on any capability. Either the critique never fired, or it fired and returned "nothing to
   add" every time, or it fired and its revision did not change a single answer. The run does not
   distinguish those, which is a defect in the run rather than in the mechanism.
2. **IE and KU collapsed while MR rose.** The failures are refusals, not wrong answers: the feature
   system's decision reasons read `{"empty":0,"threshold":0,"llm":247,"answered":253}`, so 247 questions
   were declined **by the model**, with zero by an empty store and zero by the score threshold. The
   failure census agrees: `IE 149 failed of 150 (answered 14, refused 135)`, `KU 72 of 72 (answered 14,
   refused 58)`. A capability that is *answered* 16 times out of 150 is not being judged wrongly; it is
   not being answered.
3. **The control arm failed the same way.** The ablation's baseline side reads `IE 0.67%`, `KU 0.00%`
   too. That arm receives no feature option at all — `enableAggregationCritique` and its mode are spread
   into the **feature** system only — so the collapse cannot be caused by the critique.

## 3. What was ruled out

| hypothesis | how it was checked | verdict |
| --- | --- | --- |
| this round's code | `git diff` of the whole round against `natural-language-memory.ts` deletes **two lines**, both the intended critique dispatch, and adds nothing outside the critique path | ruled out |
| the critique itself | the control arm collapsed identically, and the control never receives the option | ruled out |
| the embedding backend | determinism `max abs diff 0` at 1024 dims, retries 0, rate-limited 0, cache restored | ruled out |
| retrieval returning nothing | `{"empty": 0}` — the store always returned something; the model then declined | ruled out |
| the judge | the failures are refusals, and refusals are counted before grading | ruled out |
| a limit/sample mix-up | the log states `Running benchmark on 500 instance(s) (limit=all, ...)` | ruled out |
| a degenerate embedding | not checked. `determinism 0` proves the same text embeds the same way twice; it says nothing about whether the vectors are informative | **open** |

The one quantity that does not fit the "everything is broken" story: `recall@1 = 0.408` and
`recall@5 = 0.776` on the 100-question diagnostic sample. Retrieval is not destroyed. It is mediocre at
rank 1 and adequate by rank 5, and the reader declines anyway.

## 4. What this blocks, and what it does not

**Blocks.** The round's own experiment. The registered predictions were "`recall` moves MR little or
nothing" and "`per-item` moves it toward per-item". Neither can be read from two runs that are identical
to the digit on every capability, because identical arms are evidence about the run and not about the
mechanism.

**Does not block.** The implementation, which is exercised by thirteen tests with six mutation checks,
and the instrument work, which is exercised by three more. Those stand on their own evidence and do not
depend on a runner.

**And it raises something larger.** The archived 81.0% is the number every document in this repository
quotes as the end-to-end state, including the acceptance gate. If the same configuration now reads
44.2%, then either the baseline was measured under conditions that are not reproducible, or something in
the shared path changed between then and now. Both possibilities matter more than this round's ablation,
because every claim about progress is denominated in that number.

## 4.1 What has been done about it since

Two of the four checks are now implemented rather than planned.

**The corpus hash is printed and can be asserted.** `benchmark.yml` runs `sha256sum` on the downloaded file, logs
`corpus sha256:` and `corpus bytes:` on every dispatch, and accepts a `corpus_sha256` input that fails the job on a
mismatch. Every artifact from now on carries the version of the corpus it read, which no previous artifact did.

**The critique counters exist.** `NaturalLanguageMemorySystem.critiqueStats` reports `eligible`, `fired`, `noOp`
and `skipped`, surfaced in the ablation report. They separate the three states that produce two identical arms:
never reached, reached and found nothing, reached and changed nothing.

**And analysis of the existing artifact narrowed the hypothesis to one.** §7 does that with the log's own
per-question records: the refusals track the retrieval, four technical causes are eliminated by measurement, and
what remains is the query side, the session segmentation, or the corpus — of which only the corpus can change
without a code change.

A diagnostic run is dispatched with the shipped configuration (`aggregation_critique=0`) on the full 500 questions.
If it also reads ~44.2%, the drift predates this round's switches and the corpus hash from that run is the reference
for everything after it. If it reads ~81.0%, then the critique switch is implicated after all, and the counters from
the next run will say which of the three states did it.

## 5. The four checks that would localise it

Ordered by cost, and each one narrows the same question: **is the regression in the code, the data, or
the model?**

1. **Fix the dataset version.** `benchmark.yml` downloads `longmemeval_s_cleaned.json` from a moving
   branch each run. Pin the file by hash and record the hash in the artifact. If the file changed, the
   question set or gold answers changed with it, and 405/500 and 221/500 are measurements of two
   different datasets.
2. **Replay one archived run.** Take the run id behind `cortex-docs/evidence/longmemeval/summary.json`,
   read its recorded `featureConfig`, and dispatch with byte-identical inputs. If it reads 81.0%, the
   code regressed between the two commits. If it reads 44.2%, the environment or the data changed.
3. **Answer one question by hand.** Take an `IE` question that was refused, extract the exact prompt the
   model receives (the artifact carries `retrieved`), and send it to `deepseek-chat` outside the harness.
   If it answers, the harness is dropping or mangling part of the prompt. If it refuses, the model's
   behaviour on this prompt changed.
4. **Count the critique.** The two arms are identical, so before anything else: how many questions
   reached `critiqueAggregationLedger`, and how many returned the no-op? The artifact does not carry it.
   That counter is the first thing to add, because without it "the critique did nothing" cannot be
   distinguished from "the critique never ran" — and that distinction is the whole experiment.

## 6. What was still learned

Three things, none of which needs the run to be trusted.

1. **`recall@1 = 0.41` against `recall@5 = 0.78`** on the same 100 questions is a ranking problem with a
   measurable size, and it is the first time this repository has that number for the end-to-end path
   rather than for the adapter.
2. **The ablation report already carries a per-capability McNemar table**, computed by the runner. The
   instrument for reading an end-to-end result existed all along; the round's mistake was to plan a
   separate comparison before checking whether the report already made it.
3. **An identical pair of arms is a finding about the harness.** Two configurations that differ in one
   prompt and produce the same 500 verdicts mean the prompt is not reaching the model, or the model is
   not using it, or the artifact is not measuring it. Any of the three is worth more than the effect that
   was being hunted.

## 7. The analysis that narrowed it, run on the artifact itself

The 12 MB job log carries one record per single-session question — `question`, `ground_truth`, `decision.retrieved`,
`decision.llmRaw` — for all 379 of them. Analysing that array answered more than any further speculation would.

### 7.1 The evidence is not in the context, so the refusals are correct

For each question, count the ground-truth words (length ≥ 4) that appear in the retrieved context:

| capability | abstained | of which the context covers ≥50% of the gold | answered | of which the context covers ≥50% |
| --- | --- | --- | --- | --- |
| IE | 135 | **16** | 15 | 4 |
| KU | 58 | **4** | 14 | 4 |
| TR | 22 | 6 | 105 | **76** |

The reader is not malfunctioning. On IE it declined 135 questions and only 16 of them had the answer in front of it;
on TR it answered 105 and 76 of those had the answer in front of it. **The refusal rate tracks the retrieval rate.**
That moves the whole question from "why does the reader refuse" to "why is the evidence absent", and the second one
is answerable from the same artifact.

### 7.2 Four technical causes eliminated with the artifact's own numbers

| cause | measurement | verdict |
| --- | --- | --- |
| context window truncated | median retrieved length: IE 11,198 chars, KU 4,361, TR 10,512, max 28,462 | eliminated — nothing is being cut to a few hundred characters |
| degenerate embeddings | 162 hit scores spanning **0.408–0.987**, median 0.664, p10 0.585 / p90 0.765 | eliminated — a collapsed embedding produces a flat or NaN distribution, not this one |
| assistant turns filtered out | IE contexts carry 31% assistant turns; KU and TR carry **0%**; and gold words found *only* in assistant turns: **5 of 117** IE abstentions | eliminated — the answers are not on the assistant side |
| embedding cache mismatched | the cache is a `Map<text, vector>` serialized with text keys, magic and dimension | eliminated — a cache hit cannot return another text's vector |

So the embedding is informative, the window is large enough, the turns are present, and the cache cannot lie. What
remains is **the query side, the session segmentation, or the corpus**.

### 7.3 Where that leaves the hypothesis

`recall@1 = 0.408` against `recall@5 = 0.776` on the 100-question diagnostic says the right session is usually in
the top five but rarely first. For IE that is fatal in a way it is not for TR: an IE answer is a short phrase that
appears once, and the reader only sees the sessions that were retrieved, not the five that were ranked.

**And one candidate explains all of it without any code change: the corpus.** `benchmark.yml` downloads
`longmemeval_s_cleaned.json` from a moving branch on every run, so the questions, the gold answers and the session
boundaries can change between two dispatches while the artifact records nothing about which version it read. If the
file changed, 405/500 and 221/500 are measurements of two different datasets, and every conclusion drawn from
comparing them is an artefact of the redownload.

That is why pinning the file by hash is the first of the four checks rather than the cheapest afterthought: it is
the only one that decides whether there is a regression at all.

### 7.4 One behaviour found while writing the counter tests

`UNANSWERABLE` is the token the model actually emits when it declines, and the aggregation path does not treat it
as an abstention before the critique runs. A run whose answers are mostly refusals therefore still pays for the
audit pass on those questions. Recorded rather than fixed: moving an abstention boundary changes behaviour and
needs its own measurement, and the counters now make the cost visible.

## 8. The drift is not a drift: the two numbers belong to two systems

### 8.1 One paragraph

`40378588466` was dispatched to decide whether 44.2% reproduced the archived 81.0% under the shipped
configuration. It read **43.80%**, and the document above concluded that the drift predates the round's
switches. That conclusion is correct and the question was wrong. `40378588466` ran `benchmark.yml`,
whose feature arm is **`nl-abstain-feature`** — the reference pipeline in `natural-language-memory.ts`.
The 81.0% was measured by **`benchmark-cortex-memory.yml`**, whose feature arm is **`cortex-memory`** —
the cognitive arm configured at `maxPromptChars=48000`, `relevanceTopK=256`,
`relevanceSignal=retrieval-hybrid`, `evidenceRoles=user` (`PREREGISTRATION-CORTEX-MEMORY-ARM.md` §10.3).
**Two workflows, two systems, one headline.** Nothing regressed. 43.8% and 81.0% are the same baseline
read under two different titles.

### 8.2 The measurement that settles it, and it was already in a downloaded artifact

Run **`40088479628`** (`benchmark-cortex-memory.yml`, 2026-10-24) evaluates **both** systems in one
invocation, on one reader, one embedding model and one judge. Its ablation table:

| | accuracy | IE | MR | KU | TR | ABS |
| --- | --- | --- | --- | --- | --- | --- |
| `reference-pipeline` (baseline) | **43.40%** | 0.67% | 84.30% | 0.00% | 66.14% | 100% |
| `cortex-memory` (feature) | **80.80%** | 89.33% | 69.42% | 86.11% | 74.02% | 100% |

Set that beside `40378588466`'s feature arm:

| | `40378588466` (`benchmark.yml`) | `40088479628` baseline | `40088479628` feature |
| --- | --- | --- | --- |
| head-line | 43.80% | 43.40% | 80.80% |
| IE | 0.67% | 0.67% | 89.33% |
| MR | 84.30% | 84.30% | 69.42% |
| KU | 1.39% | 0.00% | 86.11% |
| TR | 66.93% | 66.14% | 74.02% |
| ABS | 100% | 100% | 100% |

`40378588466` reproduces `40088479628`'s baseline to **4 questions of 500** (219 against 217 as absolute
counts; 43.80% against 43.40%), and its five capability rows match within `runs=1` sampling on KU and
TR. The two runs are four days apart on different commits, and they agree on five capabilities because
they are the same system. `cortex-memory` is 37.4 points above it **in the same run**, with McNemar
`p = 1.694e-33` — a paired comparison over 500 questions in which the baseline wins 38 and the feature
wins 225.

Two numbers, two systems, and the distinction matters more than the 4 questions: `40378588466` is
`nl-abstain-feature` and `40088479628`'s baseline is `reference-pipeline`. They are close because they
share the retrieval path and the reader, not because they are the same arm — §8.7 records what happens
when that closeness is written as identity.

### 8.3 The mechanism is the configuration, and it explains the *direction* of every capability

The two arms do not differ by a prompt. They differ by how evidence is selected:

| | `benchmark.yml` (`nl-*`) | `benchmark-cortex-memory.yml` (`cortex-memory`) |
| --- | --- | --- |
| retrieval | `retrieveTopKByQueriesHybrid`, `topK` 15, radius 1 | relevance index over the full haystack, `relevanceTopK=256` |
| evidence room | product default 24,000 characters, **applied to what retrieval returned** | `maxPromptChars=48000`, applied to a 256-wide pool |
| role filter | none | `user` on `multi-session,temporal` |
| turn cap | none | 400 characters on those two routes |
| ask | `abstention-evidence-blocks` | `enumerated` |

The direction of every capability follows from that table and from nothing else:

- **IE and KU collapse under `nl-*`** because their answers are a short phrase appearing once in a
  ~500-turn haystack, and a 15-turn retrieval has to rank it first. On `40378588466`'s 379
  single-session records, the gold's content words (length ≥ 4, minus any word the question already
  contains) appear **anywhere** in the delivered context for **38.0% of IE** (49/129) and **22.5% of
  KU** (9/40) questions, against **79.5% of TR** (62/78) and **93.3% of ABS** (28/30). The reader then
  declines, correctly, on evidence it was never shown.
- This is a **different statistic** from §7.1's table, which asked for **≥ 50%** of the gold's words
  and read 16/135 for IE. Both are true and neither supersedes the other: §7.1 measures how much of
  the answer was present, this measures whether any of it was. The two are stated apart on purpose —
  a coverage number is only comparable with one that uses the same threshold, which is the same rule
  that made a bare `- Overall accuracy:` line unreadable.
- **MR rises under `nl-*`** (84.30% against 69.42%) because multi-session questions need breadth across
  sessions rather than precision inside one, and the reference pipeline retrieves **sessions**,
  truncates each one, and enumerates — the shape MR's ask rewards (§13.105.1 records that it answers
  102 of 121).
- **TR is close** (66.93% against 74.02%) because temporal questions tolerate a wider window and
  `nl-*` has a date-aware path of its own.

This is not a new hypothesis. §7 and §7.2 measured the same facts from `40378588466`'s log and
concluded that "the refusals track the retrieval". Every number in §7 is correct. What §7 could not
know is that the system it was describing is not the system 81.0% belongs to.

### 8.4 What this retracts, and what it does not

**Retracted.** The premise of §0 and §4 — that 405/500 and 221/500 are two measurements of one
configuration. They are not comparable at all, and the four checks in §5 were ordered by the cost of
answering a question that does not exist. §4.1's diagnostic dispatch has now answered it: `43.80%`,
with `{"empty":0,"threshold":0,"llm":247,"answered":253}`, matching `40088479628`'s baseline row.

**Not retracted, and worth keeping for its own sake.**

1. **The corpus hash.** `benchmark.yml` prints `sha256` and `bytes` on every dispatch and accepts a
   `corpus_sha256` assertion. This document's own failure mode is "a number whose provenance is
   unrecorded", and the corpus is part of a number's provenance. The current corpus is
   `d6f21ea9…a442`, 277,383,467 bytes.
2. **The critique counters.** Two arms producing 500 identical verdicts is still a fact about a run
   that a run must be able to explain.
3. **§7's four eliminations.** They are eliminations for the reference pipeline, correctly performed,
   and they tell us where *its* 56.6 points go. That is the number this repository can now improve
   without touching the cognitive arm at all.

**And the round's own experiment survives, at the workflow it already ran on.** The first draft of this
section said the `recall` versus `per-item` critique had been measured in the wrong system — that the
critique belongs to `cortex-memory` and the runs went to `benchmark.yml`. Reading the two packages says
otherwise, and it is worth writing down because the first draft is the same mistake this document is
about:

```
$ rg -c critique packages/cortex-memory/src/memory.ts \
                     packages/cortex-eval/src/natural-language-memory.ts
packages/cortex-eval/src/natural-language-memory.ts:52
```

`grep` returns nothing for `memory.ts`. `enableAggregationCritique`, `critiqueAggregationLedger` and
`aggregationCritiqueMode` exist only in the reference pipeline, so `benchmark.yml` is the **only**
workflow that can measure them, and §2's two runs were on the right system. What they lack is not
placement but *observability*: they predate `critiqueStats`, which landed afterwards, so "the two arms
are identical" still cannot be separated into *never reached*, *reached and found nothing*, and
*reached and changed nothing*. **The experiment needs one re-dispatch with the counters, not a move.**

That correction is the same failure at one remove — an assertion about which system a mechanism lives in,
made from the shape of the configuration rather than from the code. It cost ten minutes here and a round
the first time. The rule generalises: **before claiming a mechanism is or is not reachable in an arm,
grep for the symbol in that arm's source.**

### 8.5 The repair, and the general form of it

The renderer now carries the arm on every line a reader quotes in isolation:

```
# Cortex Benchmark Report — `cortex-memory`
- System under test: `cortex-memory` vs baseline `reference-pipeline`
- Overall accuracy (`cortex-memory`): 80.80%
```

`report-system-identity.test.ts` pins it, including the negative property — **no** `- Overall accuracy`
or `- Abstention` line may exist without an arm name — and the pair assertion that makes this incident
unrepresentable: two different feature arms must produce two different titles.

The general lesson is narrower than "label your numbers". The repository already required a system
name in `- Feature: … vs baseline …`, five lines above the accuracy. It was read past, because the
title and the quotable line were the two places a number leaves the document. **A label on a document
is not a label on a number**: the strings that get copied are the title and the `- Metric: value` lines,
so the identity has to be inside them or it does not travel.

### 8.6 Where this leaves the project

The end-to-end state is **80.80% / 500** on `cortex-memory`, reproducible in a workflow that prints its
own arm name, its corpus hash and its configuration. That is 0.2 points below the archived 81.0%
four-run mean, which is consistent with a single run and does not warrant a claim either way.

The largest single gap inside that number is **MR 69.42%**, the one capability where the cognitive arm
loses to the reference pipeline by 14.9 points with `p = 2.935e-3`. It is now the only capability where
a known-better answer exists inside this repository, which makes it the cheapest place to look next —
and `PREREGISTRATION-CORTEX-MEMORY-ARM.md` §13.105 already registered that experiment with six
predictions.

## 8.7 An external analysis, checked claim by claim

An independent review of this repository (Yuanbao, 2026-10-27, against `4c45163` / `28cef28`)
reached the same conclusion as §8 and added four claims this document had not made. They were
checked one at a time rather than adopted, and the result is mixed in a way that is worth recording:
**the two that survived are the two that were verifiable from a file in the repository.**

| # | claim | verdict | evidence |
| --- | --- | --- | --- |
| 1 | 81.0% and 44.2% are two arms | **agreed, and it sharpens §8** | it pairs 44.20% with the **archived reference pipeline** at 224/500 (`04 §1.2`) rather than with `40088479628`'s baseline at 217/500. That pairing is right and the arithmetic needs stating more carefully than either of us first wrote it — see below |
| 2 | the embedding cache carries no model identity | **confirmed, and worse than stated** | `retrieval.ts` wrote `magic + version + count + dim` and its docstring claimed it threw "so a stale cache is never silently trusted". Fixed: `MEASURE-CACHE-PROVENANCE.md` |
| 3 | the same arm regressed from 430/500 (Sept) to 221/500 (Oct) | **unproven** | the 430 reading is real (`MEASURE-FAILURE-CENSUS.md` §2–3: IE 145/150, KU 59/72, MR 106/121, TR 91/127, ABS 29/30), but the September run **predates `featureConfig` being written into the artifact**, so there is no record that its switches match October's. The claim compares two readings of unknown configuration, which is the same shape as the error this document is about |
| 4 | extracting `packages/cortex-ai` changed the embedding defaults | **not checkable here** | the local `.git` is shallow, so the rename history cannot be diffed. It is also moot in the direction that matters: whatever the defaults are now, a cache stamped with them can no longer be silently reused by a run using others |

**The three readings are two systems, not one.** The first version of this table said "three
readings of one system — 217, 221, 224 — put that arm's spread at ~1.4pp". That is wrong, and the
error is small enough to be worth spelling out because it is the same class as the one this document
is about. The rows pair up like this:

| system | readings | spread | what the spread is |
| --- | --- | --- | --- |
| `reference-pipeline` (`run-ablation.ts`'s baseline: `enableAbstention`, every other option default) | **217** (`40088479628`) and **224** (archived, `04 §1.2`, "single run") | 7 questions, **1.4pp** | four days and several commits apart — this is the run-to-run spread of one system, and it is the number §8 did not have |
| `nl-abstain-feature` (`enableAbstention` + `abstainThreshold` + `entityIdentityClause`) | **219** (`40378588466`, 43.80%) and **221** (the `recall` / `per-item` pair, 44.20%) | 2 questions, **0.4pp** | same week, and §2 already reports these two as identical to the digit at the capability level |

So `44.20%` sits 2 questions from one reading of its own arm and 4 from the other arm's baseline. Both
are inside noise, which is why the conclusion holds — but the coincidences that make them all land
between 217 and 224 are not one system's variance, and writing them as one would be a small copy of
the failure under study.

**What claim 3 gets right, and what it does not.** The *shape* of the September-to-October movement —
the two single-session capabilities collapsing (IE 145 → 1, KU 59 → 0) while the two multi-session
ones barely move (MR 106 → 104, TR 91 → 86) — is exactly what a foreign vector space predicts, because
single-session questions are served by embedding similarity alone while multi-session questions also
travel the lexical, turn-level and temporal channels. That is a mechanism with a predicted signature,
not a finding. It is recorded as a pre-registered candidate in `MEASURE-CACHE-PROVENANCE.md` §6 with
the reading that would discriminate it, and it is **not** written into the plan as a regression.

**One hypothesis of my own, refuted by a date.** Before reading the external analysis I suspected
`entityIdentityClause`: it is a sentence that licenses declining when the question names an entity
absent from the context, IE questions are exactly that shape, and `runner.ts:321` defaults it to on.
Run `35097952715` removed the clause in a controlled A/B — on **2026-09-16**, nine days before the
430/500 reading. A clause that was already present when IE read 145/150 cannot explain IE at 1/150.
Eliminated in one command, and recorded because a plausible mechanism that survives inspection of the
code and dies on inspection of a date is the normal case, not the exception.

**The general lesson, and it is the third time this round.** Claims 1 and 2 were checkable by opening
a file. Claim 3 needed a fact that was never recorded (the September configuration) and claim 4 needed
history the checkout does not have. The distance between "verifiable here" and "plausible here" is not
about the reviewer's care — it is about whether the artifact kept the field. **A number whose
configuration was not written down cannot be compared with anything, and that includes itself a month
later.**

## 8.8 The verbatim-hit rate: 4 of 150, and why it is the only number that caps IE

Run `40408635007` carried 379 per-question records with the delivered context, so the question §7.1
approximated can now be answered exactly: **does the gold phrase appear in the context the reader was
shown?**

| capability | n | gold phrase **verbatim** in context | correct | correct **and** in context | correct **without** it |
| --- | --- | --- | --- | --- | --- |
| IE | 150 | **4** | 1 | 1 | 0 |
| KU | 72 | **10** | 0 | 0 | 0 |
| TR | 127 | 27 | **87** | 23 | **64** |
| ABS | 30 | 0 | 30 | 0 | 30 |

**For IE and KU this is a ceiling, not a correlate.** Their gold is a short phrase — "Business
Administration", "four" — and a reader that never receives that phrase cannot answer, whatever it does
with what it did receive. IE's ceiling is **4/150 = 2.7%** and it read 1/150. **The reader is not the
bottleneck; 97.3% of the evidence never arrives.**

**For TR it is neither.** 64 of TR's 87 correct answers have no verbatim gold in context, because a TR
gold is a sentence the model composes ("I went on a day hike… then a road trip…") and a TR answer is a
date or an ordering the model computes from evidence it does have. So the same measurement is a
necessary condition for one capability and irrelevant to another, and the two must be reported apart —
the single most common way this table could be misread is to add its rows.

### 8.8.1 This is a sharper statistic than §8.3's, and it does not replace it

§8.3 counted *any* distinguishing gold word appearing *anywhere* in the delivered text: 38.0% for IE,
22.5% for KU, 79.5% for TR. This one requires the **whole phrase, verbatim**. Both are true:

| statistic | IE | what it says |
| --- | --- | --- |
| any gold word present (§8.3) | 38.0% | the context is *about* the right thing |
| whole phrase verbatim (§8.8) | **2.7%** | the context contains the *answer* |

A retrieval that returns the topic but not the sentence scores 38% on the first and 2.7% on the second.
**The gap between them is the whole failure**, and §8.3 alone would have supported the wrong conclusion —
that a third of IE questions had their evidence and the reader threw it away. It did not.

### 8.8.2 What it rules out, and what it proposes

**Rules out** "the reader declines too readily on IE": on 146 of 150 questions there was nothing to
answer from. It also rules out the September comparison in the strongest form: 145/150 on IE would
require 145 questions whose gold phrase reached the context, and the retrieval in this arm delivers 4.
Whatever produced 430/500 in September, its evidence delivery was not this.

**Proposes** one number to move: **verbatim-hit rate**, IE from 4/150. It is measured by the harness
already, it needs no reader change, and every retrieval candidate can be scored on it before a single
LLM call is spent. Note that this is the `nl-*` arm — the cognitive arm reads IE 89.33% and does not
need it — so the number is a diagnostic for the reference pipeline rather than a target for the product.
