import { describe, it, expect } from 'vitest';
import { createLongMemEvalMini } from '../datasets/longmemeval-mini.js';
import * as cortexEval from '../index.js';

describe('createLongMemEvalMini', () => {
  it('returns a well-formed dataset', () => {
    const ds = createLongMemEvalMini();
    expect(ds.name).toBe('longmemeval-mini');
    expect(ds.questions.length).toBeGreaterThan(0);
    for (const q of ds.questions) {
      expect(q.id).toBeTruthy();
      expect(q.context.length).toBeGreaterThan(0);
      expect(['IE', 'MR', 'KU', 'TR', 'ABS']).toContain(q.capability);
    }
  });

  it('covers all five capabilities', () => {
    const ds = createLongMemEvalMini();
    const caps = new Set(ds.questions.map((q) => q.capability));
    expect(caps).toEqual(new Set(['IE', 'MR', 'KU', 'TR', 'ABS']));
  });

  it('marks abstention questions with null expected', () => {
    const ds = createLongMemEvalMini();
    for (const q of ds.questions.filter((x) => x.capability === 'ABS')) {
      expect(q.expected).toBeNull();
    }
  });
});

describe('package exports', () => {
  it('exposes the evaluation API surface', () => {
    expect(typeof cortexEval.computeMetrics).toBe('function');
    expect(typeof cortexEval.runBenchmark).toBe('function');
    expect(typeof cortexEval.runAblation).toBe('function');
    expect(typeof cortexEval.FactMemorySystem).toBe('function');
    expect(typeof cortexEval.createLongMemEvalMini).toBe('function');
  });
});
