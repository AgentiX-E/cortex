/**
 * Admission: the first production caller `decideWrite` has ever had.
 *
 * The reference pipeline admits a turn because a retrieval score cleared a
 * lexical or embedding threshold. This admits a turn because `cortex-core`'s
 * own value function says the turn is worth retaining. The distinction is the
 * whole reason the package exists — see `docs/AUDIT-CODE-VS-DOCS.md` §6.1.
 *
 * Everything here is pure. `now` is a parameter, not a call to `Date.now()`.
 */
import {
  createMemory,
  decideWrite,
  type MemoryValue,
  type ValueFunction,
} from '@agentix-e/cortex-core';
import type { GateOptions } from './types.js';

/** A turn that cleared the write gate, with the decision's own evidence attached. */
export type AdmittedTurn = MemoryValue & {
  /**
   * Zero-based position of this turn in the list it was admitted from.
   *
   * Carried because adjacency is what a session boundary is made of, and
   * position cannot be re-derived from content once duplicates exist.
   */
  ordinal: number;
};

/** The subset of {@link GateOptions} admission reads. */
export type AdmissionOptions = {
  /** Epoch milliseconds, injected so value is a function of a pinned clock. */
  now: number;
  /** Admitted when the value is at or above this. */
  threshold: number;
  /** Replaces {@link clockAwareValueFunction} when supplied. */
  valueFunction?: ValueFunction;
};

/**
 * `cortex-core`'s `defaultValueFunction` reads the wall clock from inside — it
 * computes recency as `Math.exp(-(Date.now() - lastAccessedAt) / 30 days)` and
 * takes no clock parameter. That is correct for a library that cannot know its
 * caller's clock, and wrong for a composition layer that was handed one: a
 * caller pinning `now` would still get real-time decay, so admission would be
 * unreproducible and a replayed benchmark would admit a different set of turns
 * on every run.
 *
 * This restates the same formula against the injected clock. It is a deliberate
 * duplicate of four arithmetic operations, and the tests pin the two together
 * so they cannot drift apart silently.
 */
export function clockAwareValueFunction(now: number): ValueFunction {
  const THIRTY_DAYS_MS = 1000 * 60 * 60 * 24 * 30;
  return (memory: MemoryValue): number => {
    const recencyWeight = Math.exp(-(now - memory.lastAccessedAt) / THIRTY_DAYS_MS);
    return memory.confidence * memory.sourceTrust * (0.5 + 0.5 * recencyWeight);
  };
}

/**
 * Filter `turns` to those the write gate values at or above the threshold.
 *
 * Order is preserved and the input is not mutated. Content is passed through
 * untruncated: prompt budget is a property of prompt assembly, where the budget
 * is actually known, and truncating here would make the value decision depend
 * on a budget admission does not have.
 */
export function admitTurns(turns: readonly string[], options: AdmissionOptions): AdmittedTurn[] {
  const valueFn = options.valueFunction ?? clockAwareValueFunction(options.now);
  const admitted: AdmittedTurn[] = [];

  for (let ordinal = 0; ordinal < turns.length; ordinal += 1) {
    const content = turns[ordinal];
    if (content === undefined) continue;

    // Built through `createMemory` so FSRS defaults stay owned in one place.
    // The consolidation-clock defect was two literals that had to agree; the
    // composition layer must not become a third.
    const memory = createMemory({
      content,
      createdAt: options.now,
      lastAccessedAt: options.now,
      source: 'unknown',
      sourceTrust: 0.5,
      type: 'episodic',
    });

    const decision = decideWrite(memory, valueFn, options.threshold);
    if (decision.write) {
      admitted.push({ ...memory, value: decision.value, ordinal });
    }
  }

  return admitted;
}

/** The gate configuration admission needs, narrowed from {@link GateOptions}. */
export function admissionOptionsFrom(now: number, gate: GateOptions): AdmissionOptions {
  return gate.valueFunction === undefined
    ? { now, threshold: gate.threshold }
    : { now, threshold: gate.threshold, valueFunction: gate.valueFunction };
}
