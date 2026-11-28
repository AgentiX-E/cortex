# The dimension belongs in the embedding cache key

**The defect this records.** The content-addressed cache placed in front of a competitor's embedder keyed a vector
on `(model, text)` alone. On a variable-dimension model such as Zhipu `embedding-3`, the same text at 1024 and at
256 widths produces two different vectors, so a key without the width handed the first vector to a request that
asked for the second. The vector store then reported a failed ingest whose real cause was a cache collision it
could not name. This note records why the width is part of the identity, the test that made the bug falsifiable,
and the check that the product surface was never exposed to it.

## 1. Where the number came from

`tools/competitor-sut/embed_cache_proxy.py` exists to remove a repeated bill, not a repeated vector: run
`43170314351` spent 49m42s ingesting twenty questions and 54s answering them, a 55x ratio, because the
LongMemEval haystack reuses sessions across questions. The cache is content-addressed and shared across
dispatches, so the same `(model, text)` pair is reused both within one run and between two runs with different
configurations.

The file's own transparency section already stated the precondition that the fix had missed: Zhipu `embedding-3`
is a **variable-dimension model** and answers 400 when `dimensions` is omitted. `mem0_driver.py` sets that width
from `MEM0_EMBEDDING_DIMS`, defaulting to `256` in one code path and `1024` in another. Two experiments against one
cache file, configured with different widths, were therefore guaranteed to collide on every shared sentence.

## 2. The failure mode was silent and misattributed

A hit is not "close enough" in this design; it is claimed to be the exact value the endpoint returned. When the
width is absent from the key:

1. the first request at width 1024 stores `sha256(model, text)`;
2. the second request at width 256 hits the same key and receives a 1024-wide vector;
3. the system under test builds an index at width 256 and fails, or — worse — accepts the vector and searches a
   space the reader did not build;
4. nothing in the proxy logs an error, because from the cache's point of view the lookup succeeded.

This is the same class as the zero-usage frame bug in `sut_llm_proxy.py`: a component whose job is to make a
comparison honest instead makes it quietly wrong, and the only visible symptom is downstream noise. The falsifiable
criterion is the one already used for the model field: a request that differs in a way that changes the vector
**must not** reuse it.

## 3. The fix

`cache_key` now takes the width as its third argument and composes the identity as
`sha256(model \0 width \0 text)`:

- the controlled fields (`model`, `width`) come first and the free-form text is last, so no text containing a NUL
  can forge a boundary and collide with a different model or width — the same split-ambiguity guard the original
  two-argument form applied to `("a","bc")` against `("ab","c")`;
- `width` is empty when `dimensions` is absent, so an undimensioned request keeps a distinct identity from one
  that states a width explicitly;
- `do_POST` coerces `dimensions` to `int` when possible, so `"1024"` and `1024` cannot become two entries that
  each claim the other's vector is a miss; an unparseable value falls back to `None` rather than aborting the
  request, because the width is a property of the vector, not a reason to fail a successful answer;
- `VectorCache.get`/`put` thread the width through to the key. The stored `dimensions` column continues to record
  the vector's actual length, which is a measurement, not the requested width.

## 4. Test method and acceptance

A new criterion class, `TestCriterionSixTheDimensionIsPartOfTheVectorIdentity`, was written first and shown red
against the old key: the integration case sent the same text at widths 1024 and 256 and the upstream was called
**once**, not twice (`assert 1 == 2` failed). After the fix:

- a changed width yields a different key;
- a width cannot be forged by embedding a NUL in the text;
- the three-field composition is pinned, so a future rewrite is visible rather than merely incompatible;
- two widths cause two upstream calls and zero cache hits;
- the same width still hits the cache, so the fix did not disable memoisation.

Six new cases plus the full proxy suite run green (65 passed, 4 skipped across the four related tool test files).
The whole `pnpm check` and `pnpm test:tools` chain is re-run before submission; no benchmark was dispatched, so
this iteration spent ¥0 in API calls.

## 5. The product surface was already correct

Criterion 16 of the standing instruction asks that an evaluation-side fix be checked against the product side.
`packages/cortex-core/src/cache/embedding-cache.ts` already folds width into its fingerprint:
`CachingEmbedding.fingerprintOf` uses `[provider, model, endpoint, String(identity.dimensions)].join('/')` when a
model states an identity, and `unknown/${String(model.dimension())}` otherwise. `EmbeddingMemo`'s key is
`fingerprint \0 sha256(text)`, so two widths occupy two spaces. No product change was needed and none was made —
the gap was confined to the competitor measurement path, which is exactly where a wrong vector would have
distorted the SOTA comparison rather than a user answer.

## 6. What this does and does not move

This is a measurement-integrity fix. It does not change Cortex's retrieval, its 93.40% accuracy, or its cost per
question. It changes the confidence with which a future matched-model run can attribute a competitor's bill and
vectors. Three mechanism leads remain un-adopted (per-question routing, extractive memory, multi-step ReAct) and
the SOTA gap is unchanged; the queue head is still the `resolution: raw` dispatch. The value of this iteration is
that the ruler used to compare Cortex against those leads can no longer silently under-report a competitor.
