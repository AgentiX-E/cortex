# Design — giving the reader a second look

Status: **design only**. `PREREGISTRATION-MULTI-STEP.md` registers the measurement; this file registers
how the product gets the capability, and what it costs to keep the reading honest.

## 1. Why the obvious implementation is wrong

`cortex-ai/agent` already holds the loop, and calling it from an evaluation arm is legal: the subpath
depends on `cortex-core` and nothing else. The arm has the corpus, the reader's LLM and the renderer.
What it does not have is **the ranking under test**, and there are three ways to supply it:

| option                          | how                                                                                                      | why it is rejected                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A** arm builds its own index  | `cortex-memory`'s `SearchIndex` is public, the arm constructs one                                        | `cortex-eval` takes `cortex-memory` as a **dev** dependency only, because the edge `memory → eval` already exists for the ablation harness. A runtime import closes a cycle. And even if it did not, the second look would be a measurement of the harness's ranking, not the product's — the failure `AUDIT-EVAL-CONTRACTS.md` §2 exists to prevent                                                               |
| **B** instance cache            | `#relevanceFor` keeps the `SearchIndex` it built and a new `search()` reuses it                          | The index is built per question over `(question, turns)`, and the class is careful that per-question state cannot outlive its question — `#lastRanking`/`#lastRankingQuestion` are cleared on entry _for that reason_. A cached index is the same hazard with a larger object, and the guard would have to be "same question and same array identity", which is a correctness claim nothing else in the file makes |
| **C** caller-supplied retrieval | the product exposes one method that answers a query against a caller-passed corpus, and the arm calls it | this is the only one where the ranking under test is the one measured                                                                                                                                                                                                                                                                                                                                              |

## 2. The method

```ts
// packages/cortex-memory/src/memory.ts
/**
 * The turns this memory would rank highest for a query, over a corpus the caller names.
 *
 * ## Why the corpus is an argument and not a field
 *
 * `answer(question, context)` takes its evidence as an argument because the benchmark hands each
 * question its own haystack; the same reason applies here, and the alternative -- remembering the last
 * corpus -- is the staleness hazard §2B describes.
 *
 * ## Why this is not a second implementation of the ranking
 *
 * It builds the same `SearchIndex` from the same options with the same `prime()`/`lookup()` pair
 * `#relevanceFor` uses, and returns the pool the prompt builder would have drawn from. A caller that
 * passes these hits back as evidence has asked the product for a shorter corpus, not for a different
 * opinion about the corpus.
 */
async search(
  query: string,
  turns: readonly string[],
  options?: { readonly k?: number },
): Promise<readonly RankedTurn[]>;
```

`RankedTurn = { readonly turn: number; readonly score: number }` is declared in `memory.ts` and exported
from the barrel — `SearchHit` stays module-internal (the export census retired it), and the pair is
spelled out here rather than reused so a change to the index's internal hit shape cannot silently change
a public signature.

## 3. What the arm does with it

```
1. control retrieval (unchanged): assembleMemory ranks the haystack and the room applies
2. if readerSearch > 0: ask the reader, over the block it just received, for one query
3. hits = memory.search(query, turns, { k: relevanceTopK })
4. union = hits ∪ delivered, re-ranked by the same relevance signal, room re-applied
5. answer() on the union
```

Step 2 is one LLM call. Step 3 is one embedding call for the query plus a lookup — **not** a rebuild of
the 371-turn index, because `search` builds over `turns` and the arm may pass the same array it passed to
`answerSessions`. That is the cost model the pre-registration prices at ≤1.30×.

## 4. The cost that is easy to miss

`prime()` embeds the corpus. If the arm calls `answerSessions` and then `search` with the same `turns`,
the corpus is embedded **twice** — measured at 7,448 prompt tokens per question today, an embedding pass
over 371 turns is not free, and a duplication would be invisible in `promptTokensPerQuestion` because
embedding tokens are not prompt tokens. So the arm's receipt has to grow one field:

```ts
selfIndex: { indexes: number, embeddedTurns: number, ... }
```

A dispatch whose `embeddedTurns` is twice the control's is a dispatch whose bill was misread, and the
pre-registration's third bar cannot be evaluated without it.

## 5. Test plan, before the code

| #   | test                                                                                      | what it pins                                                                             |
| --- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | `search` over a corpus returns the same order `#relevanceFor` produces for the same query | one ranking, not two                                                                     |
| 2   | `search` with no `index` configured throws with a sentence naming `options.index`         | a product with no index has no ranking to offer, and silence would be a wrong empty list |
| 3   | `search` with an empty corpus returns `[]` rather than throwing                           | the flat route's behaviour                                                               |
| 4   | two calls with different corpora never mix                                                | the staleness hazard, asserted rather than argued                                        |
| 5   | the arm's `readerSearch=0` path is byte-identical to the registered prompt                | `digest` equality on 500 questions                                                       |
| 6   | `embeddedTurns` doubles when the corpus is embedded twice                                 | §4's receipt                                                                             |

Tests 1 and 5 are the two that decide whether the mechanism can be read at all: without 1 the second look
ranks differently from the first, and without 5 the control moved.

## 6. Sequence, and what each step is worth

| step                    | output                                                   | cost                       | blocking?                                                  |
| ----------------------- | -------------------------------------------------------- | -------------------------- | ---------------------------------------------------------- |
| 1. `search` + tests 1-4 | product capability, coverage ≥95% per dimension          | 0                          | yes                                                        |
| 2. arm wiring + test 5  | `readerSearch=0` reproduces 91.25% question for question | one 500×1 dispatch, ≈6 CNY | yes — a control that moved invalidates everything after it |
| 3. `readerSearch=1`     | the registered comparison                                | ≈24 CNY                    | no                                                         |
| 4. reading              | `--paired` + `--lists` on the discordant set             | 0                          | no                                                         |

Step 2 exists because this campaign has twice read a dispatch whose control had moved
(`RETRACTIONS` #22's +14 reference cells). A zero-cost reproduction is cheaper than a wrong delta.
