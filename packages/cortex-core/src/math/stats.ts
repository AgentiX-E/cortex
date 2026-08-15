/**
 * High-precision statistics. Sums use Kahan compensation; variance uses Welford's
 * online algorithm; the two-sample test uses Welch's t-test (no equal-variance
 * assumption).
 */

export function kahanSum(values: Iterable<number>): number {
  let sum = 0;
  let c = 0;
  for (const v of values) {
    const y = v - c;
    const t = sum + y;
    c = t - sum - y;
    sum = t;
  }
  return sum;
}

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
  const se = Math.sqrt(va / na + vb / nb);
  if (se === 0) {
    return ma === mb ? 1 : 0;
  }
  const t = (ma - mb) / se;
  const df =
    (va / na + vb / nb) ** 2 / (va ** 2 / (na * na * (na - 1)) + vb ** 2 / (nb * nb * (nb - 1)));
  return 2 * studentTCdf(-Math.abs(t), df);
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
  return 0.5 * regularizedIncompleteBeta(df / 2, 0.5, x);
}

function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  // Continued fraction (Lentz's method).
  const logBeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - logBeta) / a;
  const f = 1 + betaContinuedFraction(a, b, x);
  return front * f;
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const maxIter = 200;
  const eps = 3e-14;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < 1e-30) {
    d = 1e-30;
  }
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIter; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) {
      d = 1e-30;
    }
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) {
      c = 1e-30;
    }
    d = 1 / d;
    h *= d * c;
    aa = -((a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) {
      d = 1e-30;
    }
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) {
      c = 1e-30;
    }
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
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const x = z - 1;
  let a = c[0]!;
  const t = x + g + 0.5;
  for (let i = 1; i < c.length; i++) {
    a += c[i]! / (x + i);
  }
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
