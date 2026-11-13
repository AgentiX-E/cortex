# Measure S9 — the product ranks its own turns

Written before the dispatch, so the reading is fixed in advance rather than chosen after seeing the number.
Every prediction below is falsifiable by one artifact, and each outcome has a decision attached that was
taken while the number was still unknown.

## 0. The claim this measures, and why it has never been measured

`cortex-memory` owns a retrieval stack: `SearchIndex`, with postings over `contentTerms`, a vector channel
through an injected batch embedder, reciprocal-rank fusion, and an optional cross-encoder pass inside the
product. It has had unit tests since the round it landed, two acceptance rows (`C5`/`C6`) measured over a
synthetic four-turn corpus, and **no reading on a real corpus**, because no dispatch could reach it.

That is not a gap in coverage. It is a gap in what the campaign has been measuring. Every ranking signal on
this arm so far — `retrieval`, `retrieval-hybrid`, `retrieval-anchored`, `retrieval-session` — is an index
built by `cortex-eval` **before the run** and handed to the product as a synchronous callback. So every
published number on this arm says *this is what the harness can rank*; none of them says *this is what the
product can rank*. A product that answers well only when someone else hands it a ranking is a component of
the harness, not a product.

`self-index` closes that: the arm passes an embedder and a width, and `CortexMemory` builds the index over
each question's own turns.

## 1. The two dispatches, and the pairing rule

| side | signal | why it is the comparison |
| --- | --- | --- |
| control | `retrieval-anchored` (the adopted configuration) | the registered best on this arm; what a deployment would run today |
| treatment | `self-index` | the same vectors, plus a lexical channel, fused by rank inside the product |

Both sides run with `cortex_memory_relevance_top_k=256`, `relevance_units=turn`, `ask=verbatim-acts`,
`prompt_contract=evidence-blocks-unsourced`, `max_turn_chars=400` on `multi-session,temporal`,
`max_prompt_chars` as registered, reader `deepseek-chat` at temperature 0, four repetitions, full 500
questions. **One variable moves**: which process builds the ranking.

The pairing is by question, not by run: the per-question verdicts of the two artifacts are joined on
question id and compared with `tools/paired-test.mjs` (McNemar, two-sided). Four repetitions make the
per-question verdict a mean over four, which is what the arm's other paired rows do.

Three things would make the pair unreadable, and each is checked rather than assumed:

1. **The corpus.** `longmemeval_s_cleaned.json` is served from a moving branch; both artifacts must print
   the same `corpus sha256`, or the run is two datasets. (`benchmark.yml` asserts it when `corpus_sha256` is
   supplied; the memory workflow prints it on every run.)
2. **The reader and the judge.** `memoryArmConfig.reader` and `memoryArmConfig.judge` must agree; §13.312 is
   the round that found two artifacts graded by two judges being compared as if one instrument had produced
   both.
3. **The prompt outside the ranking.** `S9` moves the order of the evidence, not its wording, its room or
   its cap. If `promptDigest` differs on questions whose *evidence set* is identical, the difference is in
   the rendering rather than in the ranking and the delta is not attributable. The artifacts carry per-question
   digests for exactly this check.

## 2. The three readings

One dispatch produces all three; none of them is derived from another.

| # | reading | where it lives | what it decides |
| --- | --- | --- | --- |
| 1 | paired accuracy delta, in questions | the two artifacts' per-question verdicts → `cortex-docs/evidence/longmemeval/self-index.json` `paired.deltaQuestions` | whether the product's ranking is a ranking worth shipping (`S9`, threshold −15) |
| 2 | total `embedTexts` | the treatment artifact's `memoryArmConfig.selfIndex.embedTexts` | what the per-question rebuild costs |
| 3 | total `memoHits` | the treatment artifact's `memoryArmConfig.selfIndex.memoHits` | how much of that cost the instance's own store absorbed |

Reading 2 beside 3 is the reason both are recorded. The corpus arrives per question
(`answerSessions(question, sessions)`), so the index is rebuilt per question; `CortexMemory` owns one
`EmbeddingCacheStore` for its lifetime, so a turn it has already embedded is free the second time. On
LongMemEval-S each question brings its own haystack, so the store may save **nothing** — and that is a
finding about the corpus rather than a defect in the store, which is precisely why the artifact carries two
counts instead of an argument.

## 3. Predictions, written before the run

| # | prediction | falsified by |
| --- | --- | --- |
| P1 | `self-index` lands within ±8 questions of `retrieval-anchored` | a delta outside that band |
| P2 | `memoHits` is **near zero** relative to `embedTexts` (below 5%), because LongMemEval-S gives each question its own haystack | a hit rate above 5%, which would mean the haystacks overlap far more than the dataset description suggests |
| P3 | `embedTexts` is close to `turns + indexes` (one text per corpus turn plus one query), since the memo cannot help | `embedTexts` well above that, which would mean a text is being embedded twice within one index |
| P4 | `rerankCalls` is 0 and `rerankDegraded` is 0, because the dispatch runs no cross-encoder | either counter non-zero, which would mean a stage fired that the configuration did not name |

P2 is the interesting one. If the corpuses *do* overlap, the per-question rebuild is nearly free after the
first questions and the cost objection to the product's own index disappears — and the memo is then doing
the work `C5` measured on a fixture, on a real corpus.

## 4. Pre-committed decisions

- **Delta ≥ −15 questions:** `S9` passes. Adopt the signal **only if** reading 2 is at or below one text per
  corpus turn per question; a tie that doubles the embedding bill is not a tie.
- **Delta < −15:** the stack is mis-weighted, not the idea. The channels are the same vectors plus a lexical
  one, so the ordered suspects are `rrfK` (fusion), `k` (pool width) and `contentTerms` (the lexical
  channel's term list) — in that order, each as its own single-variable dispatch. **The signal is not
  removed**: a mechanism that loses to a strong dense baseline by more than noise is a mechanism with a
  tuning defect, and removing it would leave the product unable to rank at all.
- **Delta > +15:** adopt, and the next question becomes whether the lexical channel is what bought it — one
  dispatch with the vector channel's contribution removed (`embed` absent, a lexical-only index) answers it.
- **`rerankDegraded > 0` with `rerankCalls > 0`:** the stage degraded, and its accuracy is the input order's.
  Nothing about the ranking can be concluded until that is repaired; the artifact is flagged rather than read.

## 5. What the first dispatch found before it measured anything

The screening dispatch (200 questions × 2 repetitions) never reached its first reading. It died at question
4, ninety milliseconds in, on the provider's own words:

```
Embedding request failed: 400 Bad Request —
{"error":{"code":"1214","message":"input数组最大不得超过64条"}}
```

`SearchIndex.prime()` sent the whole corpus in one request and a LongMemEval haystack is ~500 turns, so the
product's own retrieval could not run against a capped provider **at all**. Every unit test passed: a fake
embedder accepts any batch size, and the fixture corpus is four turns. The repair is
`SearchIndexOptions.batch` (default 64 — Zhipu's cap and the width `cortex-eval` already batches at) plus a
loop in `prime()`, with `search-batch.test.ts` using an embedder that refuses an oversized slice exactly as
the provider did.

Two things about this are worth keeping in the record rather than in a changelog:

- **A prediction nobody wrote was the one that failed.** P1–P4 were about accuracy, memo hits and the
  reranker. None of them was "the corpus fits in one request", because that is not a property of the
  experiment — it is a property of the world the experiment runs in. The pre-registration discipline prices
  the readings; it does not price the plumbing, and the plumbing is where a run dies.
- **It cost 90 ms of a 2.85 CNY dispatch.** The same defect found after the full pass would have cost
  14.26 CNY and a day of attribution, because a dead run produces no artifact to read and the next thing to
  suspect would have been the metric.

The screening gate exists for exactly this, and round 90 is the round that paid for it twice: the first
dispatch was the price of finding the defect, the second is the price of measuring.

## 6. What this cannot tell us

It cannot say whether a *different* fusion would do better — one dispatch prices one configuration. It
cannot price the wall clock: the postings are rebuilt per question and that cost is CPU, which the artifact
counts only as `turns`. And it cannot compare against a competitor's own retrieval on equal terms: Mem0's
68.24 is their harness, their reader and their judge, so it locates the axis (a system whose retrieval is its
own is scored end to end there) and is not a number we may subtract from.
