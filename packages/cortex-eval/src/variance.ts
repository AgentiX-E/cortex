/**
 * Between-run variance analysis.
 *
 * Motivation, stated plainly because it is the reason this file exists: every
 * verdict up to P3b compared a candidate arm against a reference arm **inside a
 * single run**, and judged the result against a two-question floor measured by
 * running two configurationally-identical arms in that same run. P4 then ran the
 * *same* configuration twice, a day apart, and the endpoint moved 25 of 500
 * questions. A floor measured within a run does not bound a difference measured
 * across runs, and every promotion gated on that floor is therefore unsafe.
 *
 * This module answers one question: **how many questions does the endpoint move
 * on its own?** Everything else here — the per-capability breakdown, the
 * chronological series, the required effect size — is in service of that number.
 *
 * Conventions:
 * - Counts are in **questions**, with percentages derived from them. Percentages
 *   hide the denominator, and a denominator of 8 questions (what a misconfigured
 *   sample produced in P4) makes a 1-question change look like 12.5 pp.
 * - The sd is the **population** sd. These are the runs that happened, not a
 *   sample drawn from a process model, and an n-1 denominator would be undefined
 *   at n=1 and inflated at n=4.
 * - Nothing here calls a model or reads a file; it is pure arithmetic over
 *   already-collected observations, so it is fully testable and cannot drift.
 */

import type { Capability } from './types.js';

/** One run's observed correctness counts, per capability and overall. */
export type RunObservation = {
  /** Identifier of the run; used only for reporting, never for computation. */
  runId: string;
  /** Correct/total per capability, as reported by the harness. */
  perCapability: Partial<Record<Capability, { correct: number; total: number }>>;
  /** Total correct questions across the whole graded sample. */
  correct: number;
  /** Size of the graded sample. */
  total: number;
};

/** Spread of a single measured quantity across the config-identical runs. */
export type VarianceStats = {
  /** How many observations contributed. Never zero for a returned record. */
  n: number;
  minCorrect: number;
  maxCorrect: number;
  meanCorrect: number;
  /** Population sd, in questions. */
  sdQuestions: number;
  /** max - min, in questions. The primary figure: robust at small n. */
  rangeQuestions: number;
  /**
   * The range expressed as a percentage. The denominator is the *smallest*
   * sample across the observations, not the pooled sample: the range is a swing
   * the endpoint achieved in a single run, so it must be divided by a single
   * run's sample size, or the percentage understates the swing on every run and
   * is not comparable to an arm's per-run percentage effect.
   */
  spreadPp: number;
  /** Accuracy on the pooled sample; the single-point summary. */
  accuracy: number;
};

export type VarianceSummary = {
  n: number;
  /**
   * False when only one observation is available. One run cannot demonstrate
   * stability, it can only fail to demonstrate instability, and a caller that
   * reads a zero spread as "stable" would be reasoning from an unfalsifiable
   * premise.
   */
  sufficient: boolean;
  runIds: string[];
  perCapability: Partial<Record<Capability, VarianceStats>>;
  overall: VarianceStats;
  /** Correct counts per run, in the order given, so drift is separable from noise. */
  series: { perCapability: Partial<Record<Capability, number[]>>; overall: number[] };
};

/** One question whose correctness differed between two runs. */
export type QuestionFlip = {
  questionId: string;
  /** Correctness in the first run. */
  from: boolean;
  /** Correctness in the second run. */
  to: boolean;
};

export type QuestionVectorComparison = {
  compared: number;
  /** Questions correct in both runs, or incorrect in both. */
  stable: number;
  /** Questions incorrect in the first run and correct in the second. */
  flippedIn: number;
  /** Questions correct in the first run and incorrect in the second. */
  flippedOut: number;
  /** `flippedIn + flippedOut`; the config-identical analogue of discordant pairs. */
  changed: number;
  /** `changed / compared`, or 0 when nothing was compared. */
  changedRate: number;
  discordant: QuestionFlip[];
};

/** The minimum arm effect that clears the measured floor. */
export type RequiredEffectSize = {
  /** Number of config-identical observations the bar rests on. */
  basedOnObservations: number;
  overall: CapabilityRequirement;
  perCapability: Partial<Record<Capability, CapabilityRequirement>>;
};

export type CapabilityRequirement = {
  rangeQuestions: number;
  floorPp: number;
  /**
   * An arm must move **more than** this many questions. Strictly greater than
   * the observed range, because matching the noise is not clearing it, and never
   * below 1, because an arm that changes zero questions has shown nothing even if
   * the endpoint happened to be perfectly stable.
   */
  minQuestionsStrictlyGreaterThan: number;
};

/** Counts of correct answers, used to build a `VarianceStats`. */
type CountSeries = { counts: number[]; sampleSizes: number[] };

/** Total correct across an observation's capability buckets. */
function sumBucketCorrect(observation: RunObservation): number {
  let total = 0;
  for (const bucket of Object.values(observation.perCapability)) {
    if (bucket !== undefined) total += bucket.correct;
  }
  return total;
}

/** Mean of a non-empty list. */
function mean(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Population sd of a non-empty list. */
function populationSd(values: readonly number[]): number {
  const m = mean(values);
  let sumSquares = 0;
  for (const value of values) sumSquares += (value - m) ** 2;
  return Math.sqrt(sumSquares / values.length);
}

/**
 * Build a `VarianceStats` from a series of correct counts and their sample sizes.
 * Assumes `counts` is non-empty; callers guarantee this.
 */
function statsFrom(counts: readonly number[], sampleSizes: readonly number[]): VarianceStats {
  const minCorrect = Math.min(...counts);
  const maxCorrect = Math.max(...counts);
  const rangeQuestions = maxCorrect - minCorrect;
  const total = sampleSizes.reduce((a, b) => a + b, 0);
  const totalCorrect = counts.reduce((a, b) => a + b, 0);
  // A swing happened within one run, so it is normalized by one run's sample —
  // the smallest, which is the conservative choice and keeps the denominator a
  // quantity a single run actually had.
  const smallestSample = Math.min(...sampleSizes);
  const spreadPp = (rangeQuestions / smallestSample) * 100;
  return {
    n: counts.length,
    minCorrect,
    maxCorrect,
    meanCorrect: mean(counts),
    sdQuestions: populationSd(counts),
    rangeQuestions,
    spreadPp,
    // A zero-question run has accuracy 0; `sampleSizes` always carries the graded
    // sample size, which is 1 or more for every real benchmark.
    accuracy: totalCorrect / total,
  };
}

/**
 * Collect the correct-count series for every capability present in any
 * observation, plus the overall series.
 *
 * A capability is included if at least one observation reports it, and is
 * measured only over the observations that do: a capability absent from a run
 * means the run did not measure it, not that it scored zero, and filling in a
 * zero would fabricate evidence for instability.
 */
function collectSeries(observations: readonly RunObservation[]): {
  perCapability: Map<Capability, CountSeries>;
  overall: CountSeries;
} {
  const perCapability = new Map<Capability, CountSeries>();
  const overall: CountSeries = { counts: [], sampleSizes: [] };

  for (const observation of observations) {
    // `correct` is absent when an observation is assembled from the per-run
    // diagnostics rather than the report summary; deriving it from the buckets is
    // exact because the buckets partition the graded sample.
    overall.counts.push(observation.correct ?? sumBucketCorrect(observation));
    overall.sampleSizes.push(observation.total);
    for (const [capability, bucket] of Object.entries(observation.perCapability) as Array<
      [Capability, { correct: number; total: number }]
    >) {
      let series = perCapability.get(capability);
      if (series === undefined) {
        series = { counts: [], sampleSizes: [] };
        perCapability.set(capability, series);
      }
      series.counts.push(bucket.correct);
      series.sampleSizes.push(bucket.total);
    }
  }

  return { perCapability, overall };
}

/**
 * Summarize the spread of the endpoint across config-identical observations.
 *
 * Throws on an empty list: a spread over zero runs is undefined, and returning
 * zero would read as "perfectly stable".
 */
export function summarizeVariance(observations: readonly RunObservation[]): VarianceSummary {
  if (observations.length === 0) {
    throw new Error('summarizeVariance requires at least one observation');
  }

  const { perCapability, overall } = collectSeries(observations);

  const perCapabilityStats: Partial<Record<Capability, VarianceStats>> = {};
  const perCapabilitySeries: Partial<Record<Capability, number[]>> = {};
  // Sort capability keys so the report is deterministic regardless of the order
  // the observations happened to enumerate them in.
  for (const capability of [...perCapability.keys()].sort()) {
    const series = perCapability.get(capability)!;
    perCapabilityStats[capability] = statsFrom(series.counts, series.sampleSizes);
    perCapabilitySeries[capability] = [...series.counts];
  }

  return {
    n: observations.length,
    sufficient: observations.length >= 2,
    runIds: observations.map((observation) => observation.runId),
    perCapability: perCapabilityStats,
    overall: statsFrom(overall.counts, overall.sampleSizes),
    series: { perCapability: perCapabilitySeries, overall: [...overall.counts] },
  };
}

/**
 * Compare two runs' per-question correctness vectors.
 *
 * This is the config-identical analogue of the paired McNemar discordant-pair
 * count. With two runs of the *same* configuration, `changed` is not an effect
 * size — it is the measurement noise, and an arm must move more questions than
 * this to be distinguishable from re-running the benchmark.
 *
 * Throws when a vector's length disagrees with the id list: comparing question i
 * of one run against question j of another yields a plausible-looking number from
 * meaningless data, which is precisely the class of error this module exists to
 * catch.
 */
export function compareQuestionVectors(
  questionIds: readonly string[],
  first: readonly boolean[],
  second: readonly boolean[],
): QuestionVectorComparison {
  if (first.length !== questionIds.length) {
    throw new Error(
      `first vector length ${first.length} is not ${questionIds.length}, the number of question ids`,
    );
  }
  if (second.length !== questionIds.length) {
    throw new Error(
      `second vector length ${second.length} is not ${questionIds.length}, the number of question ids`,
    );
  }

  let stable = 0;
  let flippedIn = 0;
  let flippedOut = 0;
  const discordant: QuestionFlip[] = [];

  for (let i = 0; i < questionIds.length; i++) {
    const from = first[i]!;
    const to = second[i]!;
    if (from === to) {
      stable++;
      continue;
    }
    if (to) {
      flippedIn++;
    } else {
      flippedOut++;
    }
    discordant.push({ questionId: questionIds[i]!, from, to });
  }

  const compared = questionIds.length;
  return {
    compared,
    stable,
    flippedIn,
    flippedOut,
    changed: flippedIn + flippedOut,
    // An empty denominator yields 0, not NaN: NaN would propagate silently into
    // any downstream average.
    changedRate: compared === 0 ? 0 : (flippedIn + flippedOut) / compared,
    discordant,
  };
}

/** Derive the minimum arm effect that clears the floor implied by a summary. */
function requirementFrom(stats: VarianceStats): CapabilityRequirement {
  return {
    rangeQuestions: stats.rangeQuestions,
    floorPp: stats.spreadPp,
    minQuestionsStrictlyGreaterThan: Math.max(1, stats.rangeQuestions + 1),
  };
}

/**
 * Derive the effect an arm must exceed to be distinguishable from re-running the
 * benchmark.
 *
 * Throws when the summary rests on fewer than two observations: with n=1 there is
 * no spread, so any bar derived from it is fabricated rather than measured.
 */
export function requiredEffectSize(summary: VarianceSummary): RequiredEffectSize {
  if (!summary.sufficient) {
    throw new Error('requiredEffectSize requires at least two observations to measure a spread');
  }

  const perCapability: Partial<Record<Capability, CapabilityRequirement>> = {};
  for (const [capability, stats] of Object.entries(summary.perCapability) as Array<
    [Capability, VarianceStats]
  >) {
    perCapability[capability] = requirementFrom(stats);
  }

  return {
    basedOnObservations: summary.n,
    overall: requirementFrom(summary.overall),
    perCapability,
  };
}
