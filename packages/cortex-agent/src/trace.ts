/**
 * Turning steps into the one order the caller reads.
 *
 * ## Why the order is first appearance and not relevance
 *
 * Because a replay has to compose the same prompt, and the only order the trace can justify is the
 * order in which the evidence was put in front of the reader. A relevance order would be a second
 * ranking computed after the fact over a set that was already chosen -- it would look like the
 * index's opinion while being a different function of the same corpus, and no artifact could tell
 * which of the two produced a prompt.
 *
 * ## Why it is a function of the steps rather than accumulated in the loop
 *
 * A `Set` built as the loop runs is the same array when the loop is correct and a different one
 * when it is not, and the difference is unobservable from outside. Deriving it from the recorded
 * steps means a trace replayed from JSON -- which is what an artifact carries -- selects what the
 * run selected. The loop keeps no hidden state that this function cannot reconstruct.
 */
import type { AgentStep } from './types.js';

/**
 * Every id any step returned, in the order it first appeared.
 *
 * A `search` step's `hits` may repeat ids an earlier step returned; those are skipped here rather
 * than deduplicated in place, so the step records what the tool actually said.
 */
export function selectedOrder(steps: readonly AgentStep[]): readonly number[] {
  const seen = new Set<number>();
  const order: number[] = [];
  for (const step of steps) {
    for (const id of step.hits) {
      if (seen.has(id)) continue;
      seen.add(id);
      order.push(id);
    }
  }
  return order;
}
