/**
 * Reciprocal rank fusion, and filling a token budget instead of taking a top-K.
 *
 * ## Why ranks and not scores
 *
 * The channels this fuses do not share a scale: a cosine similarity lives in `[-1, 1]`, a BM25 score
 * is unbounded, and a graph distance is a hop count. Adding them requires a normaliser, and every
 * normaliser is a free parameter that has to be tuned per corpus. RRF throws the magnitudes away and
 * keeps only the order, which is the one thing all four channels agree on. `k = 60` is the value from
 * the original fusion literature and from the one published memory architecture that reports the
 * four-way read path (arXiv 2512.12818); it is not tuned here, because a constant tuned on the
 * benchmark it is evaluated on is not a constant.
 *
 * ## Why a budget rather than a top-K
 *
 * A top-K counts items, so the context it produces has a size that depends on how long the items
 * happen to be. Two facts cost 30 tokens and two cost 300; the prompt that results differs by an order
 * of magnitude and the failure it produces is a truncation in one case and a distraction in the other.
 * A budget counts tokens, so the context is the same size for every question, and the number of
 * facts that fit becomes the thing that varies — which is the honest way round.
 *
 * `fillBudget` **skips and continues** rather than stopping at the first item that does not fit. The
 * alternative leaves the budget partly spent while an item that would have fit sits behind it, and the
 * ordering that produced that state came from ranks, not from sizes.
 */

/** One item with the rank it holds in its own channel. Rank is 1-based, as the formula is stated. */
export type RankedItem<T> = {
  readonly item: T;
  readonly rank: number;
};

/**
 * Fuse ranked lists by `Σ 1 / (k + rank)`.
 *
 * Ties are broken by first appearance across the lists in argument order, so the result is a function
 * of the inputs alone. An item appearing in several lists is emitted once, at its best fused score —
 * emitting it once per channel would let a fact be retrieved twice and consume the budget twice.
 */
export function reciprocalRankFusion<T>(
  lists: readonly (readonly T[])[],
  keyOf: (item: T) => string,
  k = 60,
): T[] {
  return fuseWithScores(lists, keyOf, k).map((entry) => entry.item);
}

/** The same fusion, with the score kept. Used by a report; never by a gate. */
export function fuseWithScores<T>(
  lists: readonly (readonly T[])[],
  keyOf: (item: T) => string,
  k = 60,
): { item: T; score: number }[] {
  const first = new Map<string, T>();
  const scores = new Map<string, number>();
  const order: string[] = [];

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank += 1) {
      const item = list[rank]!;
      const key = keyOf(item);
      if (!first.has(key)) {
        first.set(key, item);
        order.push(key);
      }
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank + 1));
    }
  }

  // `order` makes the tie-break explicit rather than dependent on Map insertion order, which is the
  // same thing today and would stop being the same thing if the accumulation above were ever moved.
  const position = new Map(order.map((key, index) => [key, index]));
  return [...scores.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return position.get(left[0])! - position.get(right[0])!;
    })
    .map(([key, score]) => ({ item: first.get(key)!, score }));
}

export type BudgetFill<T> = {
  readonly kept: readonly T[];
  /** The sum of the costs of `kept`, never above the budget. */
  readonly spent: number;
  /** Items that did not fit, in rank order. Reported so a silently-full context is visible. */
  readonly skipped: readonly T[];
};

/**
 * Take items best-first until the budget is spent, skipping the ones that do not fit.
 *
 * An item that costs more than the whole budget is skipped like any other, which means a single
 * oversized fact can leave the context short. That is deliberate: the alternative is to raise the
 * budget silently, and a context that occasionally doubles is worse than one that is occasionally
 * thin, because only the second is visible in the report.
 */
export function fillBudget<T>(
  ranked: readonly T[],
  costOf: (item: T) => number,
  budget: number,
): BudgetFill<T> {
  const kept: T[] = [];
  const skipped: T[] = [];
  let spent = 0;
  for (const item of ranked) {
    const cost = costOf(item);
    if (spent + cost > budget) {
      skipped.push(item);
      continue;
    }
    kept.push(item);
    spent += cost;
  }
  return { kept, spent, skipped };
}
