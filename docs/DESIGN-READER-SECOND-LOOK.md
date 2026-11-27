# Design — giving the reader a second look

Status: **shipped** (2026-11-27). `PREREGISTRATION-MULTI-STEP.md` registers the measurement; this file
records how the product got the capability, and §7 records where the built mechanism differs from the
design below — which it does in two places, one of them a cost the design over-estimated.

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

## 7. What shipped, and the two places it differs from the design above

### 7.1 The call site is the product's, not the arm's

§3's five-step sketch puts the second look in the arm: `answerSessions`, then `search`, then `answer`.
That cannot be built, and the reason is the one §3's own step 2 half-admits ("over the block it just
received"): the block is decided **inside** `answerSessions` — `selectSessionBudget` spends the session
budget on a ranking `#relevanceFor` built per question — and the arm receives an `Answer`, not the
selection. An arm-side implementation would therefore have to reconstruct the first pass, which is the
second ranking §1 rejects option **A** for.

So the mechanism is `#secondLook`, a private method on `CortexMemory` called from `answerSessions`
between the first pass and the prompt. The public `search(query, context, {k})` §2 sketched was built
first and is still what it is: a user-facing question and the loop's tool — but it was not the missing
piece, and `PREREGISTRATION-MULTI-STEP.md` §3.1 records the four rounds in which the queue's first row
was a price, a bar and a control run with no way to dispatch it.

### 7.2 The corpus is not embedded twice

§4 predicts a duplicated embedding pass and asks for an `embeddedTurns` receipt to catch it. The shipped
mechanism does not pay it: `#secondLook` calls `#relevanceFor(query, turns, …)`, which builds its
`SearchIndex` with the instance's own `#embedStore`, so the turns are memo hits and the only new text
embedded is the query.

The receipt is finer than `embeddedTurns` anyway, because a count that doubles under a bug is weaker
than a counter that can only read what happened:

| counter | what it says |
| --- | --- |
| `attempted` | questions that reached the stage (switch on **and** a signal existed) |
| `queries` | decision calls whose reply became a query |
| `refused` | replies answered `NONE`, an apology, or an echo of the question |
| `unranked` | questions that reached the stage with no signal to search by |
| `promoted` | sessions whose entry into the room the second query is the only reason for |

`attempted: 121, queries: 118, promoted: 0` is a stage that fired 118 times and moved nothing — a
finding, and a different one from `queries: 0`. Two guards enforce the pair:
`assertReaderSearchReachesRanking` refuses the stage beside `relevanceSignal=none` (no first pass ⇒
§10.10's inert configuration), and `assertReaderSearchReached` refuses an artifact whose queries no index
answered (a second look builds **two** indexes per question, so one query per retrieval is the control).

### 7.3 The unit `promoted` is measured in

A **session**, not a turn. The room on this route is spent by `selectSessionBudget`, so the only way the
second look can change what the reader sees is by promoting a session across the budget line. A turn
count would move on every question and would report the mechanism as reaching everything.

### 7.4 The union is a maximum, and the reason is §1's rejected option

A turn's score is its best score under either query, and the room is then spent by the selector that was
already there. Concatenating the two rankings would need a second comparator — a second ranking, the
class of defect §14.97.8 priced at −3.75 questions. The maximum is also monotone, which is what makes
`promoted` readable: the second look can only promote, never demote.

### 7.5 What the tests assert, and the one that had to be debugged

`reader-search.test.ts` pins the parser's six verdicts, the digest's cut and tie-break, the promotion,
the "fired and promoted nothing" state, the byte-identical control, the unranked state and the route
reach. Its first draft passed for the wrong reason: the fixture's plant session did not contain the word
"plant", so both sessions scored `0.2` on the question and the promotion it asserted came from the
second query winning a tie rather than from the mechanism. The fixture now says "plant", and the
sentence is here because a green test on a fixture that cannot express the claim is this campaign's most
expensive recurring defect.

## 8. The instrument: a sixth one-flag pairing, and a receipt that could not pass

§7 recorded the mechanism. This section records what measuring it required, because two of the three
defects it found were in the *instrument*, and both would have survived a successful dispatch.

### 8.1 The control was a different run

`PREREGISTRATION-MULTI-STEP.md` §3's control column read "the registered arm (`91.25%`, run
`43140878641`)". Three readings of one arm say why that cannot carry a three-question bar:

| run | repetitions | `MR` | share |
| --- | ---: | ---: | ---: |
| `43140878641` | 1 | 102 | 84.30% |
| `45760081761` (published) | 2 | 105 | 86.78% |
| `45923435343`, control side | 1 | 108 | 89.26% |

Six questions of spread across one configuration, against a bar of three. A bar smaller than the spread
of its own control cannot fail, and that means it cannot pass either: the reading would have been
whatever the reader expected, priced at ¥5.87.

So the control is a **side**. `CORTEX_MEMORY_AB=reader` is the sixth one-flag pairing: both sides are
`CortexMemory`, the control passes no `readerSearch` key, the feature passes the registered
configuration, and the two share the corpus, the reader, the judge and the clock. One dispatch, and the
delta belongs to the second look rather than to the cognitive layer's whole difference from the
reference pipeline.

That also corrected a sentence: the arm's comment on the option said "this is not one of the axes
`CORTEX_MEMORY_AB` flips, so there is no second side to disagree with", and it was true only because
there was no way to ask the question. The option is now read from the treatment, like every other key a
pairing can split.

### 8.2 The receipt could not pass

The receipt shipped in §7 read `selfIndex.queries > selfIndex.indexes`. That is the **query-expansion**
ratio: one index, *k* queries, so the query count runs ahead. The second look issues one query against
one more index, so the two counts rise together and the inequality is false on every correct run — the
check would have thrown at the end of the dispatch it exists to police, after the money was spent.

A check that can only fire on a correct run is §208.10's shape with the sign flipped, and it is worse
than no check: it looks like a receipt.

The replacement is a floor, `indexes >= attempted + queries` — one index per question the stage reached,
one more per query it wrote. It is a lower bound rather than an equality because the product may build
indexes this stage knows nothing about, and an equality would turn the next such mechanism into a false
failure. `--second-look` applies the same floor to a finished artifact, prints the counters per
repetition (they accumulate on one instance reused across repetitions, so the total is
`per-repetition × runs`) and refuses an artifact whose counters do not close.

The bill is readable this way because `censusSourcesOf` answers the **feature** instances: an archived
reference-pair run reads `indexes: 500` over 500 questions, one index each, not a thousand. That is the
fact that makes `attempted` a lower bound rather than a count of one side of a pair, and it is why the
receipt takes no pairing argument.

### 8.3 The bar pair could not both hold

At 121 paired questions the two-sided exact McNemar reaches `p < 0.05` only from a net `+6` (with no
regressions), `+7` with one, `+8` with two. Bar 1 asks for `+3`. So bar 1 is necessary and never
sufficient, and the operative threshold is `+6` — a 5% `MR` effect, against the `+1.75` the *blind* form
of this idea measured. The registration states this rather than editing the bar, because a bar written
before a dispatch is worth more than a tidier one written after.

The most likely verdict of the screen is therefore "the axis closes at its price", and that is the
honest reading of a ¥5.87 instrument rather than a reason to spend ¥25 on the 500×4 run.
