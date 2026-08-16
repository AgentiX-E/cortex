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
  binomialCdf,
  wilsonScoreInterval,
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

describe('binomialCdf', () => {
  it('matches hand-computed binomial probabilities', () => {
    // P(X <= 0) for X ~ Bin(5, 0.5) = 1/32.
    expect(binomialCdf(0, 5, 0.5)).toBeCloseTo(0.03125, 12);
    // P(X <= 2) for X ~ Bin(10, 0.5) = (1 + 10 + 45)/1024 = 56/1024.
    expect(binomialCdf(2, 10, 0.5)).toBeCloseTo(0.0546875, 12);
    // P(X <= 1) for X ~ Bin(4, 0.5) = (1 + 4)/16 = 5/16.
    expect(binomialCdf(1, 4, 0.5)).toBeCloseTo(0.3125, 12);
  });

  it('returns 0 below the support and 1 at or above n', () => {
    expect(binomialCdf(-1, 5, 0.5)).toBe(0);
    expect(binomialCdf(5, 5, 0.5)).toBe(1);
    expect(binomialCdf(6, 5, 0.5)).toBe(1);
  });

  it('is symmetric around p = 0.5', () => {
    // P(X <= k; p) = P(X >= n-k; 1-p), so with p=0.5 the lower and upper tails match.
    expect(binomialCdf(0, 5, 0.5)).toBeCloseTo(1 - binomialCdf(4, 5, 0.5), 12);
  });

  it('handles degenerate trial counts and boundary probabilities', () => {
    // No trials: P(X <= k) is 1 for k >= 0 and 0 for k < 0.
    expect(binomialCdf(0, 0, 0.5)).toBe(1);
    expect(binomialCdf(-1, 0, 0.5)).toBe(0);
    // p = 0: every trial fails, so the CDF is 1 for any k < n.
    expect(binomialCdf(2, 5, 0)).toBe(1);
    // p = 1: every trial succeeds, so the CDF is 0 for any k < n.
    expect(binomialCdf(2, 5, 1)).toBe(0);
  });

  it('is monotone non-decreasing in k and bounded in [0, 1]', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 0, max: 19 }), (n, k) => {
        const cdf = binomialCdf(k, n, 0.5);
        expect(cdf).toBeGreaterThanOrEqual(0);
        expect(cdf).toBeLessThanOrEqual(1);
        expect(binomialCdf(k, n, 0.5)).toBeLessThanOrEqual(binomialCdf(k + 1, n, 0.5));
      }),
      { numRuns: 50 },
    );
  });
});

describe('wilsonScoreInterval', () => {
  it('matches hand-computed Wilson bounds', () => {
    const ci = wilsonScoreInterval(7, 10);
    expect(ci.lower).toBeCloseTo(0.39677321997956516, 10);
    expect(ci.upper).toBeCloseTo(0.892210712513788, 10);
  });

  it('is symmetric for p = 0.5', () => {
    const ci = wilsonScoreInterval(5, 10);
    expect(ci.lower).toBeCloseTo(0.23658959361548731, 10);
    expect(ci.upper).toBeCloseTo(0.7634104063845126, 10);
  });

  it('clamps extreme proportions into [0, 1]', () => {
    expect(wilsonScoreInterval(0, 10).lower).toBe(0);
    expect(wilsonScoreInterval(0, 10).upper).toBeCloseTo(0.2775401687666166, 10);
    expect(wilsonScoreInterval(10, 10).lower).toBeCloseTo(0.7224598312333834, 10);
    expect(wilsonScoreInterval(10, 10).upper).toBe(1);
  });

  it('returns the uninformative interval for an empty sample', () => {
    expect(wilsonScoreInterval(0, 0)).toEqual({ lower: 0, upper: 1 });
  });

  it('rejects an out-of-range correct count', () => {
    expect(() => wilsonScoreInterval(11, 10)).toThrow();
    expect(() => wilsonScoreInterval(-1, 10)).toThrow();
  });

  it('widens with a larger z quantile and shrinks with more data', () => {
    const z196 = wilsonScoreInterval(7, 10, 1.96);
    const z257 = wilsonScoreInterval(7, 10, 2.57);
    expect(z257.lower).toBeLessThan(z196.lower);
    expect(z257.upper).toBeGreaterThan(z196.upper);
    const larger = wilsonScoreInterval(70, 100);
    expect(larger.upper - larger.lower).toBeLessThan(z196.upper - z196.lower);
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
