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
 * ("What grows is the reachable set"). But *reachable* and *discriminating* are
 * different claims, and only the first was tested -- until §49 measured the
 * second and found it false:
 *
 * - **Reachable**: some threshold now closes the gate. Pinned by
 *   `retrieval-reachable-range.test.ts`.
 * - **Discriminating**: the gate can separate a strong candidate from a weak one,
 *   i.e. the value function produces *different* values for turns of different
 *   quality rather than a single constant scaled by `sourceTrust`.
 *
 * §49 found that raising the ceiling moves the point without turning it into a
 * distribution. At `sourceTrust: 1` every admitted turn scored exactly `1`, so the
 * reachable range was `[0, 1]` -- a *set* rather than a point -- while every cut
 * inside it was still all-or-nothing. That file deliberately pinned the *absence*
 * of variation so a future change could not introduce it unnoticed.
 *
 * ## This file is that future change, and it was rewritten rather than relaxed
 *
 * §49.1 wrote down the constraint the next registration had to satisfy:
 *
 * > the next registration **cannot** be "same wiring, different threshold" — it
 * > has to supply variation first. `confidence` is the only factor with room.
 *
 * A supplied `confidenceFor` is that variation. It is not a free parameter: the
 * callback is a *function of the turn*, evaluated once per turn at admission, and
 * the default is still "no callback ⇒ `confidence` 1", so every measurement taken
 * before this field existed retains its meaning.
 *
 * The constant-ness assertions that §49 added are **gone**, and that is the design
 * working rather than a test being weakened: they asserted that the admission
 * layer supplies no per-turn variation, which is precisely the fact this round
 * changed. Leaving them in place would have made this file a claim about code that
 * no longer exists. What replaces them asserts the property that was missing:
 *
 * 1. With a supplied `confidenceFor`, admitted values **differ** per turn.
 * 2. An interior threshold now **separates**: a strong candidate opens the gate
 *    where a weak one leaves it closed.
 * 3. The gate still closes above the strongest admitted value, so "it
 *    discriminates" did not become "it never closes".
 * 4. Without the callback the old constant behaviour is **unmoved** -- the default
 *    is the previous configuration, which is what keeps historical runs comparable.
 *
 * ## Why the variation is injected rather than derived here
 *
 * The signal that would populate `confidenceFor` in production is a quality
 * estimate of the turn (lexical overlap with the question, retrieval rank, an
 * embedding score). None of those live in this package: `cortex-memory` depends on
 * `cortex-core` only and owns no embedding model, and reading one here would make
 * the composition layer depend on a retrieval mechanism it is supposed to compose
 * above. So this layer owns the *mechanism* -- per-turn confidence reaches the
 * value function -- and the *measurement* of turn quality is injected by whoever
 * has one. That is the same injection boundary the `LLM` and `ValueFunction`
 * fields already use, and the same one `PREREGISTRATION` §4 relies on.
 */
import { describe, expect, it } from 'vitest';
import { decideRetrieval, createMemory } from '@agentix-e/cortex-core';
import type { MemoryValue } from '@agentix-e/cortex-core';

import { admitTurns, clockAwareValueFunction, type AdmissionOptions } from '../admission.js';

const NOW = 1_700_000_000_000;

/** The value stamped on each admitted turn at a given ceiling. */
function admittedValues(
  sourceTrust: number,
  turns: string[] = ['alpha', 'beta'],
  overrides: Partial<AdmissionOptions> = {},
): number[] {
  return admitTurns(turns, { now: NOW, threshold: 0, sourceTrust, ...overrides }).map(
    (turn) => turn.value,
  );
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

/**
 * A stand-in for a real turn-quality signal: longer turns are treated as stronger
 * evidence. Deliberately trivial and monotone, because what is under test is the
 * plumbing -- that a per-turn number reaches the value function and moves the
 * decision -- not the quality model, which is the caller's business.
 */
function confidenceByLength(turn: string): number {
  return Math.min(1, turn.length / 60);
}

describe('the retrieval gate discriminates once per-turn confidence varies', () => {
  it('gives admitted turns different values, which is what a threshold needs', () => {
    // The property §49 measured as absent. Two turns of different length now yield
    // two different values at one arming, so the set of distinct values has more
    // than one member -- the precondition for any interior cut to mean anything.
    const values = admittedValues(1, ['alpha', 'a much longer turn with more substance in it'], {
      confidenceFor: confidenceByLength,
    });

    expect(new Set(values).size).toBe(2);
    expect(values[0]).toBeLessThan(values[1]!);
  });

  it('separates a strong candidate from a weak one at an interior threshold', () => {
    // The capability the constant admission did not have: one cut, two outcomes,
    // decided by the evidence rather than by the arming. This is the claim §49.1
    // said the next registration had to be able to make.
    const valueFn = clockAwareValueFunction(NOW);
    const admitted = admitTurns(
      ['alpha', 'a turn long enough to be the strongest candidate here'],
      {
        now: NOW,
        threshold: 0,
        sourceTrust: 1,
        confidenceFor: confidenceByLength,
      },
    );
    const [, strong] = admitted;

    expect(admitted).toHaveLength(2);
    expect(strong).toBeDefined();

    const cut = valueFn(strong!) - 1e-9;
    // At the cut, the strong candidate alone opens the gate...
    expect(decideRetrieval([strong!], valueFn, cut).retrieve).toBe(true);
    // ...and the weak one alone leaves it closed. Same threshold, different
    // verdict, which is the entire content of "discriminating".
    expect(decideRetrieval([admitted[0]!], valueFn, cut).retrieve).toBe(false);
  });

  it('still closes above the strongest admitted value, so it discriminates rather than never closes', () => {
    // The control. A gate that always opens would satisfy the test above for the
    // strongest candidate and fail only if something checked the top of the range.
    // Without this, "it discriminates" and "it is stuck open" are the same
    // observation, which is the failure mode `admission.test.ts` guards on the
    // write side.
    //
    // The strongest turn is long enough for `confidenceByLength` to saturate at
    // exactly `1` (it is a `min(1, len / 60)`, so anything past 60 characters
    // pins there), and that saturation is asserted rather than assumed: the first
    // version of this test used a 58-character turn, computed `0.883`, and the
    // `toBeCloseTo(1)` below failed. The fix was to make the turn long enough, not
    // to relax the constant -- a control that only checks "above the observed
    // value" would pass while the ceiling silently sat below `sourceTrust`.
    const strongest = `${'evidence '.repeat(8)}and it is unambiguous`;
    expect(confidenceByLength(strongest)).toBe(1);

    const admitted = admitTurns(['alpha', strongest], {
      now: NOW,
      threshold: 0,
      sourceTrust: 1,
      confidenceFor: confidenceByLength,
    });
    const [weak, strong] = admitted;
    expect(weak).toBeDefined();
    expect(strong).toBeDefined();

    const valueFn = clockAwareValueFunction(NOW);
    const aboveEverything = valueFn(strong!) + 1e-9;

    expect(valueFn(strong!)).toBeCloseTo(1, 10);
    expect(decideRetrieval([strong!, weak!], valueFn, aboveEverything).retrieve).toBe(false);
    // And the strongest candidate is admitted at its own value, because the
    // comparison is `>=`. Stated so the boundary is pinned and not merely implied.
    expect(decideRetrieval([strong!], valueFn, valueFn(strong!)).retrieve).toBe(true);
  });

  it('leaves the constant behaviour untouched when no callback is supplied', () => {
    // The half that must NOT move. `confidence` staying at `createMemory`'s `1`
    // default means a caller who sets nothing gets exactly the pre-existing
    // configuration, so every run measured before `confidenceFor` existed keeps
    // its meaning and remains comparable. `sourceTrust`'s docstring makes the same
    // promise for the same reason ("What grows is the reachable set, not the
    // shipped configuration"), and both are asserted rather than assumed.
    for (const sourceTrust of [0.25, 0.5, 0.75, 1]) {
      const values = admittedValues(sourceTrust);
      expect(values).toEqual([sourceTrust, sourceTrust]);
      expect(new Set(values).size).toBe(1);
    }

    // And it is a constant *at the ceiling*, which is what makes the reachable
    // range in `retrieval-reachable-range.test.ts` still exactly `[0, S]`.
    expect(retrieveAt(0.9999, 2, 1)).toBe(true);
    expect(retrieveAt(1, 2, 1)).toBe(true);
    expect(retrieveAt(1 + 1e-9, 2, 1)).toBe(false);
  });

  it('reads the callback once per turn, on the turn it is deciding', () => {
    // The callback is a function of the turn and must see each turn exactly once
    // and in order. A version that read it once and reused the result -- or that
    // passed the ordinal instead of the content -- would satisfy the separation
    // test above (which only needs two distinct numbers) while silently making
    // every turn's confidence a property of its position rather than its evidence.
    const seen: string[] = [];
    admitTurns(['alpha', 'beta', 'gamma'], {
      now: NOW,
      threshold: 0,
      confidenceFor: (turn) => {
        seen.push(turn);
        return confidenceByLength(turn);
      },
    });

    expect(seen).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('valued a turn at zero confidence as unadmittable, since the gate is a product', () => {
    // The boundary the new field makes expressible: `confidenceFor` returning `0`
    // makes the value `0`, and `decideWrite` uses `>=`, so `threshold: 0` still
    // admits it while any positive threshold rejects it. Worth pinning because a
    // "no confidence" turn and an "unadmitted" turn are different states, and only
    // the threshold can tell them apart.
    const admitted = admitTurns(
      ['nothing to say', 'a turn long enough to be strong evidence here'],
      {
        now: NOW,
        threshold: 0,
        sourceTrust: 1,
        confidenceFor: (turn) => (turn.startsWith('nothing') ? 0 : confidenceByLength(turn)),
      },
    );

    expect(admitted).toHaveLength(2);
    expect(admitted[0]?.value).toBe(0);
    expect(admitted[0]?.confidence).toBe(0);

    const rejected = admitTurns(['nothing to say'], {
      now: NOW,
      threshold: 1e-9,
      sourceTrust: 1,
      confidenceFor: () => 0,
    });
    expect(rejected).toEqual([]);
  });

  it('stamps the confidence it computed onto the memory, not only into the value', () => {
    // `resolveContradiction` fuses on `confidence * sourceTrust`, reading the
    // FIELD rather than the value function's output. A version that varied the
    // value without stamping the field would make the retrieval gate
    // discriminating and leave contradiction resolution exactly as blind as
    // before -- the same split `admitsTurns`' `sourceTrust` test guards against.
    const admitted = admitTurns(['alpha', 'a turn long enough to be strong evidence here'], {
      now: NOW,
      threshold: 0,
      sourceTrust: 1,
      confidenceFor: confidenceByLength,
    });

    expect(admitted[0]?.confidence).toBeCloseTo(confidenceByLength('alpha'), 10);
    expect(admitted[1]?.confidence).toBeCloseTo(
      confidenceByLength('a turn long enough to be strong evidence here'),
      10,
    );
    // And the field is what the value function read, so the two cannot disagree.
    expect(admitted[1]?.value).toBeCloseTo(admitted[1]!.confidence * 1, 10);
  });

  it('rejects a callback that returns a value outside [0, 1], naming the turn', () => {
    // Same three failure modes the thresholds and `sourceTrust` reject, and one
    // more specific to this field: the callback is caller-supplied code, so it can
    // return a percentage, a rank, or `NaN`. `NaN` is the dangerous one -- every
    // `>=` against it is false, so the gate admits nothing, and `confidence` is
    // then stamped as `NaN` on a memory that reaches contradiction resolution.
    for (const bad of [1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        admitTurns(['alpha'], {
          now: NOW,
          threshold: 0,
          confidenceFor: () => bad,
        }),
      ).toThrow(/confidenceFor must return a number in \[0, 1\]/);
    }

    // The message names the offending turn, because a callback is evaluated per
    // turn and "somewhere in this context" is not a location.
    expect(() =>
      admitTurns(['offending turn'], {
        now: NOW,
        threshold: 0,
        confidenceFor: () => 2,
      }),
    ).toThrow(/offending turn/);
  });
});
