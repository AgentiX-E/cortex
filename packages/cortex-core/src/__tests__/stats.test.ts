import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  kahanSum,
  mean,
  variance,
  stddev,
  welchTTest,
  studentTCdf,
  logGamma,
} from '../math/stats.js';

describe('stats edge cases', () => {
  it('mean of empty array throws', () => {
    expect(() => mean([])).toThrow();
  });

  it('variance of fewer than 2 values is 0', () => {
    expect(variance([])).toBe(0);
    expect(variance([5])).toBe(0);
  });

  it('stddev of fewer than 2 values is 0', () => {
    expect(stddev([5])).toBe(0);
  });

  it('welch t-test with fewer than 2 samples returns 1', () => {
    expect(welchTTest([1], [1, 2])).toBe(1);
  });

  it('welch t-test of equal means returns 1', () => {
    expect(welchTTest([2, 2, 2], [2, 2, 2])).toBe(1);
  });

  it('studentTCdf with df <= 0 returns 0.5', () => {
    expect(studentTCdf(0, 0)).toBe(0.5);
  });

  it('kahanSum compensates for cancellation', () => {
    // Naive summation of [1e16, 1, 1, -1e16] gives 0; Kahan recovers both 1s.
    expect(kahanSum([1e16, 1, 1, -1e16])).toBe(2);
  });

  it('welch t-test handles denormal variance without NaN', () => {
    // Regression: squaring a denormal variance underflows to 0, which previously
    // produced a NaN degrees-of-freedom and a NaN p-value.
    const a = [0, 0, 0, 0, 0];
    const b = [0, 0, 7.936836261682544e-162, 0, 0];
    const p = welchTTest(a, b);
    expect(Number.isNaN(p)).toBe(false);
    expect(p).toBe(welchTTest(b, a));
  });
});

describe('stats numerical properties', () => {
  it('logGamma matches the gamma recurrence for positive reals', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.5, max: 20, noNaN: true }), (x) => {
        const g = logGamma(x);
        // Γ(x+1) = x·Γ(x)  =>  logΓ(x+1) - logΓ(x) = log(x)
        const diff = logGamma(x + 1) - g;
        expect(diff).toBeCloseTo(Math.log(x), 8);
      }),
      { numRuns: 50 },
    );
  });

  it('mean of a constant array equals the constant', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        fc.integer({ min: 1, max: 20 }),
        (c, n) => {
          const arr = new Array<number>(n).fill(c);
          expect(mean(arr)).toBeCloseTo(c, 9);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('variance of a constant array is zero', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        fc.integer({ min: 2, max: 20 }),
        (c, n) => {
          const arr = new Array<number>(n).fill(c);
          expect(variance(arr)).toBeCloseTo(0, 9);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('welch t-test is symmetric in its arguments', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -100, max: 100, noNaN: true }), { minLength: 5, maxLength: 20 }),
        fc.array(fc.double({ min: -100, max: 100, noNaN: true }), { minLength: 5, maxLength: 20 }),
        (a, b) => {
          expect(welchTTest(a, b)).toBeCloseTo(welchTTest(b, a), 10);
        },
      ),
      { numRuns: 30 },
    );
  });
});
