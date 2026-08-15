import { describe, it, expect } from 'vitest';
import { runAblationReport, formatAblationReport } from '../report.js';
import { runEmbeddingBenchmark } from '../runner.js';
import { createEmbeddingFromEnv } from '../embedding-factory.js';
import { HashEmbedding } from '../embedding.js';
import { FactMemorySystem } from '../fact-memory.js';
import { createLongMemEvalMini } from '../datasets/longmemeval-mini.js';
import type { LongMemEvalInstance } from '../datasets/longmemeval-loader.js';

const instances: LongMemEvalInstance[] = [
  {
    question_id: 'q1',
    question_type: 'single-session-user',
    question: 'What is the favorite color?',
    answer: 'blue',
    haystack_sessions: [[{ role: 'user', content: 'favorite color=blue' }]],
  },
  {
    question_id: 'q2_abs',
    question_type: 'single-session-user',
    question: 'What is the phone number?',
    answer: '',
    haystack_sessions: [[{ role: 'user', content: 'favorite color=blue' }]],
  },
];

describe('runAblationReport', () => {
  it('produces a report with ablation and per-capability metrics', async () => {
    const ds = createLongMemEvalMini();
    const baseline = new FactMemorySystem('naive', { fallback: 'unknown' });
    const feature = new FactMemorySystem('abstain', { abstainThreshold: 0.3 });
    const report = await runAblationReport(ds, baseline, feature, { runs: 3 });
    expect(report.dataset).toBe('longmemeval-mini');
    expect(report.questionCount).toBe(ds.questions.length);
    expect(report.ablation.delta).toBeGreaterThan(0);
    expect(report.feature.metrics.perCapability['ABS']).toBeDefined();
  });

  it('forwards all ablation options when provided', async () => {
    const ds = createLongMemEvalMini();
    const baseline = new FactMemorySystem('naive', { fallback: 'unknown' });
    const feature = new FactMemorySystem('abstain', { abstainThreshold: 0.3 });
    const report = await runAblationReport(ds, baseline, feature, {
      runs: 3,
      alpha: 0.01,
      abstentionAware: false,
    });
    expect(report.ablation.delta).toBeGreaterThan(0);
    expect(report.ablation.significant).toBe(true);
  });
});

describe('formatAblationReport', () => {
  it('renders a Markdown report', async () => {
    const ds = createLongMemEvalMini();
    const baseline = new FactMemorySystem('naive', { fallback: 'unknown' });
    const feature = new FactMemorySystem('abstain', { abstainThreshold: 0.3 });
    const report = await runAblationReport(ds, baseline, feature, { runs: 3 });
    const md = formatAblationReport(report);
    expect(md).toContain('# Cortex Benchmark Report');
    expect(md).toContain('Δ accuracy');
    expect(md).toContain('Welch t-test p-value');
  });

  it('renders positive and negative infinite effect sizes', async () => {
    const base = await runAblationReport(
      createLongMemEvalMini(),
      new FactMemorySystem('naive', { fallback: 'unknown' }),
      new FactMemorySystem('abstain', { abstainThreshold: 0.3 }),
      { runs: 3 },
    );
    const posInf = formatAblationReport({
      ...base,
      ablation: { ...base.ablation, effectSize: Infinity },
    });
    expect(posInf).toContain('+∞');
    const negInf = formatAblationReport({
      ...base,
      ablation: { ...base.ablation, effectSize: -Infinity },
    });
    expect(negInf).toContain('-∞');
    const finite = formatAblationReport({
      ...base,
      ablation: { ...base.ablation, effectSize: 0.42 },
    });
    expect(finite).toContain('0.420');
  });
});

describe('runEmbeddingBenchmark', () => {
  it('runs an embedding ablation and returns a report', async () => {
    const embedding = new HashEmbedding(64);
    const { report, markdown } = await runEmbeddingBenchmark(instances, embedding, {
      abstainThreshold: 0.5,
      runs: 3,
    });
    expect(report.questionCount).toBe(2);
    expect(markdown).toContain('Cortex Benchmark Report');
  });

  it('uses default threshold and runs when options are omitted', async () => {
    const embedding = new HashEmbedding(64);
    const { report } = await runEmbeddingBenchmark(instances, embedding);
    expect(report.questionCount).toBe(2);
    expect(report.ablation.featureAggregate.avg).toBeGreaterThanOrEqual(0);
  });
});

describe('createEmbeddingFromEnv', () => {
  it('returns OpenAIEmbedding when API credentials are present', () => {
    const embedding = createEmbeddingFromEnv({
      EMBEDDING_API_KEY: 'k',
      EMBEDDING_BASE_URL: 'https://api.example.com/v1',
      EMBEDDING_MODEL: 'text-embedding-3-small',
      EMBEDDING_DIMENSIONS: '1536',
    });
    expect(embedding.dimension()).toBe(1536);
  });

  it('falls back to HashEmbedding when credentials are missing', () => {
    const embedding = createEmbeddingFromEnv({});
    expect(embedding).toBeInstanceOf(HashEmbedding);
  });

  it('falls back when the dimension is invalid', () => {
    const embedding = createEmbeddingFromEnv({
      EMBEDDING_API_KEY: 'k',
      EMBEDDING_BASE_URL: 'https://api.example.com/v1',
      EMBEDDING_MODEL: 'm',
      EMBEDDING_DIMENSIONS: 'not-a-number',
    });
    expect(embedding).toBeInstanceOf(HashEmbedding);
  });
});
