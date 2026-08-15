/**
 * Scientific metric computation: exact match, Top-1 accuracy, abstention-aware
 * accuracy, per-capability breakdown, and run aggregation. All statistics reuse
 * the high-precision primitives from @agentix-e/cortex-core.
 */
import { mean, variance, welchTTest } from '@agentix-e/cortex-core';
import type {
  AggregateStats,
  Answer,
  BenchmarkDataset,
  Capability,
  Metrics,
  PerCapabilityResult,
} from './types.js';

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
