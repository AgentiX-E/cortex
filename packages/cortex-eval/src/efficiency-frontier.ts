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
 * cannot distinguish 85 from 77 with an unpaired reading.
 *
 * ## Which is why the paired test is the second instrument and not an improvement on the first
 *
 * `compareEfficiency` takes optional `PairedEvidence` — how many questions each arm won that the other
 * lost — and runs an exact McNemar test on it. Where it is supplied, it is the **only** instrument for
 * that label; where it is not, the margin rule runs as above and the outcome can be `underpowered`.
 * The two are not interchangeable and the difference is not academic:
 *
 * | comparison | design | verdict |
 * | --- | --- | --- |
 * | `42355323615 → 42373407439` | 500 paired questions, 27 lost to 11 won | **p = 0.0139**, a certified loss |
 * | the same pair, unpaired | ±2.47-point Wilson interval, 2.5-point margin | −3.20 points, "not resolved" |
 *
 * The unpaired reading of that pair was published as `incomparable` and the loss was described as
 * inside the instrument's resolution. It is not: 38 questions moved and 27 of them moved against the
 * arm. The interval answers "how well is the rate known", the paired test answers "did the arms
 * disagree", and on a design where every question was asked twice the second question is the one being
 * asked. That misreading is why the module now has `PairedEvidence` instead of a note in a design
 * document saying capability claims have to be paired.
 *
 * ## Billed tokens are a separate field, and are never a context win
 *
 * `C1`'s own text refuses to treat a cache hit as a discount, because the row prices *the context the
 * reader had to read*. That refusal is kept: `billedPromptTokensPerQuestion` exists so that the bill can
 * be stated, and it is documented as incomparable to any competitor's context figure. Conflating them
 * would let this project claim to be cheaper than it is in the only unit the field publishes.
 */
import { wilsonScoreInterval } from '@agentix-e/cortex-core';

// Re-exported so `tools/efficiency-frontier.mjs` can reach them through the built module it documents as
// its entry point; the implementations live in `paired-test.ts` and only there.
import { mcnemarExact, signFlipExact } from './paired-test.js';

export { mcnemarExact, signFlipExact };

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
  /**
   * Correct count over the whole measured population.
   *
   * `correct` is a **count**, and after four repetitions it is a fractional one: 454.25 of 500 is what
   * "the mean of four repetitions" arithmetically is, and requiring an integer here rounded it to 454 and
   * printed 90.80% for an arm whose own artifact says 90.85%. The half-question is not a measurement, but
   * the rounding is a **systematic** half-question in one direction on every arm that ran an even number
   * of repetitions, and it is the same class of defect as reading one repetition instead of four: a
   * reading whose precision is thrown away before anyone looks at it.
   *
   * `total` stays an integer, because it is a number of questions.
   */
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
  /**
   * The level a **paired** accuracy claim has to reach, when the comparison is given paired evidence.
   *
   * It is a separate number from `margin` because they are different instruments and neither can be
   * expressed in the other's units. `margin` is a non-inferiority bound that has to survive an unpaired
   * interval; `alpha` is a significance level on the discordant pairs, whose resolution depends on how
   * many questions the two arms disagree about and not on the marginal rate. Run
   * `42355323615 → 42373407439` is the case that makes the difference concrete: 38 discordant pairs,
   * 27 lost to 11 won, **exact p = 0.0139** — a certified loss that the ±2.47-point unpaired interval
   * could not express, because it is not a bound on a difference, it is a test of one.
   */
  readonly alpha: number;
  /**
   * The spread two dispatches of **one configuration** produced, and the bound it puts on any promotion.
   *
   * This is the instrument the paired test does not replace, and it exists because the paired test's null
   * hypothesis is not the only source of variation. Two dispatches of the same arm — same fields, same
   * reader, same judge, four repetitions each — read **90.85% and 90.20%**, with **35 of 500 questions**
   * flipping direction. A comparison between two *different* configurations disagreed on **34**. Fewer
   * disagreements between different systems than between one system and itself is the whole argument: at
   * this population the per-question flips are dominated by dispatch noise, and a promotion whose
   * disagreement count does not clear the self-comparison is a claim about the runner.
   *
   * `delta` is in the same units as `margin` (a share of the population), and it only ever **blocks a
   * promotion**. Demotion keeps the union rule above: "the reference is not worse" cannot be overstated by
   * a noisy floor, "the candidate is better" can.
   *
   * Absent means no floor was measured, which is reported rather than assumed to be zero — a policy with a
   * floor of zero is a policy that has not looked.
   */
  readonly noiseFloor?: { readonly delta: number; readonly source: string } | undefined;
  /** Capabilities the margin must hold on. Defaults to every capability the point carries. */
  readonly gated?: readonly Capability[];
};

/**
 * What the two arms did question by question, for the labels they were both read on.
 *
 * Two shapes, because the artifacts have two shapes and the test is a function of the data, not of a
 * preference:
 *
 * - **`discordant`** — one repetition, so a question is right or wrong and the count of questions that
 *   moved in each direction is the whole of the evidence. Exact McNemar.
 * - **`series`** — `k` repetitions, so a question is "three of four" and the difference is a count in
 *   `[-k, k]`. Exact sign-flip over the folded sums.
 *
 * They are not interchangeable and the union is what says so. Collapsing a `series` to `discordant` throws
 * away the repetitions — that is how `MR` read **2 won to 9 lost, p = 0.0654** on repetition 0 and
 * **16 won to 5 lost, p = 0.0039** on the four-repetition means, the same 121 questions and opposite
 * verdicts. Expanding a `discordant` into a `series` would be worse: it would invent `k` copies of one
 * observation and divide the p by roughly `k`.
 */
export type PairedEvidence = readonly (
  | {
      readonly kind: 'discordant';
      readonly label: ReadingLabel;
      /** Questions `a` answered correctly and `b` did not. */
      readonly wonByA: number;
      /** The reverse. */
      readonly wonByB: number;
    }
  | {
      readonly kind: 'series';
      readonly label: ReadingLabel;
      /** How many repetitions each question carries. Every entry must be in `[0, runs]`. */
      readonly runs: number;
      /**
       * One entry per question, in any order: how many of its `runs` repetitions each arm answered right.
       *
       * Order does not matter because the test is over the **marginal** distribution of differences, and
       * pairing is positional only in the sense that entry `i` of `a` is the same question as entry `i` of
       * `b` — a property the builder has to guarantee, which is why `tools/efficiency-frontier.mjs` joins on
       * `questionId` instead of on index.
       */
      readonly questions: readonly { readonly a: number; readonly b: number }[];
    }
)[];

/** One label's paired test, reported whichever way it came out. */
export type PairedReading = {
  readonly label: ReadingLabel;
  /** Which instrument ran, so a reader never has to infer it from the magnitudes. */
  readonly test: 'mcnemar' | 'sign-flip';
  /** Questions `a` won that `b` lost, on the same repetition-mean reading the accuracy uses. */
  readonly wonByA: number;
  /** The reverse. */
  readonly wonByB: number;
  /**
   * Questions that disagreed at all, which is the population the test is computed over.
   *
   * Not `wonByA + wonByB` for a `series`: a question the arms split 2–2 across four repetitions is a tie
   * and contributes nothing, while one split 4–2 is a win and is counted once. This number is what makes
   * the two instruments comparable at a glance — 34 on the aggregate and 21 on `MR` is a resolution
   * statement, and `500` would be a fiction.
   */
  readonly pairs: number;
  /** Exact two-sided p. 1 when the arms never disagreed. */
  readonly pValue: number;
  /**
   * Whether `pValue < alpha`, i.e. whether this pair licenses a directional claim on this label.
   *
   * `false` is a **resolved tie** rather than an absence of power: the discordant pairs were counted
   * and they did not favour either arm. That is a stronger statement than `unresolvable`, which says
   * the instrument cannot see the difference at all, and the two must not be reported as one.
   */
  readonly resolved: boolean;
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
  alpha: 0.05,
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
   * context and pay more, if the smaller prompt stops being served from the prefix cache.
   *
   * It **cannot promote an arm**, only refuse one. Every bit of information it carries beyond
   * `tokenRatio` is the cache-hit share, and that share moved 20 points between two four-repetition
   * dispatches of one arm (78.21% against 98.34%), which prices as a 0.156x bill on a 1.003x context.
   * A term that can produce that on its own is a veto and not a vote; see `compareEfficiency`.
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
  /**
   * Readings `a` was certified ahead on, whichever way the whole comparison came out.
   *
   * Reported because the two can disagree and the disagreement is the finding. `42355323615` against
   * `42310779222` is ahead on `MR` at **p = 0.0044** and blocked nowhere, and it is still not a dominated
   * verdict — the two arms differ in two fields, so what was certified is that *this pair* is better, not
   * that either variable is. A caller that only read `outcome` would see `incomparable` and conclude nothing
   * had been established, which discards a 3.1-point certified gain on a 121-question capability.
   */
  readonly leading: readonly ReadingLabel[];
  /** Readings where the margin is smaller than the sample's resolution. */
  readonly unresolvable: readonly ReadingLabel[];
  /**
   * Readings where `a` was ahead but not by more than two dispatches of one configuration disagree.
   *
   * A fifth list rather than a silent filter, and separate from `unresolvable` because the two have
   * different repairs: `unresolvable` means the sample is too small for the margin, `belowNoise` means the
   * sample is large enough and the **runner** moves more than the effect does. Reporting it as
   * `incomparable` would lose the direction, which is the part a reader needs to decide whether the next
   * experiment is worth its tokens.
   */
  readonly belowNoise: readonly ReadingLabel[];
  /**
   * Every paired test that was run, whichever way it came out.
   *
   * Reported rather than folded into `blocking`, because the two instruments answer different
   * questions and a reader has to be able to see which one produced the verdict: a label in `blocking`
   * with a `paired` entry was **certified** worse, and one without was worse than a margin the sample
   * could barely resolve. The campaign spent a round learning that difference.
   */
  readonly paired: readonly PairedReading[];
  /** Whether any paired test was supplied at all. False means every label was read unpaired. */
  readonly pairedUsed: boolean;
};

function readingOf(correct: number, total: number): EfficiencyReading {
  if (!Number.isFinite(correct) || !Number.isInteger(total)) {
    throw new Error(`an efficiency reading needs counts, got ${correct}/${total}`);
  }
  if (total <= 0) {
    throw new Error(`an efficiency reading needs a population, got ${correct}/${total}`);
  }
  if (correct < 0 || correct > total) {
    throw new Error(`an efficiency reading is out of range: ${correct} of ${total}`);
  }
  // `correct` may be fractional, and only the repetition mean makes it so. `wilsonScoreInterval` already
  // accepts a continuous proportion — it takes `correct / total` and never rounds — so the interval stays
  // the Wilson interval; what it is an interval *on* is the mean of `runs` binomials rather than one, and
  // that interval is conservative rather than wrong, because averaging `k` repetitions cannot widen it.
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
 *
 * ## The two instruments are combined asymmetrically, and the asymmetry is the design
 *
 * *Demoting* takes the **union**: an arm is blocked if either the paired test certifies a loss or the margin
 * rule says the drop is bigger than the project agreed to call a tie. Both are evidence against, so a rule
 * that needs only one is strictly more conservative — and the alternative, requiring both, is a
 * falsification this change produced on its first draft: against one control the window cut's aggregate is
 * 13 won to 23 lost at `p = 0.1325`, so a rule that demoted only on a significant pair read a −3.20-point arm
 * as "not worse" and then promoted it on the 0.50x context. Absence of a significant pair is not evidence of
 * no effect.
 *
 * *Promoting* takes the **intersection of every floor**: a certified win needs the paired test, a margin
 * above the resolution, and a difference wider than two dispatches of one configuration produce. The
 * `underpowered` outcome already encodes half of that one level up — demotion cannot overstate as the
 * interval widens, promotion can — and `noiseFloor` is the other half, measured rather than assumed.
 */
export function compareEfficiency(
  a: EfficiencyProfile,
  b: EfficiencyProfile,
  policy: EfficiencyPolicy = DEFAULT_EFFICIENCY_POLICY,
  paired?: PairedEvidence,
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
  if (!Number.isFinite(policy.alpha) || policy.alpha <= 0 || policy.alpha >= 1) {
    throw new Error(`the paired alpha must sit strictly inside (0, 1), got ${policy.alpha}`);
  }

  const pairedReadings: PairedReading[] = [];
  const pairedByLabel = new Map<ReadingLabel, PairedReading>();
  for (const entry of paired ?? []) {
    if (pairedByLabel.has(entry.label)) {
      throw new Error(`paired evidence names ${entry.label} twice`);
    }
    let wonByA: number;
    let wonByB: number;
    let pairs: number;
    let pValue: number;
    if (entry.kind === 'discordant') {
      for (const [name, count] of [
        ['wonByA', entry.wonByA],
        ['wonByB', entry.wonByB],
      ] as const) {
        if (!Number.isInteger(count) || count < 0) {
          throw new Error(
            `paired evidence for ${entry.label} is not a pair of counts: ` +
              `${name} is ${count}, which is not a non-negative integer`,
          );
        }
      }
      wonByA = entry.wonByA;
      wonByB = entry.wonByB;
      pairs = wonByA + wonByB;
      pValue = mcnemarExact(entry.wonByA, entry.wonByB);
    } else {
      if (!Number.isInteger(entry.runs) || entry.runs <= 0) {
        throw new Error(
          `paired series for ${entry.label} has no repetition count: runs is ${entry.runs}`,
        );
      }
      // A series with no questions is an absence of evidence and not a tie, so it is refused rather than
      // turned into `p = 1`: a caller that joined on the wrong key would otherwise get a clean result.
      if (entry.questions.length === 0) {
        throw new Error(`paired series for ${entry.label} carries no questions`);
      }
      const differences: number[] = [];
      wonByA = 0;
      wonByB = 0;
      for (const question of entry.questions) {
        for (const [name, count] of [
          ['a', question.a],
          ['b', question.b],
        ] as const) {
          if (!Number.isInteger(count) || count < 0 || count > entry.runs) {
            throw new Error(
              `paired series for ${entry.label} has ${name} = ${count} against ${entry.runs} ` +
                'repetitions; a question cannot be right more often than it was asked',
            );
          }
        }
        differences.push(question.a - question.b);
        if (question.a > question.b) wonByA += 1;
        if (question.b > question.a) wonByB += 1;
      }
      pairs = wonByA + wonByB;
      pValue = signFlipExact(differences);
    }
    const reading: PairedReading = {
      label: entry.label,
      test: entry.kind === 'discordant' ? 'mcnemar' : 'sign-flip',
      wonByA,
      wonByB,
      pairs,
      pValue,
      // No disagreement means no evidence *and no test*: two arms that agreed on all 500 questions are a
      // tie, and a p-value of 1 on zero pairs must not be reported as "resolved, no difference" in the same
      // voice as a tie established by 38 pairs.
      resolved: pairs > 0 && pValue < policy.alpha,
    };
    pairedByLabel.set(entry.label, reading);
    pairedReadings.push(reading);
  }

  const tokenRatio = a.promptTokensPerQuestion / b.promptTokensPerQuestion;
  const billComparable = a.runs === b.runs;
  const billedTokenRatio = a.billedPromptTokensPerQuestion / b.billedPromptTokensPerQuestion;
  const blocking: ReadingLabel[] = [];
  const leading: ReadingLabel[] = [];
  const unresolvable: ReadingLabel[] = [];
  const belowNoise: ReadingLabel[] = [];
  const noiseFloor = policy.noiseFloor?.delta ?? 0;
  for (const label of labelsOf(b, policy)) {
    const reference = readingFor(b, label);
    const candidate = readingFor(a, label);
    const delta = candidate.value - reference.value;
    // A promotion has to clear **both** floors: the significance level on the pairs and the spread two
    // dispatches of one configuration show. The second one is not a second significance test — it is the
    // same test asked against the right null. Where it fails the direction is kept in `belowNoise` rather
    // than dropped, because "ahead by less than the runner moves" and "level" are different findings and
    // only one of them argues for another experiment.
    //
    // Demotion reads neither floor: `blocking` below is built from the margin rule and a resolved loss,
    // and a noisy floor cannot make a loss look smaller than it is.
    if (reference.value - candidate.value > policy.margin) blocking.push(label);
    const test = pairedByLabel.get(label);
    if (test !== undefined) {
      // One label, one entry. The margin rule and the paired test both fire on the same loss by construction
      // whenever the loss is real, and without this the verdict lists `overall, overall, IE, MR, KU, TR, TR`
      // for one arm — a duplicated list that reads as a counting bug and buries the labels that are single.
      if (test.resolved && delta < 0 && !blocking.includes(label)) blocking.push(label);
      // Ahead, but not by enough to claim it -- and there are two distinct reasons, both of which belong in
      // `belowNoise` rather than in a silent gap. Either the pairs did not separate (`+0.50 at p = 0.354` on
      // the `ask` step) or they did and the margin is narrower than one dispatch's own repetitions move. A
      // label that is ahead and absent from every list would read as agreement, which is the one thing it is
      // not.
      if (delta > 0) {
        if (test.resolved && delta > noiseFloor) leading.push(label);
        else belowNoise.push(label);
      }
      continue;
    }
    if (candidate.value - reference.value > policy.margin) {
      if (delta > noiseFloor) leading.push(label);
      else belowNoise.push(label);
    } else if (delta > 0) {
      // Ahead, unpaired, and inside the margin: a tie by the rule, and the direction is still worth printing.
      // An earlier version dropped it here, so a +0.5-point step on the `ask` change appeared in no list at
      // all and read as agreement with the reference.
      belowNoise.push(label);
    }
    if (policy.margin > 0 && reference.halfWidth > policy.margin) unresolvable.push(label);
  }

  // Three objectives, one order. Accuracy goes up, the context goes down, the bill goes down, and
  // `dominates` means "at least as good on all three and strictly better on one" — the standard
  // definition, applied rather than shorthand for "better on the axis I happened to look at".
  //
  // It has to be all three, and the third one is the one that nearly became a false finding: a rule
  // with only the context axis called `42373407439` cheaper at 0.50x, and the bill said 1.07x and then
  // 6.90x depending on which control it was paired with. Equal `runs` is necessary for the bill but
  // **not sufficient** — `42310779222` and `42355323615` both ran four and read 78.21% and 98.34%
  // hits — which is why the bill is reported with `billComparable` beside it rather than trusted.
  //
  // Strict on both sides of 1 as well as on the tolerance, so a policy with `tokenTolerance: 0` still
  // cannot call an unchanged count an improvement.
  const cheaperOn = (ratio: number): boolean => ratio < 1 && ratio <= 1 - policy.tokenTolerance;
  const withinTolerance = (ratio: number): boolean => ratio <= 1 + policy.tokenTolerance;

  // A bill that is not comparable is not evidence, and a term that is dropped from every clause is a
  // term that can neither promote nor demote. That is the correct handling of a confounded axis:
  // `withinTolerance` and `cheaperOn` are replaced by their neutral element rather than by a guess.
  const billNoWorse = (ratio: number): boolean => !billComparable || withinTolerance(ratio);

  // The bill can **block** and can never **promote**, and the reason is not caution.
  //
  // `billedTokenRatio` equals `tokenRatio` whenever the two arms cache alike, so every bit of
  // information the bill carries beyond the context ratio comes from the cache-hit share — and that
  // share is a property of how the walk was run, not of the system. Two dispatches of one arm at four
  // repetitions each read **78.21%** and **98.34%** hits with the same 24.2M prompt tokens; priced at
  // 2% of a miss that is a 0.156x bill on a 1.003x context, i.e. a dominance claim manufactured
  // entirely by the prefix cache. It was manufactured: this rule as first written reported `dominates`
  // for that pair, and the paired instrument is what surfaced it.
  //
  // So the term keeps its veto (`aNotWorse`, `bNotWorse`) and loses its vote. A bill that went up can
  // refuse a context saving, which is the direction that cannot overstate; a bill that went down can
  // never be the reason an arm is called better, because the only thing that would have to be true for
  // it — a stable cache — is the thing the two artifacts disprove.
  const aNotWorse =
    blocking.length === 0 && withinTolerance(tokenRatio) && billNoWorse(billedTokenRatio);
  const aBetterSomewhere = leading.length > 0 || cheaperOn(tokenRatio);
  const bNotWorse =
    leading.length === 0 && withinTolerance(1 / tokenRatio) && billNoWorse(1 / billedTokenRatio);
  const bBetterSomewhere = blocking.length > 0 || cheaperOn(1 / tokenRatio);

  // The power check applies to the **promotion** and to nothing else. Certifying that an arm won is a
  // claim that it did not lose accuracy, and a margin finer than the sample resolves cannot support
  // that claim — so the honest outcome is neither a pass nor a fail. Demoting an arm is the other
  // direction and needs no power: "the reference is not worse and costs no more" only becomes easier
  // to establish as the interval widens, so it cannot overstate.
  //
  // A paired test on the aggregate replaces the check rather than passing it: the interval is not the
  // instrument once the discordant pairs have been counted, and applying both would be asking a
  // question the design already answered.
  const underpowered = !pairedByLabel.has('overall') && b.overall.halfWidth > policy.margin;

  const verdict = (outcome: EfficiencyComparison['outcome']): EfficiencyComparison => ({
    outcome,
    tokenRatio,
    billedTokenRatio,
    billComparable,
    blocking,
    leading,
    unresolvable,
    belowNoise,
    paired: pairedReadings,
    pairedUsed: pairedReadings.length > 0,
  });

  if (aNotWorse && aBetterSomewhere) return verdict(underpowered ? 'underpowered' : 'dominates');
  if (bNotWorse && bBetterSomewhere) return verdict('dominated');
  return verdict('incomparable');
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
