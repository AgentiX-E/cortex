/**
 * Direct coverage for the two degenerate-case helpers extracted from `stats.ts`.
 *
 * ## Why these are extracted rather than left inline
 *
 * Six guard bodies in `stats.ts` were annotated
 * `c8 ignore next -- defensive guard, unreachable via valid inputs`. The annotation
 * was measured, not assumed, and held up: a counter injected into each body stayed
 * empty through a full 226-test run, an always-executed positive control on the
 * same channel read 5, 499 adversarial calls across every extreme of the public
 * argument domain produced no hit, and direct calls to the private continued
 * fraction with collapsing arguments produced no hit either.
 *
 * Unreachable code that still counts against a coverage floor is a real problem:
 * it held `stats.ts` at 93.29% against this package's 95% rule, and neither
 * `c8 ignore` nor `v8 ignore` changed the reported figure -- the two spellings
 * produced byte-identical output, so neither directive is honoured by
 * `@vitest/coverage-v8` here.
 *
 * Deleting the guards was rejected. "Unreachable" means unreachable from today's
 * callers, not impossible: 580 representable magnitudes lie below the 1e-30 clamp
 * threshold (the smallest denormal is 5e-324), and `df` is a quotient of two
 * quantities that can each underflow. Removing the protection to improve a
 * percentage would trade a numerical invariant for a number.
 *
 * Extraction is the option that satisfies both: the behaviour stays, and it becomes
 * reachable by a test, so the coverage is earned rather than excluded.
 */

import { describe, it, expect } from 'vitest';
import { clampAwayFromZero, degenerateDfPValue } from '../math/stats.js';

describe('clampAwayFromZero', () => {
  it('returns values at or above the threshold unchanged', () => {
    // The threshold itself is the boundary and must pass through: clamping a value
    // that already equals the floor would be invisible for 1e-30 but a change of
    // behaviour for everything above it, so the test pins the exact edge.
    expect(clampAwayFromZero(1e-30)).toBe(1e-30);
    expect(clampAwayFromZero(1)).toBe(1);
    expect(clampAwayFromZero(-1)).toBe(-1);
    expect(clampAwayFromZero(Number.MAX_VALUE)).toBe(Number.MAX_VALUE);
  });

  it('raises magnitudes below the threshold to the threshold', () => {
    // The body the suite never executed. Each of these is a value the caller cannot
    // currently produce, which is why the arm was dead -- but the clamp exists for
    // the case it does, and that case is exercised here directly.
    expect(clampAwayFromZero(0)).toBe(1e-30);
    expect(clampAwayFromZero(1e-300)).toBe(1e-30);
    expect(clampAwayFromZero(Number.MIN_VALUE)).toBe(1e-30);
  });

  it('clamps by MAGNITUDE, so a negative value comes back positive', () => {
    // A real subtlety rather than a formality: the guard reads `Math.abs(value)`
    // and assigns the positive threshold, so a tiny negative becomes +1e-30 rather
    // than -1e-30. That flips the sign of a denominator, which flips the sign of
    // `1 / d` and therefore of every subsequent `h`. Pinning it makes the sign
    // convention explicit instead of incidental.
    expect(clampAwayFromZero(-1e-300)).toBe(1e-30);
    expect(clampAwayFromZero(-Number.MIN_VALUE)).toBe(1e-30);
    // Just inside the threshold, and the sign is preserved.
    expect(clampAwayFromZero(-1e-29)).toBe(-1e-29);
  });

  it('never returns zero, which is the property the reciprocal depends on', () => {
    // The reason the function exists: `d = 1 / d` and `c = 1 + aa / c` both divide
    // by these values, so a zero would produce Infinity or NaN and poison the
    // continued fraction. Stated as a property over the values that would break it.
    for (const input of [0, -0, 1e-300, -1e-300, Number.MIN_VALUE, -Number.MIN_VALUE]) {
      expect(clampAwayFromZero(input)).not.toBe(0);
      expect(Number.isFinite(1 / clampAwayFromZero(input))).toBe(true);
    }
  });
});

describe('degenerateDfPValue', () => {
  it('returns null for a usable degrees of freedom', () => {
    expect(degenerateDfPValue(1, 1)).toBeNull();
    expect(degenerateDfPValue(0.5, 0)).toBeNull();
    expect(degenerateDfPValue(1e300, 2)).toBeNull();
  });

  it('returns null for the smallest positive df', () => {
    // The boundary in the other direction: `df > 0` is strict, so the smallest
    // positive double is usable and must not be treated as degenerate.
    expect(degenerateDfPValue(Number.MIN_VALUE, 1)).toBeNull();
  });

  it('resolves a non-positive df to a definite p-value', () => {
    // The body the suite never executed. `df <= 0` cannot describe a t
    // distribution, so the answer is expressed as certainty rather than NaN.
    expect(degenerateDfPValue(0, 1)).toBe(0);
    expect(degenerateDfPValue(-1, 1)).toBe(0);
  });

  it('resolves NaN and Infinity to a definite p-value', () => {
    // Both arise from the underflow the guard exists for: a denormal squared to 0
    // gives `dfNum / 0`, which is NaN for a zero numerator and Infinity otherwise.
    expect(degenerateDfPValue(NaN, 1)).toBe(0);
    expect(degenerateDfPValue(Infinity, 1)).toBe(0);
    expect(degenerateDfPValue(-Infinity, 1)).toBe(0);
  });

  it('returns 1 when the means are equal, whatever the df', () => {
    // The t statistic is zero exactly when the means agree. A degenerate df cannot
    // manufacture evidence of a difference that the data does not show, so the
    // p-value is 1 for every unusable df rather than only for `df <= 0`.
    expect(degenerateDfPValue(0, 0)).toBe(1);
    expect(degenerateDfPValue(NaN, 0)).toBe(1);
    expect(degenerateDfPValue(Infinity, 0)).toBe(1);
    expect(degenerateDfPValue(-1, -0)).toBe(1);
  });

  it('is a pure function of its two arguments', () => {
    // `t` is passed rather than captured from the enclosing scope. That is what
    // makes this testable, and it also means repeated calls agree.
    const first = degenerateDfPValue(NaN, 3);
    const second = degenerateDfPValue(NaN, 3);
    expect(first).toBe(second);
    expect(degenerateDfPValue(1, -1)).toBeNull();
    expect(degenerateDfPValue(NaN, -1)).toBe(0);
  });
});
