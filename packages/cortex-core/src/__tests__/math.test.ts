import { describe, it, expect } from 'vitest';
import { cosineSimilarity, dot, l2Distance, normalize, norm } from '../math/vector.js';
import { mean, variance, welchTTest } from '../math/stats.js';
import { sinkhorn, squaredEuclideanCostMatrix } from '../math/ot.js';
import { retrievability, review } from '../math/fsrs.js';

describe('vector', () => {
  it('computes dot product exactly for identical vectors', () => {
    const a = new Float64Array([1, 2, 3]);
    expect(dot(a, a)).toBe(14);
  });

  it('throws on dimension mismatch', () => {
    expect(() => dot(new Float64Array([1]), new Float64Array([1, 2]))).toThrow();
  });

  it('cosine similarity of identical vectors is 1', () => {
    const a = new Float64Array([0.5, 0.25, 0.25]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 12);
  });

  it('cosine similarity of orthogonal vectors is 0', () => {
    const a = new Float64Array([1, 0]);
    const b = new Float64Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 12);
  });

  it('normalize produces unit norm', () => {
    const v = normalize(new Float64Array([3, 4]));
    expect(norm(v)).toBeCloseTo(1, 12);
  });

  it('l2 distance matches manual computation', () => {
    const d = l2Distance(new Float64Array([0, 0]), new Float64Array([3, 4]));
    expect(d).toBeCloseTo(5, 12);
  });
});

describe('stats', () => {
  it('mean of [1,2,3] is 2', () => {
    expect(mean([1, 2, 3])).toBeCloseTo(2, 12);
  });

  it('sample variance of [1,2,3] is 1', () => {
    expect(variance([1, 2, 3])).toBeCloseTo(1, 12);
  });

  it('welch t-test rejects clearly different means', () => {
    const a = [1, 1.1, 0.9, 1.05, 0.95];
    const b = [10, 10.1, 9.9, 10.05, 9.95];
    expect(welchTTest(a, b)).toBeLessThan(0.001);
  });

  it('welch t-test accepts identical samples', () => {
    const a = [1, 2, 3, 4, 5];
    expect(welchTTest(a, a)).toBeCloseTo(1, 12);
  });
});

describe('optimal transport (Sinkhorn)', () => {
  it('recovers identity coupling for identical distributions', () => {
    const a = [0.5, 0.5];
    const b = [0.5, 0.5];
    const cost = [
      [0, 1],
      [1, 0],
    ];
    const res = sinkhorn(a, b, cost, 0.1);
    expect(res.converged).toBe(true);
    // Most mass should be on the diagonal (identity).
    expect(res.coupling.get(0, 0)).toBeGreaterThan(res.coupling.get(0, 1));
    expect(res.coupling.get(1, 1)).toBeGreaterThan(res.coupling.get(1, 0));
  });

  it('computes squared Euclidean cost matrix with correct shape', () => {
    const c = squaredEuclideanCostMatrix(
      [
        [0, 0],
        [1, 1],
      ],
      [
        [0, 0],
        [3, 4],
      ],
    );
    expect(c.length).toBe(2);
    expect(c[0]![1]).toBeCloseTo(25, 12);
  });
});

describe('FSRS', () => {
  it('retrievability decays to near zero after long delay', () => {
    expect(retrievability(1_000_000_000, 1000)).toBeCloseTo(0, 12);
  });

  it('retrievability is 1 at zero delay', () => {
    expect(retrievability(0, 1000)).toBeCloseTo(1, 12);
  });

  it('success increases stability, failure decreases it', () => {
    const s0 = { stability: 10, difficulty: 5 };
    const success = review(s0, 'success', 0.5);
    expect(success.stability).toBeGreaterThan(s0.stability);
    const failure = review(s0, 'failure', 0.5);
    expect(failure.stability).toBeLessThan(s0.stability);
  });
});
