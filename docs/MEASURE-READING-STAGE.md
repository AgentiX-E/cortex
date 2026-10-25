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

## 2. The reading

100 questions, top-10, `--budget-tokens 2800`, DeepSeek as reader and judge, official per-type judge templates.

| provider | recall@k | all-gold | mrr | accuracy | ~tokens |
| --- | --- | --- | --- | --- | --- |
| `lexical-reference` | 89.0% | 72.0% | 0.701 | **65.0%** (65/100) | 34,563 |
| `cortex-session` | 87.0% | 73.0% | 0.746 | **60.0%** (60/100) | 33,310 |
| `cortex/trim-2.8k` | 73.0% | 6.0% | 0.708 | **52.0%** (52/100) | 2,799 |
| `cortex/whole-8t` | 7.0% | 4.0% | 0.070 | not read | 2,584 |
| `null-floor` | 0.0% | 0.0% | 0.000 | not read | 0 |

Arms marked "not read" print `—` rather than `0`. A provider that was never read has no accuracy, and a zero
would claim it answered every question wrong.

## 3. Finding one: reading costs about a third

| arm | recall@k | accuracy | conversion |
| --- | --- | --- | --- |
| `lexical-reference` | 89.0% | 65.0% | 73% |
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

## 6. The next three measurements, in order

| # | measurement | why it is next | criterion |
| --- | --- | --- | --- |
| 1 | per-capability accuracy at 2.8k | the aggregate cannot say whether MR or TR is losing, and the two have different repairs | reported; MR and TR separated |
| 2 | the same 100 questions through the **production** memory arm at a matched budget | tests the decomposition in §4 directly rather than inferring it from two different subsets | arms within ±10pp of 60.0%, or the gap attributed to a named component |
| 3 | reader swap: `deepseek-chat` vs a second model on frozen hits | separates "weak reader" from "weak retrieval" | Δ accuracy with identical `recall@k` |

Number 2 is the one that matters. Every claim in §4 is currently an inference from two runs that differ in
dataset size, prompt and pipeline; the only way to make it a measurement is to run one pipeline with one
component removed at a time.

## 7. Cost of this stage

`questions × read arms × 2` model calls: 100 × 4 × 2 = 800 per run, about eleven minutes on a runner. The arms
left unread are the ones whose accuracy the recall column already determines. This is why `accuracyFor` is a
list rather than a flag — the choice is visible in the run rather than hidden in the tool.
