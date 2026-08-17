/**
 * Ablation framework: run a baseline system and a feature system, aggregate their
 * accuracies, and compare them with scientifically valid tests.
 *
 * - Wilson 95% intervals quantify finite-sample accuracy uncertainty.
 * - The exact paired McNemar test compares the two systems on the SAME questions,
 *   which is valid even for a single deterministic evaluation.
 * - A Welch t-test + Cohen's d is reported only when repeated runs actually
 *   introduce sampling variance (stochastic temperature), because a t-test over
 *   identical deterministic repeats is undefined.
 */
import { stddev, wilsonScoreInterval } from '@agentix-e/cortex-core';
import type {
  AblationResult,
  BenchmarkDataset,
  Capability,
  MemorySystem,
  PerCapabilityPairedStats,
} from './types.js';
import { evaluateWithScorer, evaluateWithScorerDetailed } from './benchmark.js';
import {
  aggregate,
  cohensD,
  exactMatchScorer,
  mcnemarPValue,
  tTestPValue,
  type AnswerScorer,
} from './metrics.js';

const ALL_CAPABILITIES: Capability[] = ['IE', 'MR', 'KU', 'TR', 'ABS'];

function emptyPairedStats(): PerCapabilityPairedStats {
  return {
    total: 0,
    baselineCorrect: 0,
    featureCorrect: 0,
    baselineCorrectFeatureIncorrect: 0,
    baselineIncorrectFeatureCorrect: 0,
    mcnemarPValue: 1,
    mcnemarSignificant: false,
    baselineConfidence: { lower: 0, upper: 1 },
    featureConfidence: { lower: 0, upper: 1 },
  };
}

export type AblationOptions = {
  /** Number of independent runs per system (default 3). */
  runs?: number;
  /** Significance threshold (default 0.05). */
  alpha?: number;
  /** Use abstention-aware accuracy as the comparison metric (default true). */
  abstentionAware?: boolean;
  /** Answer scorer; defaults to exact match. */
  scorer?: AnswerScorer;
};

/** Run a baseline vs feature ablation and report statistical significance. */
export async function runAblation(
  dataset: BenchmarkDataset,
  baseline: MemorySystem,
  feature: MemorySystem,
  options: AblationOptions = {},
): Promise<AblationResult> {
  const runs = options.runs ?? 3;
  const alpha = options.alpha ?? 0.05;
  const abstentionAware = options.abstentionAware ?? true;
  const scorer = options.scorer ?? exactMatchScorer;
  if (runs < 1) {
    throw new Error(`ablation requires at least 1 run, got ${runs}`);
  }

  // The first evaluation captures per-question correctness so the paired McNemar
  // test and the Wilson intervals can be computed. These are question-level
  // statistics that a run-level t-test cannot provide for a deterministic system.
  const baseFirst = await evaluateWithScorerDetailed(dataset, baseline, scorer);
  const featFirst = await evaluateWithScorerDetailed(dataset, feature, scorer);

  let baselineCorrectFeatureIncorrect = 0;
  let baselineIncorrectFeatureCorrect = 0;
  const perCapability = Object.fromEntries(
    ALL_CAPABILITIES.map((c) => [c, emptyPairedStats()]),
  ) as Record<Capability, PerCapabilityPairedStats>;
  for (let i = 0; i < baseFirst.correct.length; i++) {
    const baseCorrect = baseFirst.correct[i]!;
    const featCorrect = featFirst.correct[i]!;
    const capability = dataset.questions[i]!.capability;
    const bucket = perCapability[capability]!;
    bucket.total++;
    if (baseCorrect) {
      bucket.baselineCorrect++;
    }
    if (featCorrect) {
      bucket.featureCorrect++;
    }
    if (baseCorrect && !featCorrect) {
      baselineCorrectFeatureIncorrect++;
      bucket.baselineCorrectFeatureIncorrect++;
    } else if (!baseCorrect && featCorrect) {
      baselineIncorrectFeatureCorrect++;
      bucket.baselineIncorrectFeatureCorrect++;
    }
  }

  for (const capability of ALL_CAPABILITIES) {
    const bucket = perCapability[capability]!;
    bucket.mcnemarPValue = mcnemarPValue(
      bucket.baselineCorrectFeatureIncorrect,
      bucket.baselineIncorrectFeatureCorrect,
    );
    bucket.mcnemarSignificant = bucket.mcnemarPValue < alpha;
    bucket.baselineConfidence = wilsonScoreInterval(bucket.baselineCorrect, bucket.total);
    bucket.featureConfidence = wilsonScoreInterval(bucket.featureCorrect, bucket.total);
  }

  const baselineConfidence = wilsonScoreInterval(
    baseFirst.metrics.correct,
    baseFirst.metrics.total,
  );
  const featureConfidence = wilsonScoreInterval(featFirst.metrics.correct, featFirst.metrics.total);
  const mcnemar = mcnemarPValue(baselineCorrectFeatureIncorrect, baselineIncorrectFeatureCorrect);
  const mcnemarSignificant = mcnemar < alpha;

  const toScore = (m: typeof baseFirst.metrics): number =>
    abstentionAware ? m.abstentionAwareAccuracy : m.accuracy;

  const baselineScores = [toScore(baseFirst.metrics)];
  const featureScores = [toScore(featFirst.metrics)];
  for (let i = 1; i < runs; i++) {
    const b = await evaluateWithScorer(dataset, baseline, scorer);
    const f = await evaluateWithScorer(dataset, feature, scorer);
    baselineScores.push(toScore(b));
    featureScores.push(toScore(f));
  }

  const baselineAggregate = aggregate(baselineScores);
  const featureAggregate = aggregate(featureScores);
  const delta = featureAggregate.avg - baselineAggregate.avg;

  // A t-test over runs is only meaningful when the repeats carry real variance
  // (stochastic temperature > 0). Identical deterministic repeats have zero
  // variance, so the t-test is undefined and reported as NaN.
  const hasVariance =
    baselineScores.length >= 2 && (stddev(baselineScores) > 0 || stddev(featureScores) > 0);
  const pValue = hasVariance ? tTestPValue(baselineScores, featureScores) : Number.NaN;
  const effectSize = hasVariance
    ? cohensD(baselineScores, featureScores)
    : delta === 0
      ? 0
      : delta > 0
        ? Infinity
        : -Infinity;

  return {
    feature: feature.name,
    baselineAggregate,
    featureAggregate,
    delta,
    pValue,
    significant: hasVariance && pValue < alpha,
    effectSize,
    baselineConfidence,
    featureConfidence,
    mcnemarPValue: mcnemar,
    mcnemarSignificant,
    discordant: {
      baselineCorrectFeatureIncorrect,
      baselineIncorrectFeatureCorrect,
    },
    baselineMetrics: baseFirst.metrics,
    featureMetrics: featFirst.metrics,
    perCapability,
  };
}
