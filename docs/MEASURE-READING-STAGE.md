# MEASURE — The Reading Stage, and the 21 Points Between an Adapter and the Product

## 0. One paragraph

The retrieval harness could say how often the evidence was in the context and nothing about whether the answer
came out. With a reader and the official per-type judge attached, the same 100 questions read `65.0%` for the
lexical reference, `60.0%` for Cortex's adapter at 33k tokens, and `52.0%` at the 2.8k budget Contextier reports.
Two findings follow, and the second is larger than the first: roughly **71% of a retrieved question becomes a
correct answer** — so a third of the loss is reading, not retrieval — and the adapter reads **21 points below the
product's own end-to-end score**, which means the adapter was never a proxy for the product.

## 1. What was added

| piece | why |
| --- | --- |
| `measureRetrieval` gains `answer` / `judge` / `accuracyFor` | one pass, one corpus: `accuracy` and `recallAtK` have to describe the same run |
| `competitor-reader.ts` | one Chain-of-Note prompt for every provider, deliberately **not** the production prompt |
| `CapabilityScore.read` / `.correct` | the aggregate hides which family is losing |
| workflow step at the 2.8k budget | the only context size at which a published accuracy can be compared at all |

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

| provider | recall@k | all-gold | mrr | accuracy | ~tokens |
| --- | --- | --- | --- | --- | --- |
| `lexical-reference` | 89.0% | 72.0% | 0.701 | **68.0%** (68/100) | 34,563 |
| `cortex-session` | 87.0% | 73.0% | 0.746 | **60.0%** (60/100) | 33,310 |
| `cortex/trim-2.8k` | 73.0% | 6.0% | 0.708 | **52.0%** (52/100) | 2,799 |
| `cortex/whole-8t` | 7.0% | 4.0% | 0.070 | not read | 2,584 |
| `null-floor` | 0.0% | 0.0% | 0.000 | not read | 0 |

Arms marked "not read" print `—` rather than `0`. A provider that was never read has no accuracy, and a zero
would claim it answered every question wrong.

## 2.1 Per capability, and the finding that reverses the working assumption

`found/measured` is retrieval; `aCorrect/Read` is what the reader did with it.

| capability | lexical-reference | cortex-session | cortex/trim-2.8k |
| --- | --- | --- | --- |
| ABS | 19/20 → **19/20** | 18/20 → **18/20** | 13/20 → **18/20** |
| IE | 12/20 → 9/20 | 12/20 → 10/20 | 10/20 → 9/20 |
| KU | 19/20 → 17/20 | 20/20 → **14/20** | 20/20 → **13/20** |
| MR | 19/20 → 12/20 | 18/20 → 11/20 | 16/20 → **4/20** |
| TR | 20/20 → **11/20** | 19/20 → 7/20 | 14/20 → 8/20 |

Four things, and the fourth changes the plan.

1. **ABS inverts.** `trim-2.8k` retrieves 13/20 and answers 18/20: an abstention question needs no evidence, so a
   reader that refuses when the context is thin is *right*. This is why the tight budget's total does not
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

| arm | recall@k | accuracy | conversion |
| --- | --- | --- | --- |
| `lexical-reference` | 89.0% | 68.0% | 76% |
| `cortex-session` | 87.0% | 60.0% | 69% |
| `cortex/trim-2.8k` | 73.0% | 52.0% | 71% |

**Consistent across three different retrieval qualities**, which is what makes it a property of the reading
stage rather than of one arm. Roughly 70% of a question whose evidence was retrieved becomes a correct answer.

So the ceiling on the current configuration is not 100%: even a perfect retriever would land near 73% with this
reader and this prompt. That reframes every retrieval number in this repository — `recall@k 94.0%` at 34k tokens
was never going to produce above roughly 68% accuracy.

**`all-gold` is the misleading column here**, and the 2.8k row proves it: `all-gold 6.0%` with `accuracy 52.0%`.
The metric requires *every* gold turn to be present, and a LongMemEval session carries about ten turns of which
one states the answer. A reader needs the one. `all-gold` measures "the whole conversation is here", which is not
the question anybody asks; `recall@k` (any gold turn) is the one that tracks answerability. It stays in the table
because it was reported before and removing it would look like tidying, but its role changes: it is now a
diagnostic about budget adequacy, not about correctness.

## 4. Finding two: the adapter is 21 points below the product

| path | score | what runs |
| --- | --- | --- |
| memory arm, end to end (500 questions) | **81.0%** (405/500) | `NaturalLanguageMemory`: query expansion, rerank, abstention recovery, the production prompt |
| competition adapter (100 questions) | **60.0%** | `admitSessions` + session budget + `lexicalRelevance`, then a plain Chain-of-Note reader |

The adapter is a *minimal* composition of the product's pure functions. It has no query expansion, no reranker, no
abstention recovery, and a different reader prompt. So the 21-point gap is not a contradiction — it is a
decomposition, and it names the four things that carry 21 points:

1. **query expansion** (`query-expansion.ts`) — the paper's third optimisation, unmeasured on this path;
2. **reranking** (`rerank.ts` / `rerank-factory.ts`);
3. **abstention recovery** (the `R1` campaign, currently net −1);
4. **the production reader prompt**, which is tuned and which this path deliberately does not use.

**This is the round's most useful result**, because it converts "the product scores 81.0%" into a list of
components with a measured total between them, and each is separately testable on the same harness.

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

| provider | accuracy, `con` | accuracy, `dispatch` | Δ | recall@k |
| --- | --- | --- | --- | --- |
| `lexical-reference` | 66.0% | **72.0%** | +6.0pp | 89.0% both |
| `cortex-session` | 64.0% | **69.0%** | +5.0pp | 87.0% both |
| `cortex/trim-2.8k` | 51.0% | **55.0%** | +4.0pp | 73.0% both |

Per capability, on the arm with the most headroom:

| capability | `con` | `dispatch` | Δ |
| --- | --- | --- | --- |
| TR (lexical) | 11/20 | **15/20** | **+20pp** |
| TR (cortex-session) | 11/20 | 13/20 | +10pp |
| TR (trim-2.8k) | 7/20 | 8/20 | +5pp |
| MR (lexical) | 10/20 | 14/20 | +20pp |
| MR (cortex-session) | 10/20 | 12/20 | +10pp |
| KU (lexical) | 17/20 | 15/20 | −10pp |

**The criterion was TR ≥ +15pp at constant `recall@k`, and it is met on one arm and approached on two.** All
three arms move in the same direction, on both weak capabilities, which is what a real effect looks like and
what a noise draw usually is not.

**But it is not significant, and the table must not be read as if it were.** TR carries 20 questions in this
subset; +4 questions on 20 is a binomial difference with a paired p well above 0.05. The honest statement is:
*a prompt clause worth 4–6 points overall, and 5–20 points on the two capabilities that were failing, measured
once on a hundred questions.* Confirming it needs the 500-question file.

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

## 6. The next measurements, in order, revised by §2.1

| # | measurement | why it is next | criterion |
| --- | --- | --- | --- |
| 1 | ~~the production reader prompt on the same hits~~ **done — §5.1**, as a clause rather than the production prompt | the clause is the part of the production prompt that could be isolated; the rest of that prompt is route-specific and would have changed four things at once | TR ≥ +15pp at constant `recall@k`: met on `lexical-reference` (+20pp), approached on `cortex-session` (+10pp) |
| 1b | **the same ablation on the 500-question file** | §5.1 is 20 TR questions; +4 on 20 is not significant, and the whole point of a direction is that it survives the population | TR ≥ +15pp on 127 questions, paired test |
| 2 | the same 100 questions through the **production** memory arm at a matched budget | turns the §4 decomposition into one measurement instead of an inference from two subsets | arms within ±10pp, or the gap attributed to a named component |
| 3 | reader swap: `deepseek-chat` vs a second model on frozen hits | separates "weak reader" from "weak prompt"; with §1.1's ±3pp spread, a difference under 5pp is not one | Δ accuracy with identical `recall@k` |

Number 1 replaces the cross-session compression item that this round's evidence demoted. The plan had MR and TR
as retrieval deficits; the per-capability table says TR is a reading deficit (20/20 retrieved, 11/20 answered)
and MR is both. A retrieval repair aimed at a reading problem would have produced nothing, and the only reason it
was not attempted is that the split got measured first.

## 7. Cost of this stage

`questions × read arms × 2` model calls: 100 × 4 × 2 = 800 per run, about eleven minutes on a runner. The arms
left unread are the ones whose accuracy the recall column already determines. This is why `accuracyFor` is a
list rather than a flag — the choice is visible in the run rather than hidden in the tool.
