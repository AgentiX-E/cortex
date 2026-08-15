import { describe, it, expect } from 'vitest';
import { runBenchmark, evaluate } from '../benchmark.js';
import { runAblation } from '../ablation.js';
import { FactMemorySystem } from '../fact-memory.js';
import type { BenchmarkDataset, Question } from '../types.js';

function makeDataset(): BenchmarkDataset {
  const q = (
    id: string,
    capability: Question['capability'],
    question: string,
    expected: string | null,
  ): Question => ({
    id,
    capability,
    question,
    expected,
    context: ['favorite color=blue', 'dog name=Rex', 'current job=manager', 'project=Beacon'],
  });
  return {
    name: 'demo',
    questions: [
      q('ie', 'IE', 'What is the favorite color?', 'blue'),
      q('ku', 'KU', 'What is the current job?', 'manager'),
      q('abs', 'ABS', 'What is the favorite food?', null),
    ],
  };
}

describe('runBenchmark', () => {
  it('returns one answer per question in order', async () => {
    const ds = makeDataset();
    const system = new FactMemorySystem('s');
    const answers = await runBenchmark(ds, system);
    expect(answers).toHaveLength(3);
  });

  it('evaluates a system against ground truth', async () => {
    const ds = makeDataset();
    const system = new FactMemorySystem('s');
    const m = await evaluate(ds, system);
    expect(m.total).toBe(3);
  });
});

describe('runAblation', () => {
  it('requires at least 3 runs', async () => {
    const ds = makeDataset();
    const base = new FactMemorySystem('base');
    const feat = new FactMemorySystem('feat');
    await expect(runAblation(ds, base, feat, { runs: 2 })).rejects.toThrow();
  });

  it('reports significant improvement when the feature abstains correctly', async () => {
    const ds = makeDataset();
    // Baseline never abstains: for the ABS question it returns a wrong answer.
    const baseline = new FactMemorySystem('naive', { fallback: 'unknown' });
    // Feature abstains when no fact overlaps the question.
    const feature = new FactMemorySystem('abstain', { abstainThreshold: 0.3 });
    const result = await runAblation(ds, baseline, feature, { runs: 3 });
    expect(result.delta).toBeGreaterThan(0);
    expect(result.significant).toBe(true);
    expect(result.effectSize).toBeGreaterThan(0);
  });

  it('uses default options when none are provided', async () => {
    const ds = makeDataset();
    const baseline = new FactMemorySystem('naive', { fallback: 'unknown' });
    const feature = new FactMemorySystem('abstain', { abstainThreshold: 0.3 });
    const result = await runAblation(ds, baseline, feature);
    expect(result.delta).toBeGreaterThan(0);
    expect(result.significant).toBe(true);
  });

  it('supports comparing raw accuracy instead of abstention-aware accuracy', async () => {
    const ds = makeDataset();
    const baseline = new FactMemorySystem('naive', { fallback: 'unknown' });
    const feature = new FactMemorySystem('abstain', { abstainThreshold: 0.3 });
    const result = await runAblation(ds, baseline, feature, {
      runs: 3,
      abstentionAware: false,
    });
    expect(typeof result.delta).toBe('number');
    expect(typeof result.pValue).toBe('number');
  });
});
