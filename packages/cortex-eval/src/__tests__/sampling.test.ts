import { describe, it, expect } from 'vitest';
import { cohortCoverage, sampleInstances } from '../datasets/sampling.js';
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

  it('separates single-session sub-types so a small sample is representative', () => {
    const list = [
      inst('u1', 'single-session-user'),
      inst('u2', 'single-session-user'),
      inst('u3', 'single-session-user'),
      inst('a1', 'single-session-assistant'),
      inst('p1', 'single-session-preference'),
    ];
    const sampled = sampleInstances(list, 3);
    const types = sampled.map((s) => s.question_type);
    // The three sub-types are bucketed separately, so the sample contains one
    // of each instead of three single-session-user instances.
    expect(new Set(types).size).toBe(3);
  });
});

describe('cohortCoverage', () => {
  it('reports full coverage when every required id is present', () => {
    const sample = [inst('a', 'multi-session'), inst('b', 'multi-session')];
    const coverage = cohortCoverage(sample, ['a', 'b']);
    expect(coverage.present).toEqual(['a', 'b']);
    expect(coverage.missing).toEqual([]);
    expect(coverage.ratio).toBe(1);
  });

  it('names each missing id instead of returning only a count', () => {
    const sample = [inst('a', 'multi-session')];
    const coverage = cohortCoverage(sample, ['a', 'b', 'c']);
    expect(coverage.present).toEqual(['a']);
    expect(coverage.missing).toEqual(['b', 'c']);
    expect(coverage.ratio).toBeCloseTo(1 / 3);
  });

  it('treats an empty requirement as fully covered rather than dividing by zero', () => {
    const coverage = cohortCoverage([inst('a', 'multi-session')], []);
    expect(coverage.ratio).toBe(1);
    expect(coverage.present).toEqual([]);
    expect(coverage.missing).toEqual([]);
  });

  it('preserves required order rather than sample order', () => {
    // The sample lists the required ids in the opposite order. A coverage report
    // whose `present` follows the sample would make two runs with the same
    // cohort print different strings, which defeats diffing them.
    const sample = [inst('b', 'multi-session'), inst('a', 'multi-session')];
    expect(cohortCoverage(sample, ['a', 'b']).present).toEqual(['a', 'b']);
  });

  it('exposes the measured LongMemEval-S shortfall at limit=60', () => {
    // The concrete defect the guard exists for: a proportional round-robin
    // sample of the real dataset keeps one of the seven conjunctive ABS
    // questions. The members are spread across the `ABS` and `TR` buckets, so a
    // 60-item sample reaches only the first. Reproduced here rather than
    // asserted from the dataset file so the test stays hermetic.
    const list: LongMemEvalInstance[] = [];
    for (let i = 0; i < 20; i++) list.push(inst(`u${i}`, 'single-session-user'));
    for (let i = 0; i < 20; i++) list.push(inst(`s${i}`, 'multi-session'));
    list.push(inst('80ec1f4f_abs', 'multi-session'));
    for (let i = 0; i < 20; i++) list.push(inst(`t${i}`, 'temporal-reasoning'));
    const covering = ['80ec1f4f_abs'];
    const cohort = [...covering];
    const small = sampleInstances(list, 10);
    const large = sampleInstances(list, 0);

    expect(cohortCoverage(small, cohort).present).toEqual(covering);
    expect(cohortCoverage(large, cohort).ratio).toBe(1);
  });
});
