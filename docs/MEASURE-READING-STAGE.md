# MEASURE — The Reading Stage, and the 21 Points Between an Adapter and the Product

## 0. One paragraph

The retrieval harness could say how often the evidence was in the context and nothing about whether the answer
came out. With a reader and the official per-type judge attached, the same 100 questions read `65.0%` for the
lexical reference, `60.0%` for Cortex's adapter at 33k tokens, and `52.0%` at the 2.8k budget Contextier reports.
Two findings follow, and the second is larger than the first: roughly **71% of a retrieved question becomes a
correct answer** — so a third of the loss is reading, not retrieval — and the adapter reads **21 points below the
product's own end-to-end score**, which means the adapter was never a proxy for the product.

## 1. What was added

| piece                                                       | why                                                                                     |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `measureRetrieval` gains `answer` / `judge` / `accuracyFor` | one pass, one corpus: `accuracy` and `recallAtK` have to describe the same run          |
| `competitor-reader.ts`                                      | one Chain-of-Note prompt for every provider, deliberately **not** the production prompt |
| `CapabilityScore.read` / `.correct`                         | the aggregate hides which family is losing                                              |
| workflow step at the 2.8k budget                            | the only context size at which a published accuracy can be compared at all              |

The reader is a separate prompt from `natural-language-memory.ts` on purpose. The production prompt is tuned
against one route and carries that route's abstention token, candidate-discrimination clause and variants; using
it to read a competitor's hits would measure the tuning as much as the retrieval. This one is the official
Chain-of-Note shape plus two sentences the corpus requires (recency for knowledge-update, a refusal phrase for
abstention). **Every provider is read through it**, which is what makes two accuracy cells subtractable.

## 1.1 Two runs, three points apart, and why that matters

The reading stage was run twice on the same 100 questions. `lexical-reference` read `65.0%` the first time and
`68.0%` the second; `cortex-session` read `60.0%` both times; `cortex/trim-2.8k` `52.0%` both. DeepSeek's reader
is not deterministic at temperature 0 in practice, and three points on one hundred questions is what that looks
like.

**So every accuracy number here carries a repeat-run spread of about ±3 points before sampling error is
considered**, and a later comparison has to clear that as well as the ±9 points of subset error. It is stated
because a five-point improvement measured once would otherwise look like a result; with this spread it is a
direction at best.

The tables below use the second run, which is the one the final artifact records.

## 2. The reading

100 questions, top-10, `--budget-tokens 2800`, DeepSeek as reader and judge, official per-type judge templates.

| provider            | recall@k | all-gold | mrr   | accuracy           | ~tokens |
| ------------------- | -------- | -------- | ----- | ------------------ | ------- |
| `lexical-reference` | 89.0%    | 72.0%    | 0.701 | **68.0%** (68/100) | 34,563  |
| `cortex-session`    | 87.0%    | 73.0%    | 0.746 | **60.0%** (60/100) | 33,310  |
| `cortex/trim-2.8k`  | 73.0%    | 6.0%     | 0.708 | **52.0%** (52/100) | 2,799   |
| `cortex/whole-8t`   | 7.0%     | 4.0%     | 0.070 | not read           | 2,584   |
| `null-floor`        | 0.0%     | 0.0%     | 0.000 | not read           | 0       |

Arms marked "not read" print `—` rather than `0`. A provider that was never read has no accuracy, and a zero
would claim it answered every question wrong.

## 2.1 Per capability, and the finding that reverses the working assumption

`found/measured` is retrieval; `aCorrect/Read` is what the reader did with it.

| capability | lexical-reference | cortex-session    | cortex/trim-2.8k  |
| ---------- | ----------------- | ----------------- | ----------------- |
| ABS        | 19/20 → **19/20** | 18/20 → **18/20** | 13/20 → **18/20** |
| IE         | 12/20 → 9/20      | 12/20 → 10/20     | 10/20 → 9/20      |
| KU         | 19/20 → 17/20     | 20/20 → **14/20** | 20/20 → **13/20** |
| MR         | 19/20 → 12/20     | 18/20 → 11/20     | 16/20 → **4/20**  |
| TR         | 20/20 → **11/20** | 19/20 → 7/20      | 14/20 → 8/20      |

Four things, and the fourth changes the plan.

1. **ABS inverts.** `trim-2.8k` retrieves 13/20 and answers 18/20: an abstention question needs no evidence, so a
   reader that refuses when the context is thin is _right_. This is why the tight budget's total does not
   collapse, and it is a reason not to read the aggregate as a retrieval score.
2. **KU is lost in reading.** 20/20 retrieved, 13/20 answered — seven points gone after successful retrieval, on
   the capability the end-to-end arm scores 86.8% on. The production prompt is worth roughly 20 points on KU
   against this plain one.
3. **MR collapses under a tight budget.** 16/20 retrieved, 4/20 answered. Twelve points lost in reading, twelve
   more than the retrieval column suggests.
4. **TR is not a retrieval problem at all.** `lexical-reference` retrieves 20/20 and answers 11/20; `cortex-session`
   19/20 → 7/20. **A perfect retriever would still fail half the temporal questions with this reader.** The
   working assumption going into this round was that MR and TR were retrieval deficits. On this evidence the
   larger half is reading, and the end-to-end arm's TR 74.6% against this path's 35% says the production prompt is
   where that half lives.

## 3. Finding one: reading costs about a third

| arm                 | recall@k | accuracy | conversion |
| ------------------- | -------- | -------- | ---------- |
| `lexical-reference` | 89.0%    | 68.0%    | 76%        |
| `cortex-session`    | 87.0%    | 60.0%    | 69%        |
| `cortex/trim-2.8k`  | 73.0%    | 52.0%    | 71%        |

**Consistent across three different retrieval qualities**, which is what makes it a property of the reading
stage rather than of one arm. Roughly 70% of a question whose evidence was retrieved becomes a correct answer.

So the ceiling on the current configuration is not 100%: even a perfect retriever would land near 73% with this
reader and this prompt. That reframes every retrieval number in this repository — `recall@k 94.0%` at 34k tokens
was never going to produce above roughly 68% accuracy.

**`all-gold` is the misleading column here**, and the 2.8k row proves it: `all-gold 6.0%` with `accuracy 52.0%`.
The metric requires _every_ gold turn to be present, and a LongMemEval session carries about ten turns of which
one states the answer. A reader needs the one. `all-gold` measures "the whole conversation is here", which is not
the question anybody asks; `recall@k` (any gold turn) is the one that tracks answerability. It stays in the table
because it was reported before and removing it would look like tidying, but its role changes: it is now a
diagnostic about budget adequacy, not about correctness.

## 4. Finding two: the adapter is 21 points below the product

> **Correction, 2026-10-27.** The row below attributed 81.0% to `NaturalLanguageMemory`. It is not that
> system. The archived reading comes from `benchmark-cortex-memory.yml`, whose feature arm is
> `cortex-memory` at `PREREGISTRATION-CORTEX-MEMORY-ARM.md` §10.3 (`maxPromptChars=48000`,
> `relevanceTopK=256`, `relevanceSignal=retrieval-hybrid`, `evidenceRoles=user`,
> `maxTurnChars=400` on two routes, `ask=enumerated`). `NaturalLanguageMemory` is the **baseline** in
> that same workflow and reads **43.40%** — run `40088479628` measures both. §4.1 below reads
> `natural-language-memory.ts`, so its four components are a description of the 43.40% system's
> machinery, not of the 81.0% system's. **The 21 points are real; the decomposition of them is not.**
> `MEASURE-BASELINE-DRIFT.md` §8 records how the two systems came to share a headline.

| path                                   | score               | what runs                                                                                                                 |
| -------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| memory arm, end to end (500 questions) | **81.0%** (405/500) | `cortex-memory` at §10.3: 256-wide relevance pool, 48,000-character room, user-only roles on two routes, `enumerated` ask |
| competition adapter (100 questions)    | **60.0%**           | `admitSessions` + session budget + `lexicalRelevance`, then a plain Chain-of-Note reader                                  |

The adapter is a _minimal_ composition of the product's pure functions. It has no relevance ranking, no
48,000-character room, no role filter, no enumeration contract, and a different reader prompt. So the
21-point gap is not a contradiction — it is a decomposition **that has not been performed**, and the
four components named below are where it was expected to come from rather than where it has been shown
to come from:

1. **query expansion** (`query-expansion.ts`) — the paper's third optimisation, unmeasured on this path;
2. **reranking** (`rerank.ts` / `rerank-factory.ts`);
3. **abstention recovery** (the `R1` campaign, currently net −1);
4. **the production reader prompt**, which is tuned and which this path deliberately does not use.

**The useful thing this section established, and the thing it got wrong.** It converted "the product
scores 81.0%" into a list of components with a measured total between them, which is the right shape.
It then attributed the total to components that belong to the other arm, which is the same defect §8 of
`MEASURE-BASELINE-DRIFT.md` records: a number carried away from its system. The four components above
are still each separately testable on the same harness; what is now known is that testing them
measures the 43.40% arm.

## 4.1 What the four components actually are, read from the code

§4 named four components as a hypothesis. Reading `natural-language-memory.ts` turns three of them into facts and
changes what the next experiment should be.

| component                | state in the product                                                                                                                                                                                                                                                     | what it means for the 21 points                                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| temporal arithmetic      | **on by default**: `enableTemporalEngine` — the model extracts event dates, then a deterministic engine computes elapsed time, intervals and ordering                                                                                                                    | This is the executor half of TReMu, which the dispatch clause could only imitate by asking the model to write the subtraction down. The product is **stronger than the prompt arm here**, so porting the temporal clause into production would be a downgrade. |
| knowledge update         | **on by default**: `enableBitemporalKnowledgeUpdate` — the model reports the subject's `(object, date)` history, then exact date ordering picks current vs previous                                                                                                      | Same conclusion. The clause asks for "the value from the latest date"; the product computes it.                                                                                                                                                                |
| multi-session membership | the production prompt **already emits a numbered ledger** and already folds duplicate mentions correctly                                                                                                                                                                 | So the artefact-discipline idea in §5.4 is not new to the product — it is new only to the competition reader, which had none. That predicts a real gain on `cortex-session` and no gain from porting it back.                                                  |
| aggregation critique     | **implemented, default off, never measured** — `enableAggregationCritique` re-examines the first pass's own ledger for _membership_ errors (items missed, an exchange collapsed into one, items that should have been excluded) and re-asks with that critique folded in | This is the one that matches the measured failure.                                                                                                                                                                                                             |

The comment on that last flag records the measurement this round's MR result independently reproduces: _"The
measured MR error is dominated by set membership rather than arithmetic: the model already emits a numbered
ledger, already folds duplicate mentions correctly at Step 2, and its stated count follows its own list. What it
gets wrong is which items enter the list."_

**Two consequences, and they are the reason this section is here.**

1. **The plan's `P1` — "port the dispatch clause into the production prompt" — is withdrawn.** Three of the four
   components it would have ported are already in the product, and two of them are stronger than a prompt
   instruction. Porting them would have produced a number indistinguishable from zero and would have been read as
   "prompts do not help".
2. **The replacement is a flag that already exists and has never been on the scale.** `enableAggregationCritique`
   is default-off, reachable only from tests, and targets exactly the failure the MR column shows. Enabling it and
   running its own ablation is a cheaper and better-aimed experiment than any prompt rewrite — and by this
   repository's own rule ("nothing is enabled on the graded path until its own ablation is green") it is the step
   that has to happen before it can be trusted.

   It now has a caller: `BenchmarkRunnerOptions.enableAggregationCritique`, forwarded to the feature only,
   recorded in `featureConfig` for both states, and reachable from the CLI as `AGGREGATION_CRITIQUE=1`. The test
   that matters counts **model calls**, not the config field — a runner that forwarded an option the system
   ignored would still set the field, which is exactly the defect that kept the B7 toggle dead for a round. It
   costs two calls per enumeration question, not one: the pass is a critique and a re-ask, and the first version
   of the test asserted one and read 4 against 3.

That is a general lesson worth recording: **before writing a mechanism, grep for one.** Two of this round's three
"new" ideas already existed in the product, one of them implemented and never measured, which is the same shape as
the orphan exports and the inert `retrievalThreshold` this project has caught before.

## 5. What this is not

1. **Not comparable with Contextier's 91.6%.** Different reader (`deepseek-chat` vs their unspecified low-cost
   tier), different judge (DeepSeek vs the official `gpt-4o-2024-08-06`), 100 questions vs 500. Under
   `comparability()` this is **C** on dataset and questions alone. What the row does say is: at their context
   size, our stack answers about half the questions.
2. **Not the oracle ceiling.** LongMemEval's oracle file (evidence sessions only) is the reader's upper bound;
   this run reads retrieved context, so it cannot separate "the reader is weak" from "this reader is weak on this
   context".
3. **Not a 500-question number.** The subset is stratified but a hundred questions carries roughly ±9 points of
   sampling error at p≈0.6.

## 5.1 The dispatch arm: one inserted clause, four to six points

The clause described in §2.1 was added as a second reader mode and run on the same 100 questions, the same hits,
the same judge. `recall@k` is **identical to the digit** in every row, which is the design working: the hits were
produced once per provider and handed to two prompts, so a difference cannot be retrieval.

| provider            | accuracy, `con` | accuracy, `dispatch` | Δ      | recall@k   |
| ------------------- | --------------- | -------------------- | ------ | ---------- |
| `lexical-reference` | 66.0%           | **72.0%**            | +6.0pp | 89.0% both |
| `cortex-session`    | 64.0%           | **69.0%**            | +5.0pp | 87.0% both |
| `cortex/trim-2.8k`  | 51.0%           | **55.0%**            | +4.0pp | 73.0% both |

Per capability, on the arm with the most headroom:

| capability          | `con` | `dispatch` | Δ         |
| ------------------- | ----- | ---------- | --------- |
| TR (lexical)        | 11/20 | **15/20**  | **+20pp** |
| TR (cortex-session) | 11/20 | 13/20      | +10pp     |
| TR (trim-2.8k)      | 7/20  | 8/20       | +5pp      |
| MR (lexical)        | 10/20 | 14/20      | +20pp     |
| MR (cortex-session) | 10/20 | 12/20      | +10pp     |
| KU (lexical)        | 17/20 | 15/20      | −10pp     |

**The criterion was TR ≥ +15pp at constant `recall@k`, and it is met on one arm and approached on two.** All
three arms move in the same direction, on both weak capabilities, which is what a real effect looks like and
what a noise draw usually is not.

**But it is not significant, and the table must not be read as if it were.** TR carries 20 questions in this
subset; +4 questions on 20 is a binomial difference with a paired p well above 0.05. The honest statement is:
_a prompt clause worth 4–6 points overall, and 5–20 points on the two capabilities that were failing, measured
once on a hundred questions._ Confirming it needs the 500-question file.

**KU moved the wrong way on one arm** (17→15 on lexical) and that is reported rather than dropped. The KU clause
asks the model to enumerate every distinct value with its date, and on a question whose value never changed that
instruction is one more chance to pick an older one. That is a hypothesis for the next round, not a finding.

## 5.2 What the clause is, in one paragraph

The control prompt said nothing about dates, arithmetic, or the order of the blocks. The dispatch clause says:
the blocks are in **relevance** order and not chronological (so the model must rebuild the timeline from the
dates rather than assume the order means something); for TR, write each event's date in ISO form with the quote
you took it from and then do the arithmetic one step at a time; for KU, list each distinct value with its date
and answer from the latest; for MR, collect from more than one conversation before answering; for ABS, refusing
is a correct answer. TReMu, MemFlow and Test of Time each contribute one of those, and the reason to keep them as
an **inserted clause** rather than a rewritten prompt is that the ablation then has exactly one variable.

## 5.3 The 500-question confirmation: the direction was real, and it is specific

§5.1 could only say "four to six points on a hundred questions, not significant". The 500-question run of the same
ablation says the rest. Two arms, the same two prompts, the same corpus:

| provider            | accuracy, `con` | accuracy, `dispatch` | Δ                          | recall@k   |
| ------------------- | --------------- | -------------------- | -------------------------- | ---------- |
| `lexical-reference` | 61.8% (309/500) | **69.2%** (346/500)  | **+7.4pp / +37 questions** | 93.6% both |
| `cortex-session`    | 62.8% (314/500) | **69.0%** (345/500)  | **+6.2pp / +31 questions** | 94.0% both |

Per capability, and this is the part that makes it an effect rather than a drift:

| capability | `con` lexical | `dispatch` lexical   | `con` session | `dispatch` session   |
| ---------- | ------------- | -------------------- | ------------- | -------------------- |
| **TR**     | 58/127        | **89/127** (+24.4pp) | 60/127        | **89/127** (+22.8pp) |
| MR         | 53/121        | 58/121 (+4.1pp)      | 57/121        | 55/121 (−1.7pp)      |
| IE         | 113/150       | 111/150 (−1.3pp)     | 118/150       | 117/150 (−0.7pp)     |
| KU         | 60/72         | 61/72 (+1.4pp)       | 57/72         | 58/72 (+1.4pp)       |
| ABS        | 25/30         | 27/30 (+6.7pp)       | 22/30         | 26/30 (+13.3pp)      |

Three things follow, and the second is the one that makes this a result.

1. **The criterion is met on the population, not just on a subset.** TR ≥ +15pp at constant `recall@k`: +24.4 and
   +22.8 points, on 127 questions each.
2. **The effect is where the clause is.** TR moves 31 and 29 questions; every other capability moves by at most
   five, and IE moves _down_ on both arms. A prompt that made models generally better would move everything; this
   one moves the family whose clause asks for dates and arithmetic.
3. **Two independent retrievals land on the same number.** `lexical-reference` and `cortex-session` retrieve
   differently (93.6% vs 94.0% recall, different hit sets) and both answer 89/127 temporal questions after the
   clause. A coincidence in one arm is a fluke; the same exact count in two is the clause doing the work.

**Is it significant?** The 500-question run predates `ProviderScore.records`, so the exact paired p is not
available from it — a mistake in ordering that is worth recording: the instrument to read a result was built
after the result was produced. What can be said without it: a net movement of +31 questions out of 127 is
significant under **any** pairing of that net, and the bound is arithmetic rather than a claim: the worst case
puts 38 net-preserving regressions against 69 improvements — the most the baseline's 58 correct answers allow —
and `mcnemarExact(69, 38)` is **p = 3.5e-3**. Unanimous movement would be 9.3e-10. The next run carries
`records` and will report the number rather than this bound.

The bound was computed with the tool rather than by hand, which is the point of having built it: the first draft
of this paragraph said "about 0.002", and the function said 0.0035.

**And it does not move MR.** The multi-session clause — "collect evidence from more than one conversation before
answering" — moved 53→58 on one arm and 57→55 on the other. That clause is a suggestion, not a procedure: it
names no artefact the model must produce, which is exactly what the TR clause does and the MR clause does not.
The next version of the MR clause should ask for the same kind of thing the TR clause does: write down the
candidate answers from each conversation, then choose. That is a hypothesis this table produces, and it is the
one the next round tests.

## 5.4 The second rewrite: a clause that names an artefact

§5.3 ended on an asymmetry worth acting on. Two clauses went into the same prompt at the same time, and one moved
31 questions while the other moved 5 and −2:

| clause        | what it says                                                                                                       | questions moved (lexical / session) |
| ------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| temporal      | write each event's date in ISO form, quote the phrase you took it from, then do the subtraction one step at a time | **+31 / +29**                       |
| multi-session | "collect every block that bears on the question before answering, and do not stop at the first one"                | +5 / −2                             |

The temporal clause names **what the reader must write down**. The multi-session clause names nothing; it asks for
diligence. `--reader dispatch2` is the same prompt with that one clause replaced by a procedure:

1. one row per block — `<block number> <date> — the specific fact this block states` — and a block that merely
   mentions the topic is not evidence and must be left out;
2. then every distinct candidate answer, each with the block numbers it came from;
3. aggregations computed **from that list** with the operation shown, not estimated from an impression of it.

Four findings shaped it, and none of them is our own guess:

| source                  | what it says                                                                   | what it changed                                                              |
| ----------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| LongMemEval (ICLR 2025) | multi-session queries need "further fact extraction", not more context         | asks for extraction into per-block facts rather than for careful reading     |
| BEAM (2510.27246)       | multi-session failures come from retrieval omitting events and losing order    | every row carries its date, so a merged list is still ordered                |
| Zep                     | +13.6pp on multi-session QA from a temporal graph where each fact has validity | a prompt cannot build that graph, but it can demand the same shape of output |
| §5.3, this document     | a clause naming an artefact moved 31; one encouraging moved 5 and −2           | the whole reason for trying this                                             |

`dispatch` is **frozen, not edited**. Its numbers are archived against that name, so a rewrite becomes a new arm —
and a test pins its text, which means the next person who wants to change it has to add a mode instead. Six tests
hold the chain single-variable: `dispatch2` is byte-identical to `dispatch` on every other capability, differs only
in the multi-session paragraph (asserted through a shared prefix and suffix, not through a diff of the whole
prompt), and is still the control prompt plus an insertion so `con` remains its baseline.

### A prediction registered before the result

One more external finding arrived after `dispatch2` was dispatched and before its numbers existed, and it makes a
testable prediction about **both** new mechanisms. It is recorded here first, so the result can refute it.

_Judging ≠ Enumerating_ (arXiv 2608.01000) reports that models asked to produce a complete list suffer **silent
omission**: after five items the list "looks complete" and generation stops, while dozens of correct items remain
unstated. The same items, offered one at a time with "does this qualify?", are confirmed about 90% of the time. The
prescription is to stop asking a model to recall a set and to start presenting candidates for judgement.

That distinction separates the two mechanisms built in this round:

| mechanism                                        | where the candidates come from                                                                                             | predicted effect                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `dispatch2` (this round)                         | **iterating the retrieved blocks** — one row per block, so the candidate set is the context rather than the model's recall | movement on MR                                                                         |
| `enableAggregationCritique` (wired, not yet run) | **asking the model what its first list missed** — which is enumeration again, one level up                                 | little or no movement, because the critique inherits the failure it is meant to repair |

If MR moves under `dispatch2`, the reading is that iterating the context is what fixes membership, which agrees with
the paper and would make the critique's design suspect. If MR does not move even under `dispatch2`, then neither
context-iteration nor self-critique repairs membership at the prompt layer, and the gap is in the index — which is
what LongMemEval's own "further fact extraction" sentence claims.

Either outcome decides the next step, and both are better than another prompt rewrite with no prediction attached.

### The bug this uncovered, and why it is in a measurement document

Building the paired test needed two run files, which meant piping the harness's JSON. It broke immediately, and
not in the way that was being tested:

```
json.decoder.JSONDecodeError: Unterminated string starting at: line 384 column 9 (char 8190)
```

`--json` wrote its payload and called `process.exit(0)` in the same tick. Exit does not wait for stdout to drain,
so whatever was still in the pipe was discarded. Measured on a payload of known size:

| code                                  | bytes produced | bytes received |
| ------------------------------------- | -------------- | -------------- |
| `write` then `process.exit`           | 73,480         | **65,536**     |
| `await` the write callback, then exit | 73,480         | 73,480         |

65,536 is the kernel pipe buffer. The artifact was never corrupt on disk, because a file write is synchronous —
which is why every previous run looked fine — and it was never corrupt when the reader drained immediately, which
is why the first version of the regression test **passed on the broken code**. A test for this has to pipe
through a slow reader with a payload larger than 64 KiB; with that shape it fails on the old code and passes on
the new one, both verified.

**This belongs in the measurement document rather than a changelog** because it is the same class of defect this
project keeps finding: a number that was produced by the instrument rather than by the system. A truncated JSON
file does not raise; it parses as a _smaller run_ or not at all, and the reader of an artifact has no way to tell
which. The `--json` path is the one every later comparison depends on.

## 5.5 The multi-session rewrite, and the first exact paired p

500 questions, two arms, two prompts, one run. `con` was skipped by `read_prompts` because its numbers were
already in the previous run's log and the comparison that answers this round's question is dispatch → dispatch2.

| capability | `dispatch` lexical | `dispatch2` lexical | `dispatch` session | `dispatch2` session |
| ---------- | ------------------ | ------------------- | ------------------ | ------------------- |
| ABS        | 26/30              | 27/30 (+1)          | 25/30              | 27/30 (+2)          |
| IE         | 107/150            | 111/150 (+4)        | 120/150            | 120/150 (0)         |
| KU         | 60/72              | 57/72 (−3)          | 53/72              | 54/72 (+1)          |
| **MR**     | **64/121**         | **81/121 (+17)**    | **61/121**         | **77/121 (+16)**    |
| TR         | 87/127             | 85/127 (−2)         | 77/127             | 87/127 (+10)        |
| **total**  | **344/500**        | **361/500 (+17)**   | **336/500**        | **365/500 (+29)**   |

Paired exact McNemar, same questions, same run:

| provider            | improved | regressed | net        | p          | verdict         |
| ------------------- | -------- | --------- | ---------- | ---------- | --------------- |
| `lexical-reference` | 46       | 29        | +17 (3.4%) | 0.0639     | not significant |
| `cortex-session`    | 51       | 22        | +29 (5.8%) | **0.0009** | improved        |

### What the table says, and the two things it refuses to say

**MR is the only capability that moves systematically.** +17 and +16 questions on two independent retrievals —
different recall (93.6% and 94.0%), different hit sets — with everything else inside ±4. That is the shape of an
effect located where the clause is, and it is the prediction registered in §5.4: candidates drawn from _iterating
the retrieved blocks_ fix membership, and the model's own recall does not.

**Which is why the significant p-value is not the headline.** `cortex-session` reaches p=0.0009 on a net of +29,
and only 16 of those are MR. The other 13 are ABS +2, KU +1, and **TR +10** — and the temporal clause is
byte-identical between the two arms, asserted by a test. TR's +10 is therefore a second sample of the same
prompt, not an effect.

**That is the useful part: it measures run-to-run noise on a 127-question column.** Two runs of one prompt differ
by 10 questions, 7.9 points, with no change to the prompt at all. The earlier estimate of ±3pp came from a
100-question, 20-per-capability sample where one question is five points; this one is better because the column
is six times larger.

The honest reading of the round is therefore:

> The multi-session rewrite moves MR by **+16 to +17 questions out of 121 (13–14 points)** on both arms, and the
> total movement it produces is not distinguishable from MR's contribution plus noise on a column that can swing
> ten questions on its own.

`lexical-reference` failing to reach significance (p=0.0639) while showing the same +17 on MR is consistent with
that: its regressions are spread across capabilities, and with 29 of them the test cannot separate the MR effect
from the background. **A test on the total is the wrong test for a clause that targets one capability**, which is
why the per-capability table is the result and the p-value is a footnote to it.

### The bug that produced a false disagreement

The first look at this run showed a table reading `339/500 → 349/500` (net +10) next to a paired report claiming
`improved 46, regressed 29` (net +17). Both were in the log; they disagreed by seven questions.

Cause: every reading stage ran **twice** — once with `--json > file` for the paired test and once piped to `tee`
for the table. Both invocations call the model, so the artifact and the printed table came from different samples.
The JSON said 344 for `lexical-reference` and the table said 339; the paired test used the JSON, so it was right
and the table described a different run.

The repair is `--json-out <path>`: one invocation writes the payload and prints the table from **the same
`{ config, scores }` object**. `test_json_out_writes_the_same_run_it_prints` asserts equality rather than
plausibility — it reads the token count out of the file and looks for the same integer in the printed row — and
removing the write turns it red (verified).

This is the third instrument defect in three rounds, and all three have the same shape: **an artifact that
describes a run other than the one it is filed under.** The truncated JSON said the run was smaller; the doubled
invocation said the run scored differently.

## 5.6 The aggregation critique: judgement per line instead of recall of gaps

§5.4 predicted that the two mechanisms would separate by **where their candidates come from**, and §5.5 measured
one of them: iterating the retrieved blocks moved MR by 16–17 questions, while a clause that only asked the model
to look harder had moved 5 and −2 the round before. The other mechanism is `enableAggregationCritique`, and it
asks the model what its own list **missed** — an enumeration.

_Judging ≠ Enumerating_ (arXiv 2608.01000) is the reason that is a defect rather than a wording choice. Asked for
a complete list, a model commits **silent omission**: after a handful of items the list looks done and generation
stops, while the same items offered one at a time are confirmed about 90% of the time. The prescription is to stop
asking for a recall of the set and start presenting candidates for judgement.

So `aggregationCritiqueMode: 'per-item'` changes what is asked, not how forcefully:

```
every non-empty context line is numbered [1]..[n]
the model must emit exactly one verdict per number:
    <n>: COUNT      this line states an item the question counts
    <n>: NOT-COUNT  it does not
    <n>: DUP-OF <m> it restates the item on line m
then two summary lines, stated to be DERIVED FROM THE VERDICTS JUST WRITTEN:
    MISSED: <COUNT lines absent from the draft>
    EXTRA:  <draft entries with no COUNT line behind them>
```

Three properties follow, and the ordering is deliberate.

1. **Coverage becomes decidable.** A missing line number is a malformed answer. "I found nothing missing" is not
   checkable at all — which is precisely why the recall critique can fail silently.
2. **A merged entry becomes two verdicts.** The measured MR failure is returning an item and picking up its
   replacement counted as one; a per-line verdict marks both lines `COUNT`, and the summary then reports the
   draft entry as `EXTRA`.
3. **The summary is arithmetic over a written list.** This is the same principle §5.4 established for `dispatch2`
   and it is the one this project keeps rediscovering: a prompt that names an artefact the model must write down
   moves questions; a prompt that asks for diligence does not.

`recall` remains the default and remains reachable, because the difference between the two is the experiment.

### Predictions, registered before the run

Two runs are dispatched on the same 500 questions, same reader, same judge, differing only in this mode:

| arm                                   | prediction                                                                                            | what would refute it                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `recall` vs the shipped configuration | **little or no movement on MR** — the critique inherits the enumeration failure it is meant to repair | MR moves by ≥10 questions                       |
| `per-item` vs `recall`                | **MR moves in favour of `per-item`**, for the reason §5.5 confirmed for `dispatch2`                   | `per-item` is level with or worse than `recall` |

And the noise floor from §5.5 applies to both: **a 121-question column swings about 10 questions with the prompt
unchanged (7.9 points)**. A difference under that is not a difference, and neither run will be reported as one
without a paired test over the same questions.

## 6. The next measurements, in order, revised by §2.1

| #   | measurement                                                                                                      | why it is next                                                                                                                                                                      | criterion                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ~~the production reader prompt on the same hits~~ **done — §5.1**, as a clause rather than the production prompt | the clause is the part of the production prompt that could be isolated; the rest of that prompt is route-specific and would have changed four things at once                        | TR ≥ +15pp at constant `recall@k`: met on `lexical-reference` (+20pp), approached on `cortex-session` (+10pp)                               |
| 1b  | ~~the same ablation on the 500-question file~~ **done — §5.3**                                                   | §5.1 was 20 TR questions; the population is 127                                                                                                                                     | TR +24.4pp and +22.8pp, `recall@k` unchanged; exact paired p pending `records`                                                              |
| 1c  | ~~the MR clause, rewritten to demand an artefact~~ **done — §5.5**                                               | §5.3 showed the TR clause moved 31 questions and the MR clause moved 5 and −2; TR asks for dates to be written down, MR asked for nothing                                           | MR ≥ +10pp at constant `recall@k`: **+17 and +16 on 121 questions**, both arms. Criterion met, and the total is not the metric              |
| 1d  | ~~the aggregation critique under the same test~~ **implemented and dispatched — §5.6**                           | §5.4's prediction separates the two mechanisms by where candidates come from; only one had been measured. The recall critique asks what the list missed, which is enumeration again | `recall` vs shipped: little movement. `per-item` vs `recall`: MR moves for `per-item`. Both paired, both against a ±10-question noise floor |
| 1e  | **a prompt-invariant noise baseline, per capability**                                                            | §5.5 measured 10 questions of swing on TR across two identical prompts. Every future claim on a 121-question column must clear that                                                 | report the swing before any Δ is called an effect                                                                                           |
| 2   | the same 100 questions through the **production** memory arm at a matched budget                                 | turns the §4 decomposition into one measurement instead of an inference from two subsets                                                                                            | arms within ±10pp, or the gap attributed to a named component                                                                               |
| 3   | reader swap: `deepseek-chat` vs a second model on frozen hits                                                    | separates "weak reader" from "weak prompt"; with §1.1's ±3pp spread, a difference under 5pp is not one                                                                              | Δ accuracy with identical `recall@k`                                                                                                        |

Number 1 replaces the cross-session compression item that this round's evidence demoted. The plan had MR and TR
as retrieval deficits; the per-capability table says TR is a reading deficit (20/20 retrieved, 11/20 answered)
and MR is both. A retrieval repair aimed at a reading problem would have produced nothing, and the only reason it
was not attempted is that the split got measured first.

## 7. Cost of this stage

`questions × read arms × 2` model calls: 100 × 4 × 2 = 800 per run, about eleven minutes on a runner. The arms
left unread are the ones whose accuracy the recall column already determines. This is why `accuracyFor` is a
list rather than a flag — the choice is visible in the run rather than hidden in the tool.
