import { describe, it, expect } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';
import { runAblationReport, formatAblationReport } from '../report.js';
import {
  runEmbeddingBenchmark,
  runMrAggregationAblation,
  runNaturalLanguageBenchmark,
} from '../runner.js';
import type { AnswerJudge } from '../judge.js';
import { createEmbeddingFromEnv } from '../embedding-factory.js';
import { createLlmFromEnv } from '../llm-factory.js';
import { OpenAIEmbedding } from '@agentix-e/cortex-llm';
import { HashEmbedding } from '../embedding.js';
import { FactMemorySystem } from '../fact-memory.js';
import { createLongMemEvalMini } from '../datasets/longmemeval-mini.js';
import type { LongMemEvalInstance } from '../datasets/longmemeval-loader.js';
import type { MemorySystem } from '../types.js';

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
    expect(report.ablation.mcnemarSignificant).toBe(false);
  });

  it('evaluates each system exactly once (no double evaluation)', async () => {
    const ds = createLongMemEvalMini();
    let baselineCalls = 0;
    let featureCalls = 0;
    const baseline: MemorySystem = {
      name: 'counting-baseline',
      answer: async () => {
        baselineCalls++;
        return 'blue';
      },
    };
    const feature: MemorySystem = {
      name: 'counting-feature',
      answer: async () => {
        featureCalls++;
        return 'blue';
      },
    };
    await runAblationReport(ds, baseline, feature, { runs: 1 });
    // Each question is answered once per system, not once in the ablation and
    // again for the report metrics.
    expect(baselineCalls).toBe(ds.questions.length);
    expect(featureCalls).toBe(ds.questions.length);
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

  it('renders negative delta, McNemar significance, and a defined t-test', async () => {
    const base = await runAblationReport(
      createLongMemEvalMini(),
      new FactMemorySystem('naive', { fallback: 'unknown' }),
      new FactMemorySystem('abstain', { abstainThreshold: 0.3 }),
      { runs: 3 },
    );
    const md = formatAblationReport({
      ...base,
      ablation: {
        ...base.ablation,
        delta: -0.25,
        pValue: 0.001,
        significant: true,
        mcnemarPValue: 0.03125,
        mcnemarSignificant: true,
        discordant: { baselineCorrectFeatureIncorrect: 0, baselineIncorrectFeatureCorrect: 6 },
      },
    });
    // A negative delta renders without a spurious "+" sign.
    expect(md).toContain('-25.00%');
    expect(md).toContain('significant: yes');
    expect(md).toContain('1.000e-3');
    expect(md).toContain('3.125e-2');
    expect(md).toContain('baseline-wrong/feature-correct = 6');
  });

  it('renders the per-capability significance yes/no label', async () => {
    const base = await runAblationReport(
      createLongMemEvalMini(),
      new FactMemorySystem('naive', { fallback: 'unknown' }),
      new FactMemorySystem('abstain', { abstainThreshold: 0.3 }),
      { runs: 1 },
    );
    const mr = base.ablation.perCapability['MR']!;
    const md = formatAblationReport({
      ...base,
      ablation: {
        ...base.ablation,
        perCapability: {
          ...base.ablation.perCapability,
          MR: { ...mr, mcnemarSignificant: true },
        },
      },
    });
    expect(md).toContain('## Per-capability paired significance');
    expect(md).toContain('| MR |');
    expect(md).toContain('| yes |');
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
    expect(embedding).toBeInstanceOf(OpenAIEmbedding);
    expect(embedding.dimension()).toBe(1536);
  });

  it('uses Zhipu embedding-3 defaults with ZHIPU_API_KEY', () => {
    const embedding = createEmbeddingFromEnv({ ZHIPU_API_KEY: 'zhipu-key' });
    expect(embedding).toBeInstanceOf(OpenAIEmbedding);
    expect(embedding.dimension()).toBe(1024);
  });

  it('falls back to HashEmbedding when credentials are missing', () => {
    const embedding = createEmbeddingFromEnv({});
    expect(embedding).toBeInstanceOf(HashEmbedding);
  });

  it('falls back when the dimension is invalid', () => {
    const embedding = createEmbeddingFromEnv({
      ZHIPU_API_KEY: 'k',
      EMBEDDING_DIMENSIONS: 'not-a-number',
    });
    expect(embedding).toBeInstanceOf(HashEmbedding);
  });
});

describe('createLlmFromEnv', () => {
  it('throws when DEEPSEEK_API_KEY is missing', () => {
    expect(() => createLlmFromEnv({})).toThrow(/DEEPSEEK_API_KEY/);
  });

  it('returns an OpenAI-compatible LLM for DeepSeek', () => {
    const llm = createLlmFromEnv({ DEEPSEEK_API_KEY: 'deepseek-key' });
    expect(typeof llm.complete).toBe('function');
    expect(typeof llm.completeStructured).toBe('function');
  });
});

describe('formatAblationReport single deterministic run', () => {
  it('labels the p-value as n/a when runs are deterministic', async () => {
    const ds = createLongMemEvalMini();
    const baseline = new FactMemorySystem('naive', { fallback: 'unknown' });
    const feature = new FactMemorySystem('abstain', { abstainThreshold: 0.3 });
    const report = await runAblationReport(ds, baseline, feature, { runs: 1 });
    const md = formatAblationReport(report);
    expect(Number.isNaN(report.ablation.pValue)).toBe(true);
    expect(md).toContain('n/a (deterministic)');
  });
});

describe('runNaturalLanguageBenchmark', () => {
  const embedding = new HashEmbedding(64);
  const llm: LLM = {
    complete: async (prompt) => (prompt.includes('color') ? 'blue' : 'UNANSWERABLE'),
    completeStructured: async <T>() => ({}) as T,
  };

  it('runs a natural-language ablation and returns a report', async () => {
    const { report, markdown } = await runNaturalLanguageBenchmark(instances, embedding, llm, {
      abstainThreshold: 0.5,
      runs: 1,
    });
    expect(report.questionCount).toBe(2);
    expect(markdown).toContain('Cortex Benchmark Report');
    expect(markdown).toContain('n/a (deterministic)');
  });

  it('uses default threshold and runs when options are omitted', async () => {
    const { report } = await runNaturalLanguageBenchmark(instances, embedding, llm);
    expect(report.questionCount).toBe(2);
    expect(report.ablation.featureAggregate.avg).toBeGreaterThanOrEqual(0);
  });

  it('passes the configured temperature through to the LLM', async () => {
    const temperatures: number[] = [];
    const capturingLlm: LLM = {
      complete: async (_prompt, opts) => {
        temperatures.push(opts?.temperature ?? Number.NaN);
        return 'blue';
      },
      completeStructured: async <T>() => ({}) as T,
    };
    await runNaturalLanguageBenchmark(instances, embedding, capturingLlm, {
      temperature: 0.7,
      runs: 1,
    });
    expect(temperatures.length).toBeGreaterThan(0);
    expect(temperatures.every((t) => t === 0.7)).toBe(true);
  });

  it('forwards the onDecision callback for per-question tracing', async () => {
    const questions: string[] = [];
    await runNaturalLanguageBenchmark(instances, embedding, llm, {
      runs: 1,
      onDecision: (trace) => questions.push(trace.question),
    });
    expect(questions.length).toBeGreaterThan(0);
  });
});

describe('runMrAggregationAblation', () => {
  const embedding = new HashEmbedding(64);
  const llm: LLM = {
    complete: async (prompt) => (prompt.includes('favorite color') ? 'blue' : 'UNANSWERABLE'),
    completeStructured: async <T>() => ({}) as T,
  };

  const mrInstances: LongMemEvalInstance[] = [
    {
      question_id: 'mr-1',
      question_type: 'multi-session',
      question: 'What is the favorite color?',
      answer: 'blue',
      haystack_sessions: [
        [{ role: 'user', content: 'My favorite color is blue.' }],
        [{ role: 'user', content: 'unrelated' }],
      ],
      answer_session_ids: [],
    },
    {
      question_id: 'ie-1',
      question_type: 'single-session-user',
      question: 'What is the favorite color?',
      answer: 'blue',
      haystack_sessions: [[{ role: 'user', content: 'favorite color=blue' }]],
    },
  ];

  it('isolates MR questions only and labels the prompt variants', async () => {
    // Omit runs so the single-deterministic-run default is exercised.
    const { report, markdown } = await runMrAggregationAblation(mrInstances, embedding, llm);
    expect(report.questionCount).toBe(1);
    expect(report.baseline.name).toBe('mr-legacy-aggregation');
    expect(report.feature.name).toBe('mr-cot-aggregation');
    expect(markdown).toContain('Cortex Benchmark Report');
  });

  it('forwards temperature and a custom judge through the MR ablation', async () => {
    const temperatures: number[] = [];
    const capturingLlm: LLM = {
      complete: async (_prompt, opts) => {
        temperatures.push(opts?.temperature ?? Number.NaN);
        return 'blue';
      },
      completeStructured: async <T>() => ({}) as T,
    };
    const judgeQuestions: string[] = [];
    const judge: AnswerJudge = async (question, predicted, expected) => {
      judgeQuestions.push(question);
      return predicted === expected;
    };
    const { report } = await runMrAggregationAblation(mrInstances, embedding, capturingLlm, {
      runs: 2,
      temperature: 0.6,
      judge,
    });
    expect(report.questionCount).toBe(1);
    expect(temperatures.every((t) => t === 0.6)).toBe(true);
    expect(judgeQuestions.length).toBeGreaterThan(0);
  });
});
