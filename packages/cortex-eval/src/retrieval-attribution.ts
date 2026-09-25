/**
 * Retrieval-gap attribution: decomposing the ranking gap into what a ranking
 * change can actually reach.
 *
 * ## The question this answers
 *
 * The recall curve reports a 63.08 pp gap at k=1 against a 96.26% ceiling, and
 * the roadmap read that as "ranking is the bottleneck". The cross-encoder
 * reranking arms then measured +1.33 and -1.33 pp at p=0.7539 -- no effect --
 * which refuted the *inference* while leaving the *diagnosis* intact. The gap is
 * real. The question that remained open is what kind of thing it is.
 *
 * Two readings are arithmetically identical and mechanically different:
 *
 *   1. The reader receives the evidence turn and fails to use it. Ranking
 *      cannot help; the work is in the reader or in how the context is packed.
 *   2. The reader never receives the evidence turn and consequently fails.
 *      Ranking is exactly the right lever.
 *
 * A recall curve cannot tell them apart, because it measures what retrieval
 * *delivered*, not what the reader could have *used*. This module compares the
 * curve against the run's own accuracy, per capability, and separates the gap.
 *
 * ## What the separation rests on
 *
 * The load-bearing observation is a question about two arms, not about the
 * curve: if a capability was answered *identically* before and after an
 * intervention, then that intervention moved nothing in it, whatever else it
 * did. In the A2 dispatch every capability except ABS had byte-identical
 * `correct` counts across the baseline and feature arms (IE 145/145, MR
 * 106/106, KU 59/59, TR 91/91), while ABS went 0 -> 29 and its `abstained`
 * count went 0 -> 29. So the entire +29 came from questions the reader now
 * answers *by refusing*, which is the one population retrieval cannot serve.
 *
 * That is why `abstentionQuestions` is subtracted from the ranking gap rather
 * than left inside it: an abstention question has no evidence turn to rank. The
 * recall curve already excludes them for exactly this reason, and it names them
 * `abstention` in `excluded`.
 *
 * ## The clamping, and why it is not defensive coding
 *
 * `rankingGapFailureCount` can return less than the naive subtraction. A reader
 * that answers correctly from context it retrieved *below* rank 1 has already
 * absorbed part of the gap: those questions are covered-but-not-admitted and
 * were nonetheless answered. Counting them as recoverable would credit a
 * ranking change with questions that need no change. The clamp at zero covers
 * the same situation taken to its limit, where the reader answers more
 * questions than the top-1 set contains because it also uses ranks 2..k.
 */

/** A capability's result in one arm, as the report records it. */
export type CapabilityAccuracy = {
  readonly capability: string;
  readonly total: number;
  readonly correct: number;
  /**
   * Questions the arm answered with an abstention. Only meaningful for a
   * capability whose correct answer *is* to refuse; other capabilities abstain
   * as a failure mode, which is a different event.
   */
  readonly abstained: number;
};

/** The three curve numbers the attribution needs, in the curve's own units. */
export type CurveSummary = {
  /** Questions the curve was computed over -- its own denominator. */
  readonly considered: number;
  /** Best achievable recall at the pool width, as a fraction of `considered`. */
  readonly ceiling: number;
  /** Achieved recall at k=1, as a fraction of `considered`. */
  readonly recallAtOne: number;
};

export type RetrievalGapAttribution = {
  /** Questions the curve was computed over. */
  readonly curveDenominator: number;
  /** Questions the run graded. Differs from `curveDenominator` by the exclusions. */
  readonly runQuestionCount: number;
  /** Curve denominator minus run denominator: questions the curve left out. */
  readonly absentFromDenominatorQuestions: number;

  /** Questions whose evidence turn is anywhere in the pool. */
  readonly coveredQuestions: number;
  /**
   * Questions whose evidence turn ranked at or above k=1, i.e. the recall the
   * system already achieves.
   *
   * Exposed because the three gap figures do not reconstruct the denominator
   * without it. The partition of `considered` is:
   *
   *   admitted + rankingGap + retrievalGap === considered
   *
   * and leaving this out makes that identity unstatable -- a reader would have
   * to take the other three numbers on trust.
   */
  readonly admittedAtOne: number;
  /** Questions whose evidence turn is in the pool but ranked below k=1. */
  readonly rankingGapQuestions: number;
  /** Questions whose evidence turn was never retrieved at all. */
  readonly retrievalGapQuestions: number;

  /**
   * Abstention questions in the run -- a population the gap does **not**
   * describe.
   *
   * These are reported separately rather than subtracted, because the curve
   * already excluded them: `considered` is the post-exclusion denominator, so
   * `covered` and `rankingGap` are measured over non-abstention questions only.
   * Subtracting this field from `rankingGapQuestions` would double-remove them.
   *
   * The separation is the point. In A2, the entire +29 came from these
   * questions (the reader learned to refuse) and the entire 270-question
   * ranking gap sits outside them. Two disjoint populations, two different
   * mechanisms, and one number that used to stand for both.
   */
  readonly abstentionQuestions: number;

  /** Covered-but-unadmitted questions the reader answered anyway. */
  readonly gapAlreadyAbsorbedByReader: number;
  /** Covered-but-unadmitted questions the reader failed. */
  readonly recoverableFromRanking: number;

  /** Correctness the feature added in capabilities whose answers are refusals. */
  readonly improvementFromAbstention: number;
  /** Correctness the feature added everywhere else. */
  readonly improvementFromOtherCapabilities: number;
  /** Capabilities whose `correct` count is identical in both arms. */
  readonly unchangedCapabilities: string[];
};

/**
 * Options for `attributeRecallGap`.
 *
 * Both arms are required. A single arm cannot be attributed: the observation
 * that a capability did not move is a statement about two measurements, and one
 * measurement has nothing to compare against.
 */
export type AttributeRecallGapOptions = {
  readonly curve: CurveSummary;
  readonly baseline: readonly CapabilityAccuracy[];
  readonly feature: readonly CapabilityAccuracy[];
  /**
   * Capabilities whose correct answer is to refuse, and which are therefore
   * excluded from the ranking gap. Defaults to `['ABS']`, the single such
   * capability in LongMemEval.
   */
  readonly abstentionCapabilities?: readonly string[];
};

/**
 * Count of covered-but-unadmitted questions the reader did not answer.
 *
 * The clamp is meaningful rather than defensive. A reader answering more
 * questions than the admitted set contains is normal -- it uses the whole
 * context, not just rank 1 -- so an unclamped subtraction goes negative exactly
 * when the reader is doing well.
 */
export function rankingGapFailureCount(input: {
  readonly coveredQuestions: number;
  readonly admittedAtOne: number;
  readonly readerCorrect: number;
}): number {
  const coveredButUnadmitted = Math.max(0, input.coveredQuestions - input.admittedAtOne);
  // The reader absorbed `readerCorrect - admittedAtOne` questions beyond the
  // admitted set, assuming it answered every admitted one. That count is what
  // the gap must give up.
  const absorbed = Math.max(0, input.readerCorrect - input.admittedAtOne);
  return Math.max(0, coveredButUnadmitted - absorbed);
}

/** Rounds a fraction-of-`considered` to a question count, clamped at zero. */
function toQuestions(fraction: number, considered: number): number {
  return Math.max(0, Math.round(fraction * considered));
}

export function attributeRecallGap(options: AttributeRecallGapOptions): RetrievalGapAttribution {
  const { curve, baseline, feature } = options;
  const abstentionCapabilities = options.abstentionCapabilities ?? ['ABS'];
  const abstentionSet = new Set(abstentionCapabilities);

  const considered = curve.considered;
  const coveredQuestions = toQuestions(curve.ceiling, considered);
  const admittedAtOne = toQuestions(curve.recallAtOne, considered);

  // Covered but not admitted. Clamped for the pool-narrower-than-cutoff case
  // the curve's own `gain` clamps for: a negative gap would read as "ranking
  // work makes things worse" when the truth is "the pool is too narrow".
  const rankingGapQuestions = Math.max(0, coveredQuestions - admittedAtOne);
  const retrievalGapQuestions = Math.max(0, considered - coveredQuestions);

  // A capability the curve excluded as an abstention is a capability whose
  // questions have no evidence turn. The curve never scored them, so they are
  // outside `considered` and therefore outside every count below. This figure
  // states their size so the two populations stay separable -- it is NOT
  // subtracted from the gap, because the gap does not contain them.
  const abstentionQuestions = feature
    .filter((entry) => abstentionSet.has(entry.capability))
    .reduce((sum, entry) => sum + entry.total, 0);

  const baselineByCapability = new Map(baseline.map((entry) => [entry.capability, entry]));
  const runQuestionCount = baseline.reduce((sum, entry) => sum + entry.total, 0);
  const readerCorrect = baseline.reduce((sum, entry) => sum + entry.correct, 0);

  const recoverableFromRanking = rankingGapFailureCount({
    coveredQuestions,
    admittedAtOne,
    readerCorrect,
  });
  const gapAlreadyAbsorbedByReader = Math.max(0, rankingGapQuestions - recoverableFromRanking);

  const unchangedCapabilities: string[] = [];
  let improvementFromAbstention = 0;
  let improvementFromOtherCapabilities = 0;

  for (const entry of feature) {
    const before = baselineByCapability.get(entry.capability);
    if (!before) {
      continue;
    }
    const gain = entry.correct - before.correct;
    if (abstentionSet.has(entry.capability)) {
      improvementFromAbstention += gain;
    } else {
      improvementFromOtherCapabilities += gain;
    }
    if (gain === 0) {
      unchangedCapabilities.push(entry.capability);
    }
  }

  return {
    curveDenominator: considered,
    runQuestionCount,
    absentFromDenominatorQuestions: Math.max(0, runQuestionCount - considered),
    coveredQuestions,
    admittedAtOne,
    rankingGapQuestions,
    retrievalGapQuestions,
    abstentionQuestions,
    gapAlreadyAbsorbedByReader,
    recoverableFromRanking,
    improvementFromAbstention,
    improvementFromOtherCapabilities,
    unchangedCapabilities,
  };
}
