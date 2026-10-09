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
  Answer,
  BenchmarkDataset,
  Capability,
  MemorySystem,
  PartialAblation,
  PerCapabilityPairedStats,
} from './types.js';
import { evaluateWithScorer, evaluateWithScorerDetailed } from './benchmark.js';
import type { BenchmarkProgressCallback } from './benchmark.js';
import {
  aggregate,
  cohensD,
  exactMatchScorer,
  mcnemarPValue,
  tTestPValue,
  type AnswerScorer,
  type ScoredEvaluation,
} from './metrics.js';

const ALL_CAPABILITIES: Capability[] = ['IE', 'MR', 'KU', 'TR', 'ABS'];

/**
 * Attach what was measured to the error that ended the run, and rethrow it.
 *
 * ## Why the measurement is attached rather than returned
 *
 * An ablation that did not finish must not RESOLVE. A caller cannot tell a
 * returned partial from a complete result by looking at it, and the number that
 * would be fabricated is `delta` -- which is `featureAggregate.avg -
 * baselineAggregate.avg` over the same index vector, so with one side short it is
 * meaningful arithmetic over data that was never paired. `variance.ts` throws to
 * prevent exactly that one layer down.
 *
 * ## Why it is attached rather than logged
 *
 * Run `37942775447` graded for ~40 minutes and left nothing: the answers lived in
 * `runBenchmark`'s local array, which the stack unwound. A log line would have the
 * same problem in a different medium -- it survives only if someone reads it, and
 * the artifact is what a later run reads. Attaching the vectors to the error puts
 * them in the caller's hands at the only moment they exist.
 *
 * ## Why the original error is preserved
 *
 * The cause that brought us here is a transport error, and its stack is the only
 * evidence in the record that the loss was infrastructure rather than a defect in
 * the arm (§13.11.7). Wrapping it in a new `Error` would replace that stack with
 * one that says "the ablation failed", which is already known. So the field is set
 * on the original and the original is rethrown -- a mutation, deliberately, since
 * the alternative is losing the thing the diagnostic exists for.
 *
 * ## The no-measurement case
 *
 * Only when BOTH vectors are empty is nothing attached. The predicate is not
 * `reached === 0`, because `reached` counts the side that was RUNNING when the
 * error surfaced: a feature-side death at question 0 leaves `reached: 0` and a
 * COMPLETE baseline, and discarding the baseline then would throw away the half of
 * the measurement that finished. A `partial` of two empty vectors is the same
 * bytes as a broken capture -- the `null` vs `''` distinction the evidence capture
 * keeps one layer up -- so that is the case that attaches nothing.
 */
function attachPartial(error: unknown, partial: PartialAblation): unknown {
  if (partial.reached === 0 && partial.baselineAnswers.length === 0) return error;
  if (error !== null && typeof error === 'object') {
    (error as { partial?: PartialAblation }).partial = partial;
  }
  return error;
}

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
  /**
   * Optional per-question progress sink, forwarded to every evaluation.
   *
   * Each event carries the side (`system`) and the repetition (`run`), because an
   * ablation runs the baseline in full, then the feature in full, then both again
   * for each additional run -- so a record without either is ambiguous. The
   * failure this exists to localise is a mid-run one: run `37281155088`'s arm died
   * on the feature side after ~52 minutes and its log named no question and no
   * side. See `BenchmarkProgress`.
   */
  onProgress?: BenchmarkProgressCallback;
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
  //
  // Both sides carry `run: 0`. The baseline is evaluated to completion before the
  // feature starts, so the progress stream reads as one side's questions, then the
  // other's -- which is the same ordering the pairing argument depends on, and is
  // asserted by `ablation-progress.test.ts` rather than assumed here.
  //
  // Both sides accumulate their answers through a sink, so a throw leaves the
  // measurement reachable rather than only inside a local array the stack is about
  // to unwind. See `attachPartial` below for what is done with them and why a
  // partial result must not report a delta.
  const baselineAnswers: Answer[] = [];
  const featureAnswers: Answer[] = [];
  let baseFirst: ScoredEvaluation;
  try {
    baseFirst = await evaluateWithScorerDetailed(
      dataset,
      baseline,
      scorer,
      options.onProgress,
      0,
      false,
      false,
      (answer) => baselineAnswers.push(answer),
    );
  } catch (error) {
    throw attachPartial(error, {
      system: baseline.name,
      reached: baselineAnswers.length,
      total: dataset.questions.length,
      run: 0,
      baselineAnswers,
      featureAnswers,
    });
  }
  let featFirst: ScoredEvaluation;
  try {
    featFirst = await evaluateWithScorerDetailed(
      dataset,
      feature,
      scorer,
      options.onProgress,
      0,
      // The feature side is the one whose model output explains a loss, and the
      // baseline is the reference pipeline whose abstention path is a different
      // design. Capturing only this side keeps the artifact's raw-output vector
      // aligned with `featureAnswers` and `featureCorrect`, which are the vectors
      // the roster pairs it with.
      true,
      // The evidence, on the same side and for the same reason: §13's loss is the
      // feature's, and the question it left open -- wrong evidence or no evidence --
      // can only be asked of the side that lost.
      true,
      (answer) => featureAnswers.push(answer),
    );
  } catch (error) {
    throw attachPartial(error, {
      system: feature.name,
      reached: featureAnswers.length,
      total: dataset.questions.length,
      run: 0,
      baselineAnswers,
      featureAnswers,
    });
  }

  let baselineCorrectFeatureIncorrect = 0;
  let baselineIncorrectFeatureCorrect = 0;
  // Collected alongside the counts, in the same pass. A flip count alone cannot
  // distinguish a mechanism from a coincidence: the conjunction arm's four flips
  // were all in IE while its target population never moved, and nothing in the
  // artifact could name them.
  const discordantRegression: string[] = [];
  const discordantGain: string[] = [];
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
      discordantRegression.push(dataset.questions[i]!.id);
    } else if (!baseCorrect && featCorrect) {
      baselineIncorrectFeatureCorrect++;
      bucket.baselineIncorrectFeatureCorrect++;
      discordantGain.push(dataset.questions[i]!.id);
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
    // `run: i` rather than the default, so a repeated pass is distinguishable in
    // the progress stream from the first one. Both sides take the same ordinal:
    // they are two systems measured in one repetition, not two repetitions.
    const b = await evaluateWithScorer(dataset, baseline, scorer, options.onProgress, i);
    const f = await evaluateWithScorer(dataset, feature, scorer, options.onProgress, i);
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
    discordantQuestions: {
      baselineCorrectFeatureIncorrect: discordantRegression,
      baselineIncorrectFeatureCorrect: discordantGain,
    },
    baselineMetrics: baseFirst.metrics,
    featureMetrics: featFirst.metrics,
    featureCorrect: featFirst.correct,
    featureAnswers: featFirst.answers,
    // An assertion, not a fallback. This function is the only producer of an
    // `AblationResult` and it requests the capture unconditionally on the line
    // that evaluates the feature, so `rawOutputs` is present on every path that
    // reaches here. A `=== undefined` branch would be unreachable code that reads
    // as a safety net, which is what §57.6 removed one field over, and it would
    // also make the raw vector silently absent for a run that asked for it --
    // the artifact would then describe the capture as unavailable rather than as
    // failed. The field stays optional on the type because `AblationResult` is a
    // report shape that tests build by hand, which is the reason
    // `featureAnswers` above is optional too.
    featureRawOutputs: featFirst.rawOutputs!,
    // Requested on the same call as the raw-output capture, and present for the
    // same reason: this function is the only producer of an `AblationResult` and
    // it asks for both unconditionally, so a `=== undefined` branch here would be
    // the unreachable-code-reads-as-a-safety-net shape §57.6 removed one field
    // over.
    //
    // It is declared optional on the type because `AblationResult` is a report
    // shape tests build by hand -- and unlike `featureAnswers`, whose absence
    // would silently unbuild the roster, a hand-built fixture that omits this
    // vector produces records with `turns: []`, which is the honest reading of a
    // fixture that never retrieved anything.
    featureRetrievedContexts: featFirst.retrievedContexts!,
    perCapability,
  };
}
