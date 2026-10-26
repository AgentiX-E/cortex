# End-to-end baseline drift: 81.0% → 44.2%, and what it blocks

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
