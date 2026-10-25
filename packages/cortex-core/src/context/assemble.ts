/**
 * The single exit a reader's context passes through, and the four questions it asks of every candidate.
 *
 * ## Why this module exists
 *
 * Before it, three ledgers existed and none of them could change an answer. `assumptionPenalty` decided
 * what a refuted fact was worth; `planFactor` decided what a lapsed commitment was worth; the supersession
 * edge knew which of two values came first. All three were called by tests, and by the ablation, which had
 * its own copy of the decision logic. That is the worst arrangement available: an ablation that reimplements
 * the mechanism measures the reimplementation, and a mechanism the shipping path never calls is decoration
 * with a test suite.
 *
 * So the decision logic lives here, once, and the ablation calls it. The rule the repository keeps coming
 * back to is that a reading and a product must call the same function, or the reading describes something
 * else.
 *
 * ## The four questions, in this order, because the cheap ones are also the decisive ones
 *
 * 1. **Was this true when the question asks?** `asOf` is a hard filter, never a discount. A fact that
 *    became true after the asked instant is not evidence about that instant at any weight, and discounting
 *    it lets a high-scoring later fact outrank a correct earlier one — which is exactly the failure a
 *    historical question exists to test. This is also why retirement is *suspended* under `asOf`:
 *    `refuted` means "no longer current", not "never true" (PACMI measured the two collapsed together as
 *    1.00 → 0.36 on historical questions).
 * 2. **Is the question about what happened, or about what is planned?** Two pools, not one ranking. An
 *    unfulfilled commitment is not an answer to "did they go", and a settled fact is not an answer to
 *    "where will they go". PM-Bench names the inverse failure as its dominant one — acting on plans that
 *    were completed or cancelled — and both directions cost the same kind of trust.
 * 3. **Is it still current?** The ledger's two zeros: `refuted` (the world moved on) and `stale` (a premise
 *    it rests on moved on). Neither is deleted; both stop answering the default question.
 * 4. **Does it fit?** A token budget, spent on rendered blocks rather than on atoms.
 *
 * ## What is deliberately *not* excluded
 *
 * A **conflict** — two values on one slot claiming one instant — is served, both sides, marked. Excluding
 * one would mean picking, and the id is not evidence; excluding both would hide the disagreement from the
 * reader who is best placed to resolve it. The census reports the pair so a caller that must produce a
 * single answer knows to say it does not know. That distinction — the store keeps both, the answer refuses
 * to choose — is the same one `revision.ts` draws, seen from the read side.
 */

import { assumptionPenalty, slotKey, type Penalty } from '../knowledge/assumption.js';
import type { KnowledgeFact } from '../knowledge/frame.js';
import { isPlan, planFactor } from '../knowledge/temporality.js';
import type { KnowledgeUnit } from '../knowledge/unit.js';
import { renderBlocks, tokenEstimate } from '../retrieval/typed.js';

/** What the question is asking for. Two pools; the default is the one most questions want. */
export type RetrievalIntent = 'fact' | 'plan';

/** Why a candidate did not reach the block. Counted, never silent. */
export type ExclusionReason =
  | 'refuted'
  | 'stale'
  | 'conflict'
  | 'not-a-plan'
  | 'unfulfilled-plan'
  | 'abandoned'
  | 'after-as-of'
  | 'no-score'
  | 'over-budget';

export type Exclusion = {
  readonly factId: string;
  readonly reason: ExclusionReason;
};

/**
 * A candidate the ranker has already ordered. `score` is the upstream signal — dense, lexical, fused — and
 * this module never invents one, because a similarity this file computed would be a second retriever that
 * nothing else could see.
 */
export type Ranked = {
  readonly factId: string;
  readonly score: number;
};

/**
 * Which ledgers participate.
 *
 * Every switch defaults to on. They exist so the ablation can remove exactly one mechanism and call the
 * same code path the product calls; a switch that also changed how a fact is *built* would be measuring
 * two things at once, which is why build-time decisions live in the fixture and read-time decisions live
 * here.
 */
export type AssemblePolicy = {
  /** Retirement and staleness. Off: a refuted fact answers like any other. */
  readonly ledger?: boolean;
  /** Futurity and the plan lifecycle. Off: a commitment answers a question about what happened. */
  readonly temporality?: boolean;
  /** The window. Off: `asOf` is ignored and every fact is a candidate. */
  readonly window?: boolean;
  /**
   * Whether an assumed time counts as a time.
   *
   * Off means a fact that never stated its own date cannot be placed in the window and cannot be compared
   * with a dated one. It still answers; it just cannot win an argument about *when*.
   */
  readonly anchor?: boolean;
  /**
   * Whether two values on one slot at one instant are marked as a conflict.
   *
   * Off, they are served as ordinary candidates and the ranking picks between them by score and then by id.
   * That is what a store without a `uniqueness` assumption does, and it is the thing the switch exists to
   * price.
   */
  readonly uniqueness?: boolean;
  /** The budget. Off: everything that survived is served, however long. */
  readonly budget?: boolean;
};

export type AssembleInput = {
  readonly unit: KnowledgeUnit;
  /** Candidates in upstream order, with their scores. A fact absent here is not a candidate at all. */
  readonly ranked: readonly Ranked[];
  /** The clock the ledger is read at. Required: a default of `Date.now()` would make the function impure. */
  readonly now: number;
  readonly intent?: RetrievalIntent;
  /** The instant a historical question asks about. Present means "read the store as it was then". */
  readonly asOf?: number;
  /** Token ceiling for the rendered block. Ignored when `budget` is off. */
  readonly budgetTokens?: number;
  readonly policy?: AssemblePolicy;
};

export type ServedFact = {
  readonly factId: string;
  /** What the ranker said. */
  readonly score: number;
  /** What survived the ledger. The ordering key, and the number a report explains. */
  readonly effective: number;
  readonly penalty: Penalty;
  readonly plan: number;
  /** Two values on one slot claim this fact's instant, so a single answer cannot be given. */
  readonly conflict: boolean;
};

export type AssembleCensus = {
  readonly considered: number;
  readonly served: number;
  readonly excluded: Readonly<Partial<Record<ExclusionReason, number>>>;
  /**
   * Facts that answered although the ledger had retired them.
   *
   * Must be zero on a default question. Non-zero is the number the `-ledger` ablation moves, and it is
   * reported per answer rather than per run so a single leak is visible rather than averaged away.
   */
  readonly servedNotCurrent: number;
  /** Facts served *because* a historical question asked for them. Not a leak; a correct answer. */
  readonly servedHistorically: number;
  readonly conflicts: number;
  readonly tokens: number;
  readonly budget: number;
};

export type AssembleResult = {
  readonly lines: readonly string[];
  readonly served: readonly ServedFact[];
  readonly excluded: readonly Exclusion[];
  readonly census: AssembleCensus;
};

/**
 * When a fact claims to hold: its stated time, else the anchor it assumed.
 *
 * `undefined` means the fact cannot be placed, which is different from being false. Used by the window
 * check and by the conflict check, so both read the same clock.
 */
export function effectiveAt(
  fact: KnowledgeFact,
  options: { readonly anchor?: boolean } = {},
): number | undefined {
  if (fact.at !== undefined) return fact.at;
  if (options.anchor === false) return undefined;
  const anchor = (fact.assumptions ?? []).find((assumption) => assumption.kind === 'time-anchor');
  if (anchor === undefined) return undefined;
  const value = Number(anchor.value);
  return Number.isFinite(value) ? value : undefined;
}

/** Whether a fact still answers the default question. Separate from *how much* it is worth. */
function retirement(fact: KnowledgeFact): 'refuted' | 'stale' | null {
  if (fact.stale === true) return 'stale';
  const persistence = (fact.assumptions ?? []).find(
    (assumption) => assumption.kind === 'persistence',
  );
  if (persistence !== undefined && persistence.status === 'refuted') return 'refuted';
  return null;
}

/**
 * Assemble the block, or explain why nothing is in it.
 *
 * Pure: same inputs, same output, no clock read, no map iteration order depended on. That property is not
 * stylistic — the ablation compares two arms over one fixture, and a tie broken by insertion order would
 * make the two arms differ for a reason that has nothing to do with the mechanism.
 */
export function assemble(input: AssembleInput): AssembleResult {
  const policy = input.policy ?? {};
  const ledgerOn = policy.ledger !== false;
  const temporalityOn = policy.temporality !== false;
  const windowOn = policy.window !== false;
  const anchorOn = policy.anchor !== false;
  const uniquenessOn = policy.uniqueness !== false;
  const budgetOn = policy.budget !== false;
  const intent: RetrievalIntent = input.intent ?? 'fact';
  const budget = budgetOn ? (input.budgetTokens ?? 600) : Number.POSITIVE_INFINITY;

  const facts = new Map(input.unit.facts.map((fact) => [fact.id, fact]));
  const scored = new Map(input.ranked.map((entry) => [entry.factId, entry.score]));

  const excluded: Exclusion[] = [];
  const exclude = (factId: string, reason: ExclusionReason): void => {
    excluded.push({ factId, reason });
  };

  /** Candidates that survived every filter, with the numbers that decided. */
  const candidates: ServedFact[] = [];
  let servedNotCurrent = 0;
  let servedHistorically = 0;

  for (const fact of input.unit.facts) {
    const score = scored.get(fact.id);
    if (score === undefined) {
      exclude(fact.id, 'no-score');
      continue;
    }

    // 1. The window. A hard filter -- see the module comment for why it cannot be a discount.
    const at = effectiveAt(fact, { anchor: anchorOn });
    if (windowOn && input.asOf !== undefined && at !== undefined && at > input.asOf) {
      exclude(fact.id, 'after-as-of');
      continue;
    }

    // 2. The pool. `fulfilled` is a fact and stays; `pending`, `lapsed` and `abandoned` are not answers to
    //    "what happened". A question that asks for a plan gets only plans, for the symmetric reason.
    if (temporalityOn) {
      const planned = isPlan(fact);
      const state = fact.planState ?? 'pending';
      if (intent === 'plan' && !planned) {
        exclude(fact.id, 'not-a-plan');
        continue;
      }
      if (intent === 'fact' && planned && state !== 'fulfilled') {
        exclude(fact.id, state === 'abandoned' ? 'abandoned' : 'unfulfilled-plan');
        continue;
      }
    }

    // 3. The ledger. Retirement is **detected** unconditionally and **enforced** by policy, because the two
    //    are different questions: a report of how many uncurrent facts got through needs the detection to
    //    run even when the enforcement is switched off for an ablation. Under a historical question
    //    retirement is suspended as well, because "no longer current" and "never true" are different claims
    //    and `refuted` makes only the first of them.
    const retired = retirement(fact);
    const historical = windowOn && input.asOf !== undefined;
    if (retired !== null && !historical && ledgerOn) {
      exclude(fact.id, retired);
      continue;
    }
    const penalty: Penalty = assumptionPenalty(fact, input.now);
    // A historical question reads the store at its own instant, where a fact later retired was the current
    // value. Discounting it to zero would leave the window's answer to a tie-break on ids, which is the
    // exact failure PACMI measured as 1.00 → 0.36 when it collapsed the two meanings.
    const ledgerFactor = ledgerOn && !historical ? penalty.factor : 1;
    const plan = temporalityOn ? planFactor(fact) : 1;
    if (plan === 0) {
      // `abandoned` is the only plan state worth zero, and it is a declaration somebody made rather than an
      // absence, which is the difference between this and `lapsed`'s mild discount.
      exclude(fact.id, 'abandoned');
      continue;
    }

    const effective = score * ledgerFactor * plan;
    if (retired !== null) {
      if (historical) servedHistorically += 1;
      else servedNotCurrent += 1;
    } else if (historical && at !== undefined) {
      servedHistorically += 1;
    }
    candidates.push({ factId: fact.id, score, effective, penalty, plan, conflict: false });
  }

  // 4. Conflicts, computed over the survivors rather than over the store: a disagreement that involves a
  //    retired fact is not a live disagreement. Grouped by slot and by instant, because a slot may hold
  //    several settled values at different times without any of them being in conflict.
  const conflicted = new Set<string>();
  const bySlotAndTime = new Map<string, ServedFact[]>();
  for (const entry of candidates) {
    const fact = facts.get(entry.factId)!;
    const at = effectiveAt(fact, { anchor: anchorOn });
    if (fact.subject === undefined || fact.predicate === undefined || at === undefined) continue;
    const key = `${slotKey(fact.subject, fact.predicate)}@${at}`;
    const bucket = bySlotAndTime.get(key) ?? [];
    bucket.push(entry);
    bySlotAndTime.set(key, bucket);
  }
  for (const bucket of uniquenessOn ? bySlotAndTime.values() : []) {
    const texts = new Set(
      bucket.map((entry) => facts.get(entry.factId)!.text.trim().toLowerCase()),
    );
    if (bucket.length < 2 || texts.size < 2) continue;
    for (const entry of bucket) conflicted.add(entry.factId);
  }

  const ordered = candidates
    .map((entry) => (conflicted.has(entry.factId) ? { ...entry, conflict: true } : entry))
    .sort((left, right) => {
      if (right.effective !== left.effective) return right.effective - left.effective;
      return left.factId < right.factId ? -1 : 1;
    });

  // 5. The budget, spent on the rendered form.
  //
  //    `fillBudget` is not used here, and the reason is measurable rather than aesthetic: `renderBlocks`
  //    states the frame once and names a relation's other end by id when that end is in the same block, so
  //    a fact's marginal cost depends on which facts are already in. Adding one can make the block
  //    *shorter*. A cost that is not additive cannot be summed into a fill, and summing it would refuse
  //    facts a real render fits. Each step therefore renders and measures, which is O(n^2) on a set that is
  //    single digits in practice and exact in every case.
  //
  //    Skipping and continuing, rather than stopping at the first miss, keeps `fillBudget`'s documented
  //    behaviour: a long fact must not close the door on a short one behind it.
  const chosen: ServedFact[] = [];
  for (const entry of ordered) {
    const trial = [...chosen, entry];
    const lines = render(trial, input.unit);
    if (budgetOn && tokenEstimate(lines.join('\n')) > budget) {
      exclude(entry.factId, 'over-budget');
      continue;
    }
    chosen.push(entry);
  }

  const lines = render(chosen, input.unit);
  const tokens = chosen.length === 0 ? 0 : tokenEstimate(lines.join('\n'));

  const counts: Partial<Record<ExclusionReason, number>> = {};
  for (const entry of excluded) counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;

  return {
    lines,
    served: chosen,
    excluded,
    census: {
      considered: input.unit.facts.length,
      served: chosen.length,
      excluded: counts,
      servedNotCurrent,
      servedHistorically,
      conflicts: [...conflicted].length,
      tokens,
      budget: budgetOn ? (input.budgetTokens ?? 600) : 0,
    },
  };
}

/**
 * Render a chosen set, with the conflict line the block owes a reader.
 *
 * The frame is stated once by `renderBlocks`, and the extra line is passed through `flags` rather than
 * spliced in afterwards, so the two trial renders the budget makes and the final render are produced by
 * exactly the same code. A budget that measured one form and shipped another would be off by the very
 * lines it added last.
 */
function render(chosen: readonly ServedFact[], unit: KnowledgeUnit): readonly string[] {
  if (chosen.length === 0) return [];
  const flags = new Map<string, readonly string[]>();
  for (const entry of chosen) {
    if (entry.conflict) {
      flags.set(entry.factId, [
        'conflict: shares a slot and an instant with another value, so no single answer is available',
      ]);
    }
  }
  return renderBlocks(
    unit,
    chosen.map((entry) => entry.factId),
    { flags },
  );
}
