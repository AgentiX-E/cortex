/**
 * Admission is where the cognitive layer earns its name.
 *
 * The reference pipeline admits a turn because a retrieval score cleared a
 * lexical or embedding threshold. `admitTurns` admits a turn because
 * `cortex-core`'s own value function says the turn is worth retaining — it is
 * the first production caller `decideWrite` has ever had.
 *
 * These are unit tests over a pure function: no I/O, no clock, no randomness
 * beyond the injected `now`.
 */
import { describe, expect, it } from 'vitest';
import { createMemory } from '@agentix-e/cortex-core';
import { admitTurns, type AdmittedTurn, type AdmissionOptions } from '../admission.js';

const NOW = 1_700_000_000_000;

/** A turn string that is long enough to look like evidence, not a greeting. */
function turn(label: string): string {
  return `the user said something about ${label} and it was recorded in full`;
}

function options(overrides: Partial<AdmissionOptions> = {}): AdmissionOptions {
  return {
    now: NOW,
    threshold: 0.3,
    ...overrides,
  };
}

describe('admitTurns', () => {
  it('admits every turn when the threshold is permissive', () => {
    const turns = [turn('alpha'), turn('beta'), turn('gamma')];
    const admitted = admitTurns(turns, options({ threshold: 0 }));

    expect(admitted).toHaveLength(3);
    expect(admitted.map((a) => a.content)).toEqual(turns);
  });

  it('admits nothing when the threshold is unreachable', () => {
    // The value function is bounded by confidence * sourceTrust * (0.5 + 0.5r),
    // so 1.0 is unreachable and every turn must be rejected. Asserting the
    // empty case matters: a gate that admits everything and a gate that admits
    // nothing both look "wired" from the outside.
    const admitted = admitTurns([turn('alpha'), turn('beta')], options({ threshold: 1 }));

    expect(admitted).toEqual([]);
  });

  it('preserves turn order, because the prompt is order-sensitive', () => {
    const turns = [turn('first'), turn('second'), turn('third')];
    const admitted = admitTurns(turns, options({ threshold: 0 }));

    expect(admitted.map((a) => a.content)).toEqual(turns);
  });

  it('records the decision value alongside the admitted turn', () => {
    const admitted = admitTurns([turn('alpha')], options({ threshold: 0 }));

    expect(admitted).toHaveLength(1);
    const [first] = admitted;
    expect(first).toBeDefined();
    // The value is what made the decision, so it must survive into the result:
    // a caller that cannot see it cannot audit why a turn was kept.
    expect(typeof (first as AdmittedTurn).value).toBe('number');
    expect((first as AdmittedTurn).value).toBeGreaterThan(0);
    expect((first as AdmittedTurn).value).toBeLessThanOrEqual(1);
  });

  it('carries the ordinal of each turn as it appeared in the source list', () => {
    // The ordinal is what lets a later stage reconstruct adjacency, and
    // adjacency is what a session boundary is made of. Losing it here would
    // force sessionize to re-derive position from content, which is wrong for
    // repeated turns.
    const admitted = admitTurns(
      [turn('alpha'), turn('beta'), turn('gamma')],
      options({ threshold: 0 }),
    );

    expect(admitted.map((a) => a.ordinal)).toEqual([0, 1, 2]);
  });

  it('keeps the source and trust defaults that createMemory establishes', () => {
    const admitted = admitTurns([turn('alpha')], options({ threshold: 0 }));

    expect(admitted[0]?.source).toBe('unknown');
    expect(admitted[0]?.sourceTrust).toBe(0.5);
  });

  it('admits a turn valued exactly at the threshold', () => {
    // `decideWrite` uses `>=`, so the threshold is inclusive. Asserting the
    // exact-equality case is not pedantry: a defect injection that tightened
    // the bound by 1e-9 passed every other test in this file, because all of
    // them sat clearly on one side of the line. The equality case is the only
    // one that distinguishes `>=` from `>`.
    const admitted = admitTurns(['t'], { now: NOW, threshold: 0.5, valueFunction: () => 0.5 });

    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.value).toBe(0.5);
  });

  it('rejects a turn valued just below the threshold', () => {
    const admitted = admitTurns(['t'], {
      now: NOW,
      threshold: 0.5,
      valueFunction: () => 0.5 - 1e-12,
    });

    expect(admitted).toEqual([]);
  });

  it('admits a turn valued just above the threshold', () => {
    const admitted = admitTurns(['t'], {
      now: NOW,
      threshold: 0.5,
      valueFunction: () => 0.5 + 1e-12,
    });

    expect(admitted).toHaveLength(1);
  });

  it('accepts a custom value function and honours it', () => {
    // The default value function decays with age. A caller that supplies its
    // own must actually replace it, not be silently ignored.
    const admitted = admitTurns(
      [turn('alpha')],
      options({
        threshold: 0.9,
        valueFunction: () => 0.95,
      }),
    );

    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.value).toBeCloseTo(0.95, 10);
  });

  it('passes the turn as the memory content, never a truncated form', () => {
    // Truncation belongs to prompt assembly, where the budget is known. Doing
    // it at admission would make the value decision depend on a budget that
    // admission does not have.
    const long = `prefix ${'x'.repeat(5_000)} suffix`;
    const admitted = admitTurns([long], options({ threshold: 0 }));

    expect(admitted[0]?.content).toBe(long);
  });

  it('does not mutate the input array', () => {
    const turns = [turn('alpha'), turn('beta')];
    const copy = [...turns];
    admitTurns(turns, options({ threshold: 0 }));

    expect(turns).toEqual(copy);
  });
});

describe('admitTurns memory construction', () => {
  it('builds memories through createMemory so FSRS defaults stay in one place', () => {
    // The consolidation-clock defect came from two literals that had to agree.
    // The composition layer must not restate a default that createMemory owns.
    const admitted = admitTurns([turn('alpha')], options({ threshold: 0 }));
    const reference = createMemory({ content: turn('alpha') });

    expect(admitted[0]?.stability).toBe(reference.stability);
    expect(admitted[0]?.difficulty).toBe(reference.difficulty);
  });

  it('stamps createdAt from the injected clock, not from the wall clock', () => {
    // Every timing assertion downstream (consolidation, decay, temporal
    // reasoning) is meaningless if this one leaks the real clock.
    const admitted = admitTurns([turn('alpha')], options({ now: 42, threshold: 0 }));

    expect(admitted[0]?.createdAt).toBe(42);
    expect(admitted[0]?.lastAccessedAt).toBe(42);
  });
});
