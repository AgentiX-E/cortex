/**
 * Which fixture rows a review round is allowed to draw from.
 *
 * ## Why a review round cannot reuse its own cards
 *
 * A3 asks whether the *presentation* changes the reviewer's decision. A second pass over cards the
 * same person has already judged does not answer that: the reviewer remembers the card, so the
 * second judgement is a recall test ("this is the Lightroom one, the atoms were fine") rather than a
 * decision, and recall actively flatters consistency -- which is the thing the instrument is trying
 * to hold still. Re-clicking the same cards would produce a number that looks like a replication and
 * is partly a memory.
 *
 * So each round draws rows nobody has judged, **in fixture order**, and a ledger records what has
 * been used. The order is what makes this an expansion of the sample rather than a re-draw: a round
 * takes the next N unjudged rows, never a selection from them.
 *
 * ## Why the ledger is a file and not a flag
 *
 * The set of judged cards is a fact about the campaign, and a fact that only exists in a shell
 * history is a fact nobody can audit. `--offset 21` would express the same intent and go stale the
 * moment a round draws an uneven number of rows: the offset would have to be recomputed by hand, and
 * a wrong offset silently re-issues cards. An id list cannot be off by one.
 *
 * ## Why running out is an error rather than an empty draw
 *
 * A round that draws zero rows produces a page with no cards and a `prepare` that exits successfully,
 * which reads as "the corpus is exhausted" only to someone who checks the count. Throwing names the
 * condition at the point it happens.
 */
export type DrawableRow = { readonly id: string };

/** What a draw produced, and what it had to skip to get there. */
export type Draw = {
  readonly rows: readonly DrawableRow[];
  /** Rows skipped because the ledger already contains their id. */
  readonly skipped: number;
};

/**
 * Every unjudged row, in the order the corpus gives them.
 *
 * **All of them, not `limit` of them**, and that is not a detail: the round's limit counts *cards*,
 * while a row can fail to produce one -- three of the previous round's twenty-one rows were decided by
 * the rule layer or produced no atoms. Truncating the row list to the card limit would hand back a
 * round that is short by however many rows failed, which is how an earlier version of this measurement
 * asked for twenty and got eighteen pairs.
 *
 * Rows are drawn whole rather than filtered by label first, for the same reason: a row labelled
 * `defer` may still be decided by the rules, so a label filter under-fills.
 */
export function drawUnjudged(rows: readonly DrawableRow[], judged: readonly string[]): Draw {
  const used = new Set(judged);
  const skipped = rows.filter((row) => used.has(row.id)).length;
  const rows_ = rows.filter((row) => !used.has(row.id));
  if (rows_.length === 0) {
    throw new Error(
      `every row is already judged (${rows.length} rows, ${judged.length} in the ledger): ` +
        'a review round cannot reuse its own cards, and an empty draw is reported here rather than ' +
        'produced as a page with no cards',
    );
  }
  return { rows: rows_, skipped };
}
