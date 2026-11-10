/**
 * Rendering a computed value back into the answer shape the corpus scores.
 *
 * ## Two shapes, and why the second one is not a formatting nicety
 *
 * Counts render as a bare integer, which is the shape the tally pass already used and the shape the
 * count questions' golds take. Sums render with the currency symbol their numbers shared -- `$3,750`
 * rather than `3750` -- because the golds for money questions carry the symbol and a judge comparing
 * strings has no reason to forgive its absence.
 *
 * ## Three results the renderer refuses
 *
 * `list`, `first`, `last` and `group-count` are executable and are not renderable: an answer to a
 * count question is a count, and putting a quotation where a count belongs is the previous pass's
 * failure (`37f165cf` answered `"440 pages and 416 pages"` against a gold of `856`) reproduced by a
 * different mechanism. A mixed-unit sum is refused for the same reason -- `3752` from `$3,750` and
 * `2 pages` is a number that means nothing, and the plan that produced it has to be fixed before it
 * is answered from.
 *
 * So rendering is a total function with four empty branches, and `null` means "keep the first
 * pass's answer". That is the same contract `renderTally` has in the other direction: the mechanism
 * answers only where its own type discipline says the answer is well-formed.
 */

import type { AggregationResult } from './execute.js';

/** Currency symbols a sum may carry, which is the set the ledger's numeral pattern recognises. */
const CURRENCIES = new Set(['$', '¥', '€', '£']);

/**
 * Whether a summed value should carry its currency.
 *
 * Only a currency, and only when every number agreed on it. A unit like `pages` is not rendered:
 * `856` is the corpus's answer and `856 pages` is a sentence, and the count questions' golds are the
 * bare number.
 */
function currencyOf(unit: string | null): string | null {
  return unit !== null && CURRENCIES.has(unit) ? unit : null;
}

/**
 * The answer text for a result, or `null` when the result is not an answer.
 *
 * A sum whose numbers disagreed on their unit is `null` -- not a rounded guess and not the bare
 * number. This is the branch that keeps the executor's most dangerous failure from reaching a
 * scorer: two quantities added because the plan did not say which one it meant reads as a confident
 * number, and the only defence a renderer has is to decline to write it.
 */
export function renderAggregate(result: AggregationResult): string | null {
  if (result.kind === 'empty') return null;
  if (result.operation === 'count' && typeof result.value === 'number') return String(result.value);
  if (result.operation !== 'sum' || typeof result.value !== 'number') return null;
  // Two quantities added because the plan did not say which one it meant reads as a confident
  // number, and the only defence a renderer has is to decline to write it.
  if (result.mixed) return null;
  return `${currencyOf(result.unit) ?? ''}${result.value}`;
}
