/**
 * The retrieval gate's *reachable range*, as distinct from its value.
 *
 * ## Why this file exists
 *
 * §10.9 of `docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md` records a run whose
 * registered arming included `retrievalThreshold: 0.25`, and which was read as
 * evidence about that gate. It is not evidence about that gate. The gate never
 * closed once: `admission.ts` supplies `sourceTrust: 0.5` and sets
 * `lastAccessedAt === createdAt === now`, `createMemory` defaults `confidence`
 * to `1`, and the value function is
 *
 *     confidence × sourceTrust × (0.5 + 0.5 × recency)
 *     = 1 × 0.5 × (0.5 + 0.5 × 1) = 0.5
 *
 * so every candidate scores exactly `0.5`. `decideRetrieval` compares the
 * **value function's output** against the threshold — not the `confidence`
 * field, which `PREREGISTRATION` §7.4 stated and which is wrong — and therefore
 * every `retrievalThreshold ≤ 0.5` is *always open* while every threshold above
 * it is *always closed*. `0.25` is a no-op; the only reachable behaviour change
 * is at `> 0.5`.
 *
 * ## Why the existing tests did not catch it
 *
 * `abstention-decision.test.ts` does exercise `0.9` (closed) and `0.1` (open) —
 * but it varies the *threshold*, never the *ceiling that bounds the value*. With
 * `sourceTrust` left at its default the reachable range is `[0, 0.5]`, so a
 * threshold of `0.9` closing and `0.1` opening is consistent both with a working
 * gate and with a gate whose entire useful range is a single point. The pair of
 * tests passes under both hypotheses, which is why it could not distinguish
 * them, and why the no-op survived until a benchmark reported `95.80%`
 * abstention that the gate had not caused.
 *
 * The lesson generalises: **testing that a knob has an effect is not testing
 * that the knob is reachable.** A configuration value can be accepted, recorded
 * in the artifact, echoed in the log line, and still be inert, because the
 * quantity it thresholds has a range the caller's other settings collapsed to a
 * point.
 *
 * ## What is asserted
 *
 * 1. The value an admitted turn carries is the constant the arithmetic predicts.
 * 2. The reachable range is stated, and both of its members are exercised: the
 *    largest threshold that still opens, and the smallest that closes.
 * 3. Raising `sourceTrust` widens the range — so the collapse is attributable to
 *    the ceiling and not to `decideRetrieval`.
 * 4. The boundary is *exactly* `0.5`, so a future change to any of the three
 *    factors moves this test rather than silently redefining the no-op region.
 *
 * ## Why the candidate builder takes the ceiling explicitly
 *
 * `createMemory` defaults `sourceTrust` to `0.5`, so a candidate built without
 * naming it carries the low ceiling no matter what the caller intended. A first
 * draft of this file let that default stand and passed only the *values* array
 * into the probe, which made the array decorative: every "high ceiling" case was
 * silently probing a low ceiling again, so the widening test and the boundary
 * sweep both failed against the gate's real behaviour. The builder below takes
 * the ceiling as a parameter and stamps it on each candidate, so the probe's
 * candidates and the admitted turns it is modelling cannot disagree.
 */
import { describe, expect, it } from 'vitest';
import { decideRetrieval, createMemory } from '@agentix-e/cortex-core';
import type { MemoryValue } from '@agentix-e/cortex-core';
import { admitTurns, clockAwareValueFunction } from '../admission.js';

const NOW = 1_700_000_000_000;

/**
 * The smallest offset that reliably lands *past* a ceiling. `Number.EPSILON`
 * (`2.22e-16`) is too small to be a valid probe: it is comparable to the
 * rounding the value function's arithmetic introduces, so it cannot be relied on
 * to cross the comparison. `1e-9` sits well above double-precision resolution
 * and well below the spacing between sampled ceilings.
 */
const JUST_ABOVE = 1e-9;

/** The value the registered arming stamps on every admitted turn. */
function admittedValues(sourceTrust: number): number[] {
  return admitTurns(['alpha', 'beta'], { now: NOW, threshold: 0, sourceTrust }).map(
    (turn) => turn.value,
  );
}

/**
 * Probe the gate at `threshold` over candidates carrying `sourceTrust` as their
 * ceiling. The ceiling is stamped explicitly: relying on `createMemory`'s
 * default would pin every probe to `0.5` and make the argument inert.
 */
function retrieveAt(threshold: number, values: number[], sourceTrust: number): boolean {
  const valueFn = clockAwareValueFunction(NOW);
  const candidates: MemoryValue[] = values.map((_, ordinal) =>
    createMemory({
      content: `c${ordinal}`,
      createdAt: NOW,
      lastAccessedAt: NOW,
      sourceTrust,
    }),
  );
  return decideRetrieval(candidates, valueFn, threshold).retrieve;
}

describe('the retrieval gate reachable range', () => {
  it('stamps every admitted turn with the constant the ceiling arithmetic predicts', () => {
    // confidence defaults to 1, recency is exactly 1 because admission sets
    // `lastAccessedAt === createdAt === now`, so the only surviving factor is
    // sourceTrust and the value is `sourceTrust` itself.
    expect(admittedValues(0.5)).toEqual([0.5, 0.5]);
    expect(admittedValues(1)).toEqual([1, 1]);
  });

  it('opens on every threshold at or below the ceiling, and closes above it', () => {
    const values = admittedValues(0.5);
    // Both members of the reachable range, stated as the boundary pair rather
    // than as two arbitrary sample points.
    expect(retrieveAt(0, values, 0.5)).toBe(true);
    expect(retrieveAt(0.25, values, 0.5)).toBe(true); // the registered value: a no-op
    expect(retrieveAt(0.5, values, 0.5)).toBe(true); // the largest opening threshold
    expect(retrieveAt(0.5 + JUST_ABOVE, values, 0.5)).toBe(false); // just past it: closed
  });

  it('widens the range when the ceiling is raised, so the collapse is the ceiling', () => {
    // The same threshold closes under the low ceiling and opens under the high
    // one. That is what makes the collapse attributable to `sourceTrust` rather
    // than to a `decideRetrieval` that ignores thresholds above 0.5.
    const lowCeiling = admittedValues(0.5);
    const highCeiling = admittedValues(1);
    expect(retrieveAt(0.9, lowCeiling, 0.5)).toBe(false);
    expect(retrieveAt(0.9, highCeiling, 1)).toBe(true);
  });

  it('places the boundary exactly at the ceiling, not near it', () => {
    for (const sourceTrust of [0.1, 0.25, 0.5, 0.75, 1]) {
      const values = admittedValues(sourceTrust);
      expect(retrieveAt(sourceTrust, values, sourceTrust)).toBe(true);
      expect(retrieveAt(sourceTrust + JUST_ABOVE, values, sourceTrust)).toBe(false);
    }
  });
});
