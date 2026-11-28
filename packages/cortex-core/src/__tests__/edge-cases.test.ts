import { describe, it, expect } from 'vitest';
import { normalize, cosineSimilarity, l2Distance } from '../math/vector.js';
import { sinkhorn } from '../math/ot.js';
import { retrievability, initialFsrsState } from '../math/fsrs.js';

describe('vector edge cases', () => {
  it('normalize of zero vector returns the zero vector', () => {
    const v = normalize(new Float64Array([0, 0]));
    expect(v[0]).toBe(0);
    expect(v[1]).toBe(0);
  });

  it('cosine similarity with zero vector is 0', () => {
    expect(cosineSimilarity(new Float64Array([0, 0]), new Float64Array([1, 1]))).toBe(0);
  });

  it('l2 distance throws on dimension mismatch', () => {
    expect(() => l2Distance(new Float64Array([1]), new Float64Array([1, 2]))).toThrow();
  });
});

describe('optimal transport edge cases', () => {
  it('throws on empty histogram', () => {
    expect(() => sinkhorn([], [1], [[1]], 0.1)).toThrow();
  });

  it('throws on cost matrix shape mismatch', () => {
    expect(() => sinkhorn([1], [1], [[1, 2]], 0.1)).toThrow();
  });

  it('converges on a small non-trivial case', () => {
    const a = [0.3, 0.7];
    const b = [0.6, 0.4];
    const res = sinkhorn(
      a,
      b,
      [
        [0, 1],
        [1, 0],
      ],
      0.5,
    );
    // The old assertions (`cost >= 0`, `iterations > 0`) held for any non-negative transport plan,
    // so an implementation that returned a wrong coupling with a positive cost passed. What the
    // solver promises is a coupling with the two requested marginals, converged, at a real cost.
    expect(res.converged).toBe(true);
    const rowSums = a.map((_, i) => b.reduce((sum, _j, j) => sum + res.coupling.get(i, j)!, 0));
    const colSums = b.map((_, j) => a.reduce((sum, _i, i) => sum + res.coupling.get(i, j)!, 0));
    rowSums.forEach((sum, i) => expect(sum).toBeCloseTo(a[i]!, 6));
    colSums.forEach((sum, j) => expect(sum).toBeCloseTo(b[j]!, 6));
    // The cheap diagonal is cost 0 and the expensive off-diagonal is 1; the optimal plan pays to
    // move the 0.3/0.6 overlap and 0.3 of the other mass, which is strictly inside [0, 1].
    expect(res.cost).toBeGreaterThan(0);
    expect(res.cost).toBeLessThan(1);
  });
});

describe('FSRS edge cases', () => {
  it('retrievability with non-positive stability is 0', () => {
    expect(retrievability(100, 0)).toBe(0);
    expect(retrievability(100, -5)).toBe(0);
  });

  it('initialFsrsState returns valid state', () => {
    const s = initialFsrsState();
    expect(s.stability).toBeGreaterThan(0);
    expect(s.difficulty).toBeGreaterThanOrEqual(1);
    expect(s.difficulty).toBeLessThanOrEqual(10);
  });
});
