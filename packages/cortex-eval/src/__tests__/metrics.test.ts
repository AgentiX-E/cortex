import { describe, it, expect } from 'vitest';
import {
  normalizeAnswer,
  exactMatch,
  computeMetrics,
  aggregate,
  cohensD,
  tTestPValue,
} from '../metrics.js';
import type { BenchmarkDataset, Question } from '../types.js';

const q = (capability: Question['capability'], expected: string | null): Question => ({
  id: `q-${capability}`,
  capability,
  question: 'q',
  expected,
  context: [],
});

describe('normalizeAnswer', () => {
  it('lowercases, trims, and collapses whitespace', () => {
    expect(normalizeAnswer('  New   York ')).toBe('new york');
    expect(normalizeAnswer('Blue')).toBe('blue');
  });
});

describe('exactMatch', () => {
  it('matches case-insensitively', () => {
    expect(exactMatch('Blue', 'blue')).toBe(true);
  });

  it('treats null expected as abstain-only', () => {
    expect(exactMatch(null, null)).toBe(true);
    expect(exactMatch('x', null)).toBe(false);
    expect(exactMatch(null, 'x')).toBe(false);
  });
});

describe('computeMetrics', () => {
  it('throws on answer count mismatch', () => {
    const ds: BenchmarkDataset = { name: 'd', questions: [q('IE', 'x')] };
    expect(() => computeMetrics(ds, [])).toThrow();
  });

  it('computes accuracy and abstention-aware accuracy', () => {
    const ds: BenchmarkDataset = {
      name: 'd',
      questions: [q('IE', 'a'), q('ABS', null)],
    };
    const m = computeMetrics(ds, ['a', null]);
    // Both answers are exact matches (abstention on an ABS question is correct).
    expect(m.accuracy).toBe(1);
    expect(m.abstentionRate).toBeCloseTo(0.5, 12);
    expect(m.abstentionCorrectRate).toBeCloseTo(1, 12);
    expect(m.abstentionAwareAccuracy).toBe(1);
  });

  it('tracks per-capability results', () => {
    const ds: BenchmarkDataset = {
      name: 'd',
      questions: [q('IE', 'a'), q('IE', 'b')],
    };
    const m = computeMetrics(ds, ['a', 'x']);
    expect(m.perCapability['IE'].total).toBe(2);
    expect(m.perCapability['IE'].correct).toBe(1);
    expect(m.perCapability['IE'].accuracy).toBeCloseTo(0.5, 12);
  });

  it('handles an empty dataset', () => {
    const m = computeMetrics({ name: 'd', questions: [] }, []);
    expect(m.accuracy).toBe(0);
    expect(m.abstentionCorrectRate).toBe(0);
  });
});

describe('aggregate', () => {
  it('throws on empty input', () => {
    expect(() => aggregate([])).toThrow();
  });

  it('computes min/max/avg/median', () => {
    const s = aggregate([0.2, 0.8, 0.4]);
    expect(s.min).toBe(0.2);
    expect(s.max).toBe(0.8);
    expect(s.avg).toBeCloseTo(0.4666, 3);
    expect(s.median).toBeCloseTo(0.4, 12);
  });

  it('averages the two middle values for even-length input', () => {
    expect(aggregate([1, 2, 3, 4]).median).toBeCloseTo(2.5, 12);
  });
});

describe('cohensD and tTestPValue', () => {
  it('cohensD returns 0 for fewer than 2 samples', () => {
    expect(cohensD([1], [1, 2])).toBe(0);
  });

  it('cohensD is positive when feature mean exceeds baseline', () => {
    const d = cohensD([0.1, 0.2, 0.15], [0.9, 0.95, 0.85]);
    expect(d).toBeGreaterThan(0);
  });

  it('cohensD returns -Infinity for a perfect negative effect', () => {
    expect(cohensD([1, 1, 1], [0, 0, 0])).toBe(-Infinity);
  });

  it('cohensD returns 0 for identical zero-variance samples', () => {
    expect(cohensD([1, 1, 1], [1, 1, 1])).toBe(0);
  });

  it('tTestPValue is tiny for clearly separated samples', () => {
    expect(tTestPValue([0.1, 0.2, 0.15], [0.9, 0.95, 0.85])).toBeLessThan(0.01);
  });
});
