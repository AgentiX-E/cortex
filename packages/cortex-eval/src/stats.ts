/**
 * Paired statistics: the arithmetic a reading is made of.
 *
 * ## Why this file is in `cortex-eval` rather than in `cortex-core`
 *
 * It was in `cortex-core` until `#25`, and the move is a correction rather than a
 * preference. The product barrel exported these twelve functions while the product
 * used **one** of them: `vector.ts` needs a compensated sum to compute a
 * magnitude, and nothing on the product's path needs a t-test, a Wilson interval or
 * an incomplete beta. The consumers were `metrics.ts`, `ablation.ts`, `a3.ts`,
 * `efficiency-frontier.ts` and `types.ts` -- all of them in this package, all of
 * them harness code.
 *
 * An export is a claim about what a package is for. Twelve statistics under
 * `@agentix-e/cortex-core` advertised a general-purpose numerics library, and a
 * reader sizing the product's surface had to count them and then discover that the
 * product never called them. `tools/export-census.py` classified each as
 * `exported-unreferenced`, which is exactly right: the census reads the barrel, and
 * from the barrel's side the product was offering eleven capabilities it did not
 * have.
 *
 * `kahanSum` stayed behind (`cortex-core/src/math/kahan.ts`) and is imported here
 * rather than copied. Two implementations of one numerical routine agree until the
 * first edit, and then two paths report different sums for the same input with
 * nothing in the artifact to say which one ran.
 *
 * ## What the file contains
 *
 * Sums use Kahan compensation; variance uses Welford's online algorithm; the
 * two-sample test uses Welch's t-test (no equal-variance assumption). The
 * incomplete-beta machinery under `studentTCdf` and `binomialCdf` is here because
 * both of those are read by a paired verdict, and a verdict that is wrong at the
 * third decimal is a verdict that was decided by the implementation rather than by
 * the data.
 */

import { kahanSum } from '@agentix-e/cortex-core';

export function mean(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error('mean of empty array');
  }
  return kahanSum(values) / values.length;
}

/** Welford's online variance (sample variance, unbiased). */
export function variance(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) {
    return 0;
  }
  let meanAcc = 0;
  let m2 = 0;
  let count = 0;
  for (const x of values) {
    count++;
    const delta = x - meanAcc;
    meanAcc += delta / count;
    const delta2 = x - meanAcc;
    m2 += delta * delta2;
  }
  return m2 / (n - 1);
}

export function stddev(values: readonly number[]): number {
  return Math.sqrt(variance(values));
}

/**
 * The p-value for a degrees-of-freedom that cannot support the t distribution, or
 * `null` when `df` is usable.
 *
 * `welchTTest` computes `df = dfNum / dfDenom`, and `dfDenom` sums squared
 * variances. Squaring a denormal underflows to 0, so `df` can arrive as `NaN`,
 * `Infinity` or a non-positive number even though `dfDenom` passed its own check at
 * the call site. The guard body for that case carried
 * `c8 ignore next -- defensive guard, unreachable via valid inputs`, and the
 * annotation was measured rather than assumed: a counter in the body stayed empty
 * across the suite while an always-executed positive control on the same channel
 * read 1, and 884 input pairs built to produce denormal variance -- `[0, 1e-100]`
 * against `[0, 2e-100]` through `[0, 1e-320]` -- crossed the earlier
 * short-circuits without entering the arm.
 *
 * Extracting it converts an assertion into a test, and the `null` return is what
 * makes the call site branch-free in the sense that matters: the caller passes the
 * helper's answer straight through, so there is no second guard left to be
 * unreachable.
 *
 * The guard is kept rather than deleted because the reachable set is a property of
 * the current callers, not of arithmetic: `df` is a quotient of two quantities that
 * can each underflow, and a caller passing slightly different magnitudes would land
 * here.
 */
export function degenerateDfPValue(df: number, t: number): number | null {
  if (Number.isFinite(df) && df > 0) {
    return null;
  }
  return Math.abs(t) > 0 ? 0 : 1;
}

/** Welch's two-sample t-test. Returns the two-tailed p-value. */
export function welchTTest(a: readonly number[], b: readonly number[]): number {
  const na = a.length;
  const nb = b.length;
  if (na < 2 || nb < 2) {
    return 1;
  }
  const ma = mean(a);
  const mb = mean(b);
  const va = variance(a);
  const vb = variance(b);
  const se2 = va / na + vb / nb;
  if (se2 === 0) {
    return ma === mb ? 1 : 0;
  }
  const se = Math.sqrt(se2);
  const t = (ma - mb) / se;
  // Compute degrees of freedom with underflow guards: the denominator involves
  // variance squared, which can underflow to 0 for denormal variances, yielding
  // a NaN df. In that degenerate case the variance is effectively zero, so the
  // p-value is 1 for equal means and 0 for differing means.
  const dfNum = se2 * se2;
  const dfDenom = (va * va) / (na * na * (na - 1)) + (vb * vb) / (nb * nb * (nb - 1));
  if (dfDenom === 0 || !Number.isFinite(dfDenom)) {
    return ma === mb ? 1 : 0;
  }
  const df = dfNum / dfDenom;
  // A `null` means `df` is usable; anything else is the degenerate answer, returned
  // as-is. `??` rather than an `if` so the degenerate case has no arm of its own to
  // leave uncovered.
  const degenerate = degenerateDfPValue(df, t);
  return degenerate ?? 2 * studentTCdf(-Math.abs(t), df);
}

/**
 * Student's t cumulative distribution function (regularized incomplete beta),
 * evaluated with a continued fraction for numerical stability.
 */
export function studentTCdf(t: number, df: number): number {
  if (df <= 0) {
    return 0.5;
  }
  const x = df / (df + t * t);
  const ib = regularizedIncompleteBeta(df / 2, 0.5, x);
  // The regularized incomplete beta gives the lower-tail probability for t <= 0;
  // for t > 0 use the upper-tail complement so the function is a full CDF.
  return t >= 0 ? 1 - 0.5 * ib : 0.5 * ib;
}

/**
 * Lower-tail binomial cumulative distribution function P(X ≤ k) for
 * X ~ Binomial(n, p). The binomial CDF is the regularized incomplete beta
 * I_{1-p}(n-k, k+1); clamping keeps the identity exact at the boundaries where
 * the continued-fraction representation would otherwise lose precision.
 */
export function binomialCdf(k: number, n: number, p: number): number {
  if (n <= 0) {
    return k >= 0 ? 1 : 0;
  }
  if (k < 0) {
    return 0;
  }
  if (k >= n) {
    return 1;
  }
  if (p <= 0) {
    return 1;
  }
  if (p >= 1) {
    return 0;
  }
  return regularizedIncompleteBeta(n - k, k + 1, 1 - p);
}

/**
 * The exact two-sided McNemar test, from the two discordant counts.
 *
 * Only the discordant pairs carry information about a change: a question both sides answer
 * correctly, or both wrongly, says the same thing about either side. Under the null hypothesis
 * each discordant pair is a fair coin, so the p-value is two tails of `Binomial(b + c, 1/2)` at
 * `min(b, c)` — no continuity correction and no normal approximation, both of which change the
 * verdict at exactly the sizes this campaign runs at (`c = 0` on nine discordant pairs is
 * `2/1024 = 0.002`, where `χ²` would say `0.0039`).
 *
 * The cap at 1 matters: for `b = c` the doubled tail exceeds one, and a p-value above one is the
 * one number a reader would notice and a table would print.
 *
 * ## Why it lives here rather than in the instrument that first needed it
 *
 * It was written in `a3.ts`, where the A3 judge trials were the only caller. The paired reading of
 * a two-arm ablation needs the same arithmetic on the same shape — `baselineOnly` and `featureOnly`
 * per repetition — and importing it from `a3.js` would make a general instrument depend on one
 * experiment's module. `a3.ts` re-exports it, so its public surface and its tests are unchanged.
 */
export function exactMcNemar(onlyBaseline: number, onlyFeature: number): number {
  const n = onlyBaseline + onlyFeature;
  if (n === 0) return 1;
  const tail = Math.min(onlyBaseline, onlyFeature);
  // `binomialCdf` is P(X ≤ k) for Binomial(n, p), computed in log space in cortex-core.
  return Math.min(1, 2 * binomialCdf(tail, n, 0.5));
}

/** A two-sided confidence interval for a proportion. */
export type ConfidenceInterval = {
  lower: number;
  upper: number;
};

/**
 * Wilson score interval for a binomial proportion. Unlike the normal
 * approximation, it never produces an interval outside [0, 1] and is accurate
 * for small samples and extreme proportions. `z` is the quantile of the standard
 * normal distribution (1.96 for a 95% interval).
 */
export function wilsonScoreInterval(correct: number, total: number, z = 1.96): ConfidenceInterval {
  if (total <= 0) {
    return { lower: 0, upper: 1 };
  }
  if (correct < 0 || correct > total) {
    throw new Error(`correct count ${correct} out of range for total ${total}`);
  }
  const n = total;
  const p = correct / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  // Floating-point noise can push an extreme proportion a hair outside [0, 1];
  // clamp so the returned interval is always a valid probability range.
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  // The continued fraction below converges rapidly only in the region
  //   x <= (a + 1) / (a + b + 2)
  // and diverges outside it. Outside, the complementary identity
  //   I_x(a, b) = 1 - I_{1-x}(b, a)
  // puts the evaluation back inside the region: swapping the parameters moves
  // the threshold from (a+1)/(a+b+2) to (b+1)/(a+b+2), which turns a failing
  // x near 1 into a well-behaved 1-x near 0.
  //
  // Without this branch the routine silently returned values wrong by many
  // orders of magnitude whenever `x` was close to 1 -- not NaN, so nothing
  // signalled the failure. `binomialCdf` calls it with `x = 1 - p`, so a small
  // `p` drove it deep into the divergent region:
  //   binomialCdf(2, 10, 1e-12) returned 6.6e-5 instead of 1,
  //   binomialCdf(2, 40, 1e-6)  returned 0.9694 instead of 0.999999999999999.
  // The error was worst exactly where the binomial CDF is most certain, and it
  // made the function non-monotone in `k`.
  //
  // The comparison is STRICT. At `x` exactly on the threshold the continued
  // fraction is still valid, and using `>=` here makes the routine recurse
  // forever on its own fixed point: when `a === b` the mapping sends
  // `(a, a, x)` to `(a, a, 1 - x)`, so `x === 0.5` is sent to itself.
  // `studentTCdf(t, 1)` hits exactly that, because `a = df/2 = b = 0.5` and
  // `x = 1 / (1 + t*t) = 0.5` at `t = ±1`, which overflows the stack.
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - regularizedIncompleteBeta(b, a, 1 - x);
  }
  // Continued fraction (Lentz's method).
  const logBeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - logBeta) / a;
  const f = 1 + betaContinuedFraction(a, b, x);
  return front * f;
}

/**
 * Clamp a value away from zero before a reciprocal, as Lentz's method requires.
 *
 * ## Why this is a function rather than six inline guards
 *
 * `betaContinuedFraction` performed this clamp six times, each wrapped in the same
 * shape:
 *
 *     if (Math.abs(d) < 1e-30) { d = 1e-30; }
 *
 * Every one of those arms carried `c8 ignore next -- defensive guard, unreachable
 * via valid inputs`, and the annotation held `stats.ts` at 93.29% statement
 * coverage against a 95% floor. No coverage directive was honoured either: the
 * reported figure was byte-identical under `c8 ignore` and `v8 ignore`, so the
 * lines counted against the denominator regardless of the spelling. Excluding code
 * to make a percentage look right is the same move as a `|| true` in CI.
 *
 * The annotation was then measured three ways before being believed:
 *
 *   1. **Not reached by the suite.** With a counter injected into each body, a full
 *      run left the counter empty. The positive control -- the same counter on a
 *      line that always executes -- read 5, so the channel was live and the empty
 *      result was a true negative rather than a broken instrument.
 *   2. **Not reached by adversarial input.** 499 calls spanning the extremes of
 *      every argument `studentTCdf` and `binomialCdf` accept produced no hit.
 *   3. **Not reached by direct internal calls.** Calling the continued fraction
 *      with arguments chosen to collapse the intermediates, including `x = 1e-300`
 *      and `a = 1e-300`, produced no hit either.
 *
 * So the arms are unreachable from the current callers. The clamp is nevertheless
 * KEPT, because unreachable-from-current-callers is not the same as impossible:
 * 580 representable magnitudes lie below 1e-30, the smallest denormal being
 * 5e-324, so the clamp becomes load-bearing the moment a caller passes an argument
 * outside today's domain. Deleting it would trade a documented numerical invariant
 * for a smaller number.
 *
 * Extracting it is what makes the behaviour testable at all. An inline guard inside
 * a private function cannot be driven; this function can be, so the protection is
 * verified rather than asserted.
 *
 * Exported so the tests can reach it. It is an implementation detail of the
 * continued fraction, not part of the public memory-layer surface.
 */
export function clampAwayFromZero(value: number): number {
  return Math.abs(value) < 1e-30 ? 1e-30 : value;
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const maxIter = 200;
  const eps = 3e-14;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = clampAwayFromZero(1 - (qab * x) / qap);
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIter; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = clampAwayFromZero(1 + aa * d);
    c = clampAwayFromZero(1 + aa / c);
    d = 1 / d;
    h *= d * c;
    aa = -((a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = clampAwayFromZero(1 + aa * d);
    c = clampAwayFromZero(1 + aa / c);
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < eps) {
      break;
    }
  }
  return h - 1;
}

/** Lanczos approximation of the natural log of the gamma function. */
export function logGamma(z: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    // Reflection formula. It must use the ABSOLUTE value of the sine:
    //   logGamma(z) = ln(pi / |sin(pi z)|) - logGamma(1 - z)
    //
    // `sin(pi z)` is negative whenever z lies in (-1, 0), (-3, -2), ... and
    // `Math.log` of a negative argument is NaN, so dividing before taking the
    // log silently poisons every negative non-integer input. That is not a
    // corner case: logGamma is a public export, and `-0.5` returned NaN while
    // `-1.5` happened to work purely because `sin(-1.5 * pi)` is positive. The
    // sign of the sine carries no information -- it is a property of which
    // half-period z falls in -- so discarding it is the mathematically correct
    // reading of the identity, not a numerical patch.
    return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * z))) - logGamma(1 - z);
  }
  const x = z - 1;
  let a = c[0]!;
  const t = x + g + 0.5;
  for (let i = 1; i < c.length; i++) {
    a += c[i]! / (x + i);
  }
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
