# FIX — The Store That Cannot Say Which Model Wrote It

**Status:** fixed and guarded. `EmbeddingModel` could report its width and nothing else, so a
same-width substitution between two unrelated embedding spaces was invisible to every layer that
compares vectors — the width check in `dot` catches a 1024-against-256 query and says nothing about
1024-against-1024. `EmbeddingIdentity` and `EmbeddingSpace` make the space a stated, checked property,
and the benchmark's retrieval path now assembles every index through it.

**Found by:** reading `interfaces/embedding.ts` against `AUDIT-MODEL-PORTABILITY.md` §7.0, which cites
Goyal & Ray (arXiv:2609.05339) measuring a store that gains 9.91 points one way and loses 13.28 the
other under a writer swap, and states that this repository had a provenance record for the benchmark's
*cache* and none for a deployment's *index*. The audit was right about the gap and wrong about one
thing: this repository's own test doubles could not have reached it either, because seven of them did
not implement the interface they were cast to.

---

## 1. The defect, stated as the two cases width cannot separate

`VectorIndex` stores `Float64Array`s and `EmbeddingModel` produces them, and neither abstraction records
who produced which. Three layers of check existed, and all three are about the wrong field:

| layer | what it checks | the case it misses |
| --- | --- | --- |
| `dot` / `l2Distance` (`math/vector.ts`) | array length | two models of the same width |
| `deserializeEmbeddingCache` (`cortex-eval/src/retrieval.ts`) | provider, model, baseUrl, dimensions of a **cache file** | a deployment's own index, which has no such header |
| `EmbeddingProvenance` (`cortex-eval/src/embedding-factory.ts`) | which backend the **harness** reached | who wrote the vectors in a **product** index |

So the guard lived where the measurement happens rather than where the product is assembled, which is
the same inversion as publishing a type-safety argument in a test file. Concretely:

```
Zhipu embedding-3, 1024 dims, unit-norm  ──┐
                                           ├─ cosine between them: a number in [-1, 1], meaningless
a 1024-dim local model, unit-norm        ──┘
```

Every `add` succeeds, every `search` returns `k` hits, and the ranking is noise. There is no error to
see, which is what makes it worse than a crash: the run reports an accuracy.

## 2. What was added, and why each piece is where it is

| piece | file | why there |
| --- | --- | --- |
| `EmbeddingIdentity` (`provider`, `model`, `endpoint`, `dimensions`) | `cortex-core/src/interfaces/embedding.ts` | the interface is the extension point a user injects into, so the identity has to be part of the injected contract rather than a harness convention |
| `EmbeddingModel.identity?()` | same | **optional** on purpose: a new required member would break every implementation outside this repository on a minor upgrade, and this interface is documented as the way to plug a model in |
| `EmbeddingSpace` / `EmbeddingSpaceError` | `cortex-core/src/vector/embedding-space.ts` | a vector index is where vectors of different spaces meet, so it is where the check belongs |
| `identity()` on `OpenAIEmbedding` and `HashEmbedding` | `cortex-ai/src/embedding/openai.ts`, `cortex-eval/src/embedding.ts` | the two backends this repository ships, each naming itself from the fields it already had |
| adoption in `buildTurnIndex`, `buildSessionIndex`, `buildSessionTurnIndex`, `EmbeddingMemorySystem` | `cortex-eval/src/retrieval.ts`, `cortex-eval/src/embedding-memory.ts` | so the guard is on the scoring path of every retrieved question instead of waiting for a caller to adopt it |

`provider` for the remote adapter is `'openai-compatible'`, not a vendor name, because that is what
that class can honestly state: it speaks one protocol and reaches whatever `baseUrl` was configured.
The vendor is legible from `endpoint`, which is a field of the identity for a related reason — the same
model id served by two gateways can be two different sets of weights.

## 3. The three refusals at `open`, and the one that is deliberately strict

An index cannot describe itself: its entries are vectors plus caller-chosen metadata. So the space the
existing contents were written with has to be *stated*, as `stored`.

| condition | reason | why it is a refusal rather than a default |
| --- | --- | --- |
| `size() > 0` and no `stored` | `unstated` | "I am X" is a fact about the model, not evidence that the index was written by X. Assuming it is the silent substitution itself |
| `stored` present, model unnamed | `unidentifiable` | a statement nothing can check is not a guard |
| `stored` differs from the model | `mismatch` | names **every** differing field, not the first, because five of the six ways two backends can differ would pass a single-field comparison |
| `identity().dimensions` ≠ `dimension()` | `width` | every later width check trusts `identity`, so a model that disagrees with itself is caught before that trust is placed |

The strictness is the first row: a non-empty index with no stated space is refused **even when the model
names itself**. That costs a caller one field on reopen, and it buys the only property that matters —
a store whose space is unknown can never be queried through this path. `space.identity` is what to
persist beside the index.

## 4. The two ways a model can answer wrongly, which are now refusals

`embed` checks the count and the width of what came back:

- **count** — a model that returns three vectors for four texts shifts text against vector in every
  caller that indexes by position, and the shift is silent. `EmbeddingSpaceError('count')`.
- **width** — a vector that is not the space's width is refused with its position and the space named.
  This is what catches the *padded* vector: `embedManyCached` inserts an empty vector when a provider
  returns fewer vectors than it was given, so the cache stays positionally correct. Before this guard
  those empty vectors were indexed and every cosine against them read `0` — a turn that can never be
  retrieved, indistinguishable from a turn that is simply irrelevant. `retrieval.test.ts` now pins that
  as a refusal.

## 5. What the adoption surfaced: seven test doubles that were not `EmbeddingModel`s

`EmbeddingSpace.open` calls `model.dimension()`. `dimension()` had exactly one caller in the repository
(`embedding-preflight.ts`), so a double could omit it and still run. Two did more than omit it:

- `retrieval-diagnostics-threshold-name.test.ts` declared `dimensions: 2` — a **data field**, not the
  method — and cast the object `as unknown as EmbeddingModel`. Five tests in that file failed the moment
  the method was called. The cast is gone with the typo; the doubles now return `Float64Array[]` as the
  interface requires, so the file's own subject (a percentile read off real score distributions) is
  measured on well-formed vectors.
- `retrieval.test.ts` stubbed `embed: async () => []` to make "every query matches no turn" true. That
  made every query vector zero-length, and a zero-norm query scores 0 against everything — so the test
  was asserting an empty result that came from a broken vector rather than from an empty corpus. It now
  uses a well-formed model and an empty corpus, and the broken-vector case is its own test asserting the
  width refusal.

Neither was a product bug. Both were the reason a product bug could not have been *found* here: a test
suite whose doubles do not satisfy the interface cannot disagree with the interface.

## 6. The two records of one fact, and the test that keeps them equal

`EmbeddingProvenance` (harness) and `EmbeddingIdentity` (product) now describe the same thing. A second
copy that passes its own tests while the first drifts is the shape this repository has been burned by
before, so `cortex-eval/src/__tests__/embedding-space-parity.test.ts` asserts the two agree on four
environments — a Zhipu key, the alternate variable names, no credential, and a credential delivered as
an empty string (which is how an unset CI secret arrives). The projection is:

| `EmbeddingProvenance` | `EmbeddingIdentity` |
| --- | --- |
| `provider` | `provider` |
| `model` | `model` |
| `baseUrl` | `endpoint` — renamed deliberately: the cache block has carried `baseUrl` since version 2, and renaming it would make every archived cache report a differing field and re-embed 115,000 turns |
| `dimensions` | `dimensions` |

The same file also asserts the deployment the guard exists for: an index written by the remote backend,
a key that disappears, the factory's silent fallback to the 256-dimension hash embedding, and a
`mismatch` refusal that names both spaces (`openai-compatible/embedding-3 at … , 1024 dimensions` against
`hash/(none) at (none), 256 dimensions`) instead of returning a ranking.

## 7. Verification

| check | reading |
| --- | --- |
| `embedding-space.test.ts` | 15 tests; the new file at **46/46 statements, 14/14 functions, 28/28 branches** |
| `embedding-space-parity.test.ts` | 7 tests across four environments plus the two directions of a reopen |
| `cortex-ai` identity | `llm.test.ts` asserts the adapter states the endpoint it was given |
| adoption | `retrieval.test.ts` 103 tests, `embedding-memory.test.ts` 8, `cortex-eval` **3,252** |
| census | `EmbeddingSpace` is `with-caller` (two call sites); its three error-surface names are registered as `embedding-space-public-api` with the reason, because catching it is what a caller needs them for |
| lint / format / build | clean; `pnpm check` EXIT=0 |

## 8. What this does not fix, and the next entry it creates

**No number.** This fix makes a substitution *loud*; it does not measure what a real provider pair
costs. The audit's §7.0 first priority — "a measured migration cost for cortex's own store" — is
unmoved by it, and the honest statement of where portability stands after this round is the same as
before: `P1` in `ACCEPTANCE-MATRIX.md` is still `unrun`, because the between-provider variance against
within-provider variance ratio has not been measured on any pair of readers or embedders in this
repository.

What the fix changes about that claim is its failure mode. A future portability run cannot be read as
"the substitute scored the same" when the store was silently half-re-embedded, because that run now
refuses at `open` instead of reporting a number. The measurement is still owed; the way to get a
plausible one by accident is closed.
