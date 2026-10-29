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
  CompletedPass,
  BenchmarkDataset,
  Capability,
  CountSpread,
  MemorySystem,
  PartialAblation,
  PerCapabilityPairedStats,
} from './types.js';
import { classifyTransitions } from './answer-transition.js';
import { evaluateWithScorerDetailed } from './benchmark.js';
import type { BenchmarkProgressCallback } from './benchmark.js';
import { correctnessMask } from './question-record.js';
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
 * Only when nothing at all was measured is nothing attached, and `run` is part of that
 * question rather than a detail of the record. The repetitions are sequential, so a
 * repetition ordinal above zero means every earlier repetition completed on both sides:
 * a partial at `run: 1` with two empty vectors states that repetition 1 died before it
 * measured anything, which is a real measurement record. At `run: 0` there is nothing
 * before it, and a partial of two empty vectors is then the same bytes as a broken
 * capture -- the `null` vs `''` distinction the evidence capture keeps one layer up --
 * so that is the case that attaches nothing.
 *
 * The predicate is not `reached === 0` either, and for the same reason one repetition in:
 * `reached` counts the side that was RUNNING when the error surfaced, so a feature-side
 * death at question 0 leaves `reached: 0` and a COMPLETE baseline, and discarding the
 * baseline then would throw away the half of the measurement that finished.
 */
function attachPartial(error: unknown, partial: PartialAblation): unknown {
  const measuredNothing =
    partial.run === 0 &&
    partial.reached === 0 &&
    partial.baselineAnswers.length === 0 &&
    partial.completed.length === 0;
  if (measuredNothing) return error;
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
  /**
   * Wall-clock ceiling for **each pass**, in milliseconds. Absent means no ceiling.
   *
   * ## Why the unit is a pass and not the whole ablation
   *
   * Each pass is one system over one repetition, and that is where a hang happens: run
   * `38725510400` spent over five hours in the reference pipeline's first question and
   * never ended, and the workflow's own `timeout-minutes: 240` did not fire, so no
   * `benchmark-error.log` was written at all. A per-ablation ceiling would have to be
   * derived from a figure the caller knows (four repetitions of two sides) and would still
   * let one hung pass consume it; a per-pass ceiling is the quantity that was actually
   * observed to run away.
   *
   * ## Why the measured value is generous rather than tight
   *
   * A pass is roughly a twenty-sixth of a completed run on this arm (`3h32m` for eight
   * passes), so a ceiling has to be far above that to be a hang detector rather than a
   * slow-run detector. The dispatch sets it well above what any healthy pass has measured,
   * and the reason is the same one §13.28 gives: a hang and a slow pass want opposite
   * repairs, and a ceiling that fires on the slow one destroys the measurement it was meant
   * to protect.
   */
  budgetMs?: number | undefined;
};

/** Run a baseline vs feature ablation and report statistical significance. */
/**
 * Correct counts per capability, aggregated across repetitions.
 *
 * ## Why the unit is a count and not a rate
 *
 * A capability's questions are fixed, so a rate hides the denominator a reader needs to compare two
 * runs of different sample sizes; the count is what the roster shows and what a reader has been
 * comparing. `questionsByCapability` carries the denominator beside it.
 *
 * ## Why min / mean / max rather than a standard deviation
 *
 * Four repetitions do not support a variance estimate worth quoting, and the campaign's decisions
 * have always been made against a range. Recording the three numbers states the range without
 * implying a distribution nobody measured.
 *
 * A capability absent from every repetition's dataset cannot arise -- the vectors are aligned with
 * the dataset by construction -- so there is no empty-object branch here.
 */
function spreadByCapability(
  dataset: BenchmarkDataset,
  correctPerRun: readonly (readonly boolean[])[],
): Record<string, CountSpread> {
  const capabilities = questionsByCapability(dataset);
  const totals: Record<string, number[]> = {};
  for (const capability of Object.keys(capabilities)) totals[capability] = [];
  for (const correct of correctPerRun) {
    const counts: Record<string, number> = {};
    for (const capability of Object.keys(capabilities)) counts[capability] = 0;
    dataset.questions.forEach((question, index) => {
      // `!` because `counts` was seeded with every capability above: the fallback a `?? 0` would
      // provide is unreachable, and an unreachable branch in a counter is exactly the shape that
      // hides a real one (`§57.6`).
      if (correct[index] === true) counts[question.capability]! += 1;
    });
    for (const [capability, count] of Object.entries(counts)) totals[capability]!.push(count);
  }
  return Object.fromEntries(
    Object.entries(totals).map(([capability, counts]) => [
      capability,
      {
        min: Math.min(...counts),
        avg: counts.reduce((sum, count) => sum + count, 0) / counts.length,
        max: Math.max(...counts),
      },
    ]),
  );
}

/** How many questions each capability carries, so a count can be read as a rate. */
function questionsByCapability(dataset: BenchmarkDataset): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const question of dataset.questions) {
    counts[question.capability] = (counts[question.capability] ?? 0) + 1;
  }
  return counts;
}

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
  // Every repetition that finished, so a failure in a later one does not discard it.
  // Declared HERE rather than inside the loop below because the first repetition is
  // not run by that loop -- it is the pair of calls immediately after this line --
  // and a `completed` that only ever held the loop's repetitions would report `[]`
  // for the failure the runs above actually had.
  const completed: CompletedPass[] = [];
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
      options.budgetMs,
    );
  } catch (error) {
    throw attachPartial(error, {
      system: baseline.name,
      reached: baselineAnswers.length,
      total: dataset.questions.length,
      run: 0,
      baselineAnswers,
      featureAnswers,
      completed,
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
      options.budgetMs,
    );
  } catch (error) {
    throw attachPartial(error, {
      system: feature.name,
      reached: featureAnswers.length,
      total: dataset.questions.length,
      run: 0,
      baselineAnswers,
      featureAnswers,
      completed,
    });
  }

  // Repetition 0 is the only one whose completion is not visible where the others'
  // is: it ends here rather than at the bottom of the loop below. Recorded before
  // the pairing arithmetic, because the arithmetic can throw on a length mismatch
  // (`buildQuestionRecords` throws for the same reason) and the answers would then
  // be lost by a failure that is not about them.
  completed.push({ run: 0, baselineAnswers, featureAnswers });

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

  // The two flip counts split by the abstention line, from the same two vectors the loop above walked.
  //
  // Computed here rather than in `report.ts` because the answers are in hand exactly once -- on the two
  // `ScoredEvaluation`s this function owns -- and a reporter that recomputed them from the roster would be a
  // second definition of the same classification, reading a field (`correct`) that cannot see a decline at
  // all. `classifyTransitions` throws on a length mismatch, which is the one way this call can fail and the
  // one way a wrong pairing would otherwise reach the artifact.
  const transitions = classifyTransitions({
    baselineAnswers: baseFirst.answers,
    featureAnswers: featFirst.answers,
    baselineCorrect: baseFirst.correct,
    featureCorrect: featFirst.correct,
  });

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
  // Seeded with the first repetition, which is the one the roster records.
  const baselineCorrect: boolean[][] = [baseFirst.correct];
  const featureCorrectPerRun: boolean[][] = [featFirst.correct];
  for (let i = 1; i < runs; i++) {
    // `run: i` rather than the default, so a repeated pass is distinguishable in
    // the progress stream from the first one. Both sides take the same ordinal:
    // they are two systems measured in one repetition, not two repetitions.
    //
    // ## Why this loop has sinks and a wrap, and it is the same reason the loop above does
    //
    // It did not, and run `38520676669` is the cost. That run dispatched §13.22's
    // measurement, completed repetitions 0 and 1 on both sides -- two thousand graded
    // answers -- and died on `TypeError: terminated` at the start of repetition 2. Because
    // this loop passed no sink and had no catch, the error left `runAblation` unwrapped,
    // `error.partial` was `undefined`, and the failure path in `bench/run-ablation.ts`
    // wrote an error log and nothing else. Three hours and eight minutes produced no
    // durable record of anything.
    //
    // The durability rule is stated at the top of `partial-ablation.test.ts` and it does
    // not distinguish repetitions: a repetition is a measurement, and losing one silently
    // is the defect that file exists to prevent. What differs is only which vectors the
    // partial carries -- the dying repetition's, in both cases -- because
    // `PartialAblation.run` records how many repetitions completed before it.
    const baselineThisRun: Answer[] = [];
    const featureThisRun: Answer[] = [];
    let b: ScoredEvaluation;
    try {
      b = await evaluateWithScorerDetailed(
        dataset,
        baseline,
        scorer,
        options.onProgress,
        i,
        // No capture on a repeat: the artifact records the first repetition's raw output and
        // evidence, and capturing every repetition would multiply the artifact by `runs` for
        // vectors no reader pairs with a record.
        false,
        false,
        (answer) => baselineThisRun.push(answer),
        options.budgetMs,
      );
    } catch (error) {
      throw attachPartial(error, {
        system: baseline.name,
        reached: baselineThisRun.length,
        total: dataset.questions.length,
        run: i,
        baselineAnswers: baselineThisRun,
        featureAnswers: featureThisRun,
        completed,
      });
    }
    let f: ScoredEvaluation;
    try {
      f = await evaluateWithScorerDetailed(
        dataset,
        feature,
        scorer,
        options.onProgress,
        i,
        false,
        false,
        (answer) => featureThisRun.push(answer),
        options.budgetMs,
      );
    } catch (error) {
      throw attachPartial(error, {
        system: feature.name,
        reached: featureThisRun.length,
        total: dataset.questions.length,
        run: i,
        baselineAnswers: baselineThisRun,
        featureAnswers: featureThisRun,
        completed,
      });
    }
    baselineScores.push(toScore(b.metrics));
    featureScores.push(toScore(f.metrics));
    // §13.88. The correctness vectors are held per repetition, because a per-capability count that
    // only ever existed for one pass is the unit defect §13.87 measured: the same configuration
    // moved MR by seven questions between two runs and the artifact could not say so.
    baselineCorrect.push(b.correct);
    featureCorrectPerRun.push(f.correct);
    completed.push({
      run: i,
      baselineAnswers: baselineThisRun,
      featureAnswers: featureThisRun,
    });
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

  // §13.88's projection. Absent for one repetition, because a spread of zero would read as
  // perfect stability rather than as no measurement. The masks ride the same condition: at one
  // repetition they would be a second copy of `featureCorrect`/`baselineCorrect`, and two arrays that
  // must agree are two arrays that can disagree.
  const capabilitySpreads =
    runs > 1
      ? {
          featureByCapability: spreadByCapability(dataset, featureCorrectPerRun),
          baselineByCapability: spreadByCapability(dataset, baselineCorrect),
          questionsByCapability: questionsByCapability(dataset),
          featureCorrectByRun: featureCorrectPerRun.map(correctnessMask),
          baselineCorrectByRun: baselineCorrect.map(correctnessMask),
        }
      : {};

  return {
    ...capabilitySpreads,
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
    transitions,
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
    // Beside the context vector and from the same capture, because the two are one
    // fact: the context is what the reader was shown, this is how much of it
    // reached the prompt. Carrying only the first is what let `38044858147`'s
    // artifact report 3,016-4,528 turns of evidence for a model that received
    // roughly 150-160.
    featurePromptEvidenceChars: featFirst.promptEvidenceChars!,
    featureAdmittedEvidence: featFirst.admittedEvidence!,
    perCapability,
  };
}
