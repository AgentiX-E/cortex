/**
 * The rerank stage's own tally.
 *
 * ## Why the stage needs a census before it needs a result
 *
 * `cortex-core`'s `rerankHits` degrades to the input order on **every** scorer failure — a thrown
 * request, a short response, a non-finite score — because dropping candidates would turn a ranking
 * bug into a recall bug. That is the right behaviour for the ranking and the wrong behaviour for the
 * measurement: a reranker that never once reached its provider and a reranker that reached it and
 * agreed with the retriever on all five hundred questions produce the **same** artifact, the same
 * accuracy, and the same `0.00pp` delta.
 *
 * This project has already paid for that ambiguity three times: `reviewPass: 'bare'` shipped and was
 * credited with `+3.15` while the artifact could not say whether the pass had fired (§13.107),
 * `retrievalThreshold: 0.25` was read as a working gate while the cut was inert (§10.10), and the
 * mem0 reproduction printed `0.0%` for a run whose corpus had never entered the index
 * (`COMPETITOR-REPRODUCTION.md` §6.1). So the four counters here exist to make the fourth
 * occurrence impossible: **`fallbacks > 0` means the stage did not do what its arm claims**, and the
 * registered reading of the rerank increment treats that as an assembly failure rather than as
 * evidence that reranking does not help.
 *
 * ## Why a wrapper rather than counters on the scorer
 *
 * The scoring contract is `(pairs) => Promise<readonly number[]>`, and it is implemented by the
 * `/rerank` HTTP client, the local cross-encoder and the listwise LLM adapter alike. Widening it
 * would force every implementation — including ones that cannot fail this way — to carry accounting
 * they have no use for, and it would put the counters inside the layer whose behaviour is being
 * measured. Counting at the boundary keeps the adapter dumb and the instrument outside it, which is
 * the same decision `readRerankFallbacks` records for the reference pipeline's arm.
 *
 * ## The one duplicated predicate, and why it is tested rather than avoided
 *
 * `RerankScoreFn` has no failure channel, so the wrapper has to decide what counts as a failure
 * using the same three predicates `cortex-core`'s `scoreSafely` uses: the result must be an array,
 * of the expected length, of finite numbers. The wrapper therefore *repeats* that decision rather
 * than reading it. The alternative — deriving `fallbacks` from "the order did not change" — is
 * strictly worse, because a reranker that agrees with the retriever is a real and expected outcome;
 * counting it as a failure would make the stage unable to report success.
 *
 * The duplication is acceptable only because the two verdicts cannot disagree: both read the same
 * returned value with the same three predicates in the same order, and
 * `rerank-census.test.ts` drives every degradation shape through `rerankHits` and asserts that
 * `fallbacks` moved exactly when the order was left as retrieved. A future edit that weakened one
 * side would fail that test rather than silently redefining the counter.
 */
import type { RerankScoreFn } from '@agentix-e/cortex-core';

/**
 * What the stage did, as four numbers that cannot be inferred from the accuracy.
 *
 * All four are construction-time facts aggregated over the run rather than per-question records: a
 * per-question ledger is a different instrument (and §13's step 4 of the remaining plan), while this
 * one answers the single question that decides whether the arm's delta may be read at all.
 */
export type RerankCensus = {
  /** Scoring invocations. On this arm one call carries one question, so this is questions reranked. */
  readonly calls: number;
  /** `(question, passage)` pairs scored in total. This is the cost, not the question count. */
  readonly pairs: number;
  /**
   * Invocations whose result could not be trusted, so the retrieved order stood.
   *
   * Non-zero is the assembly-failure signal. It is deliberately **not** softened into a ratio: with
   * one call per question, `fallbacks = 3` means three questions were never actually reranked, and
   * an arm reporting `98.8% success` would be a much easier number to read past.
   */
  readonly fallbacks: number;
  /**
   * Questions whose ordering the reranker changed.
   *
   * The counting unit is the question, not the position: "the reranker reordered 412 of 500
   * questions" is a statement about how much of the run the stage touched, while a count of moved
   * positions would be dominated by questions with a hundred candidates and say very little. A
   * question whose order came back identical is indistinguishable from a fallback in this counter,
   * which is exactly why `fallbacks` is tracked separately.
   */
  readonly changed: number;
  /**
   * Passages shortened to the scorer's declared per-document limit before scoring.
   *
   * The fifth counter, and it is not decoration. A provider's wire limit is not a property of the
   * question being asked: Zhipu's `/rerank` accepts documents of at most 4096 characters, and this
   * corpus carries turns up to 15,369 (§13.67 measured median 272, p90 2,305). A turn longer than the
   * limit is **rejected for the whole call** — not just for that document — so a stage that did not
   * clip would fail entire questions on a technicality and report them as `fallbacks`, where the
   * registered reading calls that an assembly failure.
   *
   * Clipping keeps the four counters interpretable, and this one says how often the reranker judged a
   * prefix rather than a whole turn. Zero is the state a reader wants; a non-zero value is not an
   * error but it does bound how much of a long turn the ordering could have seen.
   */
  readonly clipped: number;
};

/** A scorer that reports on itself, plus the one observation only the caller can make. */
export type CountedRerank = {
  /** The scoring function to hand to `rerankHits`. Same contract, plus accounting. */
  readonly score: RerankScoreFn;
  /**
   * Record whether the reranking moved this question's order.
   *
   * Takes the sequence **before** and **after** rather than the before-sequence and a verdict,
   * because a caller cannot honestly compute "did it change" for a wrapper it cannot see inside. It
   * is a method rather than a returned value so the caller cannot forget to report it: `observeOrder`
   * sits on the only path between `rerankHits` and the score map.
   */
  readonly observeOrder: (before: readonly string[], after: readonly string[]) => void;
  /** The counters as they stand. A copy, so a caller holding one cannot watch it mutate. */
  readonly snapshot: () => RerankCensus;
};

/**
 * Wrap a scorer so the run can say whether the stage executed.
 *
 * The wrapper never swallows: a failure is counted **and rethrown**, so `rerankHits` performs the
 * degradation and the ordering policy stays in exactly one place. Returning a zeroed score vector
 * here instead would rank the pool on a constant, which is the "partially-zeroed vector" the
 * `/rerank` parser already refuses.
 */
export function countedRerank(
  score: RerankScoreFn,
  bounds: { readonly maxDocumentChars?: number } = {},
): CountedRerank {
  let calls = 0;
  let pairs = 0;
  let fallbacks = 0;
  let changed = 0;
  let clipped = 0;
  const limit = bounds.maxDocumentChars;

  const counted: RerankScoreFn = async (raw) => {
    calls += 1;
    pairs += raw.length;
    // Clipped here rather than at the call site, because this is the boundary that knows the
    // provider's wire limits. The passage keeps its identity (`candidateId`), so the order that comes
    // back still refers to what was retrieved -- only the text the scorer saw is shortened.
    const input =
      limit === undefined
        ? raw
        : raw.map((pair) => {
            if (pair.text.length <= limit) return pair;
            clipped += 1;
            return { ...pair, text: pair.text.slice(0, limit) };
          });

    let result: readonly number[];
    try {
      result = await score(input);
    } catch (error) {
      fallbacks += 1;
      throw error;
    }
    // The three predicates `scoreSafely` applies, in the same order, so the two verdicts cannot
    // disagree. Counting before the rethrow is what makes `fallbacks` independent of whether the
    // caller chose to continue.
    if (!Array.isArray(result) || result.length !== input.length) {
      fallbacks += 1;
      return result;
    }
    for (const value of result) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fallbacks += 1;
        return result;
      }
    }
    return result;
  };

  return {
    score: counted,
    observeOrder: (before, after) => {
      // Same length by construction (`rerankHits` never filters), and asserted rather than assumed
      // by the test that exercises a filtering scorer. Compared by position because the question is
      // whether the *order* moved, not whether the set did.
      const moved =
        before.length !== after.length || before.some((text, index) => text !== after[index]);
      if (moved) changed += 1;
    },
    snapshot: () => ({ calls, pairs, fallbacks, changed, clipped }),
  };
}
