/**
 * Benchmark runner: run a memory system over a dataset and evaluate its answers.
 */
import type { Answer, BenchmarkDataset, MemorySystem, Metrics } from './types.js';
import { computeMetrics, computeMetricsAsync, type AnswerScorer } from './metrics.js';

/** Run a system over every question, preserving question order. */
export async function runBenchmark(
  dataset: BenchmarkDataset,
  system: MemorySystem,
): Promise<Answer[]> {
  const answers: Answer[] = [];
  for (const q of dataset.questions) {
    answers.push(await system.answer(q.question, q.context));
  }
  return answers;
}

/** Run a system and immediately evaluate against ground truth. */
export async function evaluate(dataset: BenchmarkDataset, system: MemorySystem): Promise<Metrics> {
  const answers = await runBenchmark(dataset, system);
  return computeMetrics(dataset, answers);
}

/** Run a system and evaluate with an arbitrary (possibly async) scorer. */
export async function evaluateWithScorer(
  dataset: BenchmarkDataset,
  system: MemorySystem,
  scorer: AnswerScorer,
): Promise<Metrics> {
  const answers = await runBenchmark(dataset, system);
  return computeMetricsAsync(dataset, answers, scorer);
}
