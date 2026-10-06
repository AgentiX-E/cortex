/**
 * Is the retrieval gate *useful* at any reachable arming, or only *reachable*?
 *
 * ## Why this file exists
 *
 * `docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md` §10.10 established that at
 * `sourceTrust: 0.5` the retrieval gate is inert: the value function returns the
 * constant `0.5` for every admitted turn, so every `retrievalThreshold ≤ 0.5`
 * is permanently open and the cut cannot discriminate. §48.11.7 named the fix:
 * raise the ceiling so the range stops being a point.
 *
 * `GateOptions.sourceTrust` exists for exactly that and its docstring says so
 * ("What grows is the reachable set"). But *reachable* and *useful* are
 * different claims, and only the first has been tested:
 *
 * - **Reachable**: some threshold now closes the gate. Already pinned by
 *   `retrieval-reachable-range.test.ts`.
 * - **Useful**: the gate can separate a strong candidate from a weak one, i.e.
 *   the value function produces *different* values for turns of different
 *   quality rather than a single constant scaled by `sourceTrust`.
 *
 * Those come apart in a way that matters. At `sourceTrust: 1` every admitted
 * turn scores exactly `1`, so the reachable range is `[0, 1]` — a *set* rather
 * than a point — but every cut inside it is still all-or-nothing: `0.99` admits
 * everything and `1.01` (conceptually) admits nothing. Widening `sourceTrust`
 * moves the point; it does not turn the point into a distribution.
 *
 * The reason is structural, and it is the finding this file pins. The three
 * factors of the value function are `confidence`, `sourceTrust`, and `recency`,
 * and `admission.ts` fixes all three for every turn it constructs:
 *
 * - `confidence` — not passed, so `createMemory` defaults it to `1`;
 * - `sourceTrust` — one value for the whole admission, by construction;
 * - `recency` — `lastAccessedAt === createdAt === now`, so `exp(0) = 1`.
 *
 * So the admission layer has **no per-turn variation to threshold**. A gate whose
 * input is constant cannot discriminate no matter where its cut is placed. The
 * next registration therefore cannot be "same arming, different threshold" — it
 * has to supply variation first. This file states that as an executable fact so a
 * future change that introduces per-turn `confidence` moves these tests rather
 * than silently invalidating the reasoning behind them.
 *
 * ## What is asserted
 *
 * 1. Raising `sourceTrust` does move the reachable boundary — the fix works as
 *    far as it goes.
 * 2. Every turn at one arming still carries the *same* value as every other:
 *    `sourceTrust` widens the range without introducing a distribution.
 * 3. Consequently the gate is still all-or-nothing at a raised ceiling: no
 *    interior threshold separates "some turn is good enough" from "none is".
 * 4. Per-turn `confidence` is what would supply separation, so the moment it
 *    varies the constant-ness asserted in (2) is expected to break — the test
 *    that would catch it is recorded here as the one to change.
 */
import { describe, expect, it } from 'vitest';
import { decideRetrieval, createMemory } from '@agentix-e/cortex-core';
import type { MemoryValue } from '@agentix-e/cortex-core';

import { admitTurns, clockAwareValueFunction } from '../admission.js';

const NOW = 1_700_000_000_000;

/** The value stamped on each admitted turn at a given ceiling. */
function admittedValues(sourceTrust: number, turns: string[] = ['alpha', 'beta']): number[] {
  return admitTurns(turns, { now: NOW, threshold: 0, sourceTrust }).map((turn) => turn.value);
}

/** Probe the gate at `threshold` over candidates carrying `sourceTrust`. */
function retrieveAt(threshold: number, count: number, sourceTrust: number): boolean {
  const valueFn = clockAwareValueFunction(NOW);
  const candidates: MemoryValue[] = Array.from({ length: count }, (_, ordinal) =>
    createMemory({
      content: `c${ordinal}`,
      createdAt: NOW,
      lastAccessedAt: NOW,
      sourceTrust,
    }),
  );
  return decideRetrieval(candidates, valueFn, threshold).retrieve;
}

describe('the retrieval gate is reachable at a raised ceiling but not yet discriminating', () => {
  it('moves the reachable boundary when the ceiling is raised', () => {
    // The fix §48.11.7 names, stated as behaviour. This is the property that was
    // missing at the default ceiling: with `sourceTrust: 0.5` a cut at `0.9`
    // closed and with `sourceTrust: 1` the same cut opens.
    expect(retrieveAt(0.9, 2, 0.5)).toBe(false);
    expect(retrieveAt(0.9, 2, 1)).toBe(true);
  });

  it('gives every admitted turn the same value, at every ceiling', () => {
    // The structural finding. `sourceTrust` scales the constant; it does not
    // split it. Asserted across several ceilings so the test fails if any future
    // change introduces variation at one of them but not another.
    for (const sourceTrust of [0.25, 0.5, 0.75, 1]) {
      const values = admittedValues(sourceTrust);
      expect(values).toEqual([sourceTrust, sourceTrust]);
      // The set of distinct values has one member, which is the whole point.
      expect(new Set(values).size).toBe(1);
    }
  });

  it('is all-or-nothing at a raised ceiling: no interior threshold discriminates', () => {
    // The consequence that blocks a "same arming, new threshold" registration.
    // With every candidate at exactly `1`, a cut at `0.9999` admits everything
    // and a cut at `1.0001` admits nothing -- there is no cut in between that
    // "lets the good ones through", because there are no bad ones to exclude.
    // A gate that cannot exclude anything cannot improve a ranking.
    expect(retrieveAt(0.9999, 2, 1)).toBe(true);
    expect(retrieveAt(1, 2, 1)).toBe(true);
    expect(retrieveAt(1 + 1e-9, 2, 1)).toBe(false);

    // And the same at the default ceiling, which is why §10.9's arm was inert.
    expect(retrieveAt(0.4999, 2, 0.5)).toBe(true);
    expect(retrieveAt(0.5, 2, 0.5)).toBe(true);
    expect(retrieveAt(0.5 + 1e-9, 2, 0.5)).toBe(false);
  });

  it('would discriminate only if per-turn confidence varied, since that is the unbound factor', () => {
    // `recency` is pinned to 1 by the admission clock and `sourceTrust` is one
    // value for the whole admission, so `confidence` is the only factor with
    // room to carry per-turn quality. This test constructs the variation by hand
    // to show (a) that it is what would make the gate discriminating and (b) that
    // the fix does not require touching `decideRetrieval` or the value function.
    //
    // It is deliberately a *construction*, not a change to `admitTurns`: the
    // admission layer supplies no per-turn confidence today, and this file exists
    // to pin that rather than to paper over it.
    const valueFn = clockAwareValueFunction(NOW);
    const strong = createMemory({
      content: 'strong',
      createdAt: NOW,
      lastAccessedAt: NOW,
      sourceTrust: 1,
      confidence: 1,
    });
    const weak = createMemory({
      content: 'weak',
      createdAt: NOW,
      lastAccessedAt: NOW,
      sourceTrust: 1,
      confidence: 0.4,
    });

    // A cut between the two separates them -- which is the capability the
    // constant admission does not have.
    expect(decideRetrieval([strong, weak], valueFn, 0.7).retrieve).toBe(true);
    expect(decideRetrieval([weak], valueFn, 0.7).retrieve).toBe(false);

    // And the values really do differ, at one arming.
    expect(valueFn(strong)).toBeCloseTo(1, 10);
    expect(valueFn(weak)).toBeCloseTo(0.4, 10);
  });
});
