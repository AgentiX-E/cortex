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
    const res = sinkhorn(
      [0.3, 0.7],
      [0.6, 0.4],
      [
        [0, 1],
        [1, 0],
      ],
      0.5,
    );
    expect(res.cost).toBeGreaterThanOrEqual(0);
    expect(res.iterations).toBeGreaterThan(0);
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
