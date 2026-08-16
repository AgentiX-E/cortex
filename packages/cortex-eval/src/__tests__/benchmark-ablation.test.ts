import { describe, it, expect } from 'vitest';
import { runBenchmark, evaluate } from '../benchmark.js';
import { runAblation } from '../ablation.js';
import { FactMemorySystem } from '../fact-memory.js';
import type { BenchmarkDataset, MemorySystem, Question } from '../types.js';

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
  it('requires at least 1 run', async () => {
    const ds = makeDataset();
    const base = new FactMemorySystem('base');
    const feat = new FactMemorySystem('feat');
    await expect(runAblation(ds, base, feat, { runs: 0 })).rejects.toThrow();
  });

  it('supports a single deterministic run with no statistical test', async () => {
    const ds = makeDataset();
    const baseline = new FactMemorySystem('naive', { fallback: 'unknown' });
    const feature = new FactMemorySystem('abstain', { abstainThreshold: 0.3 });
    const result = await runAblation(ds, baseline, feature, { runs: 1 });
    expect(result.delta).toBeGreaterThan(0);
    expect(Number.isNaN(result.pValue)).toBe(true);
    expect(result.significant).toBe(false);
    expect(result.effectSize).toBe(Infinity);
  });

  it('reports zero effect size when a single run has equal means', async () => {
    const ds = makeDataset();
    const baseline = new FactMemorySystem('b', { fallback: 'unknown' });
    const feature = new FactMemorySystem('f', { fallback: 'unknown' });
    const result = await runAblation(ds, baseline, feature, { runs: 1 });
    expect(result.delta).toBe(0);
    expect(result.effectSize).toBe(0);
  });

  it('reports negative infinite effect size when a single run regresses', async () => {
    const ds = makeDataset();
    // Baseline abstains correctly on the ABS question (overlap 1/6 < 0.2) while
    // answering the IE/KU questions (overlap 0.4); feature never abstains.
    const baseline = new FactMemorySystem('b', { abstainThreshold: 0.2 });
    const feature = new FactMemorySystem('f', { fallback: 'unknown' });
    const result = await runAblation(ds, baseline, feature, { runs: 1 });
    expect(result.delta).toBeLessThan(0);
    expect(result.effectSize).toBe(-Infinity);
  });

  it('reports the improvement with an exact paired McNemar test', async () => {
    const ds = makeDataset();
    // Baseline never abstains: for the ABS question it returns a wrong answer.
    const baseline = new FactMemorySystem('naive', { fallback: 'unknown' });
    // Feature abstains when no fact overlaps the question.
    const feature = new FactMemorySystem('abstain', { abstainThreshold: 0.3 });
    const result = await runAblation(ds, baseline, feature, { runs: 3 });
    expect(result.delta).toBeGreaterThan(0);
    // Deterministic repeats carry no variance, so the over-run t-test is n/a.
    expect(result.significant).toBe(false);
    expect(Number.isNaN(result.pValue)).toBe(true);
    // Exactly one discordant pair (baseline wrong, feature right) is not enough
    // for the paired McNemar test to reach significance on a three-question set.
    expect(result.discordant.baselineCorrectFeatureIncorrect).toBe(0);
    expect(result.discordant.baselineIncorrectFeatureCorrect).toBe(1);
    expect(result.mcnemarPValue).toBeCloseTo(1, 12);
    expect(result.mcnemarSignificant).toBe(false);
  });

  it('uses default options when none are provided', async () => {
    const ds = makeDataset();
    const baseline = new FactMemorySystem('naive', { fallback: 'unknown' });
    const feature = new FactMemorySystem('abstain', { abstainThreshold: 0.3 });
    const result = await runAblation(ds, baseline, feature);
    expect(result.delta).toBeGreaterThan(0);
    expect(result.mcnemarSignificant).toBe(false);
    expect(result.baselineConfidence.lower).toBeLessThanOrEqual(result.baselineConfidence.upper);
    expect(result.featureConfidence.lower).toBeLessThanOrEqual(result.featureConfidence.upper);
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

  it('reports a t-test only when stochastic runs introduce variance', async () => {
    const ds: BenchmarkDataset = {
      name: 'stochastic',
      questions: [
        {
          id: 'q',
          capability: 'KU',
          question: 'Is the answer yes?',
          expected: 'yes',
          context: ['yes'],
        },
      ],
    };
    // The stochastic system alternates correct/wrong across runs, so its run
    // scores have real variance; the deterministic baseline stays constant.
    let flip = false;
    const stochastic: MemorySystem = {
      name: 'stochastic',
      answer: async () => {
        flip = !flip;
        return flip ? 'yes' : 'no';
      },
    };
    const deterministic: MemorySystem = {
      name: 'deterministic',
      answer: async () => 'no',
    };
    const result = await runAblation(ds, deterministic, stochastic, { runs: 3 });
    // Real variance → the over-run Welch t-test is defined (non-NaN p-value).
    expect(Number.isNaN(result.pValue)).toBe(false);
    expect(Number.isFinite(result.effectSize)).toBe(true);
  });
});
