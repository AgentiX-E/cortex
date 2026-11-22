/**
 * The adapter from any search index to the loop's three tools.
 *
 * ## Why an adapter and not a fourth retrieval implementation
 *
 * §14.97.8 measured what happens when a mechanism is transplanted without the selection that
 * feeds it: the reference pipeline's aggregation contract, moved onto this repository's
 * relevance-ranked window, cost 3.75 questions. The lesson generalises -- a mechanism is its
 * selection -- so the loop must call the *same* index the registered arm calls, and this file is
 * the whole of the seam. It adds no scoring, no fusion and no threshold.
 *
 * `SearchableIndex` is structural on purpose: `cortex-memory`'s `SearchIndex` is the common case,
 * and a caller with a stable corpus or a hosted vector store should not need this package to name
 * it. The only requirement is that `search` answers with ids that index `turns`.
 *
 * ## Why `read` is the corpus array rather than the index
 *
 * The index carries turn ids and postings, not text: `search` returns positions, and the string a
 * position names lives wherever the caller got it from. Passing the array here rather than
 * re-deriving it is what keeps one copy of the corpus in memory and makes "the turn the index
 * ranked" and "the turn the reader reads" the same object.
 */
import type { Retrieval, SearchHit } from './types.js';

/**
 * Build the three tools over an index and the corpus it was built from.
 *
 * `turns` must be the array the index was built over, in the same order -- the ids `search`
 * returns are positions in it. A mismatch is a caller error that cannot be detected here (both
 * arrays are strings) and would show up as answers quoting the wrong turn, so it is stated once
 * here rather than guarded by a check that would pass anyway.
 *
 * Both shapes are inline rather than named: the index is anything with one `search` method, and the
 * options are one field. A named type for either would be an export whose only mention is its own
 * declaration, which the export census refuses.
 */
export function indexRetrieval(
  index: { search(query: string, k: number): Promise<readonly SearchHit[]> },
  turns: readonly string[],
  options: {
    /**
     * Turn id to session id, aligned with `turns`.
     *
     * Absent means every turn is its own conversation, which is the honest default: a caller who
     * has not told the loop where the boundaries are has not told it, and inventing them from
     * adjacency would make `session(turn)` return an arbitrary window that no dataset agrees with.
     */
    readonly sessionOf?: readonly number[];
  } = {},
): Retrieval {
  const sessionOf = options.sessionOf;
  if (sessionOf !== undefined && sessionOf.length !== turns.length) {
    throw new Error(
      `indexRetrieval options.sessionOf has ${String(sessionOf.length)} entries for ${String(turns.length)} ` +
        'turns. The map is indexed by turn id, so a short map would silently report the last turns as ' +
        'belonging to no conversation and `session(turn)` would return an empty list for evidence the ' +
        'reader can see.',
    );
  }
  return {
    turns: turns.length,
    async search(query: string, k: number): Promise<readonly { turn: number; score: number }[]> {
      return index.search(query, k);
    },
    read(turn: number): string | undefined {
      // `turns[turn]` on a sparse index is `undefined` and so is a negative one, which is the
      // answer the caller needs: an id outside the corpus has no text.
      return Number.isInteger(turn) && turn >= 0 && turn < turns.length ? turns[turn] : undefined;
    },
    session(turn: number): readonly number[] {
      if (!Number.isInteger(turn) || turn < 0 || turn >= turns.length) return [];
      if (sessionOf === undefined) return [turn];
      const key = sessionOf[turn];
      if (key === undefined) return [turn];
      const ids: number[] = [];
      for (let id = 0; id < sessionOf.length; id += 1) {
        if (sessionOf[id] === key) ids.push(id);
      }
      return ids;
    },
  };
}
