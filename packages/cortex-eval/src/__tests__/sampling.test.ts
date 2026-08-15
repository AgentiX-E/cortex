import { describe, it, expect } from 'vitest';
import { sampleInstances } from '../datasets/sampling.js';
import type { LongMemEvalInstance } from '../datasets/longmemeval-loader.js';

function inst(id: string, type: string): LongMemEvalInstance {
  return { question_id: id, question_type: type, question: id, answer: 'x' };
}

describe('sampleInstances', () => {
  it('returns the full list when limit is zero or covers everything', () => {
    const list = [inst('a', 'single-session-user'), inst('b', 'knowledge-update')];
    expect(sampleInstances(list, 0)).toHaveLength(2);
    expect(sampleInstances(list, 10)).toHaveLength(2);
  });

  it('keeps abstention questions represented in small samples', () => {
    const list = [
      inst('q1', 'single-session-user'),
      inst('q2', 'single-session-user'),
      inst('q3', 'single-session-user'),
      inst('q4_abs', 'single-session-user'),
      inst('q5_abs', 'single-session-user'),
    ];
    const sampled = sampleInstances(list, 3);
    const ids = sampled.map((s) => s.question_id);
    expect(sampled).toHaveLength(3);
    // Round-robin pulls one IE, one ABS, then one IE.
    expect(ids).toContain('q1');
    expect(ids).toContain('q4_abs');
  });

  it('round-robins across capability buckets', () => {
    const list = [
      inst('a1', 'single-session-user'),
      inst('b1', 'knowledge-update'),
      inst('c1', 'multi-session'),
      inst('a2', 'single-session-user'),
      inst('b2', 'knowledge-update'),
      inst('c2', 'multi-session'),
    ];
    const sampled = sampleInstances(list, 4);
    // One from each of the first three buckets, then wrapping to the first.
    const types = sampled.map((s) => s.question_type);
    expect(new Set(types.slice(0, 3)).size).toBe(3);
    expect(sampled).toHaveLength(4);
  });
});
