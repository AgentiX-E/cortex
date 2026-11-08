/**
 * Two axes read together: what an arm answers, and what it costs the reader to answer it.
 *
 * ## The defect this module is written against
 *
 * The acceptance matrix prices accuracy on one set of rows (`S1`–`S5`, `R1`) and cost on another
 * (`C1`, `C2`), and every row is judged alone. So the one reading the field is actually decided on —
 * *more accuracy for fewer tokens* — has no row, and an arm can pass one axis while failing the other
 * with nothing computing the joint verdict. Run `42373407439` is the case in hand: it shrank the
 * delivery window and read **6,077 prompt tokens per question against 12,137**, a 49.9% saving, at
 * **−3.20 overall accuracy points** and `MR −6.61`. `C1` reads that as a large win, `S1` reads it as a loss, and
 * neither row can answer "which arm is better". A reader is left to choose an axis, and choosing an
 * axis after seeing the numbers is how a trade-off becomes a preference.
 *
 * ## Why the answer is not one weighted number
 *
 * The obvious repair — `w₁·accuracy + w₂·saving` — fails for a reason that is specific to this
 * dataset rather than aesthetic. The two axes have **radically different resolution**:
 *
 * - Accuracy at n = 500 and p ≈ 91.4% has a Wilson half-width of **±2.47 points**, so a 2.5-point
 *   non-inferiority margin is the finest test the aggregate can support — by three hundredths of a
 *   point — and no capability subset can support one at all. The judge's own main effect on the same
 *   answers was measured at 8–9 points (§13.312.8), three times the aggregate's whole interval.
 * - The token axis is a **sum of provider counters over a fixed configuration**. Its sampling variance
 *   is zero: two runs of the same arm return the same 12,137. The only movement it has is a
 *   configuration change, which is the thing being measured.
 *
 * A scalar with fixed weights therefore multiplies a ±2.4-point noise source by `w₁` and a exact
 * quantity by `w₂`, and the verdict becomes a function of `w` rather than of the measurement.
 * Re-weighting moves an arm across another with no run in between, which is the same failure as
 * widening a coverage band until the noise fits.
 *
 * ## So the primitive is dominance, and the scalar is derived from it
 *
 * Two readings are ordered only when one is **not worse on accuracy** and **strictly cheaper on
 * tokens**. Everything else is `incomparable`, which is a result and not a gap: it says the two arms
 * are on different points of a frontier and the choice between them is a product decision that the
 * data cannot make.
 *
 * ## Per capability, not the aggregate
 *
 * The aggregate is the reading that would have licensed the window cut: −3.20 points against a ±2.47-point
 * interval is separated from zero only by the margin, and the margin is what a policy chooses. The
 * configuration was refused on `MR −6.61` and `TR −4.72`, i.e. on
 * parts, which is `COMPETITOR-MECHANISMS-2026-11.md` §3.2's rule — *the per-item split, not the
 * aggregate, is the unit at which a score here can be read* — applied to our own arms rather than to a
 * competitor's. So a capability can block a dominance claim even when the total does not.
 *
 * ## And a margin that the sample has to be able to resolve
 *
 * Blocking on disjoint intervals is the strict rule and it is nearly always satisfied-vacuously here:
 * at n = 121 `MR` has a half-width of **±8.03 points**, so a 6.61-point drop is not distinguishable
 * and nothing blocks. That is not a licence. The module therefore takes a **pre-registered margin** and
 * refuses to certify when the margin is smaller than the resolution the sample offers — the outcome is
 * `underpowered`, which is neither a pass nor a fail and cannot be read as one.
 *
 * The numbers that come out of this are uncomfortable and are meant to be: the aggregate can support a
 * 2.5-point non-inferiority claim at n = 500, and **no capability subset can support one at n = 121 or
 * n = 72**. `S3`'s aim of 85% on 121 questions has a ±8-point interval at its own threshold, so the row
 * cannot distinguish 85 from 77 with an unpaired reading. The consequence for the roadmap is stated in
 * `docs/DESIGN-EFFICIENCY-FRONTIER.md`: capability-level claims have to be **paired**, where the
 * discordant-pair count rather than the marginal rate sets the resolution.
 *
 * ## Billed tokens are a separate field, and are never a context win
 *
 * `C1`'s own text refuses to treat a cache hit as a discount, because the row prices *the context the
 * reader had to read*. That refusal is kept: `billedPromptTokensPerQuestion` exists so that the bill can
 * be stated, and it is documented as incomparable to any competitor's context figure. Conflating them
 * would let this project claim to be cheaper than it is in the only unit the field publishes.
 */
import { wilsonScoreInterval } from '@agentix-e/cortex-core';

import type { Capability } from './types.js';

/**
 * What a cache hit costs relative to a miss, on the provider this arm is measured against.
 *
 * Published pricing for `V4.1-Flash` is $0.006 per million cached input tokens against $0.30 per
 * million uncached, i.e. a hit costs **2%** of a miss. Recorded as a constant rather than as an
 * argument so the discount is one number that a reader can disagree with, and so a provider change
 * shows up as an edit here instead of as a silent drift in every ratio computed downstream.
 */
export const CACHE_HIT_PRICE_RATIO = 0.02;

/** A proportion with its Wilson interval and the half-width that interval implies. */
export type EfficiencyReading = {
  readonly value: number;
  readonly lower: number;
  readonly upper: number;
  readonly halfWidth: number;
};

/** One arm, on both axes. */
export type EfficiencyPoint = {
  readonly arm: string;
  /** Correct count over the whole measured population. */
  readonly overall: { readonly correct: number; readonly total: number };
  /**
   * The same for each capability the arm was read on.
   *
   * Required and required to be non-empty. An aggregate-only point cannot be ordered here, because
   * the aggregate is exactly the reading that hid the `MR −6.61` behind a `−3.20` total on the window
   * cut — a rule that accepted a bare aggregate would license the arm that was refused. Every artifact
   * this repository writes already carries the breakdown, so the requirement costs nothing and removes
   * a way for a later caller to compare on the weaker reading.
   */
  readonly perCapability: readonly {
    readonly capability: Capability;
    readonly correct: number;
    readonly total: number;
  }[];
  /** Prompt tokens delivered for one question, one repetition — the unit `C1` reads. */
  readonly promptTokensPerQuestion: number;
  /** Share of those prompt tokens the provider served from its prefix cache, in [0, 1]. */
  readonly cacheHitShare: number;
  /**
   * How many repetitions the arm ran.
   *
   * Not a provenance detail: **the cache-hit share is a function of it.** An arm that runs four
   * repetitions over one prompt can hit on three of them; an arm that runs two can hit on one. So the
   * bill is comparable only between arms that ran the same number of repetitions, and a comparison
   * across 4 and 2 is a measurement of `runs` wearing the name of a cost. That is not a hypothesis —
   * the two artifacts this module was first pointed at read 98.34% hits at 4 repetitions and 51.07% at
   * 2, and 51.07% is what "one repetition misses, one hits, prompts are equal-sized" produces.
   */
  readonly runs: number;
};

/** A point plus everything derived from it. */
export type EfficiencyProfile = {
  readonly arm: string;
  readonly overall: EfficiencyReading;
  readonly perCapability: readonly (EfficiencyReading & { readonly capability: Capability })[];
  readonly promptTokensPerQuestion: number;
  /** What the same tokens cost once the cache is priced — a bill, never a context figure. */
  readonly billedPromptTokensPerQuestion: number;
  readonly runs: number;
};

/**
 * What counts as a win, decided before the numbers are in.
 *
 * `margin` is a **non-inferiority margin**: the accuracy drop the project is willing to call a tie in
 * exchange for a cost saving. It is pre-registered because choosing it after seeing a result is how a
 * trade-off becomes a preference. `tokenTolerance` is the smallest relative saving that is treated as a
 * saving at all, and it exists so that a 1% movement — which is inside the spread of two runs at the
 * same configuration — cannot be the entire basis of a dominance claim.
 */
export type EfficiencyPolicy = {
  readonly margin: number;
  readonly tokenTolerance: number;
  /** Capabilities the margin must hold on. Defaults to every capability the point carries. */
  readonly gated?: readonly Capability[];
};

/**
 * 2.5 points and 5%.
 *
 * The margin is set at the aggregate's own resolution: at n = 500 and p ≈ 91.4% the Wilson half-width is
 * 2.47 points, so 2.5 is the smallest round value the sample can distinguish — by three hundredths of a
 * point. A margin below the resolution is not a stricter test, it is an underpowered one, and
 * `compareEfficiency` reports that rather than certifying against it.
 */
export const DEFAULT_EFFICIENCY_POLICY: EfficiencyPolicy = {
  margin: 0.025,
  tokenTolerance: 0.05,
};

/** `overall`, or one capability. Named so a blocking reason can say which. */
export type ReadingLabel = Capability | 'overall';

/**
 * The verdict, plus the two facts that produced it.
 *
 * `underpowered` is a fourth outcome rather than a flavour of `incomparable`, because it says
 * something about the *instrument* rather than about the arms: the sample cannot resolve the margin,
 * so a rerun of the same size will not change the answer. Merging it into `incomparable` would invite
 * exactly the wrong response — dispatch the same arm again. It is only ever produced in the direction
 * that would promote an arm, never in the direction that demotes one; see `compareEfficiency`.
 *
 * Power is judged on the **aggregate** and not on the narrowest gated subset. Judging it on the subset
 * would make every comparison underpowered the moment an arm carries a capability breakdown —
 * 121-question subsets resolve ±8 points at best — and a criterion that can never be green is the
 * failure the acceptance matrix's own section 2 refuses. The subsets' resolutions are still reported,
 * in `unresolvable`, because a capability-level claim is not licensed by an aggregate-level test and a
 * reader is entitled to see which labels that applies to.
 */
export type EfficiencyComparison = {
  readonly outcome: 'dominates' | 'dominated' | 'incomparable' | 'underpowered';
  /** `a`'s context tokens over `b`'s. Below 1 means `a` reads less. */
  readonly tokenRatio: number;
  /**
   * The same over the **bill**. Below 1 means `a` costs less to run.
   *
   * Reported separately because it is not a restatement of `tokenRatio`: an arm can read half the
   * context and pay more, if the smaller prompt stops being served from the prefix cache. An arm is
   * only cheaper when both are below 1 — and only when `billComparable` is true, which is the field
   * that exists because the first version of this ratio read a 6.90x that was the repetition count.
   */
  readonly billedTokenRatio: number;
  /**
   * Whether the bill is admissible as evidence at all.
   *
   * False when the two arms ran a different number of repetitions, because the cache-hit share — and
   * therefore the bill — moves with `runs` rather than with the system. When it is false the verdict is
   * a **two-axis** order over accuracy and context, and no cost claim may be read off it.
   */
  readonly billComparable: boolean;
  /** Readings where `a` falls below `b` by more than the margin. */
  readonly blocking: readonly ReadingLabel[];
  /** Readings where the margin is smaller than the sample's resolution. */
  readonly unresolvable: readonly ReadingLabel[];
};

function readingOf(correct: number, total: number): EfficiencyReading {
  if (!Number.isInteger(correct) || !Number.isInteger(total)) {
    throw new Error(`an efficiency reading needs counts, got ${correct}/${total}`);
  }
  if (total <= 0) {
    throw new Error(`an efficiency reading needs a population, got ${correct}/${total}`);
  }
  if (correct < 0 || correct > total) {
    throw new Error(`an efficiency reading is out of range: ${correct} of ${total}`);
  }
  const { lower, upper } = wilsonScoreInterval(correct, total);
  return { value: correct / total, lower, upper, halfWidth: (upper - lower) / 2 };
}

/**
 * Turn a point into the two axes it is read on.
 *
 * The billed figure is `promptTokens × (hit·ratio + (1 − hit))`, which is the arithmetic the provider
 * performs. It is reported beside the context figure and never substituted for it.
 */
export function profileOf(point: EfficiencyPoint): EfficiencyProfile {
  const { promptTokensPerQuestion, cacheHitShare } = point;
  if (!Number.isFinite(promptTokensPerQuestion) || promptTokensPerQuestion <= 0) {
    throw new Error(
      `arm ${point.arm} has no token reading: promptTokensPerQuestion is ${promptTokensPerQuestion}`,
    );
  }
  if (!Number.isInteger(point.runs) || point.runs <= 0) {
    throw new Error(`arm ${point.arm} has no repetition count: runs is ${point.runs}`);
  }
  if (!Number.isFinite(cacheHitShare) || cacheHitShare < 0 || cacheHitShare > 1) {
    throw new Error(`arm ${point.arm} has a cache share outside [0, 1]: ${cacheHitShare}`);
  }
  if (point.perCapability.length === 0) {
    throw new Error(
      `arm ${point.arm} carries no capability breakdown; an aggregate-only point cannot be ordered ` +
        'here, because the aggregate is the reading that hid the part-level loss on the window cut',
    );
  }
  const billed =
    promptTokensPerQuestion * (cacheHitShare * CACHE_HIT_PRICE_RATIO + (1 - cacheHitShare));
  return {
    arm: point.arm,
    overall: readingOf(point.overall.correct, point.overall.total),
    perCapability: point.perCapability.map((entry) => ({
      capability: entry.capability,
      ...readingOf(entry.correct, entry.total),
    })),
    promptTokensPerQuestion,
    billedPromptTokensPerQuestion: billed,
    runs: point.runs,
  };
}

function labelsOf(profile: EfficiencyProfile, policy: EfficiencyPolicy): ReadingLabel[] {
  const gated = policy.gated ?? profile.perCapability.map((entry) => entry.capability);
  const present = new Set(profile.perCapability.map((entry) => entry.capability));
  for (const capability of gated) {
    if (!present.has(capability)) {
      throw new Error(
        `arm ${profile.arm} was gated on ${capability} but carries no reading for it; a gate on a ` +
          'capability that was never measured would pass by being absent',
      );
    }
  }
  return ['overall', ...gated];
}

function readingFor(profile: EfficiencyProfile, label: ReadingLabel): EfficiencyReading {
  if (label === 'overall') return profile.overall;
  const entry = profile.perCapability.find((candidate) => candidate.capability === label);
  if (entry === undefined) {
    throw new Error(`arm ${profile.arm} carries no ${label} reading`);
  }
  return entry;
}

/**
 * Is `a` better than `b` on both axes at once?
 *
 * `b` is the reference: its resolution is what the margin has to clear, because the claim is "`a` has
 * not lost accuracy relative to `b`", and an interval on `a` alone cannot support a statement about a
 * difference. Using one arm's half-width is conservative against the paired difference the artifacts
 * actually carry (a paired test on discordant pairs is sharper), which is the right direction for a
 * number that gates a claim.
 */
export function compareEfficiency(
  a: EfficiencyProfile,
  b: EfficiencyProfile,
  policy: EfficiencyPolicy = DEFAULT_EFFICIENCY_POLICY,
): EfficiencyComparison {
  if (a.arm === b.arm) {
    throw new Error(`compareEfficiency needs two arms, got ${a.arm} on both sides`);
  }
  if (!Number.isFinite(policy.margin) || policy.margin < 0) {
    throw new Error(`the accuracy margin must be a non-negative number, got ${policy.margin}`);
  }
  if (!Number.isFinite(policy.tokenTolerance) || policy.tokenTolerance < 0) {
    throw new Error(
      `the token tolerance must be a non-negative number, got ${policy.tokenTolerance}`,
    );
  }
  const tokenRatio = a.promptTokensPerQuestion / b.promptTokensPerQuestion;
  const billComparable = a.runs === b.runs;
  const billedTokenRatio = a.billedPromptTokensPerQuestion / b.billedPromptTokensPerQuestion;
  const blocking: ReadingLabel[] = [];
  const leading: ReadingLabel[] = [];
  const unresolvable: ReadingLabel[] = [];
  for (const label of labelsOf(b, policy)) {
    const reference = readingFor(b, label);
    const candidate = readingFor(a, label);
    if (policy.margin > 0 && reference.halfWidth > policy.margin) unresolvable.push(label);
    if (reference.value - candidate.value > policy.margin) blocking.push(label);
    if (candidate.value - reference.value > policy.margin) leading.push(label);
  }

  // Three objectives, one order. Accuracy goes up, the context goes down, the bill goes down, and
  // `dominates` means "at least as good on all three and strictly better on one" — the standard
  // definition, applied rather than shorthand for "better on the axis I happened to look at".
  //
  // It has to be all three, and the third one is the one that nearly became a false finding: a rule
  // with only the context axis called `42373407439` cheaper at 0.50x, and the bill said 1.07x and then
  // 6.90x depending on which control it was paired with. Both bill figures were the repetition count
  // (4 against 2, cache share 98.34% against 51.07%) rather than the system, which is why
  // `billComparable` exists and why the tool refuses the comparison outright.
  //
  // Strict on both sides of 1 as well as on the tolerance, so a policy with `tokenTolerance: 0` still
  // cannot call an unchanged count an improvement.
  const cheaperOn = (ratio: number): boolean => ratio < 1 && ratio <= 1 - policy.tokenTolerance;
  const withinTolerance = (ratio: number): boolean => ratio <= 1 + policy.tokenTolerance;

  // A bill that is not comparable is not evidence, and a term that is dropped from every clause is a
  // term that can neither promote nor demote. That is the correct handling of a confounded axis:
  // `withinTolerance` and `cheaperOn` are replaced by their neutral element rather than by a guess.
  const billNoWorse = (ratio: number): boolean => !billComparable || withinTolerance(ratio);
  const billBetter = (ratio: number): boolean => billComparable && cheaperOn(ratio);

  const aNotWorse =
    blocking.length === 0 && withinTolerance(tokenRatio) && billNoWorse(billedTokenRatio);
  const aBetterSomewhere =
    leading.length > 0 || cheaperOn(tokenRatio) || billBetter(billedTokenRatio);
  const bNotWorse =
    leading.length === 0 && withinTolerance(1 / tokenRatio) && billNoWorse(1 / billedTokenRatio);
  const bBetterSomewhere =
    blocking.length > 0 || cheaperOn(1 / tokenRatio) || billBetter(1 / billedTokenRatio);

  if (aNotWorse && aBetterSomewhere) {
    // The power check applies to the **promotion** and to nothing else. Certifying that an arm won is
    // a claim that it did not lose accuracy, and a margin finer than the sample resolves cannot
    // support that claim — so the honest outcome is neither a pass nor a fail. Demoting an arm is the
    // other direction and needs no power: "the reference is not worse and costs no more" only becomes
    // easier to establish as the interval widens, so it cannot overstate.
    if (b.overall.halfWidth > policy.margin) {
      return {
        outcome: 'underpowered',
        tokenRatio,
        billedTokenRatio,
        billComparable,
        blocking,
        unresolvable,
      };
    }
    return {
      outcome: 'dominates',
      tokenRatio,
      billedTokenRatio,
      billComparable,
      blocking,
      unresolvable,
    };
  }
  if (bNotWorse && bBetterSomewhere) {
    return {
      outcome: 'dominated',
      tokenRatio,
      billedTokenRatio,
      billComparable,
      blocking,
      unresolvable,
    };
  }
  return {
    outcome: 'incomparable',
    tokenRatio,
    billedTokenRatio,
    billComparable,
    blocking,
    unresolvable,
  };
}

/** The frontier over a set of arms, plus who ended each arm. */
export type EfficiencyFrontier = {
  /** Arms no other arm in the set dominates, in the order they were supplied. */
  readonly front: readonly string[];
  readonly dominated: readonly { readonly arm: string; readonly by: readonly string[] }[];
  /** Pairs whose verdict was `underpowered`, kept as a count so a frontier is never read as complete. */
  readonly underpoweredPairs: number;
};

/**
 * The Pareto set.
 *
 * The set is a claim about what has been **measured**, so a mixed set is refused rather than reported:
 * `profileOf` requires a capability breakdown, and a caller that supplied one arm with and one without
 * gets an error naming the arm instead of a frontier in which the aggregate-only point cannot be
 * ordered and therefore silently survives.
 */
export function efficiencyFrontier(
  points: readonly EfficiencyPoint[],
  policy: EfficiencyPolicy = DEFAULT_EFFICIENCY_POLICY,
): EfficiencyFrontier {
  const profiles = points.map(profileOf);
  const names = new Set<string>();
  for (const profile of profiles) {
    if (names.has(profile.arm)) throw new Error(`two arms are both named ${profile.arm}`);
    names.add(profile.arm);
  }
  const dominated: { arm: string; by: string[] }[] = [];
  let underpoweredPairs = 0;
  for (const candidate of profiles) {
    const by: string[] = [];
    for (const other of profiles) {
      if (other.arm === candidate.arm) continue;
      const verdict = compareEfficiency(other, candidate, policy);
      if (verdict.outcome === 'underpowered') underpoweredPairs += 1;
      if (verdict.outcome === 'dominates') by.push(other.arm);
    }
    if (by.length > 0) dominated.push({ arm: candidate.arm, by });
  }
  const beaten = new Set(dominated.map((entry) => entry.arm));
  return {
    front: profiles.filter((profile) => !beaten.has(profile.arm)).map((profile) => profile.arm),
    dominated,
    underpoweredPairs,
  };
}
