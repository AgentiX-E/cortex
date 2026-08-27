/**
 * End-to-end embedding benchmark runner: loads LongMemEval instances, builds a
 * naive baseline and an abstaining feature system over the same embedding, runs
 * a scientific ablation, and renders a Markdown report.
 */
import type { EmbeddingModel, LLM } from '@agentix-e/cortex-core';
import { loadLongMemEval, type LongMemEvalInstance } from './datasets/longmemeval-loader.js';
import { EmbeddingMemorySystem } from './embedding-memory.js';
import {
  buildAggregationQaPrompt,
  buildLegacyAggregationQaPrompt,
  NaturalLanguageMemorySystem,
} from './natural-language-memory.js';
import { createLlmJudge, type AnswerJudge } from './judge.js';
import { judgeScorer } from './metrics.js';
import type { DecisionTrace } from './natural-language-memory.js';
import { formatAblationReport, runAblationReport, type AblationReport } from './report.js';

export type BenchmarkRunnerOptions = {
  /** Abstention threshold for the feature system (default 0.5). */
  abstainThreshold?: number;
  /** Number of independent ablation runs (default 3). */
  runs?: number;
  /**
   * LLM sampling temperature for both systems. Defaults to the system default
   * (0, deterministic). Set > 0 together with runs > 1 to measure sampling
   * variance; at 0 repeated runs are identical and the over-run t-test is NaN.
   */
  temperature?: number;
  /** Optional answer judge; defaults to an LLM judge over the same LLM. */
  judge?: AnswerJudge;
  /** Optional callback for per-question decision tracing (diagnostic). */
  onDecision?: (trace: DecisionTrace) => void;
};

export async function runEmbeddingBenchmark(
  instances: readonly LongMemEvalInstance[],
  embedding: EmbeddingModel,
  options: BenchmarkRunnerOptions = {},
): Promise<{ report: AblationReport; markdown: string }> {
  const dataset = loadLongMemEval(instances);
  const threshold = options.abstainThreshold ?? 0.5;
  const baseline = new EmbeddingMemorySystem('naive-baseline', {
    embedding,
    fallback: 'unknown',
  });
  const feature = new EmbeddingMemorySystem('abstain-feature', {
    embedding,
    abstainThreshold: threshold,
  });
  const report = await runAblationReport(dataset, baseline, feature, {
    runs: options.runs ?? 3,
  });
  return { report, markdown: formatAblationReport(report) };
}

/** Natural-language QA benchmark: baseline never abstains; feature abstains. */
export async function runNaturalLanguageBenchmark(
  instances: readonly LongMemEvalInstance[],
  embedding: EmbeddingModel,
  llm: LLM,
  options: BenchmarkRunnerOptions = {},
): Promise<{ report: AblationReport; markdown: string }> {
  const dataset = loadLongMemEval(instances);
  const threshold = options.abstainThreshold ?? 0.5;
  const baseline = new NaturalLanguageMemorySystem('nl-naive-baseline', {
    embedding,
    llm,
    enableAbstention: false,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });
  const feature = new NaturalLanguageMemorySystem('nl-abstain-feature', {
    embedding,
    llm,
    abstainThreshold: threshold,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.onDecision ? { onDecision: options.onDecision } : {}),
  });
  // Natural-language answers need semantic equivalence grading, not exact match.
  const judge = options.judge ?? createLlmJudge(llm);
  const report = await runAblationReport(dataset, baseline, feature, {
    runs: options.runs ?? 3,
    scorer: judgeScorer(judge),
  });
  return { report, markdown: formatAblationReport(report) };
}

/**
 * Multi-session aggregation ablation. The main natural-language ablation varies
 * abstention, so it cannot attribute an MR accuracy change to the aggregation
 * prompt (both systems share it). This isolates the prompt: both systems disable
 * abstention and differ ONLY in the aggregation prompt — legacy inline-counting
 * vs the CoT enumerate-then-count prompt — so the paired McNemar test on MR
 * questions measures the prompt's contribution directly.
 */
export async function runMrAggregationAblation(
  instances: readonly LongMemEvalInstance[],
  embedding: EmbeddingModel,
  llm: LLM,
  options: BenchmarkRunnerOptions = {},
): Promise<{ report: AblationReport; markdown: string }> {
  const dataset = loadLongMemEval(instances);
  const mrQuestions = dataset.questions.filter((q) => q.capability === 'MR');
  const mrDataset = { name: 'longmemeval-mr', questions: mrQuestions };

  const legacy = new NaturalLanguageMemorySystem('mr-legacy-aggregation', {
    embedding,
    llm,
    enableAbstention: false,
    aggregationPrompt: buildLegacyAggregationQaPrompt,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });
  const cot = new NaturalLanguageMemorySystem('mr-cot-aggregation', {
    embedding,
    llm,
    enableAbstention: false,
    aggregationPrompt: buildAggregationQaPrompt,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });

  const judge = options.judge ?? createLlmJudge(llm);
  const report = await runAblationReport(mrDataset, legacy, cot, {
    runs: options.runs ?? 1,
    scorer: judgeScorer(judge),
  });
  return { report, markdown: formatAblationReport(report) };
}

/**
 * Deterministic temporal-engine ablation. The main natural-language ablation
 * enables the deterministic engine in both systems, so it cannot attribute a TR
 * accuracy change to the engine (both systems share it). This isolates the
 * engine: both systems disable abstention and differ ONLY in
 * `enableDeterministicTemporal` — LLM date-reading vs deterministic date
 * arithmetic — so the paired McNemar test on TR questions measures the engine's
 * contribution directly.
 */
export async function runTemporalEngineAblation(
  instances: readonly LongMemEvalInstance[],
  embedding: EmbeddingModel,
  llm: LLM,
  options: BenchmarkRunnerOptions = {},
): Promise<{ report: AblationReport; markdown: string }> {
  const dataset = loadLongMemEval(instances);
  const trQuestions = dataset.questions.filter((q) => q.capability === 'TR');
  const trDataset = { name: 'longmemeval-tr', questions: trQuestions };

  const llmTemporal = new NaturalLanguageMemorySystem('tr-llm-temporal', {
    embedding,
    llm,
    enableAbstention: false,
    enableDeterministicTemporal: false,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });
  const deterministicTemporal = new NaturalLanguageMemorySystem('tr-deterministic-temporal', {
    embedding,
    llm,
    enableAbstention: false,
    enableDeterministicTemporal: true,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });

  const judge = options.judge ?? createLlmJudge(llm);
  const report = await runAblationReport(trDataset, llmTemporal, deterministicTemporal, {
    runs: options.runs ?? 1,
    scorer: judgeScorer(judge),
  });
  return { report, markdown: formatAblationReport(report) };
}
