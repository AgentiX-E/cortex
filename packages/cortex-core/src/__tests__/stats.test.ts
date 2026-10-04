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

  it('welch t-test returns 1 for equal means with zero variance in both samples', () => {
    // Two constant samples with the same value: `se2 === 0` so the standard error
    // is undefined, and the function falls to the degenerate-case answer. The
    // answer must be 1 -- identical constant samples are maximally consistent, and
    // returning 0 here would report "certainly different" from data that shows no
    // difference at all. Only the TRUE arm of `ma === mb ? 1 : 0` is taken, which
    // the coverage report showed was never executed.
    expect(welchTTest([7, 7], [7, 7])).toBe(1);
    expect(welchTTest([0, 0, 0], [0, 0, 0])).toBe(1);
    expect(welchTTest([-3.5, -3.5], [-3.5, -3.5])).toBe(1);
  });

  it('welch t-test returns 0 for differing means with zero variance in both samples', () => {
    // The complement, and the reason the ternary exists: with no variance at all,
    // any difference in mean is infinitely significant. Pinning both arms is what
    // makes the pair meaningful -- a test for the 1 arm alone would pass on an
    // implementation that always returned 1.
    expect(welchTTest([1, 1], [2, 2])).toBe(0);
    expect(welchTTest([0, 0], [1e-12, 1e-12])).toBe(0);
  });

  it('welch t-test returns 1 for equal denormal means at the underflow boundary', () => {
    // Denormal variances square to exactly 0, so `va * va` underflows and the
    // degrees-of-freedom denominator is 0. That is the second degenerate ternary in
    // the function, and its equal-means arm was also never taken. The equal-means
    // case must agree with the `se2 === 0` path above: the same input distribution
    // cannot give 1 through one short-circuit and 0 through the other.
    const tiny = 1e-200;
    expect(welchTTest([tiny, tiny], [tiny, tiny])).toBe(1);
  });

  it('reaches the dfDenom guard with equal means and non-zero variance', () => {
    // The case that makes the `ma === mb` arm of the dfDenom guard REACHABLE, and
    // the reason it could not be dismissed as dead code.
    //
    // `[0, v, 2v]` and `[v, v, v]` share the mean `v` while having DIFFERENT
    // samples, so the variance is non-zero and `se2` is non-zero -- the first
    // short-circuit is passed. But the variances are of order 1e-200, so `va * va`
    // is of order 1e-400 and underflows to 0, which makes `dfDenom` exactly 0 and
    // enters the guard. The means are equal, so the taken arm is the `1`.
    //
    // An earlier reading of this code reasoned that equal means force equal
    // variances and therefore `dfDenom === 0` implies `va === 0`, which would make
    // the arm unreachable. Instrumenting the guard body disproved it: this input
    // enters the body, and 884 exponent-pairs had already shown the neighbouring
    // `df` guard to be genuinely dead. Reachability is not something to reason
    // about here; floating-point underflow decides it.
    for (const exponent of [100, 150, 160]) {
      const v = Math.pow(10, -exponent);
      const p = welchTTest([0, v, 2 * v], [v, v, v]);
      expect(Number.isFinite(p), `exponent ${exponent}`).toBe(true);
      expect(p, `equal means with underflowing variance, exponent ${exponent}`).toBe(1);
    }
  });

  it('returns 1 for equal means reached through the second short-circuit', () => {
    // The two-element spelling of the same case. `[-v, v]` has mean 0 and variance
    // `v*v`, which underflows for the same reason; `[0, 0]` has mean 0 and zero
    // variance, so `se2` is non-zero and the guard is entered on equal means.
    for (const exponent of [100, 150, 160]) {
      const v = Math.pow(10, -exponent);
      expect(welchTTest([-v, v], [0, 0]), `exponent ${exponent}`).toBe(1);
    }
  });

  it('welch t-test returns 0 for differing denormal means at the underflow boundary', () => {
    const tiny = 1e-200;
    expect(welchTTest([tiny, tiny], [2 * tiny, 2 * tiny])).toBe(0);
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
    // `p` MUST be generated, not fixed. This test previously hardcoded
    // `p = 0.5` while its name claimed to check monotonicity in general, and
    // `p = 0.5` is precisely the one value at which the defect below cannot
    // occur: it puts `x = 1 - p = 0.5` comfortably inside the continued
    // fraction's region of convergence, so the missing complementary branch was
    // never exercised. Every other assertion in this file used p = 0.5, 0 or 1,
    // which is why no test ever entered the region where the routine was wrong.
    //
    // The lower bound is `Number.MIN_VALUE` rather than an arbitrary small
    // number so that underflow-scale probabilities are covered too -- that is
    // exactly where the error was largest.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 19 }),
        fc.double({ min: Number.MIN_VALUE, max: 1, noNaN: true }),
        (n, k, p) => {
          const cdf = binomialCdf(k, n, p);
          expect(cdf).toBeGreaterThanOrEqual(0);
          expect(cdf).toBeLessThanOrEqual(1);
          expect(binomialCdf(k, n, p)).toBeLessThanOrEqual(binomialCdf(k + 1, n, p));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('agrees with an independent pmf sum for small interior p', () => {
    // Regression. `regularizedIncompleteBeta` was missing the branch that swaps
    // to the complementary pair when `x = 1 - p` sits outside the continued
    // fraction's convergence region, so a small `p` produced values wrong by
    // orders of magnitude -- silently, since the result was a plausible number
    // rather than NaN, and worst exactly where the CDF is closest to 1.
    //
    // The reference is the definition, computed independently here:
    //   CDF(k) = sum_{i=0..k} C(n, i) p^i (1-p)^(n-i)
    const pmfSum = (k: number, n: number, p: number): number => {
      let total = 0;
      let binom = 1;
      for (let i = 0; i <= k; i++) {
        total += binom * Math.pow(p, i) * Math.pow(1 - p, n - i);
        binom = (binom * (n - i)) / (i + 1);
      }
      return total;
    };
    const cases: [number, number, number][] = [
      [2, 40, 1e-6],
      [3, 40, 1e-6],
      [1, 40, 1e-6],
      [0, 40, 1e-6],
      [2, 10, 1e-12],
      [4, 50, 1e-3],
      [1, 20, 1e-8],
    ];
    for (const [k, n, p] of cases) {
      expect(binomialCdf(k, n, p), `binomialCdf(${k}, ${n}, ${p})`).toBeCloseTo(
        pmfSum(k, n, p),
        12,
      );
    }
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
    // AUDIT NOTE -- this test cannot reach the reflection branch, and that is
    // unavoidable, not an oversight to be "fixed" here.
    //
    // The recurrence `logGamma(x+1) - logGamma(x) = log(x)` is only a valid
    // oracle for `x > 0`: for `x` in `(-1, 0)` the sub-expression `logGamma(x+1)`
    // is evaluated at a positive argument while `logGamma(x)` is evaluated by
    // reflection, and `log(x)` is not real. Evaluating the identity across zero
    // makes it fail for arithmetic reasons, not because the routine is wrong.
    //
    // The lower bound was `0.5`, which is *also* the reflection threshold in
    // `logGamma` (`z < 0.5`), so the generator's minimum sat exactly on the branch
    // boundary and every draw of `x` was evaluable by the direct path alone. That
    // is the same shape as the `binomialCdf` defect this file used to have: a
    // property test whose generator never enters the branch under test. It is only
    // tolerable here because the branch *is* covered elsewhere -- see
    // `branch-coverage.test.ts`, whose descriptions name the reflection branch
    // explicitly and whose generator spans negative half-periods. The bound stays
    // at 0.5 rather than being widened, because widening it would require inventing
    // a comparison that is simultaneously real-valued and sensitive to the sign
    // error that `Math.abs` fixes.
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
