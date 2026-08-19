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
import {
  computeMetrics,
  computeMetricsAsync,
  scoreEvaluation,
  type AnswerScorer,
  type ScoredEvaluation,
} from './metrics.js';

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
    if (isSessionAware(system) && q.sessions && q.sessions.length > 0) {
      if (q.capability === 'MR') {
        // Multi-session questions aggregate evidence across sessions.
        answers.push(await system.answerSessions(q.question, q.sessions));
      } else if (system.answerFromSessions) {
        // Single-session questions still benefit from session-first retrieval:
        // the answer session is recalled far more reliably than the answer turn.
        answers.push(await system.answerFromSessions(q.question, q.sessions));
      } else {
        answers.push(await system.answer(q.question, q.context));
      }
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

/**
 * Run a system and evaluate with an arbitrary scorer, returning per-question
 * correctness alongside the aggregate metrics. The correctness vector enables
 * paired tests (McNemar) that compare two systems on the SAME questions.
 */
export async function evaluateWithScorerDetailed(
  dataset: BenchmarkDataset,
  system: MemorySystem,
  scorer: AnswerScorer,
): Promise<ScoredEvaluation> {
  const answers = await runBenchmark(dataset, system);
  return scoreEvaluation(dataset, answers, scorer);
}
