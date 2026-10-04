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
    // The default is asserted here and its reachability is asserted below. The two
    // are different properties: this one says a caller who sets nothing gets the
    // documented default, and the ceiling suite says a caller who sets something
    // else is no longer ignored. Before the `sourceTrust` field existed, only the
    // first could be asserted -- which is exactly how a constant passed for a
    // default for as long as it did.
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

/**
 * The value ceiling, and why it is a defect rather than a default.
 *
 * ## What was found, and where
 *
 * Dispatch `37110579101` measured this arm at `6.45%` against the reference
 * pipeline's `84.70%`, unchanged from the pre-repair `6.40%`, and the config line
 * explained why: `retrievalThreshold=0` cannot close a gate whose maximum
 * observable value is `0.5` (`PREREGISTRATION-CORTEX-MEMORY-ARM.md` §7.5).
 *
 * The ceiling is `confidence(1) * sourceTrust(0.5) * (0.5 + 0.5 * recency(1))`.
 * `createMemory` defaults `sourceTrust` to `0.5`, but this module passed `0.5`
 * **explicitly**, so the composition layer had no way to admit a memory worth more
 * than half. Measured on real admitted turns: `value === 0.5` for every content,
 * and `threshold > 0.5` admits nothing.
 *
 * ## Why this is a remedy and not a re-tuning
 *
 * `MemoryValue.sourceTrust` is documented as "Source trust score in `[0, 1]`" --
 * the domain is the full interval. A composition layer that can only ever pass one
 * value has a narrower domain than the model it composes, and the shrinkage is
 * invisible: `decideWrite` accepts any `number`, so an unreachable threshold
 * produces no error, only always-false.
 *
 * Three consequences, each wrong independently of any benchmark:
 *
 * 1. the write gate's upper half is unreachable, so it is a two-state switch;
 * 2. `selectSessionBudget` ranks by the best admitted value and every value is
 *    identical, so its best-of ordering collapses to the tie-break;
 * 3. `contradiction/resolve.ts` fuses on `confidence * sourceTrust`, so a rumour
 *    and a first-hand observation are indistinguishable.
 *
 * Making the field settable fixes all three at once. The **default does not move**,
 * so no existing artifact's meaning changes -- which is what separates this from
 * tuning a parameter toward a preferred outcome.
 */
describe('the sourceTrust ceiling', () => {
  it('defaults to the value createMemory establishes, so nothing shifts', () => {
    // The load-bearing half of the fix. If the default moved, every measurement
    // taken before this change would have been taken under a different
    // configuration than the one it now describes.
    const admitted = admitTurns([turn('alpha')], options({ threshold: 0 }));

    expect(admitted[0]?.sourceTrust).toBe(0.5);
    expect(admitted[0]?.value).toBe(0.5);
  });

  it('lets a fully-trusted memory reach the top of the gate, which it could not before', () => {
    // The property the ceiling denies. With `sourceTrust: 1` and the clock pinned
    // so recency is exactly 1, the value is `1` -- and a threshold in `(0.5, 1]`
    // now discriminates instead of rejecting everything.
    const admitted = admitTurns([turn('alpha')], {
      now: NOW,
      threshold: 0.9,
      sourceTrust: 1,
    });

    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.value).toBe(1);
  });

  it('admits nothing above the raised ceiling either, so the gate still closes', () => {
    // The control for the test above. Without it, an implementation that ignored
    // the threshold entirely would satisfy "the high threshold admits" -- and a
    // gate that never closes is the failure `admission.test.ts` already guards on
    // the low side. `1` is `>= 1`, so the only unreachable value is one above it,
    // and `threshold` is validated to `[0, 1]` by the arm. The discriminator here
    // is therefore mid-range.
    const admitted = admitTurns([turn('alpha')], {
      now: NOW,
      threshold: 0.9,
      sourceTrust: 0.5,
    });

    expect(admitted).toEqual([]);
  });

  it('carries the supplied trust onto the admitted memory, not just into the value', () => {
    // Fixing only the value function would leave the model still stamped 0.5, and
    // the contradiction-resolution defect would persist: `resolve.ts` fuses on
    // `confidence * sourceTrust`, reading the field rather than the value.
    const admitted = admitTurns([turn('alpha')], { now: NOW, threshold: 0, sourceTrust: 0.9 });

    expect(admitted[0]?.sourceTrust).toBe(0.9);
    expect(admitted[0]?.value).toBeCloseTo(0.9, 10);
  });

  it('rejects a trust outside [0, 1], naming the value', () => {
    // Same three failure modes as the thresholds: above 1 makes the ceiling a lie
    // about the model, below 0 makes every value negative, and NaN makes every
    // comparison false. Each completes a run whose artifact describes the typo.
    for (const bad of [1.5, -0.1, Number.NaN]) {
      expect(() =>
        admitTurns([turn('alpha')], { now: NOW, threshold: 0, sourceTrust: bad }),
      ).toThrow(/sourceTrust must be a number in \[0, 1\]/);
    }
  });

  it('names NaN as NaN, not as null', () => {
    // The first version interpolated the value with `JSON.stringify`, and
    // `JSON.stringify(NaN)` is `null` -- so the message reported an argument the
    // caller never passed and could not search for. A diagnostic that names
    // something other than the input is the same defect as an artifact that
    // describes a typo instead of the system, and it is invisible unless asserted.
    expect(() =>
      admitTurns([turn('alpha')], { now: NOW, threshold: 0, sourceTrust: Number.NaN }),
    ).toThrow(/got NaN\./);

    // The finite cases must keep rendering as themselves, so the fix did not trade
    // one wrong rendering for another.
    expect(() => admitTurns([turn('alpha')], { now: NOW, threshold: 0, sourceTrust: 1.5 })).toThrow(
      /got 1\.5\./,
    );
  });

  it('accepts the endpoints, because both are in the documented domain', () => {
    // `0` means "trust nothing" and `1` means "trust fully"; both are meaningful
    // configurations and a guard that rejected either would narrow the domain it
    // exists to widen.
    const none = admitTurns([turn('alpha')], { now: NOW, threshold: 0, sourceTrust: 0 });
    expect(none[0]?.value).toBe(0);

    const full = admitTurns([turn('alpha')], { now: NOW, threshold: 1, sourceTrust: 1 });
    expect(full).toHaveLength(1);
  });
});
