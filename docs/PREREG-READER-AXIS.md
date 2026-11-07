# PREREG-READER-AXIS

Holding the hits fixed and changing only the model that reads them, because the largest published delta on this
benchmark is a reader swap and this project has never measured its own.

## 0. What is being tested, and what is not

**Not** "is a stronger model better" — that is known and uninteresting. The question is **how much of the 5.7
points to the reproducible frontier is the reader**, because every plan written before this one treated the gap
as retrieval and the evidence now says otherwise:

| evidence                           | delta                   | what it isolates                              |
| ---------------------------------- | ----------------------- | --------------------------------------------- |
| Mastra, same memory system         | 84.23% → 94.87%         | the reader, at **+10.64**                     |
| Raw-RAG, shape-matched to this arm | 87.53% with GPT-4o-mini | the reader plus a reranker, versus our 80.80% |
| StateMem, DeepSeek vs Qwen         | 0.656 vs 0.580          | the reader, at **+7.6**                       |

Three independent observations, all larger than the 5.7-point gap they are being used to explain. That is a
reason to measure rather than to assume: if the reader is worth ten points, the retrieval work in
`PLAN-RETRIEVAL-SIGNALS.md` is aimed at a smaller target than the plan believed, and the ordering of the plan is
wrong.

## 1. The design

Two arms, one variable, paired by question.

| field     | arm A (control)                                                                    | arm B (treatment) |
| --------- | ---------------------------------------------------------------------------------- | ----------------- |
| retrieval | unchanged — same corpus, same `relevanceTopK`, same `relevanceSignal`, same budget | **identical**     |
| judge     | the benchmark's own prompt, unchanged                                              | **identical**     |
| reader    | the shipped model (`deepseek-chat`)                                                | one other model   |

The claim that "the hits did not move" is not an assumption. Retrieval here is deterministic given the corpus
and the embedding cache, and three artefacts make that checkable without trusting anything:

| evidence                        | where it is                               | what it proves                                                         |
| ------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| `corpus sha256`                 | the run's own log                         | the same file, byte for byte                                           |
| `Restored N embedding vectors`  | the log                                   | the haystack vectors came from cache rather than a fresh provider call |
| `goldOverlap.pool` per question | the JSON report, when it can be collected | the ranking surfaced the same candidates                               |

**The third one is the real check and the first two are only consistent with it.** `benchmark-cortex-memory.yml`
does not print a `recall@k` line — that column belongs to `competitor-harness.mjs` — so a reader arm dispatched
through the benchmark workflow can only compare candidate sets through the per-question records. If the
artifacts cannot be collected, the run reports R2 as **unverified** rather than as passed, and the accuracy
difference is published with that qualification attached. Stating this before the run rather than after is the
point: a check whose evidence might not exist has to say so in advance, or it becomes a check nobody applies.

## 2. Predictions, with numbers

| id     | prediction                                                                       | refutation                                                                                                                                                                         |
| ------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1** | the treatment reader moves overall accuracy by **≥ 5 points** in one direction   | a movement under 5 points means the reader is not the lever here, and `PLAN-RETRIEVAL-SIGNALS.md` keeps its current order                                                          |
| **R2** | `recall@k` and the per-question candidate sets are **identical** across arms     | any difference voids the run rather than being reported                                                                                                                            |
| **R3** | the abstention route does not move by more than 1 question                       | a larger move means the treatment changed _willingness to decline_, which is a calibration change and not a reading difference — it must then be reported as such, not as accuracy |
| **R4** | the gain, if any, concentrates in MR and TR (the two categories holding the gap) | a uniform gain says the reader lifts everything, which makes the category-split argument in `ACCEPTANCE-MATRIX.md` §5.1 wrong                                                      |
| **R5** | cost moves by less than the accuracy does, in relative terms                     | a large cost increase for a small accuracy gain makes this a different trade and it has to be stated as one                                                                        |

## 3. Why R3 is the one that decides whether the result is usable

A stronger reader can raise accuracy two ways: by reading the same evidence better, or by **declining less
often**. The second is not an improvement on this benchmark — `ABS` grades abstention as correct, so a reader
that stops declining loses those 30 questions while gaining nothing on the ones it now guesses at. If ABS moves,
the arm has measured calibration and the number must be reported as a calibration change.

That is also why the retry pass (`reviewPass: 'bare'`) is excluded from this registration: it is a change to
_whether the model is offered the token_, which is calibration by construction.

## 4. Cost, stated before the run

| item        | arm A                   | arm B                                                                           |
| ----------- | ----------------------- | ------------------------------------------------------------------------------- |
| questions   | 500                     | 500                                                                             |
| model calls | ~500 (+ declines)       | ~500 (+ declines)                                                               |
| embeddings  | cached from the control | **zero — the cache is shared, which is also what proves the hits did not move** |

The shared cache is doing double duty: it saves the embedding bill and it is the mechanism by which R2 is
checkable. A run that re-embedded would have no way to demonstrate that the evidence was the same.

## 5. What this registration refuses to do

- **It does not change the judge.** A reader swap graded by a different judge measures two things. The
  benchmark's own prompt stays.
- **It does not change retrieval at the same time.** That is `PLAN-RETRIEVAL-SIGNALS.md`'s job and it runs at
  weight zero until this question is answered.
- **It does not compare against a vendor's reader swap as if it were ours.** Mastra's 10.64 points were measured
  on Mastra's pipeline; this project's number will be its own, and if the two disagree the disagreement is the
  finding.

## 6. State

**Running.** Both arms dispatched with the full input set from `docs/ARM-PRESETS.md` §2 — which is now the
default, so the only field that differs between them is `model`: `deepseek-chat` (control) against
`deepseek-v4-pro` (treatment). Same provider, same key, same endpoint, so a difference cannot be an
availability artefact. A reader arm that also changed `ask` or the budget would be the same defect this round
already paid for once.

## 7. Amendment: this file says 5 points, the matrix registers 3, and both were written in good faith

`docs/ACCEPTANCE-MATRIX.md` row `M1` reads `≥ 3.0pp`. Section 2 of this file reads "**≥ 5 points**". They are
the same criterion, so one of them is wrong, and until now nothing read this paragraph and nothing compared
the two -- which is the failure the matrix was built to end, arriving in the one direction the matrix cannot
see: it checks prose it is generated from, not prose written before it existed.

### 7.1 Which number wins, and why it is the looser one

The row wins, and the reason is not that it is easier. `M1`'s threshold is a field in
`packages/cortex-eval/src/acceptance.ts` that `tools/acceptance-check.mjs` evaluates, that
`tools/docs-crosscheck.mjs` re-derives on every check, and that a build can fail on. This section is a
paragraph. A number that is checked beats a number that is quoted, and the repair for a quote that disagrees
is to amend the quote -- not to weaken the check so the quote stays true.

That direction needs justifying rather than announcing, because the value that survived is the one that is
easier to pass, and "the checked copy happens to be the lenient one" is exactly what a reader should distrust.

Three facts make it defensible:

1. **The prereg's 5 was never read against a run.** No dispatch was ever evaluated as "did it clear 5". The
   number was written as an intention and then a second number was written as a check, and the two were never
   in the same room.
2. **The pair that exists read +4.70** (`41222844945` at 85.75% against `41254359622` at 90.45%, prompts
   byte-identical). It is not a reading of this row's configuration, and it is the only pair the project has,
   and it sits *between* the two thresholds. So neither number has been contradicted by a measurement and the
   choice between them cannot be made on evidence from our own runs.
3. **`3.4` is the entire observed reader spread of the strongest published system.** Agent Zero Memory
   (`arXiv:2608.29606` §5.3) varies the backbone across eight model families with the memory, retriever and
   control logic held fixed, and LongMemEval accuracy moves **3.4 points** while per-query cost moves about
   30x. A 5-point bar therefore asks this pipeline to be *more* reader-sensitive than the state of the art is,
   and reader-insensitivity is the property that paper argues is the *good* one: "quality is retrieval-
   dominated" is its central claim, and it is the claim this campaign has been trying to earn. A row that
   rewards a reader for moving the number five points is a row that rewards the opposite.

Point 3 is the one that decides it, and it arrived after both numbers were written.

### 7.2 What the row still binds

The threshold moved by two points and the *interpretation* of a miss moved by more. Section 3's `R3` -- the
abstention route must not move by more than one question -- is the load-bearing part of this registration and
it is unchanged: a reader swap that buys accuracy by declining less is a calibration change on a benchmark
whose `ABS` gold *is* a decline. `M1`'s `onMiss` now also splits by sign, because the outside evidence splits:
a delta between `0` and `+3` is the retrieval-dominated signature the field reports, and a *negative* delta is
the prompt-contract defect `AUDIT-READER-THINKING-REVERSES.md` documents. Treating those two outcomes the
same is what a single threshold with one paragraph of prose did.

### 7.3 The general repair, so this does not recur

Every `PREREG-*.md` that states a numeric threshold must have a row in `acceptance.ts` carrying the same
number, or a sentence saying why it is deliberately not a row. The check that enforces it reads this file for a
`≥ N points` pattern and the table for `M1`'s threshold, and fails when they disagree -- which means the
amendment above is the last one that can be made by hand.
