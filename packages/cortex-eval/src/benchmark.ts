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
    if (isSessionAware(system) && q.capability === 'MR' && q.sessions && q.sessions.length > 0) {
      // Multi-session questions aggregate evidence across sessions.
      answers.push(await system.answerSessions(q.question, q.sessions));
    } else if (isSessionAware(system) && q.capability === 'TR' && system.answerTemporal) {
      // Temporal questions need the question date as the reference point for
      // "how long ago" reasoning, plus a dedicated date-reading prompt.
      answers.push(await system.answerTemporal(q.question, q.context, q.questionDate));
    } else if (isSessionAware(system) && q.capability === 'ABS' && system.answerAbstention) {
      // Abstention questions are answered with a conservative prompt so the
      // model recognizes the absence of an answer instead of being pushed to
      // choose a candidate. Routed before the assistant check because an ABS
      // question may carry a single-session-assistant type.
      answers.push(await system.answerAbstention(q.question, q.context));
    } else if (
      isSessionAware(system) &&
      q.questionType === 'single-session-assistant' &&
      system.answerAssistant
    ) {
      // The evidence for single-session-assistant questions lives in an
      // assistant turn, so route to a path that includes assistant turns.
      answers.push(await system.answerAssistant(q.question, q.context));
    } else if (
      isSessionAware(system) &&
      q.questionType === 'single-session-preference' &&
      system.answerPreference
    ) {
      // Preference/recommendation questions ask for a suggestion that reflects
      // the user's stated preferences, not a single extracted fact. The
      // extractive answer path would abstain on them, so route to a generative
      // path instead.
      answers.push(await system.answerPreference(q.question, q.context));
    } else if (
      isSessionAware(system) &&
      q.questionType === 'knowledge-update' &&
      system.answerKnowledgeUpdate
    ) {
      // Knowledge-update questions ask which value a time qualifier selects
      // (previous vs currently), which the generic extractive prompt does not
      // make explicit. Route to the time-qualifier-aware prompt instead.
      answers.push(await system.answerKnowledgeUpdate(q.question, q.context));
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
