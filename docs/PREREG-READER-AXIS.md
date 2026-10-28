# PREREG-READER-AXIS

Holding the hits fixed and changing only the model that reads them, because the largest published delta on this
benchmark is a reader swap and this project has never measured its own.

## 0. What is being tested, and what is not

**Not** "is a stronger model better" — that is known and uninteresting. The question is **how much of the 5.7
points to the reproducible frontier is the reader**, because every plan written before this one treated the gap
as retrieval and the evidence now says otherwise:

| evidence | delta | what it isolates |
| --- | --- | --- |
| Mastra, same memory system | 84.23% → 94.87% | the reader, at **+10.64** |
| Raw-RAG, shape-matched to this arm | 87.53% with GPT-4o-mini | the reader plus a reranker, versus our 80.80% |
| StateMem, DeepSeek vs Qwen | 0.656 vs 0.580 | the reader, at **+7.6** |

Three independent observations, all larger than the 5.7-point gap they are being used to explain. That is a
reason to measure rather than to assume: if the reader is worth ten points, the retrieval work in
`PLAN-RETRIEVAL-SIGNALS.md` is aimed at a smaller target than the plan believed, and the ordering of the plan is
wrong.

## 1. The design

Two arms, one variable, paired by question.

| field | arm A (control) | arm B (treatment) |
| --- | --- | --- |
| retrieval | unchanged — same corpus, same `relevanceTopK`, same `relevanceSignal`, same budget | **identical** |
| judge | the benchmark's own prompt, unchanged | **identical** |
| reader | the shipped model (`deepseek-chat`) | one other model |

The claim that "the hits did not move" is not an assumption; it is **measured**, because retrieval here is
deterministic given the corpus and the embedding cache: the run's own `recall@k` column and its per-question
candidate sets must be identical between arms. If they are not, the run is void — a reader difference computed
over different evidence is not a reader difference.

## 2. Predictions, with numbers

| id | prediction | refutation |
| --- | --- | --- |
| **R1** | the treatment reader moves overall accuracy by **≥ 5 points** in one direction | a movement under 5 points means the reader is not the lever here, and `PLAN-RETRIEVAL-SIGNALS.md` keeps its current order |
| **R2** | `recall@k` and the per-question candidate sets are **identical** across arms | any difference voids the run rather than being reported |
| **R3** | the abstention route does not move by more than 1 question | a larger move means the treatment changed *willingness to decline*, which is a calibration change and not a reading difference — it must then be reported as such, not as accuracy |
| **R4** | the gain, if any, concentrates in MR and TR (the two categories holding the gap) | a uniform gain says the reader lifts everything, which makes the category-split argument in `ACCEPTANCE-MATRIX.md` §5.1 wrong |
| **R5** | cost moves by less than the accuracy does, in relative terms | a large cost increase for a small accuracy gain makes this a different trade and it has to be stated as one |

## 3. Why R3 is the one that decides whether the result is usable

A stronger reader can raise accuracy two ways: by reading the same evidence better, or by **declining less
often**. The second is not an improvement on this benchmark — `ABS` grades abstention as correct, so a reader
that stops declining loses those 30 questions while gaining nothing on the ones it now guesses at. If ABS moves,
the arm has measured calibration and the number must be reported as a calibration change.

That is also why the retry pass (`reviewPass: 'bare'`) is excluded from this registration: it is a change to
*whether the model is offered the token*, which is calibration by construction.

## 4. Cost, stated before the run

| item | arm A | arm B |
| --- | --- | --- |
| questions | 500 | 500 |
| model calls | ~500 (+ declines) | ~500 (+ declines) |
| embeddings | cached from the control | **zero — the cache is shared, which is also what proves the hits did not move** |

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

Registered, not run. The dispatch is one input (`model`) on `benchmark-cortex-memory.yml`, with the control's
full input set from `docs/ARM-PRESETS.md` §1 — because a reader arm that also changed `ask` or the budget would
be the same defect this round already paid for once.
