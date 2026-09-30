/**
 * FSRS-style forgetting-curve model (Free Spaced Repetition Scheduler).
 * Retrievability R = exp(-Δt / S); stability S grows on successful recall and
 * shrinks on failure, guided by difficulty D. This powers Cortex's selective
 * forgetting and retrieval-as-consolidation dynamics.
 *
 * Units: S is in **days**, Δt is in **milliseconds**. See `retrievability` for why
 * the time argument is not in the same unit as the state.
 */

// Stability is measured in DAYS, and elapsed time is converted to days before the
// curve is evaluated. Both unit choices are load-bearing.
//
// The first version of this module documented both arguments as milliseconds and
// set `MIN_STABILITY = 1`. Measured: `retrievability(1000, 1)` is `exp(-1000)`, i.e.
// zero, one second after creation. Since `consolidate` defaults its forgetting
// threshold to `0.01` and deletes everything below it, **every memory older than
// five milliseconds was deleted on the first consolidation**, including memories
// that had never been accessed. Nothing caught it: the only caller of `consolidate`
// is a composition layer that does not exist yet, and the tests that drove the
// forgetting mechanism all passed an explicit threshold while avoiding the default.
//
// The unit is the bug, not the constant. FSRS stability is a duration of the same
// order as the review interval, which for a memory store is days; expressing it in
// milliseconds turns "one day of durability" into `86_400_000` and makes the tuning
// ranges meaningless. Days keep stability and its initial value comparable, so the
// default is readable at a glance.
const MS_PER_DAY = 86_400_000;

/**
 * Retrievability at elapsed time Δt (`deltaMs`, milliseconds) given stability S
 * (`stabilityDays`, days): `exp(-Δt / S)` with Δt converted to days.
 *
 * The time argument stays in milliseconds on purpose. Every timestamp in the
 * domain is epoch milliseconds, so a millisecond argument cannot be passed by
 * mistake; a days argument can, and would silently scale the curve by 86.4
 * million.
 */
export function retrievability(deltaMs: number, stabilityDays: number): number {
  if (stabilityDays <= 0) {
    return 0;
  }
  return Math.exp(-deltaMs / (stabilityDays * MS_PER_DAY));
}

export type ReviewOutcome = 'success' | 'failure';

export type FsrsState = {
  /** Stability S in days: the interval at which retrievability decays to 1/e. */
  stability: number;
  /** Difficulty D in [1, 10]; higher means faster decay growth. */
  difficulty: number;
};

const INITIAL_DIFFICULTY = 5;
const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 10;

/** One day: a new memory is durable for a day, not for a millisecond. */
export const MIN_STABILITY = 1;

/**
 * Stability multiplier credited to a successful review that costs no elapsed time,
 * i.e. `+25%`. A floor, not a curve: see `review`.
 */
export const MAX_REVIEW_BOOST = 0.25;

/**
 * Update stability and difficulty after a review.
 * - success: S *= 1 + factor; D decreases (item becomes easier).
 * - failure: S *= failFactor; D increases (item becomes harder).
 *
 * ## Where the boost comes from
 *
 * The success multiplier is `1 + β`, where β is the spacing effect: `0` when the
 * memory was reviewed while still fully retrievable and up to `MAX_REVIEW_BOOST`
 * when it was reviewed on the verge of being forgotten. That β scales with *spacing*
 * rather than simply with low retrievability is a named simplification, not FSRS:
 * real FSRS derives the target interval from difficulty and the review rating.
 * Cortex has no review rating to draw on, so the curve here is FSRS-shaped, not
 * FSRS-faithful, and the difference is recorded rather than implied.
 *
 * ## Why the zero-spacing case is special-cased
 *
 * With β proportional to `1 - R` alone, a review at `Δt = 0` gives `R = 1`, so
 * `β = 0` and the state is returned unchanged: a memory could be accessed any
 * number of times in a row, at no elapsed cost, and its durability would never
 * move. Consolidation would then have no effect for recent accesses, which is the
 * common case. The floor exists only in that degenerate case (its condition
 * implies `R = 1`), so no memory that has actually decayed is affected, and a
 * plain `review` followed by `retrievability` stays reversible by construction —
 * a property the tests rely on to attribute a change to one step at a time.
 *
 * `retrievabilityNow` is the retrievability *reported by the caller*, not a
 * probability this function computes. It is passed in because the caller knows
 * which clock the access happened on.
 */
export function review(
  state: FsrsState,
  outcome: ReviewOutcome,
  retrievabilityNow: number,
): FsrsState {
  const difficulty = state.difficulty;
  let nextDifficulty: number;
  let nextStability: number;
  if (outcome === 'success') {
    // Larger stability boost when the item was about to be forgotten.
    const boost = 1 + (1 - retrievabilityNow) * 2;
    const immediate = state.stability * boost <= state.stability;
    nextStability = immediate
      ? state.stability * (1 + MAX_REVIEW_BOOST)
      : Math.max(MIN_STABILITY, state.stability * boost);
    nextDifficulty = Math.max(MIN_DIFFICULTY, difficulty - 1);
  } else {
    nextStability = Math.max(MIN_STABILITY, state.stability * 0.5);
    nextDifficulty = Math.min(MAX_DIFFICULTY, difficulty + 1);
  }
  return { stability: nextStability, difficulty: nextDifficulty };
}

/**
 * The state of a memory that has never been reviewed.
 *
 * `stability: MIN_STABILITY` is one day, expressed in the unit the rest of the
 * module uses. The previous value of the constant was also `1`, but in
 * milliseconds, which is the defect described at the top of this file.
 */
export function initialFsrsState(): FsrsState {
  return { stability: MIN_STABILITY, difficulty: INITIAL_DIFFICULTY };
}
