import { describe, it, expect } from 'vitest';
import { sharedRequestGate } from '../pacing.js';

/**
 * The gate is reached through `sharedRequestGate`, not constructed directly.
 *
 * That is the surface a caller has: the class is module-private because nothing outside this file
 * builds one by hand -- the registry is what keeps one schedule per process -- so a test that
 * imported it would be asserting a door no consumer walks through. Every interval below is unique
 * to its test for the same reason the registry exists: it is keyed by the interval and lives for
 * the life of the process, so two tests sharing one would consume each other's slots.
 */

/**
 * The gate, tested off the clock.
 *
 * `reserve` takes "now" as an argument precisely so these assertions do not need timers: the
 * property under test is the arithmetic of the reservation, and measuring it through `setTimeout`
 * would make the test's duration a second variable in an assertion about ordering.
 */
describe('RequestGate spaces requests by at least one interval', () => {
  it('lets the first reservation through with no wait', () => {
    // Without this the gate would impose a full interval on a process that has just started, which
    // is a delay no provider asked for.
    const gate = sharedRequestGate(1_001)!;
    expect(gate.reserve(10_000)).toBe(0);
  });

  it('makes the second reservation wait exactly one interval', () => {
    const gate = sharedRequestGate(1_002)!;
    gate.reserve(10_000);
    expect(gate.reserve(10_000)).toBe(1_002);
  });

  it('reserves a burst one interval apart, in the order the callers arrive', () => {
    // This is the shape the workers produce: four readers asking at the same instant must be
    // serialised into four slots, not all waved through because each compares itself to the same
    // "now" -- which is what a gate written as "wait if the last request was recent" does.
    const gate = sharedRequestGate(1_003)!;
    const waits = [0, 1, 2, 3].map(() => gate.reserve(10_000));
    expect(waits).toEqual([0, 1_003, 2_006, 3_009]);
  });

  it('does not accumulate a debt while nobody is asking', () => {
    // A gate that advanced its slot by one interval per reservation *from the last slot* would
    // come back from a long pause owing thousands of slots and stall the next caller for minutes.
    // Idle time is forgiveness, not credit: the second of two immediate calls still waits.
    const gate = sharedRequestGate(1_004)!;
    gate.reserve(10_000);
    expect(gate.reserve(60_000)).toBe(0);
    expect(gate.reserve(60_000)).toBe(1_004);
  });

  it('refuses an interval it cannot honour', () => {
    // Zero has its own meaning at this door (`off`), so the refusals here are the values that are
    // neither a rate nor a decision to have none. A `NaN` in particular would otherwise reach the
    // slot arithmetic and make every comparison false, i.e. a gate that silently never waits.
    expect(() => sharedRequestGate(-250)).toThrow(/positive/);
    expect(() => sharedRequestGate(Number.NaN)).toThrow(/positive/);
  });
});

describe('sharedRequestGate hands one gate to every caller that asks for the same rate', () => {
  it('returns the same instance for the same interval', () => {
    // The reason this is a registry and not a constructor call at the read site: baseline and
    // feature arms, and every worker in the pool, have to share one schedule. A per-caller gate
    // reproduces the rate limit it was installed to avoid, at N times the configured rate, and
    // nothing in the code would look wrong.
    expect(sharedRequestGate(7_001)).toBe(sharedRequestGate(7_001));
  });

  it('keeps different intervals apart', () => {
    // Two rates are two schedules; folding them together would make the slower one govern the
    // faster and the artifact state a number neither of them ran at.
    expect(sharedRequestGate(7_002)).not.toBe(sharedRequestGate(7_003));
  });

  it('returns nothing for a rate that asks for no pacing', () => {
    // `undefined` rather than a zero-interval gate: the retry loop then takes a branch with no
    // arithmetic in it at all, and there is no object left behind holding a schedule nobody
    // consults. Zero is the one value that means "off" here, because an operator who sets the
    // interval to zero is stating there is no limit to respect.
    expect(sharedRequestGate(0)).toBeUndefined();
  });

  it('refuses a negative interval instead of reading it as no pacing', () => {
    // Refused rather than clamped to zero: the environment parser rejects negatives first, so
    // reaching this with one is a caller defect, and a gate that quietly became "no pacing"
    // would let that defect run at the rate the provider throttles.
    expect(() => sharedRequestGate(-1)).toThrow(/positive/);
  });
});
