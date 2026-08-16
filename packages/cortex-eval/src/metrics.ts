/**
 * Scientific metric computation: exact match, Top-1 accuracy, abstention-aware
 * accuracy, per-capability breakdown, and run aggregation. All statistics reuse
 * the high-precision primitives from @agentix-e/cortex-core.
 */
import { binomialCdf, mean, variance, welchTTest } from '@agentix-e/cortex-core';
import type {
  AggregateStats,
  Answer,
  BenchmarkDataset,
  Capability,
  Metrics,
  PerCapabilityResult,
  Question,
} from './types.js';
import type { AnswerJudge } from './judge.js';

const ALL_CAPABILITIES: Capability[] = ['IE', 'MR', 'KU', 'TR', 'ABS'];

/** Normalize an answer for exact-match comparison. */
export function normalizeAnswer(a: string): string {
  return a.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function exactMatch(actual: Answer, expected: string | null): boolean {
  if (expected === null) {
    return actual === null;
  }
  if (actual === null) {
    return false;
  }
  return normalizeAnswer(actual) === normalizeAnswer(expected);
}

function emptyCapability(): PerCapabilityResult {
  return { total: 0, correct: 0, accuracy: 0, abstained: 0 };
}

/** Compute metrics from a dataset and the system's answers. */
export function computeMetrics(dataset: BenchmarkDataset, answers: Answer[]): Metrics {
  if (dataset.questions.length !== answers.length) {
    throw new Error(
      `answer count mismatch: ${answers.length} answers for ${dataset.questions.length} questions`,
    );
  }
  const perCapability = Object.fromEntries(
    ALL_CAPABILITIES.map((c) => [c, emptyCapability()]),
  ) as Record<Capability, PerCapabilityResult>;

  let correct = 0;
  let abstained = 0;
  let abstentionCorrect = 0;

  for (let i = 0; i < dataset.questions.length; i++) {
    const q = dataset.questions[i]!;
    const answer = answers[i]!;
    const isExact = exactMatch(answer, q.expected);
    const isAbstain = answer === null;

    if (isExact) {
      correct++;
    }
    if (isAbstain) {
      abstained++;
      if (q.expected === null) {
        abstentionCorrect++;
      }
    }

    const bucket = perCapability[q.capability];
    bucket.total++;
    if (isExact) {
      bucket.correct++;
    }
    if (isAbstain) {
      bucket.abstained++;
    }
  }

  for (const c of ALL_CAPABILITIES) {
    const bucket = perCapability[c];
    bucket.accuracy = bucket.total === 0 ? 0 : bucket.correct / bucket.total;
  }

  const total = dataset.questions.length;
  const accuracy = total === 0 ? 0 : correct / total;
  return {
    accuracy,
    abstentionRate: total === 0 ? 0 : abstained / total,
    abstentionCorrectRate: abstained === 0 ? 0 : abstentionCorrect / abstained,
    // Exact-match accuracy already treats a correct abstention (null==null) as
    // correct, so abstention-aware accuracy equals accuracy.
    abstentionAwareAccuracy: accuracy,
    total,
    correct,
    perCapability,
  };
}

/** A scorer decides whether an answer is correct for a question. */
export type AnswerScorer = (question: Question, answer: Answer) => Promise<boolean> | boolean;

/** Evaluation output including per-question correctness for paired tests. */
export type ScoredEvaluation = {
  metrics: Metrics;
  /** Correctness of each answer, aligned with `dataset.questions`. */
  correct: boolean[];
};

/**
 * Exact paired McNemar test. Given two systems evaluated on the SAME questions,
 * `b` counts questions the baseline answered correctly but the feature answered
 * incorrectly, and `c` counts the reverse. Under the null hypothesis the
 * discordant pairs split evenly, so the two-tailed p-value is the exact binomial
 * tail of Bin(b + c, 0.5) at min(b, c). Unlike a Welch t-test over repeated
 * runs, this is meaningful for a single deterministic evaluation.
 */
export function mcnemarPValue(b: number, c: number): number {
  if (!Number.isInteger(b) || !Number.isInteger(c) || b < 0 || c < 0) {
    throw new Error(`discordant counts must be non-negative integers, got b=${b}, c=${c}`);
  }
  const n = b + c;
  if (n === 0) {
    // No discordant pairs: the systems agree on every question.
    return 1;
  }
  const tail = binomialCdf(Math.min(b, c), n, 0.5);
  return Math.min(1, 2 * tail);
}

/** Exact-match scorer (normalized string equality). */
export function exactMatchScorer(question: Question, answer: Answer): boolean {
  return exactMatch(answer, question.expected);
}

/** Extract the first integer or decimal number from an answer string. */
export function extractLeadingNumber(s: string): number | undefined {
  const match = s.trim().match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : undefined;
}

/** True when the question asks for a count or quantity. */
export function isCountingQuestion(question: string): boolean {
  return /\b(how many|how much|number of|count|total)\b/i.test(question);
}

/**
 * Deterministic numeric equivalence for counting questions. An LLM judge is
 * unreliable for numeric answers ("5 distinct projects" vs "2") because it
 * focuses on semantics rather than the leading number, so counting questions
 * with numeric answers are compared arithmetically before delegating to the
 * judge. Returns `undefined` when the question is not a counting question or
 * either answer lacks a leading number, signalling the caller to fall back to
 * the LLM judge.
 */
export function numericAnswerVerdict(
  question: string,
  predicted: string,
  expected: string,
): boolean | undefined {
  if (!isCountingQuestion(question)) {
    return undefined;
  }
  const p = extractLeadingNumber(predicted);
  const e = extractLeadingNumber(expected);
  if (p === undefined || e === undefined) {
    return undefined;
  }
  return p === e;
}

/** LLM-judge scorer: abstentions are graded structurally, others via the judge. */
export function judgeScorer(judge: AnswerJudge): AnswerScorer {
  return async (question, answer) => {
    if (question.expected === null) {
      return answer === null;
    }
    if (answer === null) {
      return false;
    }
    // Counting questions are graded numerically first, so a verbose answer
    // cannot trick the LLM judge into accepting "5" for "2".
    const numeric = numericAnswerVerdict(question.question, answer, question.expected);
    if (numeric !== undefined) {
      return numeric;
    }
    return judge(question.question, answer, question.expected);
  };
}

/** Compute metrics using an arbitrary (possibly async) answer scorer. */
export async function computeMetricsAsync(
  dataset: BenchmarkDataset,
  answers: Answer[],
  scorer: AnswerScorer,
): Promise<Metrics> {
  return (await scoreEvaluation(dataset, answers, scorer)).metrics;
}

/** Compute metrics plus per-question correctness using an arbitrary scorer. */
export async function scoreEvaluation(
  dataset: BenchmarkDataset,
  answers: Answer[],
  scorer: AnswerScorer,
): Promise<ScoredEvaluation> {
  if (dataset.questions.length !== answers.length) {
    throw new Error(
      `answer count mismatch: ${answers.length} answers for ${dataset.questions.length} questions`,
    );
  }
  const perCapability = Object.fromEntries(
    ALL_CAPABILITIES.map((c) => [c, emptyCapability()]),
  ) as Record<Capability, PerCapabilityResult>;

  let correct = 0;
  let abstained = 0;
  let abstentionCorrect = 0;
  const correctPerQuestion: boolean[] = [];

  for (let i = 0; i < dataset.questions.length; i++) {
    const q = dataset.questions[i]!;
    const answer = answers[i]!;
    const isCorrect = await scorer(q, answer);
    const isAbstain = answer === null;
    correctPerQuestion.push(isCorrect);

    if (isCorrect) {
      correct++;
    }
    if (isAbstain) {
      abstained++;
      if (q.expected === null) {
        abstentionCorrect++;
      }
    }

    const bucket = perCapability[q.capability];
    bucket.total++;
    if (isCorrect) {
      bucket.correct++;
    }
    if (isAbstain) {
      bucket.abstained++;
    }
  }

  for (const c of ALL_CAPABILITIES) {
    const bucket = perCapability[c];
    bucket.accuracy = bucket.total === 0 ? 0 : bucket.correct / bucket.total;
  }

  const total = dataset.questions.length;
  const accuracy = total === 0 ? 0 : correct / total;
  return {
    metrics: {
      accuracy,
      abstentionRate: total === 0 ? 0 : abstained / total,
      abstentionCorrectRate: abstained === 0 ? 0 : abstentionCorrect / abstained,
      // A correct abstention (null==null) is graded as correct by the scorer, so
      // abstention-aware accuracy equals accuracy.
      abstentionAwareAccuracy: accuracy,
      total,
      correct,
      perCapability,
    },
    correct: correctPerQuestion,
  };
}

/** Aggregate a list of per-run scores into min/max/avg/median. */
export function aggregate(scores: readonly number[]): AggregateStats {
  if (scores.length === 0) {
    throw new Error('aggregate of empty list');
  }
  const sorted = [...scores].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  return {
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    avg: mean(sorted),
    median,
  };
}

/** Cohen's d effect size from two samples. */
export function cohensD(a: readonly number[], b: readonly number[]): number {
  const na = a.length;
  const nb = b.length;
  if (na < 2 || nb < 2) {
    return 0;
  }
  const ma = mean(a);
  const mb = mean(b);
  const va = variance(a);
  const vb = variance(b);
  const pooled = Math.sqrt(((na - 1) * va + (nb - 1) * vb) / (na + nb - 2));
  if (pooled === 0) {
    // Zero variance with identical means → no effect; differing means → infinite effect.
    return ma === mb ? 0 : mb > ma ? Infinity : -Infinity;
  }
  return (mb - ma) / pooled;
}

/** Two-tailed Welch t-test p-value between two score samples. */
export function tTestPValue(a: readonly number[], b: readonly number[]): number {
  return welchTTest(a, b);
}
