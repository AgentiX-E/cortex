/**
 * B7 pre-registered criterion: make "the targeted questions must move" decidable.
 *
 * The criterion was published before the intervention existed (`09-progress-and-
 * delivery-report.md` §2.5.10.6) and it names a **count** — "the 9 questions whose
 * truth and answer fall in different clusters must move". What it never named was
 * the **roster**. A count cannot be compared against an artifact: two runs can
 * both report 9 and still disagree about which 9, and nothing in either artifact
 * would reveal it.
 *
 * This module is the fix, and its shape follows from one decision:
 *
 * **The roster is RECOMPUTED from an artifact, never transcribed from prose.**
 *
 * Transcription is the failure mode this avoids. If the target list were typed
 * into a constant from the report's prose, then every later run would be compared
 * against a list that no artifact can contradict — and if the clustering changed
 * (a revision, a different dataset build, a fixed tokeniser), the constant would
 * keep asserting "these 9 are targeted" while the pipeline targeted a different
 * 9. The check would pass and mean nothing. Recomputing from the same inputs the
 * pipeline uses makes the roster falsifiable: it moves when the inputs move.
 *
 * The consequence is that the published "9" is a **claim about a snapshot**, and
 * this module can disagree with it. That is the point. `verifyTargetCohort`
 * reports the disagreement rather than reconciling it, because a roster that can
 * only ever confirm is not a criterion.
 */

import {
  candidateSides,
  clusterCandidates,
  contentTerms,
  type TurnLike,
} from './candidate-context.js';

/**
 * A question whose truth and reader answer are known, together with the turns the
 * reader was shown.
 *
 * Deliberately the same three inputs `discriminateContext` takes, plus the id:
 * the roster must be computed from exactly what the intervention sees, or the
 * criterion is measuring a different question set than the one being fixed.
 */
export type CohortQuestion = {
  /** Stable identifier. Ids, not indices — indices drift with the dataset build. */
  readonly questionId: string;
  readonly question: string;
  readonly groundTruth?: string | number | null;
  readonly answer?: string | number | null;
  /** The retrieved context the reader was given, in admission order. */
  readonly turns: readonly TurnLike[];
  /**
   * Whether the question was a grounded failure at all, as the upstream
   * classifier judged it. `false` means the question is out of scope for B7 by
   * construction and is excluded before clustering, so a change in the
   * classifier cannot silently enlarge the B7 target set.
   */
  readonly grounded: boolean;
};

/** A question classified into the target set, with the evidence for it. */
export type TargetMember = {
  readonly questionId: string;
  /** 1-based cluster the ground truth landed in, or `null` if it landed nowhere. */
  readonly truthCluster: number | null;
  /** 1-based cluster the reader's answer landed in, or `null`. */
  readonly answerCluster: number | null;
};

export type TargetCohort = {
  /** Questions whose truth and answer fall in DIFFERENT clusters. The targets. */
  readonly targets: readonly TargetMember[];
  /**
   * Grounded questions whose truth and answer are the SAME VALUE, so no second
   * candidate exists by construction.
   *
   * Kept apart from `unseparable` because the two are different observations and
   * only one of them is a limitation. "The reader reproduced the truth" is a
   * fact about the reader; "we could not tell the sides apart" is a fact about
   * the instrument. Merging them would let an instrument failure read as a
   * finding, where the same distinction upstream separates a retrieval failure
   * from a discrimination one.
   */
  readonly identical: readonly string[];
  /** Grounded questions for which two clusters could not be formed at all. */
  readonly unseparable: readonly string[];
  /** Non-grounded questions, excluded before clustering. */
  readonly notGrounded: readonly string[];
};

/**
 * Terms are compared by VALUE, never by reference.
 *
 * `candidateSides` rebuilds its arrays on each call, so a reference check against
 * a side would never match the array a cluster was built from. This is the same
 * class of trap the id-versus-index decision avoids one level up: an identity
 * that looks stable in one call site and is not.
 *
 * The comparison is `join`-based rather than element-wise, and that is a
 * deliberate simplification rather than a shortcut. An element-wise loop was
 * written first and its mismatch branch was unreachable: `clusterCandidates`
 * copies each side verbatim into `cluster.terms`, so for the side a cluster was
 * built from the arrays are always equal, and `clusterOfIn` scans clusters in
 * order so it stops at that cluster before any equal-length neighbour is
 * compared. A loop whose body only ever runs to completion is a `join`.
 */
function sameTerms(a: readonly string[], b: readonly string[]): boolean {
  // A separator that cannot occur in a term, so ["a b"] and ["a","b"] cannot
  // collide. `contentTerms` splits on whitespace, so a term never contains one.
  return a.length === b.length && a.join('\u0000') === b.join('\u0000');
}

/**
 * Compute the target roster from the cohort.
 *
 * The rule is the published one, stated as code so it cannot drift from the
 * prose: a grounded question is a **target** when its ground truth and the
 * reader's answer are placed in different clusters. Grounded questions whose two
 * values share a cluster are reported separately (`sameCluster`) rather than
 * dropped, because "we looked and it is not competing" is a different fact from
 * "we could not look".
 */
export function computeTargetCohort(questions: readonly CohortQuestion[]): TargetCohort {
  const targets: TargetMember[] = [];
  const identical: string[] = [];
  const unseparable: string[] = [];
  const notGrounded: string[] = [];

  for (const entry of questions) {
    if (!entry.grounded) {
      notGrounded.push(entry.questionId);
      continue;
    }
    if (valuesAreIdentical(entry.groundTruth, entry.answer)) {
      // Checked BEFORE clustering, and it has to be: `candidateSides` returns no
      // sides at all when both values carry the same terms, so this case would
      // otherwise land in `unseparable` and misreport "the instrument could not
      // tell them apart" for a reader that simply answered correctly.
      identical.push(entry.questionId);
      continue;
    }
    const sides = candidateSides({
      question: entry.question,
      // Spread conditionally rather than passing `undefined`: with
      // `exactOptionalPropertyTypes` an explicit `undefined` is not the same as
      // an absent optional, and these two fields are genuinely optional.
      ...(entry.groundTruth === undefined ? {} : { groundTruth: entry.groundTruth }),
      ...(entry.answer === undefined ? {} : { answer: entry.answer }),
    });
    if (sides.length < 2) {
      unseparable.push(entry.questionId);
      continue;
    }
    const clusters = clusterCandidates(entry.turns, sides, sides);
    const truthCluster = clusterOfIn(clusters, sides[0]!);
    const answerCluster = clusterOfIn(clusters, sides[1]!);
    if (truthCluster === null || answerCluster === null) {
      unseparable.push(entry.questionId);
      continue;
    }
    // NO same-cluster branch here, and its absence is a finding rather than an
    // omission. `clusterCandidates` emits one cluster PER NON-EMPTY SIDE, so two
    // non-empty sides always produce two distinct cluster ids -- the ids differ
    // because they are positional. "Truth and answer share a cluster" is
    // therefore unreachable through this pair, and a `sameCluster` bucket would
    // be a field that is always empty while reading as a live classification.
    // The invariant is asserted below instead of being stored.
    targets.push({ questionId: entry.questionId, truthCluster, answerCluster });
  }

  return { targets, identical, unseparable, notGrounded };
}

/**
 * Whether the two values carry the same candidate content.
 *
 * Compared through `contentTerms`, not by string equality: "85 dollars" and
 * "The 85 dollars." name the same candidate, and a raw `===` would file the
 * second as a competing candidate against the first. The comparison is on the
 * CONTENT tokens, which is the same notion of identity the clustering uses, so
 * the two cannot disagree about whether a second candidate exists.
 */
function valuesAreIdentical(
  truth: string | number | null | undefined,
  answer: string | number | null | undefined,
): boolean {
  const a = contentTerms(truth);
  const b = contentTerms(answer);
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  return a.every((term) => bSet.has(term)) && b.every((term) => new Set(a).has(term));
}

function clusterOfIn(
  clusters: readonly { readonly id: number; readonly terms: readonly string[] }[],
  side: readonly string[],
): number | null {
  // `clusterCandidates` copies `usable[i]` into `terms`, so identity is by value.
  const hit = clusters.find((cluster) => sameTerms(cluster.terms, side));
  return hit === undefined ? null : hit.id;
}

/**
 * The invariant `computeTargetCohort` relies on when it omits a same-cluster
 * bucket: two non-empty sides cannot share a cluster id.
 *
 * Exposed rather than inlined so it can be tested directly against the real
 * `clusterCandidates`. An unstated assumption about a dependency is exactly what
 * makes a removed branch look like a bug later; a checked one is a contract.
 */
export function sidesLandInDistinctClusters(clusters: readonly { readonly id: number }[]): boolean {
  const seen = new Set<number>();
  for (const cluster of clusters) {
    if (seen.has(cluster.id)) return false;
    seen.add(cluster.id);
  }
  return true;
}

/**
 * The verdict of comparing a computed roster against the published snapshot.
 *
 * `matches` is the only state that permits claiming the pre-registered criterion
 * was met. `differs` is NOT a failure of the pipeline — it is a failure of the
 * published count to describe the current inputs, and it must be reported before
 * any A/B is read.
 */
export type CohortVerdict =
  | { readonly kind: 'matches'; readonly count: number }
  | {
      readonly kind: 'differs';
      readonly published: number;
      readonly computed: number;
      readonly missing: readonly string[];
      readonly unexpected: readonly string[];
    };

/**
 * Compare a freshly computed roster against the roster a published report claims.
 *
 * `publishedIds` is the roster as the report states it. When the report states
 * only a count (which is the current situation, and the defect this exists to
 * expose), pass an empty roster and the verdict will report every computed target
 * as `unexpected` — which is the honest reading: **a count is not a roster, so
 * nothing can be confirmed against it.**
 */
export function verifyTargetCohort(
  cohort: TargetCohort,
  publishedIds: readonly string[],
): CohortVerdict {
  const computed = cohort.targets.map((member) => member.questionId);
  const publishedSet = new Set(publishedIds);
  const computedSet = new Set(computed);
  const missing = publishedIds.filter((id) => !computedSet.has(id));
  const unexpected = computed.filter((id) => !publishedSet.has(id));
  if (missing.length === 0 && unexpected.length === 0) {
    return { kind: 'matches', count: computed.length };
  }
  return {
    kind: 'differs',
    published: publishedIds.length,
    computed: computed.length,
    missing,
    unexpected,
  };
}

/**
 * The B7 pre-registered criterion, applied to one A/B pair.
 *
 * Three arms of the published criterion, in the order they must be checked:
 *
 * 1. **Targets must move.** If every target question answers identically in both
 *    arms, the annotation reached the prompt without changing the reading. The
 *    published criterion says this is a **finding about the reader**, to be
 *    reported rather than tuned away — so `targetsMoved === 0` yields `no-move`,
 *    not `fail`. "Identically" means the OUTCOME, not the wording: see
 *    `outcomeMoved`.
 * 2. **Non-targets must not regress.** A always-on annotation would turn a
 *    targeted fix into a global rewrite; this is the guard against it. Any
 *    regression here is a `regression` verdict regardless of the target result.
 *    It is the same test as clause 1 — one definition of "moved" for both
 *    clauses, because two is how the reader and the noise tool disagreed.
 * 3. **Only then is a gain claimable.**
 *
 * The order matters and is not cosmetic: a run that gains on targets *and*
 * regresses elsewhere must report `regression`, because the second clause is a
 * guard and a guard that can be overridden by the thing it guards is not one.
 */
export type CriterionVerdict =
  | { readonly kind: 'regression'; readonly regressed: readonly string[] }
  | { readonly kind: 'no-move'; readonly targets: readonly string[] }
  | {
      readonly kind: 'settled';
      readonly moved: readonly string[];
      readonly gained: readonly string[];
      readonly lost: readonly string[];
    };

/**
 * One question's outcome in an arm: the answer it produced, or abstention, plus
 * the scorer's verdict when the caller has one.
 *
 * `correct` is what makes movement decidable, and it is optional only because
 * not every producer of an arm has run a scorer. When it is ABSENT the criterion
 * treats the outcome as unscored rather than as wrong: absence is missing
 * evidence, and reading it as `false` would turn "we did not score this" into
 * "this regressed" -- the same substitution that makes a recording gap look like
 * a reader failure one layer up.
 */
export type ArmOutcome = {
  readonly questionId: string;
  /** The answer text, normalized by the caller. `null` means the arm abstained. */
  readonly answer: string | null;
  /** The scorer's verdict for this question, when the caller has one. */
  readonly correct?: boolean;
};

/**
 * Whether one question's OUTCOME differs between two arms.
 *
 * This is the single definition of "moved" in this module, and it exists because
 * two definitions is exactly how the reader and the noise tool came to disagree:
 * given the same pair of C5 arms, `read-b7-criterion.mjs` reported 4 moved
 * non-targets and `quantify-endpoint-noise.mjs` reported 1, because the first
 * compared ANSWER TEXT and the second compared CORRECTNESS. Both were labelled
 * "movement" and neither said which it meant.
 *
 * **Text is not an outcome.** A language model does not reproduce its own wording
 * byte for byte, so a text comparison fires on `three times a week` ->
 * `Three times a week` -- a measured C5 case, and one the scorer scored the same
 * in both arms. A guard that fires on capitalisation fires on every arm a
 * language model ever produced, which is the same as not having a guard: the
 * criterion becomes unpassable and its most severe verdict becomes the default.
 *
 * The rule, in both directions, is:
 *
 * 1. Both sides scored -> compare the scores. This is the case the guard exists
 *    for, and the only case where "the outcome changed" is directly observed.
 * 2. Either side unscored -> compare against ABSTENTION only. An arm that stopped
 *    producing an answer did move, and that is visible without a scorer; an arm
 *    that merely reworded did not, and claiming so needs evidence the criterion
 *    does not have.
 */
export function outcomeMoved(before: ArmOutcome, after: ArmOutcome): boolean {
  if (before.correct !== undefined && after.correct !== undefined) {
    return before.correct !== after.correct;
  }
  return (before.answer === null) !== (after.answer === null);
}

export function judgeCriterion(input: {
  readonly cohort: TargetCohort;
  readonly control: readonly ArmOutcome[];
  readonly feature: readonly ArmOutcome[];
}): CriterionVerdict {
  const targetIds = new Set(input.cohort.targets.map((member) => member.questionId));
  const controlById = new Map(input.control.map((o) => [o.questionId, o]));

  const regressed: string[] = [];
  const moved: string[] = [];
  const gained: string[] = [];
  const lost: string[] = [];

  for (const outcome of input.feature) {
    const id = outcome.questionId;
    const before = controlById.get(id);
    if (before === undefined) continue;
    const changed = outcomeMoved(before, outcome);
    if (targetIds.has(id)) {
      if (!changed) continue;
      moved.push(id);
      // Direction needs BOTH scores. With either side unscored the module knows
      // the outcome changed but not which way, and a guessed direction would be
      // a claim the artifact does not support.
      if (before.correct !== undefined && outcome.correct !== undefined) {
        if (outcome.correct && !before.correct) gained.push(id);
        if (!outcome.correct && before.correct) lost.push(id);
      }
      continue;
    }
    // Non-target: any change away from the control is a regression, because the
    // criterion does not license movement outside the target set in EITHER
    // direction. A non-target that flips to an ABSTENTION is the case this
    // catches, and it is invisible to a bare accuracy comparison that only
    // counts answers. Both cases are covered by `outcomeMoved`; reworded text is
    // deliberately not one of them.
    if (changed) regressed.push(id);
  }

  if (regressed.length > 0) return { kind: 'regression', regressed };
  if (moved.length === 0) {
    return { kind: 'no-move', targets: [...targetIds] };
  }
  return { kind: 'settled', moved, gained, lost };
}
