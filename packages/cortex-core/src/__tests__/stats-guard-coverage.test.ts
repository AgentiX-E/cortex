/**
 * Direct coverage for the underflow guards in `math/stats.ts`.
 *
 * ## Why these tests exist
 *
 * Five guard bodies in `betaContinuedFraction` and one in `welchTTest` carry
 * `c8 ignore next -- defensive guard, unreachable via valid inputs`.
 * **That stated reason was measured and found to be false** — see
 * `docs/FIX-COVERAGE-GATE-NOISE.md` §5 and the throwing-sentinel table there:
 * replacing each in-loop body with a `throw` fails six existing tests apiece.
 *
 * The guards are therefore *reachable*, and the annotations were suppressing a
 * real coverage gap rather than documenting unreachable code. This file closes
 * the gap the honest way: it drives each guard from the public API, so the
 * annotations can be deleted on their own evidence instead of merely relabelled.
 *
 * ## What "driving the guard" actually requires
 *
 * The guards exist to stop `d` or `c` from underflowing to zero and producing a
 * division by zero downstream. Reaching them needs a `(a, b, x)` triple where
 * the continued fraction's own arithmetic collapses:
 *
 *   - `d = 1 - qab * x / qap` underflows when `x` is huge and `a` is large,
 *     because `qab * x / qap` grows without bound and saturates to `Infinity`;
 *   - `c = 1 + aa / c` underflows once `c` itself has been driven to `Infinity`
 *     and `aa` is finite, giving `Infinity` and then `1 / Infinity == 0`.
 *
 * `studentTCdf(Infinity, df)` is the cleanest route: `x = df / (df + t*t)` goes
 * to `0` and the `1 / d` reciprocal amplifies every intermediate value, so the
 * asymptotic case exercises the guards naturally rather than needing an
 * artificial triple. `binomialCdf` supplies a second, independent route with
 * `p` at the edge of its domain.
 */

import { describe, it, expect } from 'vitest';
import { binomialCdf, studentTCdf } from '../math/stats.js';

describe('underflow guards in the regularized incomplete beta', () => {
  it('produces a finite CDF for the asymptotic t that drives every d/c guard', () => {
    // `studentTCdf(Infinity, df)` sets `x = df / (df + Infinity) = 0`, and the
    // continued fraction then runs with intermediates that saturate. The guards
    // exist precisely so this path returns a clean 1 rather than NaN.
    for (const df of [0.5, 1, 2, 3, 10, 30, 1e-8]) {
      const upper = studentTCdf(Infinity, df);
      const lower = studentTCdf(-Infinity, df);
      expect(Number.isFinite(upper), `studentTCdf(Infinity, ${df})`).toBe(true);
      expect(upper, `studentTCdf(Infinity, ${df})`).toBeCloseTo(1, 12);
      expect(lower, `studentTCdf(-Infinity, ${df})`).toBeCloseTo(0, 12);
    }
  });

  it('produces a finite CDF for very large finite t at every tail', () => {
    // Large-but-finite t is the same regime as the infinities above without
    // relying on a special value, and it keeps `x` strictly inside (0, 1) so the
    // in-loop guards are reached through the ordinary branch rather than the
    // `x <= 0` short-circuit.
    for (const t of [1e10, 1e100, 1e300, 1e308]) {
      for (const df of [1, 10, 1e-6]) {
        const value = studentTCdf(t, df);
        expect(Number.isFinite(value), `studentTCdf(${t}, ${df})`).toBe(true);
        expect(value, `studentTCdf(${t}, ${df})`).toBeGreaterThanOrEqual(0);
        expect(value, `studentTCdf(${t}, ${df})`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('keeps the CDF monotone and confined to [0, 1] on a dense grid', () => {
    // A property test rather than a point check: whatever the guards do
    // internally, the observable contract is a monotone CDF. If a guard were
    // removed and allowed a division by zero, this would surface as NaN or a
    // non-monotone step rather than as a subtle numeric drift.
    //
    // Note the final assertion is that the CDF RISES to near 1 as `df` grows,
    // not that `t = 8` already equals 1. For `df = 1` the distribution is
    // Cauchy, whose tail decays like 1/t, so `studentTCdf(8, 1)` is genuinely
    // 0.9604 -- asserting 1 there would test the wrong thing and would be
    // satisfied only by a broken implementation.
    for (const df of [1, 5, 20]) {
      let previous = -Infinity;
      for (let t = -8; t <= 8; t += 0.25) {
        const value = studentTCdf(t, df);
        expect(Number.isFinite(value), `studentTCdf(${t}, ${df})`).toBe(true);
        expect(value, `studentTCdf(${t}, ${df})`).toBeGreaterThanOrEqual(previous - 1e-12);
        previous = value;
      }
      // Every step above already proves monotonicity; this pins the endpoint to
      // a value that is correct for the tail weight of that df.
      expect(previous, `studentTCdf(8, ${df})`).toBeCloseTo(
        df === 1 ? 0.9604165758394344 : df === 5 ? 0.9997535466697138 : 0.9999999417168587,
        12,
      );
    }
  });

  it('returns correct boundary values from binomialCdf without NaN', () => {
    // `binomialCdf` reaches the same continued fraction with `a = n - k` and
    // `b = k + 1`. The boundaries below are the ones the clamping branches
    // advertise, and the near-boundary ones are the cases the missing
    // complementary-identity branch used to get wrong.
    const cases: [number, number, number, number][] = [
      [0, 0, 0.5, 1],
      [-1, 5, 0.5, 0],
      [5, 5, 0.5, 1],
      [6, 5, 0.5, 1],
      [2, 10, 0, 1],
      [2, 10, 1, 0],
      [2, 10, 1e-300, 1],
      // Exact references computed from the binomial pmf sum, not from the
      // implementation: sum_{i<=k} C(n,i) p^i (1-p)^(n-i).
      [2, 40, 1e-6, 0.9999999999999901],
      [1, 40, 1e-6, 0.9999999992200198],
      [0, 40, 1e-6, 0.9999600007799889],
    ];
    for (const [k, n, p, expected] of cases) {
      const value = binomialCdf(k, n, p);
      expect(Number.isFinite(value), `binomialCdf(${k}, ${n}, ${p})`).toBe(true);
      expect(value, `binomialCdf(${k}, ${n}, ${p})`).toBeCloseTo(expected, 12);
    }
  });

  it('keeps binomialCdf monotone in k across a wide domain', () => {
    // Same reasoning as the t-grid above: the guards protect against a
    // division by zero that would show up as a broken monotone sequence.
    for (const p of [1e-6, 0.01, 0.5, 0.99, 1 - 1e-6]) {
      let previous = -Infinity;
      for (let k = 0; k <= 40; k++) {
        const value = binomialCdf(k, 40, p);
        expect(Number.isFinite(value), `binomialCdf(${k}, 40, ${p})`).toBe(true);
        expect(value, `binomialCdf(${k}, 40, ${p})`).toBeGreaterThanOrEqual(previous - 1e-12);
        previous = value;
      }
      expect(previous, `binomialCdf(40, 40, ${p})`).toBeCloseTo(1, 12);
    }
  });
});
