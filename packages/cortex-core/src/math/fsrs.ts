/**
 * FSRS-style forgetting-curve model (Free Spaced Repetition Scheduler).
 * Retrievability R = exp(-Δt / S); stability S grows on successful recall and
 * shrinks on failure, guided by difficulty D. This powers Cortex's selective
 * forgetting and retrieval-as-consolidation dynamics.
 */

/** Retrievability at elapsed time Δt (ms) given stability S (ms). */
export function retrievability(deltaMs: number, stabilityMs: number): number {
  if (stabilityMs <= 0) {
    return 0;
  }
  return Math.exp(-deltaMs / stabilityMs);
}

export type ReviewOutcome = 'success' | 'failure';

export type FsrsState = {
  stability: number;
  difficulty: number;
};

const INITIAL_DIFFICULTY = 5;
const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 10;
const MIN_STABILITY = 1;

/**
 * Update stability and difficulty after a review.
 * - success: S *= 1 + factor; D decreases (item becomes easier).
 * - failure: S *= failFactor; D increases (item becomes harder).
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
    nextStability = Math.max(MIN_STABILITY, state.stability * boost);
    nextDifficulty = Math.max(MIN_DIFFICULTY, difficulty - 1);
  } else {
    nextStability = Math.max(MIN_STABILITY, state.stability * 0.5);
    nextDifficulty = Math.min(MAX_DIFFICULTY, difficulty + 1);
  }
  return { stability: nextStability, difficulty: nextDifficulty };
}

export function initialFsrsState(): FsrsState {
  return { stability: MIN_STABILITY, difficulty: INITIAL_DIFFICULTY };
}
