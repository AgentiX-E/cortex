/**
 * End-to-end embedding benchmark runner: loads LongMemEval instances, builds a
 * naive baseline and an abstaining feature system over the same embedding, runs
 * a scientific ablation, and renders a Markdown report.
 */
import type { EmbeddingModel, LLM } from '@agentix-e/cortex-core';
import { loadLongMemEval, type LongMemEvalInstance } from './datasets/longmemeval-loader.js';
import { EmbeddingMemorySystem } from './embedding-memory.js';
import { NaturalLanguageMemorySystem } from './natural-language-memory.js';
import { createLlmJudge, type AnswerJudge } from './judge.js';
import { judgeScorer } from './metrics.js';
import type { DecisionTrace } from './natural-language-memory.js';
import { formatAblationReport, runAblationReport, type AblationReport } from './report.js';

export type BenchmarkRunnerOptions = {
  /** Abstention threshold for the feature system (default 0.5). */
  abstainThreshold?: number;
  /** Number of independent ablation runs (default 3). */
  runs?: number;
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
  });
  const feature = new NaturalLanguageMemorySystem('nl-abstain-feature', {
    embedding,
    llm,
    abstainThreshold: threshold,
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
