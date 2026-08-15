/**
 * Ablation framework: run a baseline system and a feature system multiple times,
 * aggregate their accuracies, and compare with a Welch t-test + Cohen's d.
 */
import type { AblationResult, BenchmarkDataset, MemorySystem } from './types.js';
import { evaluate } from './benchmark.js';
import { aggregate, cohensD, tTestPValue } from './metrics.js';

export type AblationOptions = {
  /** Number of independent runs per system (default 3). */
  runs?: number;
  /** Significance threshold (default 0.05). */
  alpha?: number;
  /** Use abstention-aware accuracy as the comparison metric (default true). */
  abstentionAware?: boolean;
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
  if (runs < 3) {
    throw new Error(`ablation requires at least 3 runs, got ${runs}`);
  }

  const baselineScores: number[] = [];
  const featureScores: number[] = [];
  for (let i = 0; i < runs; i++) {
    const b = await evaluate(dataset, baseline);
    const f = await evaluate(dataset, feature);
    baselineScores.push(abstentionAware ? b.abstentionAwareAccuracy : b.accuracy);
    featureScores.push(abstentionAware ? f.abstentionAwareAccuracy : f.accuracy);
  }

  const baselineAggregate = aggregate(baselineScores);
  const featureAggregate = aggregate(featureScores);
  const delta = featureAggregate.avg - baselineAggregate.avg;
  const pValue = tTestPValue(baselineScores, featureScores);
  const effectSize = cohensD(baselineScores, featureScores);

  return {
    feature: feature.name,
    baselineAggregate,
    featureAggregate,
    delta,
    pValue,
    significant: pValue < alpha,
    effectSize,
  };
}
