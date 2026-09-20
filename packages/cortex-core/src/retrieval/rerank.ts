/**
 * Cross-encoder reranking (roadmap measure B1).
 *
 * Retrieval in Cortex is bi-encoder: the question and each turn are embedded
 * independently and compared by cosine, and the recall channels are fused by
 * reciprocal rank. A bi-encoder cannot express interaction between the question
 * and the passage, because neither is visible to the other at encode time. A
 * cross-encoder scores the (question, passage) pair jointly and is the standard
 * last stage of a retrieval pipeline for exactly that reason.
 *
 * This module is the pure half of that stage: it owns ordering, tie-breaking,
 * deduplication, the protected head, and every degradation path. The model call
 * is injected as `RerankScoreFn`, so this file performs no I/O and stays valid
 * for both Node and browser hosts.
 *
 * Two properties are load-bearing and are tested directly:
 *
 *  1. **No candidate is ever lost.** Reranking reorders; it must not filter.
 *     Every failure mode (thrown scorer, short response, non-finite score)
 *     returns the input order rather than a truncated list, because dropping a
 *     candidate silently converts a ranking bug into a recall bug.
 *
 *  2. **The head is a fixed prefix.** The eval pipeline reads its abstention
 *     confidence from the top of the hit list (`maxHitScore`, and `hits[0]` on
 *     the single-channel path). History shows what happens otherwise: when RRF
 *     was wired in it re-ordered hits while `hits[0].score` was still read as
 *     confidence, and IE fell from 95.0% to 87.5%. Keeping a caller-chosen head
 *     frozen in place lets a reranker be added without moving that signal, so an
 *     A/B isolates the reranker instead of conflating it with a threshold shift.
 */

/**
 * The minimum shape a candidate must have to be reranked.
 *
 * Deliberately only `id`, `text` and `score`: this stage reorders and never
 * inspects a positional field, and callers carry different ones (`RetrievalHit`
 * has `index`, `SessionHit` has `sessionIndex`). Requiring a position here would
 * force one of them to fake the other's field, so the structural type absorbs
 * whichever the caller has and returns it untouched.
 */
export type RerankCandidate = {
  id: string;
  text: string;
  score: number;
};

/** One (question, candidate) pair handed to the scoring model. */
export type RerankPair = {
  question: string;
  candidateId: string;
  text: string;
};

/**
 * Score `(question, candidate)` pairs jointly. Higher means more relevant.
 * Scores need only be on a consistent scale within one call; the absolute values
 * are never compared against the retrieval scores, because the two live on
 * incompatible scales by construction.
 */
export type RerankScoreFn = (pairs: readonly RerankPair[]) => Promise<readonly number[]>;

export type FuseRerankOptions = {
  /**
   * How many leading candidates of `head` stay pinned in place. These are
   * excluded from re-scoring entirely, so they can never be demoted. Defaults to
   * the full head.
   */
  headSize?: number;
};

/**
 * Score every candidate and return them best-first.
 *
 * Ordering is by descending score, with the input order as the tie-break, so
 * equal scores preserve the recall ranking and the result is deterministic.
 *
 * On any scorer failure the input order is returned unchanged. The single
 * exception is an empty input, where the scorer is not called at all.
 */
export async function rerankHits<T extends RerankCandidate>(
  candidates: readonly T[],
  question: string,
  score: RerankScoreFn,
): Promise<T[]> {
  if (candidates.length === 0) {
    return [];
  }

  const scores = await scoreSafely(candidates, question, score);
  if (scores === null) {
    return [...candidates];
  }

  return candidates
    .map((candidate, position) => ({ candidate, position, score: scores[position]! }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.position - b.position;
    })
    .map((entry) => entry.candidate);
}

/**
 * Rerank `pool` and append it behind a frozen prefix of `head`.
 *
 * The result is `head[0 .. headSize)` in its original order, followed by the
 * reranked remainder of both lists. A candidate appearing in both `head` and
 * `pool` is emitted once, at its position in `head`.
 *
 * This is the shape the context builder wants: the recall ranking owns the top
 * slots (and therefore the abstention signal), while the reranker decides the
 * ordering of everything underneath it.
 */
export async function fuseRerank<T extends RerankCandidate>(
  head: readonly T[],
  pool: readonly T[],
  question: string,
  score: RerankScoreFn,
  options: FuseRerankOptions = {},
): Promise<T[]> {
  const headSize = options.headSize ?? head.length;
  const pinned = head.slice(0, Math.max(0, headSize));
  const tail = head.slice(Math.max(0, headSize));

  const pinnedIds = new Set(pinned.map((item) => item.id));
  const rerankable: T[] = [];
  for (const item of [...tail, ...pool]) {
    if (!pinnedIds.has(item.id)) {
      rerankable.push(item);
    }
  }

  // Deduplicate within the rerankable set too: the same id can arrive from both
  // the head's tail and the pool, and emitting it twice would double its weight
  // in the context window.
  const seen = new Set<string>();
  const unique = rerankable.filter((item) => {
    if (seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
    return true;
  });

  if (unique.length === 0) {
    return [...pinned];
  }

  return [...pinned, ...(await rerankHits(unique, question, score))];
}

/**
 * Call the scorer and normalise its result, or return null when the response
 * cannot be trusted. A response of the wrong length is treated as a failure
 * rather than padded, because a short response means the model did not score
 * what we asked it to and silently truncating would drop candidates.
 */
async function scoreSafely<T extends RerankCandidate>(
  candidates: readonly T[],
  question: string,
  score: RerankScoreFn,
): Promise<number[] | null> {
  const pairs: RerankPair[] = candidates.map((candidate) => ({
    question,
    candidateId: candidate.id,
    text: candidate.text,
  }));

  let raw: readonly number[];
  try {
    const result = await score(pairs);
    if (!Array.isArray(result)) {
      return null;
    }
    raw = result;
  } catch {
    return null;
  }

  if (raw.length !== candidates.length) {
    return null;
  }

  const scores: number[] = [];
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }
    scores.push(value);
  }
  return scores;
}
