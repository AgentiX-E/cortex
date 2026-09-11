import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import type { LLM } from '@agentix-e/cortex-core';
import { runAblationReport, formatAblationReport } from '../report.js';
import {
  runEmbeddingBenchmark,
  runMrAggregationAblation,
  runNaturalLanguageBenchmark,
  runTemporalEngineAblation,
  runTimeWindowAnnotationAblation,
  runDeterministicCoverageAblation,
  runBitemporalKnowledgeUpdateAblation,
} from '../runner.js';
import type { AnswerJudge } from '../judge.js';
import { createEmbeddingFromEnv } from '../embedding-factory.js';
import { createLlmFromEnv, resolveTimeoutMs } from '../llm-factory.js';
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

describe('resolveTimeoutMs', () => {
  it('extends the per-attempt deadline for thinking mode', () => {
    expect(resolveTimeoutMs({ type: 'enabled' })).toBe(300_000);
  });

  it('keeps the default deadline for non-thinking mode', () => {
    expect(resolveTimeoutMs({ type: 'disabled' })).toBeUndefined();
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

  it('disables DeepSeek thinking by default so V4-Pro answers on the fast non-reasoning path', async () => {
    let captured: Record<string, unknown> | null = null;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        captured = JSON.parse(body) as Record<string, unknown>;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    try {
      const llm = createLlmFromEnv({
        DEEPSEEK_API_KEY: 'k',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${addr.port}/v1`,
        DEEPSEEK_MODEL: 'deepseek-v4-pro',
      });
      await llm.complete('hi');
      expect(captured!['thinking']).toEqual({ type: 'disabled' });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it('opts back into thinking when DEEPSEEK_THINKING=enabled', async () => {
    let captured: Record<string, unknown> | null = null;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        captured = JSON.parse(body) as Record<string, unknown>;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    try {
      const llm = createLlmFromEnv({
        DEEPSEEK_API_KEY: 'k',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${addr.port}/v1`,
        DEEPSEEK_MODEL: 'deepseek-v4-pro',
        DEEPSEEK_THINKING: 'enabled',
      });
      await llm.complete('hi');
      expect(captured!['thinking']).toEqual({ type: 'enabled' });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
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
        // A non-exact answer forces the judge path (exact matches are now
        // short-circuited without consulting the judge).
        return 'green';
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

describe('runTemporalEngineAblation', () => {
  const embedding = new HashEmbedding(64);

  // An ordering question reaches the LLM judge (it is not a "how many" counting
  // question), so the judge-forwarding test below can assert the judge is used.
  const trInstances: LongMemEvalInstance[] = [
    {
      question_id: 'tr-1',
      question_type: 'temporal-reasoning',
      question: "Which event happened first, my cousin's wedding or Michael's engagement party?",
      answer: "Michael's engagement party",
      question_date: '2023/10/01',
      haystack_sessions: [
        [
          {
            role: 'user',
            content: "I attended my cousin's wedding and Michael's engagement party.",
          },
        ],
      ],
      haystack_dates: ['2023/05/15'],
    },
    {
      question_id: 'ie-1',
      question_type: 'single-session-user',
      question: 'What is the favorite color?',
      answer: 'blue',
      haystack_sessions: [[{ role: 'user', content: 'favorite color=blue' }]],
    },
  ];

  const eventsLlm: LLM = {
    complete: async (prompt) => (prompt.includes('Specific events:') ? 'receive chandelier' : '4'),
    completeStructured: async <T>() =>
      ({
        events: [
          { name: "my cousin's wedding", date: '2023/05/15' },
          { name: "Michael's engagement party", date: '2023/04/06' },
        ],
      }) as T,
  };

  it('isolates TR questions only and labels the engine variants', async () => {
    const { report, markdown } = await runTemporalEngineAblation(trInstances, embedding, eventsLlm);
    expect(report.questionCount).toBe(1);
    expect(report.baseline.name).toBe('tr-llm-temporal');
    expect(report.feature.name).toBe('tr-deterministic-temporal');
    expect(markdown).toContain('Cortex Benchmark Report');
  });

  it('forwards temperature and a custom judge through the temporal ablation', async () => {
    const temperatures: number[] = [];
    const capturingLlm: LLM = {
      complete: async (_prompt, opts) => {
        temperatures.push(opts?.temperature ?? Number.NaN);
        return '4';
      },
      completeStructured: async <T>() =>
        ({
          events: [
            { name: "my cousin's wedding", date: '2023/05/15' },
            { name: "Michael's engagement party", date: '2023/04/06' },
          ],
        }) as T,
    };
    const judgeQuestions: string[] = [];
    const judge: AnswerJudge = async (question, predicted, expected) => {
      judgeQuestions.push(question);
      return predicted === expected;
    };
    const { report } = await runTemporalEngineAblation(trInstances, embedding, capturingLlm, {
      runs: 2,
      temperature: 0.6,
      judge,
    });
    expect(report.questionCount).toBe(1);
    expect(temperatures.every((t) => t === 0.6)).toBe(true);
    expect(judgeQuestions.length).toBeGreaterThan(0);
  });
});

describe('runTimeWindowAnnotationAblation', () => {
  const embedding = new HashEmbedding(64);

  // A weekday-anchored lookup question: "last Saturday" resolves through the
  // extended engine, so the annotation has a window to measure against.
  const trInstances: LongMemEvalInstance[] = [
    {
      question_id: 'tr-window-1',
      question_type: 'temporal-reasoning',
      question: 'Who did I receive the jewelry from last Saturday?',
      answer: 'my aunt',
      question_date: '2023/04/10',
      haystack_sessions: [
        [
          { role: 'user', content: 'I received a crystal chandelier from my aunt.' },
          { role: 'user', content: 'I bought wire-wrapped jewelry-making tools.' },
        ],
      ],
      haystack_dates: ['2023/04/08', '2023/03/04'],
    },
    {
      question_id: 'ie-1',
      question_type: 'single-session-user',
      question: 'What is the favorite color?',
      answer: 'blue',
      haystack_sessions: [[{ role: 'user', content: 'favorite color=blue' }]],
    },
  ];

  const llm: LLM = {
    complete: async () => 'my aunt',
    completeStructured: async <T>() => ({ events: [] }) as T,
  };

  it('isolates dated TR questions only and labels the annotation variants', async () => {
    const { report, markdown } = await runTimeWindowAnnotationAblation(trInstances, embedding, llm);
    // The IE question has no question_date, so it is excluded from the arm.
    expect(report.questionCount).toBe(1);
    expect(report.baseline.name).toBe('tr-no-time-window');
    expect(report.feature.name).toBe('tr-time-window');
    expect(markdown).toContain('Cortex Benchmark Report');
  });

  it('shows the annotation in the prompt but not in the control arm', async () => {
    const prompts: string[] = [];
    const capturingLlm: LLM = {
      complete: async (prompt) => {
        prompts.push(prompt);
        return 'my aunt';
      },
      completeStructured: async <T>() => ({ events: [] }) as T,
    };
    await runTimeWindowAnnotationAblation(trInstances, embedding, capturingLlm);
    // Both arms are evaluated, so the rendered field appears in exactly the
    // annotated arm's prompt — this is what makes the delta attributable to the
    // label rather than to the retrieval stack, which both arms share.
    expect(prompts.some((p) => p.includes('"timeWindow":'))).toBe(true);
    expect(prompts.some((p) => !p.includes('"timeWindow":'))).toBe(true);
  });

  it('forwards a custom judge and temperature through the ablation', async () => {
    const temperatures: number[] = [];
    const capturingLlm: LLM = {
      complete: async (_prompt, opts) => {
        temperatures.push(opts?.temperature ?? Number.NaN);
        // Deliberately NOT the expected answer: an exact match short-circuits
        // the scorer before the judge, so the answer must be a paraphrase for
        // this test to observe the judge being consulted at all.
        return 'my beloved aunt';
      },
      completeStructured: async <T>() => ({ events: [] }) as T,
    };
    const judgeQuestions: string[] = [];
    const judge: AnswerJudge = async (question, predicted, expected) => {
      judgeQuestions.push(question);
      return predicted.includes(expected) || expected.includes(predicted);
    };
    const { report } = await runTimeWindowAnnotationAblation(trInstances, embedding, capturingLlm, {
      runs: 2,
      temperature: 0.6,
      judge,
    });
    expect(report.questionCount).toBe(1);
    expect(temperatures.every((t) => t === 0.6)).toBe(true);
    expect(judgeQuestions.length).toBeGreaterThan(0);
  });
});

describe('runDeterministicCoverageAblation', () => {
  const embedding = new HashEmbedding(64);

  const trInstances: LongMemEvalInstance[] = [
    {
      question_id: 'tr-cover-1',
      question_type: 'temporal-reasoning',
      // An eventLookup question: `computeTemporalAnswer` returns null for this
      // kind by construction, so the LLM (and therefore the judge) is always
      // reached. A counting question would be graded numerically and an
      // ordering/interval question with two extractable events would be answered
      // by the engine; neither can observe judge forwarding.
      question: 'Where did I attend the wedding two weeks ago?',
      answer: 'the botanical garden',
      question_date: '2023/10/01',
      haystack_sessions: [
        [
          { role: 'user', content: "I attended my cousin's wedding." },
          { role: 'user', content: "I attended Michael's engagement party." },
        ],
      ],
      haystack_dates: ['2023/05/15', '2023/04/06'],
    },
    {
      question_id: 'ie-1',
      question_type: 'single-session-user',
      question: 'What is the favorite color?',
      answer: 'blue',
      haystack_sessions: [[{ role: 'user', content: 'favorite color=blue' }]],
    },
  ];

  const llm: LLM = {
    complete: async () => '39',
    completeStructured: async <T>() =>
      ({
        events: [
          { name: "my cousin's wedding", date: '2023/05/15' },
          { name: "Michael's engagement party", date: '2023/04/06' },
        ],
      }) as T,
  };

  it('isolates dated TR questions and labels the engine variants', async () => {
    const { report, markdown } = await runDeterministicCoverageAblation(
      trInstances,
      embedding,
      llm,
    );
    expect(report.questionCount).toBe(1);
    expect(report.baseline.name).toBe('tr-base-engine');
    expect(report.feature.name).toBe('tr-extended-engine');
    expect(markdown).toContain('Cortex Benchmark Report');
  });

  it('forwards a custom judge and temperature through the ablation', async () => {
    const temperatures: number[] = [];
    const capturingLlm: LLM = {
      complete: async (_prompt, opts) => {
        temperatures.push(opts?.temperature ?? Number.NaN);
        return 'the rose garden';
      },
      completeStructured: async <T>() =>
        ({
          events: [
            { name: "my cousin's wedding", date: '2023/05/15' },
            { name: "Michael's engagement party", date: '2023/04/06' },
          ],
        }) as T,
    };
    const judgeQuestions: string[] = [];
    const judge: AnswerJudge = async (question, predicted, expected) => {
      judgeQuestions.push(question);
      // The two answers share only the noun "garden", so an exact-match
      // short-circuit cannot fire and the judge must be consulted.
      return predicted.includes('garden') && expected.includes('garden');
    };
    const { report } = await runDeterministicCoverageAblation(
      trInstances,
      embedding,
      capturingLlm,
      { runs: 2, temperature: 0.6, judge },
    );
    expect(report.questionCount).toBe(1);
    expect(temperatures.every((t) => t === 0.6)).toBe(true);
    expect(judgeQuestions.length).toBeGreaterThan(0);
  });
});

describe('runBitemporalKnowledgeUpdateAblation', () => {
  const embedding = new HashEmbedding(64);

  const kuInstances: LongMemEvalInstance[] = [
    {
      question_id: 'ku-1',
      question_type: 'knowledge-update',
      question: 'What is my current city?',
      answer: 'Shanghai',
      haystack_sessions: [
        [{ role: 'user', content: 'I lived in Beijing.' }],
        [{ role: 'user', content: 'I moved to Shanghai.' }],
      ],
    },
    {
      question_id: 'ku-2',
      question_type: 'knowledge-update',
      question: 'What is my favorite color?',
      answer: 'blue',
      haystack_sessions: [[{ role: 'user', content: 'My favorite color is blue.' }]],
    },
  ];

  const factsLlm: LLM = {
    complete: async (prompt) => (prompt.includes('Specific items:') ? 'city' : 'Shanghai'),
    completeStructured: async <T>() =>
      ({
        facts: [
          { subject: 'city', predicate: 'resides_in', object: 'Beijing', date: '2023/01/08' },
          { subject: 'city', predicate: 'resides_in', object: 'Shanghai', date: '2023/03/04' },
        ],
      }) as T,
  };

  it('isolates KU temporal questions only and labels the variants', async () => {
    const { report, markdown } = await runBitemporalKnowledgeUpdateAblation(
      kuInstances,
      embedding,
      factsLlm,
    );
    // Only the "current city" question carries a previous/current qualifier; the
    // "favorite color" question is excluded.
    expect(report.questionCount).toBe(1);
    expect(report.baseline.name).toBe('ku-cot-knowledge-update');
    expect(report.feature.name).toBe('ku-bitemporal-knowledge-update');
    expect(markdown).toContain('Cortex Benchmark Report');
  });

  it('forwards temperature through the bitemporal ablation', async () => {
    const temperatures: number[] = [];
    const capturingLlm: LLM = {
      complete: async (_prompt, opts) => {
        temperatures.push(opts?.temperature ?? Number.NaN);
        return 'Shanghai';
      },
      completeStructured: async <T>(
        _prompt: string,
        _schema: unknown,
        opts?: { temperature?: number },
      ) => {
        temperatures.push(opts?.temperature ?? Number.NaN);
        return {
          facts: [
            { subject: 'city', predicate: 'resides_in', object: 'Shanghai', date: '2023/03/04' },
          ],
        } as T;
      },
    };
    const { report } = await runBitemporalKnowledgeUpdateAblation(
      kuInstances,
      embedding,
      capturingLlm,
      { runs: 2, temperature: 0.6 },
    );
    expect(report.questionCount).toBe(1);
    expect(temperatures.every((t) => t === 0.6)).toBe(true);
  });
});

/**
 * Cache-sharing contract across every ablation.
 *
 * Background: the P5 measurement found that two arms resolving to the *same*
 * configuration disagreed on 2 of 127 TR questions in run `34389565513`, while the
 * main benchmark's two arms — which share a query-expansion cache and an answer
 * cache — disagreed on 0 of 470 questions. The difference was not noise: the arms
 * with separate caches re-query the hosted endpoint, which is not reproducible
 * across calls even at `temperature=0`, so an arm comparison silently included an
 * LLM-non-reproducibility term.
 *
 * These tests pin the contract directly. A counting LLM returns different text
 * for the same prompt on each call, simulating exactly that endpoint. Any arm
 * pair that shares an answer cache must then still agree question-for-question,
 * because the second arm must reuse the first arm's raw output rather than call
 * the model again.
 */
describe('ablation arms share the answer cache', () => {
  const embedding = new HashEmbedding(64);

  type CountingLlm = LLM & {
    /** Calls whose prompt was not served from the answer cache. */
    uncachedCalls: () => number;
    /** Distinct prompts seen, to confirm the arms really issue identical prompts. */
    prompts: Map<string, number>;
  };

  /**
   * An LLM that answers a repeated prompt differently every time. Deterministic
   * by prompt would make a cache-sharing bug invisible, which is the whole point:
   * the real endpoint is not deterministic, so the test's model must not be either.
   */
  function nonReproducibleLlm(): CountingLlm {
    const prompts = new Map<string, number>();
    let calls = 0;
    return {
      prompts,
      uncachedCalls: () => calls,
      complete: async (prompt: string) => {
        const seen = (prompts.get(prompt) ?? 0) + 1;
        prompts.set(prompt, seen);
        calls++;
        // Same prompt, different answer each time it is actually sent.
        return seen === 1 ? 'blue' : `blue-variant-${seen}`;
      },
      completeStructured: async <T>() => ({}) as T,
    } as CountingLlm;
  }

  const mrInstances: LongMemEvalInstance[] = [
    {
      question_id: 'mr-1',
      question_type: 'multi-session',
      question: 'What is the favorite color?',
      answer: 'blue',
      haystack_sessions: [[{ role: 'user', content: 'My favorite color is blue.' }]],
      answer_session_ids: [],
    },
  ];

  const trInstances: LongMemEvalInstance[] = [
    {
      question_id: 'tr-1',
      question_type: 'temporal-reasoning',
      question: 'How many days ago did I buy the lamp?',
      answer: '3',
      question_date: '2023/05/10',
      haystack_sessions: [[{ role: 'user', content: 'I bought a lamp.' }]],
      haystack_dates: ['2023/05/07'],
    },
  ];

  const kuInstances: LongMemEvalInstance[] = [
    {
      question_id: 'ku-1',
      question_type: 'knowledge-update',
      question: 'Where do I live now?',
      answer: 'Shanghai',
      question_date: '2023/05/10',
      haystack_sessions: [[{ role: 'user', content: 'I moved to Shanghai.' }]],
      haystack_dates: ['2023/05/01'],
    },
  ];

  it('never lets the MR arms share a prompt, so the cache cannot mask the treatment', async () => {
    // The MR arms differ in `aggregationPrompt`, so every aggregation prompt is
    // distinct between them and no answer-cache entry is shared. That is a weaker
    // guarantee than the TR arms enjoy — for MR the cache buys a saving on any
    // prompt both arms happen to issue, not a correctness guarantee — but it must
    // hold, or sharing would collapse the two arms into one call and the ablation
    // would measure nothing.
    const llm = nonReproducibleLlm();
    await runMrAggregationAblation(mrInstances, embedding, llm);
    for (const [prompt, seen] of llm.prompts) {
      expect(seen, `prompt sent ${seen} times: ${prompt.slice(0, 60)}`).toBe(1);
    }
  });

  it('exercises both MR prompt templates so the ablation is a real comparison', async () => {
    const llm = nonReproducibleLlm();
    const { report } = await runMrAggregationAblation(mrInstances, embedding, llm, {
      judge: async (_question, predicted, expected) => predicted === expected,
    });
    expect(report.ablation.perCapability.MR!.total).toBe(1);
    // Two distinct aggregation prompts on the same question means the contrast is
    // real; one would mean the cache merged the arms.
    const aggregationPrompts = [...llm.prompts.keys()].filter((p) => p.includes('favorite color'));
    expect(aggregationPrompts.length).toBeGreaterThan(1);
  });

  it('keeps both TR-engine arms in agreement when the model is not reproducible', async () => {
    const llm = nonReproducibleLlm();
    await runTemporalEngineAblation(trInstances, embedding, llm, {
      judge: async (_question, predicted, expected) => predicted === expected,
    });
    for (const [prompt, seen] of llm.prompts) {
      expect(seen, `prompt sent ${seen} times: ${prompt.slice(0, 60)}`).toBe(1);
    }
  });

  it('keeps both TR-window arms in agreement when the model is not reproducible', async () => {
    const llm = nonReproducibleLlm();
    await runTimeWindowAnnotationAblation(trInstances, embedding, llm, {
      judge: async (_question, predicted, expected) => predicted === expected,
    });
    for (const [prompt, seen] of llm.prompts) {
      expect(seen, `prompt sent ${seen} times: ${prompt.slice(0, 60)}`).toBe(1);
    }
  });

  it('keeps both TR-coverage arms in agreement when the model is not reproducible', async () => {
    const llm = nonReproducibleLlm();
    await runDeterministicCoverageAblation(trInstances, embedding, llm, {
      judge: async (_question, predicted, expected) => predicted === expected,
    });
    for (const [prompt, seen] of llm.prompts) {
      expect(seen, `prompt sent ${seen} times: ${prompt.slice(0, 60)}`).toBe(1);
    }
  });

  it('keeps both KU-bitemporal arms in agreement when the model is not reproducible', async () => {
    const llm = nonReproducibleLlm();
    await runBitemporalKnowledgeUpdateAblation(kuInstances, embedding, llm, {
      judge: async (_question, predicted, expected) => predicted === expected,
    });
    for (const [prompt, seen] of llm.prompts) {
      expect(seen, `prompt sent ${seen} times: ${prompt.slice(0, 60)}`).toBe(1);
    }
  });
});
