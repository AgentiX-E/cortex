/**
 * The veto's arithmetic: does the first answer's own token appear among the rows the plan selected?
 *
 * ## Why this relation exists
 *
 * `MEASURE-PLAN-SHAPE.md` measured the mechanism family this pass belongs to and found the one line every
 * member depends on to be false in the data: **damages are wide and repairs are not.** On run `42930900136` the
 * three repairs came from plans whose `scope` covered the whole ledger, and 37 of the 43 damages were `sum`
 * plans that selected too much. A predicate over the plan (`span-wide`) blocked all 43 damages and lost all
 * three repairs, because the two populations are not separated by the plan's shape.
 *
 * So the next arm does not judge the plan. It judges the **substitution**: keep the plan's value only when the
 * first answer's own token is one of the rows the plan selected. The relation is between the two answers, which
 * is the same shape `supersede.ts` enforces one mechanism later, and unlike the plan's scope it is checkable
 * from the evidence both sides already used.
 *
 * ## What is recorded, and why four numbers rather than a verdict
 *
 * `selected` and `ledgerRows` say how much of the history the plan kept; `supportHits` says how many of those
 * rows carry the answer's token; `authorized` is `supportHits > 0`. The verdict alone would be a boolean over a
 * population nobody could reconstruct, and the identity `supportHits <= selected <= ledgerRows` is what lets a
 * reader check the census from the artifact instead of trusting the counter.
 *
 * `tokens` is the number of distinct numerals the first answer offered, and it is here to explain a zero: with
 * `tokens: 0` the veto can never fire, which is a fact about the answers rather than about the plans.
 *
 * ## The two asymmetries, which are decisions
 *
 * - **A first answer with no numeral is never authorized.** A word answer (`Friday`) cannot be authorized by
 *   comparing numbers, and refusing keeps the answer that was actually read. The alternative — authorize by
 *   default when the check cannot run — makes the veto a no-op exactly where it is least understood.
 * - **A hit counts rows, not occurrences.** A row that says `1998` twice is one supporting row, because the
 *   question the check answers is "is the answer's quantity among the rows the plan kept", not "how often".
 *
 * ## What it does not do
 *
 * It does not look at the evidence the plan did **not** select. A `sum` that selected the wrong two rows out of
 * three and happens to include one carrying the answer's numeral is authorized, and the arithmetic can still be
 * wrong. This is the cheapest relation that is a relation; it is not a correctness check, and the arm's own
 * bars (`V1`–`V4`) are what decide whether it was enough.
 */

import type { AggregationResult } from './execute.js';
import type { Ledger } from './ledger.js';
import { numeralsIn } from './ledger.js';

/** What the authorization saw, and what it decided. */
export type SpecAuthorization = {
  /** Rows the plan selected, which is `support.length` of a computed result. */
  readonly selected: number;
  /** Rows in the ledger the plan ran over, which bounds `selected`. */
  readonly ledgerRows: number;
  /** Selected rows carrying at least one of the first answer's numerals. */
  readonly supportHits: number;
  /** Distinct numerals the first answer offered. Zero means the veto cannot run. */
  readonly tokens: number;
  /** `supportHits > 0`. The one derived field, so a reader never has to compute it twice. */
  readonly authorized: boolean;
};

/**
 * Authorize — or refuse — substituting a plan's value for the first answer.
 *
 * Pure: it reads the result's `support`, the ledger's rows, and the answer's numerals, and returns four
 * integers and their consequence. The caller decides what to do with the verdict, which is what keeps the
 * census measurable on a build that does not yet apply it.
 */
export function authoriseSpecSubstitution(
  result: AggregationResult,
  ledger: Ledger,
  firstAnswer: string,
): SpecAuthorization {
  const tokens = new Set(numeralsIn(firstAnswer));
  const support = result.kind === 'value' ? result.support : [];
  // Iterated over the ledger rather than over `support`, so the loop cannot index a row that is not there and
  // needs no guard for a state `executeSpec` cannot produce: its support is drawn from `ledger.rows`, and a
  // guard for an impossible step would be a branch no caller can enter — a guard that reads as safety while
  // measuring nothing.
  const selected = new Set(support);
  let supportHits = 0;
  if (tokens.size > 0) {
    for (const row of ledger.rows) {
      if (!selected.has(row.step)) continue;
      if (row.numbers.some((number) => tokens.has(number.value))) supportHits += 1;
    }
  }
  return {
    selected: support.length,
    ledgerRows: ledger.rows.length,
    supportHits,
    tokens: tokens.size,
    authorized: supportHits > 0,
  };
}
