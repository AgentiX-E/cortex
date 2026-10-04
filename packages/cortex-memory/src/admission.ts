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
  /**
   * Source trust stamped on each constructed memory. In `[0, 1]`; defaults to
   * `0.5`. See {@link GateOptions.sourceTrust} for why this is a field.
   */
  sourceTrust?: number;
};

/**
 * The trust stamped on a memory when the caller supplies none.
 *
 * Not exported through the barrel. It earns its name inside this file -- the ceiling
 * theorem is `confidence * DEFAULT_SOURCE_TRUST * (0.5 + 0.5 * recency)`, so a
 * reader can evaluate it without leaving the module -- but making it public API
 * would publish a number that no caller needs and that `createMemory` already
 * owns. The census gate is what caught that: the constant was exported with no
 * consumer, which is the shape of a symbol that will drift from its one real use.
 */
const DEFAULT_SOURCE_TRUST = 0.5;

/**
 * Validate a `[0, 1]` trust score, naming the offending value.
 *
 * The same guard the arm applies to its thresholds, for the same reason: all three
 * failure modes complete a full run whose result describes the typo rather than the
 * system. `> 1` makes the ceiling a lie about the model, `< 0` makes every value
 * negative so the gate admits nothing, and `NaN` makes every `>=` false so the gate
 * admits nothing -- and neither of the last two produces an error anywhere.
 *
 * Thrown rather than clamped. A clamp would silently reinterpret `1.5` as `1`, and
 * a caller who typed a percentage instead of a fraction would get a plausible
 * configuration and an uninterpretable result -- the shape the threshold guards
 * already reject.
 *
 * The message renders the value with `String` rather than `JSON.stringify`, and the
 * difference is not cosmetic: `JSON.stringify(NaN)` is `` null ``, so the offending
 * argument would be reported as `` null `` -- a value the caller did not pass and
 * cannot search for. A diagnostic that names something other than the input is the
 * same defect as an artifact that describes a typo instead of a system.
 */
function validateSourceTrust(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `sourceTrust must be a number in [0, 1], got ${String(value)}. ` +
        'It scales the value function confidence * sourceTrust * (0.5 + 0.5 * recency), ' +
        'so a value above 1 makes the ceiling exceed the model, and a value below 0 or ' +
        'NaN admits nothing -- each completing a run whose result describes the argument.',
    );
  }
  return value;
}

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
  const sourceTrust = validateSourceTrust(options.sourceTrust ?? DEFAULT_SOURCE_TRUST);
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
      sourceTrust,
      type: 'episodic',
    });

    const decision = decideWrite(memory, valueFn, options.threshold);
    if (decision.write) {
      admitted.push({ ...memory, value: decision.value, ordinal });
    }
  }

  return admitted;
}

/**
 * The gate configuration admission needs, narrowed from {@link GateOptions}.
 *
 * The optional fields are copied only when present, so an unset `valueFunction`
 * stays absent rather than becoming `undefined`. The distinction is small and it is
 * kept for the reason the original single-field version kept it: `admissionOptionsFrom`
 * is the one place a caller's gate becomes admission's options, and a reader
 * comparing the two objects should see the same shape.
 *
 * Written as statements rather than a chain of conditional spreads. The spread form
 * is shorter and produced two more branch sites than there are decisions, which the
 * coverage gate reported as an uncovered line -- the code was harder to read and
 * the measurement said so.
 */
export function admissionOptionsFrom(now: number, gate: GateOptions): AdmissionOptions {
  const options: AdmissionOptions = { now, threshold: gate.threshold };
  if (gate.valueFunction !== undefined) options.valueFunction = gate.valueFunction;
  if (gate.sourceTrust !== undefined) options.sourceTrust = gate.sourceTrust;
  return options;
}
