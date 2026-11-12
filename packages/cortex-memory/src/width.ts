/**
 * How much evidence one question is worth, decided before the prompt is assembled.
 *
 * ## The defect this file exists for
 *
 * The arm's room is **fixed per route**: `multi-session` gets 48,460 characters and the other four get
 * 24,000 (`cost.json`, `cap.rooms`). That is a statement about the *route*, not about the question, and
 * the bill shows what it costs: 9,168 billed prompt tokens per question, of which **6,167** -- 67.3% --
 * is the two load-bearing routes answering at their full width, while the floor those prompts carry
 * (instructions, question line, section headers) is a median 272 characters of evidence per turn against
 * a room measured in tens of thousands. A question whose gold evidence is four short turns is read by a
 * prompt with room for two hundred.
 *
 * The arithmetic version of the same claim is §14.126.1's fifth row: at **2x the gold evidence**, capped
 * at what the run actually delivers, the same 500 questions would bill **3,703** tokens instead of 9,168.
 * That row is an upper bound and not a configuration -- production does not have the gold -- but it says
 * where the money is: **59.6% of the bill is not evidence, it is the assumption that every question needs
 * the same room.**
 *
 * ## What replaces it, and what the replacement cannot see
 *
 * The signal this file uses is `lexicalRelevance`, which is already in the pipeline and already drives
 * `selectByRelevance`. The rule is a **coverage cut**: rank the candidate turns by relevance, take the
 * shortest prefix that explains a target share of the total relevance mass, and cap the evidence at that
 * prefix's rendered length.
 *
 * The honest statement of what that measures: relevance mass is not gold recall. A turn that shares no
 * term with the question can hold the decisive fact -- the arm's own history has that case on record
 * (`a4996e51`, where the operand sat in a turn the reader was handed and the sentence was cut mid-word).
 * So this file can be wrong in a specific direction: **it can cut evidence that mattered.** That is not a
 * risk to be mitigated by loosening the cut until it does nothing; it is the hypothesis `C6` registers,
 * with a negative form (`03` §14.126.2 clause 5: below 90.40% accuracy the family closes) and a price of
 * 2.85 CNY to read.
 *
 * ## Why the cut is a prefix and not a subset
 *
 * Because the budget it feeds is a prefix. `chooseEvidence` spends `evidenceRoom` on the highest-scoring
 * turns it can fit, so a `maxEvidenceChars` that admits the top ten by relevance is exactly the set the
 * selector would deliver -- the cut removes the *tail* rather than choosing among the head. Asking for a
 * subset the selector does not order that way would be a second selector, and then a reading could not
 * say whether the width or the new ordering earned the delta.
 */

import { lexicalRelevance } from './relevance.js';

/** What the allocator is allowed to assume, all of it stated by the caller. */
export interface WidthPlanOptions {
  /**
   * Share of the question's total relevance mass the delivered evidence must explain, in `(0, 1]`.
   *
   * `1` is every candidate and therefore the identity -- the plan returns `undefined` and the route's
   * room stands. The arm's registered value is `0.9`, which is the smallest cut whose prefix is still
   * larger than the gold set on this population; stating it as a share rather than as a character count
   * is what keeps it independent of how long the turns happen to be.
   */
  readonly coverage: number;
  /**
   * A floor in characters, below which the plan refuses to go.
   *
   * Not a safety net for accuracy -- it is a statement about resolution. A cut to 600 characters leaves a
   * prompt that cannot carry an instruction and one turn, so the reading would measure "a prompt too small
   * to work" rather than "less evidence than the room allowed". The registered value is 4,000, one sixth
   * of the narrowest route's room.
   */
  readonly floorChars: number;
  /**
   * How much longer a rendered block is than the turn it holds, as a multiplier.
   *
   * The renderer prefixes each block with its rank and a separator, so a prefix measured in raw characters
   * is **shorter** than the same prefix rendered. Under-estimating here is the one error that costs
   * accuracy rather than money: the selector would be handed less room than the plan believed it granted,
   * and turns the plan counted as delivered would be dropped. `1.15` is the margin this arm registers; it
   * is a constant rather than a measurement because measuring it would mean depending on the renderer, and
   * `width.ts` is deliberately renderer-agnostic -- the artifact reports `evidenceChars` from the prompt
   * that was actually assembled, so a wrong margin is visible as a gap rather than as a silent loss.
   */
  readonly renderMargin: number;
}

/**
 * One question's evidence budget, or `undefined` for "the route's room stands".
 *
 * ## Why `undefined` rather than a large number
 *
 * Because the absence has a meaning the artifact can record: the plan did not act. A number large enough
 * to never bind would be indistinguishable, in a reading, from a plan that computed a bound and had it
 * discarded by a larger room -- and the difference between "did not act" and "acted and was overruled" is
 * the difference between a mechanism that failed and one that was never reached.
 */
export interface WidthPlan {
  /** Characters of rendered evidence the plan will fund. */
  readonly evidenceChars: number;
  /** Share of the relevance mass the funded prefix actually covers, measured rather than requested. */
  readonly coveredShare: number;
  /** How many turns the funded prefix holds. */
  readonly turnsKept: number;
  /** How many turns were ranked. */
  readonly turnsConsidered: number;
}

/**
 * Why the plan gave the answer it gave, in the vocabulary a reader needs.
 *
 * Four values, and every one of them is reachable: `unsignalled` is a question sharing no content term
 * with any candidate (a real population -- 29 of the 500 abstention questions ask about a subject the
 * evidence never names), `identity` is `coverage = 1` or a prefix that already covers the whole budget,
 * `capped` is the plan acting, `empty` is no candidates at all.
 *
 * Not exported: it is {@link WidthDecision.reason}'s type and nothing names it on its own -- a consumer
 * switches on the value. `tools/export-census.mjs` reported it as an orphan when it was, which is the
 * gate doing its job rather than an inconvenience.
 */
type WidthPlanReason = 'empty' | 'unsignalled' | 'identity' | 'capped';

/** The plan, with the field a census needs to tell the four reasons apart. */
export interface WidthDecision {
  readonly reason: WidthPlanReason;
  /** Absent for every reason except `capped`. */
  readonly plan?: WidthPlan;
}

/** No candidates: the route's room stands, and the prompt is the empty-evidence prompt it already was. */
const EMPTY: WidthDecision = { reason: 'empty' };

/** A question with no content terms, or candidates sharing none of them: nothing to rank, nothing to cut. */
const UNSIGNALLED: WidthDecision = { reason: 'unsignalled' };

/** The plan looked and declined to act -- `coverage` at 1, or a prefix that already fits the room. */
const IDENTITY: WidthDecision = { reason: 'identity' };

/**
 * Decide how much evidence this question is worth.
 *
 * @param question the question as the reader will see it
 * @param turns the candidate turns, in arrival order -- the order is kept for ties, because a tie is the
 *   relevance signal saying it has no opinion and the arrival order is the only other rule in the pipeline
 * @param options see {@link WidthPlanOptions}
 * @param rendered the characters each turn will actually contribute, when that differs from its length.
 *
 *   ## Why this parameter exists, and what it cost to notice
 *
 *   The registered arm caps one turn at **400 characters on two routes** (`CORTEX_MEMORY_MAX_TURN_CHARS`,
 *   reaching `multi-session` and `temporal`), so a 5,000-character turn enters the prompt as 400. A plan
 *   that measures the *raw* turn would then report a budget twelve times the prompt it is budgeting: the
 *   funded prefix is mostly text the renderer was never going to print, `fitToBudget` reads the cap as
 *   non-binding, and the mechanism silently does nothing -- on exactly the two routes whose bill the
 *   experiment exists to reduce. That is not a hypothetical: the first dispatch of this plan
 *   (`43259468403`) was cancelled for it before it produced a reading.
 *
 *   Absent means the turn's length, which is what an arm with no per-turn cap renders and therefore the
 *   correct default for every configuration that does not have one.
 */
export function planEvidenceRoom(
  question: string,
  turns: readonly string[],
  options: WidthPlanOptions,
  rendered?: readonly number[],
): WidthDecision {
  if (turns.length === 0) return EMPTY;
  if (options.coverage >= 1) return IDENTITY;

  const charsOf = (index: number): number => rendered?.[index] ?? turns[index]!.length;
  const scores = turns.map((turn) => lexicalRelevance(question, turn));
  const total = scores.reduce((sum, score) => sum + score, 0);
  // A question sharing no content term with any candidate scores zero everywhere. Returning `IDENTITY`
  // rather than a zero budget is the whole point: a signal that found nothing is not evidence that the
  // evidence is worthless, and cutting on it would spend the mechanism on exactly the questions it knows
  // least about -- 29 of the 500 abstention questions, whose gold is a decline.
  if (total === 0) return UNSIGNALLED;

  // Descending by score, ties by arrival. Sorted indices rather than sorted turns, because the plan
  // reports *which* prefix it funded and the caller needs to compare that against what was delivered.
  const ranked = scores
    .map((score, index) => ({ score, index }))
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const target = options.coverage * total;
  let covered = 0;
  let kept = 0;
  let chars = 0;
  for (const entry of ranked) {
    covered += entry.score;
    chars += charsOf(entry.index);
    kept += 1;
    if (covered >= target) break;
  }

  const funded = Math.max(options.floorChars, Math.ceil(chars * options.renderMargin));
  const whole = Math.ceil(
    turns.reduce((sum, _turn, index) => sum + charsOf(index), 0) * options.renderMargin,
  );
  // The prefix already covers every candidate: there is nothing left for a cap to remove, and returning a
  // number here would report a mechanism acting on a question it did not change.
  if (funded >= whole) return IDENTITY;

  return {
    reason: 'capped',
    plan: {
      evidenceChars: funded,
      coveredShare: covered / total,
      turnsKept: kept,
      turnsConsidered: turns.length,
    },
  };
}
