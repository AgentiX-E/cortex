/**
 * The precision at which a relevance ordering is allowed to resolve.
 *
 * ## The reading this exists for
 *
 * `R1` (run `44507560716`) dispatched 121 `MR` questions with one field changed — the reader's model —
 * and the registration made prompt identity a criterion rather than a courtesy: *a reader swap that
 * moved a prompt is not a reader swap*. **119 of 121 prompts were byte-identical and 2 were not.**
 *
 * The two that moved were not polluted by the reader. Their offered evidence was identical to the
 * character (`evidenceChars` 59,836 and 62,465 on both sides), their pool size was identical (255 and
 * 221 turns), and their delivered window held the same number of turns (212 and 185). The symmetric
 * difference was **exactly one turn each way**, and the delivered length differed by **68 and 40
 * characters** — the length difference between the two turns that swapped. One turn sat on the budget
 * boundary, and which of two adjacent candidates occupied the last slot flipped between dispatches.
 *
 * ## Why that happens, and why the comparator was not enough
 *
 * `selectByRelevance` already breaks ties by arrival, so an exact tie cannot flip. The flip needs the
 * two scores to be *unequal* and to swap — which means they differ by less than the noise of the
 * provider that produced them. A cosine similarity over 1,024 dimensions travels through a JSON float
 * and a float32 accumulation before it arrives here; the same turn scored by the same service on two
 * days is not the same number to the last digit, and two turns whose true scores are a millionth apart
 * are then ordered by arithmetic noise rather than by the signal.
 *
 * ## The quantum, and what it costs
 *
 * `1e-4` is four orders of magnitude above the accumulation error of a 1,024-term dot product
 * (`sqrt(1024) * 2^-52 ~ 7e-15` in float64, `~2e-6` in the worst case for float32) and two orders below
 * the resolution at which a cosine similarity separates two turns about which the signal has anything to
 * say. Rounding to that grid turns "9.99999e-1 against 1.000001e+0" into a tie, and a tie has a defined
 * answer here — arrival order — that does not depend on the provider.
 *
 * It is a *quotient*, not a tolerance: a comparator that treated `|a - b| < eps` as equal would not be
 * transitive (a≈b, b≈c, a≫c), and an intransitive comparator leaves the result to the engine's sort.
 * Rounding to a grid partitions the scores into equivalence classes, and partition membership is
 * transitive by construction.
 *
 * ## What it does not claim
 *
 * A provider whose noise exceeds `1e-4` still flips a boundary, and no client-side rule can prevent
 * that — the information is gone before it arrives. What this buys is that the *measured* flip is
 * removed at a stated precision, and that the next paired dispatch re-reads the same identity number
 * with the same instrument. `R1`'s `2 of 121` is therefore the before; the next pair is the after.
 */

/**
 * Scores per unit. `10_000` rather than `1e4` so the multiplication is by an integer and the product
 * of a score in `[0, 1]` is exact for every value a float can represent at that scale.
 *
 * Not exported, and the census is why: nothing outside this module names the grid — the three comparators
 * call the function, and a test that wanted the constant is excluded from the caller count by design. An
 * `export` here would advertise a consumer that does not exist, which is the claim `tools/export-census.mjs`
 * refuses. The resolution is still pinned, from the function: `orderableRelevance(1) - orderableRelevance(0)`.
 */
const RELEVANCE_ORDER_QUANTUM = 10_000;

/**
 * A relevance score reduced to the grid an ordering may see.
 *
 * Monotone — `a <= b` implies `orderableRelevance(a) <= orderableRelevance(b)` — so an ordering by this
 * value is never *worse* than an ordering by the raw score; it only refuses to resolve differences the
 * score does not carry.
 *
 * The one value that needed a line of its own is the negative zero: a score of `-0` rounds to `-0`, and
 * `-0` is equal to `0` under `===` but not under `Object.is`. Three comparators in this package and any
 * number of visitors to an artifact will disagree about which of those they mean, so the function returns
 * one of them.
 */
export function orderableRelevance(score: number): number {
  const quantised = Math.round(score * RELEVANCE_ORDER_QUANTUM);
  return quantised === 0 ? 0 : quantised;
}
