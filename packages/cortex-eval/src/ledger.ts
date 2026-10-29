/**
 * The portfolio: what two increments are worth **together**, which no per-run delta can say.
 *
 * ## The question this exists to answer
 *
 * Every roadmap decision after §13.123 has the same shape. `silent` is registered against MR and predicted
 * at +9 questions; `answer-line` is registered against IE and predicted at +6; the temporal signal carries
 * a +3 prediction and the cross-encoder a +2. Adding those is the natural next sentence, and it is
 * unsupported by construction: each figure is measured against **its own** baseline, and if two increments
 * buy the same questions the second one's gain was already in the first one's number.
 *
 * Nothing in the artifacts could tell whether they do. A run's report prints one delta per feature; the
 * per-capability table splits that delta; the `discordantQuestions` list names the questions **for one
 * pair**. Reading two runs side by side gives two lists a human can compare by eye, which is how a
 * mis-attributed gain survives: at 100 questions a three-question overlap is invisible in two columns of
 * ids, and exactly large enough to turn +15 into +12.
 *
 * So the instrument is one function over the lists that already exist, and its output is the difference
 * between the sum and the union. `bought ∪ bought` is what the increments are worth if they compose;
 * `Σ|bought|` is what adding them claims; the gap **is** the double-counted questions, named.
 *
 * ## The second thing a sum cannot express at all
 *
 * A sum of nets also cancels silently. If the first increment buys `q7` and the second sells it, the totals
 * read `+1` and `-1` and add to zero, and every rendering of that arithmetic says neither increment touched
 * the question. The truth is that two increments moved it in opposite directions, which is a different
 * finding with a different repair: one of the two treatments is wrong for that question and the pair should
 * not be shipped together. `conflicting` names it, and `portfolioOf` reports it ahead of the arithmetic that
 * hides it.
 *
 * ## What this does not claim
 *
 * **A union is not the combined arm's score.** Two increments measured against two different baselines can
 * interact: `silent` makes the reader keep its notes private and `answer-line` tells it what shape to reply
 * in, and the second increment measured on top of the first could buy a question neither bought alone — or
 * lose one. The union is the **ceiling under perfect additivity**, and it is worth computing precisely
 * because a sum is the ceiling under the *assumption* that additivity holds, which is the assumption on
 * trial. A portfolio that shows zero overlap does not prove the pair composes; it removes the one reason
 * that is checkable on artifacts already on disk before spending a dispatch.
 *
 * It also does not merge baselines. Each increment keeps its own: `bought` is relative to the run it was
 * measured against, which is why the increments in a portfolio must be listed in dispatch order -- the
 * ordering is the only record of what sat on top of what.
 */

import type { IncrementLedger, LedgerSource, Portfolio } from './types.js';

export type { IncrementLedger, Portfolio };

/**
 * One increment's ledger, read from the result that already recorded it.
 *
 * ## Why this refuses rather than defaults
 *
 * `discordantQuestions` is optional on `AblationResult` because the type is also the shape of a report read
 * back from disk, and every report written before the field existed lacks it. An empty `bought` list and an
 * unrecorded one are indistinguishable in a portfolio and mean opposite things: the first says the
 * increment bought nothing, the second says nobody kept the record. Substituting `[]` would let a legacy
 * artifact contribute a confident zero to a union -- the same defect `recoveryCensus` and the `ingest` line
 * were repaired for, one artifact over.
 *
 * A duplicate id is refused for the same reason at a smaller scale: a run cannot buy one question twice, so
 * a list that names one twice is corrupt, and quietly deduping it would put the list out of agreement with
 * the count printed one line above it in the same report.
 */
export function ledgerOf(label: string, result: LedgerSource): IncrementLedger {
  const questions = result.discordantQuestions;
  if (questions === undefined) {
    throw new Error(
      `increment "${label}" carries no discordantQuestions: its artifact predates the field, so its ` +
        'purchases are unrecorded rather than empty and cannot enter a portfolio',
    );
  }

  const bought = questions.baselineIncorrectFeatureCorrect;
  const sold = questions.baselineCorrectFeatureIncorrect;
  refuseDuplicates(label, 'bought', bought);
  refuseDuplicates(label, 'sold', sold);

  return { label, bought: [...bought], sold: [...sold] };
}

/**
 * The union of N increments, with the arithmetic a sum gets wrong spelled out.
 *
 * Order is first appearance, bought before sold within an increment, so the output is stable for a given
 * input order and a reader can see which increment paid first. Nothing is sorted: sorting by id would
 * destroy the only attribution the output carries, and the ids in this corpus are opaque hex.
 */
export function portfolioOf(increments: readonly IncrementLedger[]): Portfolio {
  const bought: string[] = [];
  const sold: string[] = [];
  const boughtIds = new Set<string>();
  const soldIds = new Set<string>();
  const doubleCounted: string[] = [];
  let summedBought = 0;
  let summedSold = 0;

  for (const increment of increments) {
    for (const id of increment.bought) {
      summedBought += 1;
      if (!boughtIds.has(id)) {
        boughtIds.add(id);
        bought.push(id);
      } else if (!doubleCounted.includes(id)) {
        doubleCounted.push(id);
      }
    }
    for (const id of increment.sold) {
      summedSold += 1;
      if (!soldIds.has(id)) {
        soldIds.add(id);
        sold.push(id);
      }
    }
  }

  return {
    bought,
    sold,
    doubleCounted,
    conflicting: bought.filter((id) => soldIds.has(id)),
    summedBought,
    summedSold,
  };
}

/** Rejects a list that names one question twice, naming the increment, the side and the id. */
function refuseDuplicates(label: string, side: 'bought' | 'sold', ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(
        `increment "${label}" names ${id} twice in its ${side} list: a run cannot move one question ` +
          'twice, so the artifact is corrupt and deduping it would disagree with its own count',
      );
    }
    seen.add(id);
  }
}
