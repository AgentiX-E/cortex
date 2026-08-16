/**
 * Benchmark runner: run a memory system over a dataset and evaluate its answers.
 */
import type {
  Answer,
  BenchmarkDataset,
  MemorySystem,
  Metrics,
  SessionAwareMemorySystem,
} from './types.js';
import { computeMetrics, computeMetricsAsync, type AnswerScorer } from './metrics.js';

/** True when the system opts into session-boundary-aware answering. */
function isSessionAware(system: MemorySystem): system is SessionAwareMemorySystem {
  return 'answerSessions' in system;
}

/** Run a system over every question, preserving question order. */
export async function runBenchmark(
  dataset: BenchmarkDataset,
  system: MemorySystem,
): Promise<Answer[]> {
  const answers: Answer[] = [];
  for (const q of dataset.questions) {
    // Only multi-session questions benefit from session-boundary-aware answering:
    // their answer is aggregated across sessions. Single-session capabilities
    // (IE/KU/TR/ABS) keep the turn-level path because coarse session filtering
    // can drop the answer session and regress those questions.
    if (isSessionAware(system) && q.capability === 'MR' && q.sessions && q.sessions.length > 0) {
      answers.push(await system.answerSessions(q.question, q.sessions));
    } else {
      answers.push(await system.answer(q.question, q.context));
    }
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
