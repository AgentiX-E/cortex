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
  computeMetricsAsync,
  scoreEvaluation,
  type AnswerScorer,
  type ScoredEvaluation,
} from './metrics.js';

/** True when the system opts into session-boundary-aware answering. */
function isSessionAware(system: MemorySystem): system is SessionAwareMemorySystem {
  return 'answerSessions' in system;
}

/**
 * One per-question progress event, emitted BEFORE that question is answered.
 *
 * ## Why before, and not after
 *
 * The failure this exists to localise happens *inside* the answer call -- run
 * `37281155088`'s arm spent ~52 minutes in the LLM and then died on an HTTP 402
 * when the account's balance ran out. A callback that fired on completion would
 * leave the one question that died unrecorded, which is precisely the shape of
 * the defect: that run's `benchmark-error.log` carried a stack trace and no
 * question at all, so a 52-minute spend could not be localised and the next
 * attempt would repeat it up to an unknown point.
 *
 * ## The fields
 *
 * - `system` — `MemorySystem.name` of the side about to run. An ablation has two
 *   (`reference-pipeline` / `cortex-memory`), and which one died is not
 *   inferable from a question index.
 * - `index` — 0-based position in `dataset.questions`. 0-based so it is the same
 *   number as the `correct[]` index the paired tests use; a reader adds one.
 * - `total` — the dataset size, so `index` is readable as `index + 1 / total`
 *   without the log having to carry the dataset too.
 * - `run` — 0-based repetition ordinal. `runAblation` evaluates the SAME dataset
 *   `runs` times, so `(system, run, index)` is the key of one attempt and a
 *   record without `run` is ambiguous on any arm with `runs > 1`.
 * - `questionId` — the question's stable id, so the record names the question
 *   rather than only its position in a dataset that may be resampled.
 */
export type BenchmarkProgress = {
  readonly system: string;
  readonly index: number;
  readonly total: number;
  readonly run: number;
  readonly questionId: string;
};

/**
 * Optional per-question progress sink.
 *
 * A callback rather than a `console.log` for the reason this package holds
 * throughout: `cortex-eval/src` emits nothing to a stream. Printing is the entry
 * point's job (the `bench` directories of the packages that run one), and an
 * instrument that wrote to stdout would put output policy inside the measurement.
 */
export type BenchmarkProgressCallback = (progress: BenchmarkProgress) => void;

/** Run a system over every question, preserving question order. */
export async function runBenchmark(
  dataset: BenchmarkDataset,
  system: MemorySystem,
  progress?: BenchmarkProgressCallback,
  run = 0,
): Promise<Answer[]> {
  const answers: Answer[] = [];
  const total = dataset.questions.length;
  for (let index = 0; index < dataset.questions.length; index++) {
    const q = dataset.questions[index]!;
    // Before the answer call, so a throw inside it cannot skip the question it
    // threw on. See `BenchmarkProgress`. `run` is a parameter rather than
    // something read here, because a single pass over the dataset has no way to
    // know which repetition it is serving.
    progress?.({ system: system.name, index, total, run, questionId: q.id });
    if (isSessionAware(system) && q.capability === 'MR' && q.sessions && q.sessions.length > 0) {
      // Multi-session questions aggregate evidence across sessions.
      answers.push(await system.answerSessions(q.question, q.sessions));
    } else if (isSessionAware(system) && q.capability === 'TR' && system.answerTemporal) {
      // Temporal questions need the question date as the reference point for
      // "how long ago" reasoning, plus a dedicated date-reading prompt.
      answers.push(await system.answerTemporal(q.question, q.context, q.questionDate, q.sessions));
    } else if (isSessionAware(system) && q.capability === 'ABS' && system.answerAbstention) {
      // Abstention questions are answered with a conservative prompt so the
      // model recognizes the absence of an answer instead of being pushed to
      // choose a candidate. Routed before the assistant check because an ABS
      // question may carry a single-session-assistant type.
      answers.push(await system.answerAbstention(q.question, q.context, q.sessions));
    } else if (
      isSessionAware(system) &&
      q.questionType === 'single-session-assistant' &&
      system.answerAssistant
    ) {
      // The evidence for single-session-assistant questions lives in an
      // assistant turn, so route to a path that includes assistant turns.
      answers.push(await system.answerAssistant(q.question, q.context, q.sessions));
    } else if (
      isSessionAware(system) &&
      q.questionType === 'single-session-preference' &&
      system.answerPreference
    ) {
      // Preference/recommendation questions ask for a suggestion that reflects
      // the user's stated preferences, not a single extracted fact. The
      // extractive answer path would abstain on them, so route to a generative
      // path instead.
      answers.push(await system.answerPreference(q.question, q.context, q.sessions));
    } else if (
      isSessionAware(system) &&
      q.questionType === 'knowledge-update' &&
      system.answerKnowledgeUpdate
    ) {
      // Knowledge-update questions ask which value a time qualifier selects
      // (previous vs currently), which the generic extractive prompt does not
      // make explicit. Route to the time-qualifier-aware prompt instead.
      answers.push(await system.answerKnowledgeUpdate(q.question, q.context, q.sessions));
    } else {
      answers.push(await system.answer(q.question, q.context, q.sessions));
    }
  }
  return answers;
}

/** Run a system and evaluate with an arbitrary (possibly async) scorer. */
export async function evaluateWithScorer(
  dataset: BenchmarkDataset,
  system: MemorySystem,
  scorer: AnswerScorer,
  progress?: BenchmarkProgressCallback,
  run = 0,
): Promise<Metrics> {
  const answers = await runBenchmark(dataset, system, progress, run);
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
  progress?: BenchmarkProgressCallback,
  run = 0,
): Promise<ScoredEvaluation> {
  const answers = await runBenchmark(dataset, system, progress, run);
  return scoreEvaluation(dataset, answers, scorer);
}
