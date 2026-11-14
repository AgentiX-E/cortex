/**
 * Which memory a bounded store gives up, decided by `MemoryType`.
 *
 * ## Why this module is the read side of a field that had no read side
 *
 * `MemoryType` is `'episodic' | 'semantic' | 'procedural'` and, until this module, the product constructed
 * every `MemoryValue` with a literal `'episodic'` and never branched on the field. A union with three members
 * that one code path writes and no code path reads is a taxonomy the type system asserts and the runtime does
 * not have — `DECISION-SEMANTIC-LAYER-ROUTE.md` §3 calls that out as the shape that would make E3 fake, and
 * the semantic store is where the difference is observable: a knowledge entry and an observation are not
 * equally worth keeping, and the eviction is the place where that opinion has to become arithmetic.
 *
 * ## The two rules, and why they are not the same rule twice
 *
 * | type | rank | why |
 * | --- | --- | --- |
 * | `semantic` | `[lastAccessedAt, reads]` | a statement about the world is kept by being *used*; a change no window has quoted yet is the first thing to lose |
 * | `episodic` | `[createdAt, 0]` | a turn is a reading of one window, and how often a later window happened to quote it says nothing about whether the turn is still worth holding |
 * | `procedural` | `[createdAt, 0]` | same as `episodic`, and stated rather than defaulted so the table has no silent member |
 *
 * A single rule with a `type === 'semantic'` guard would have produced the same behaviour and a worse artefact:
 * the two other members would have become a comment, and a fourth member added to the union would fall through
 * to whatever the guard's `else` happened to do. `Record<MemoryType, …>` makes that a compile error here.
 *
 * ## Why the second element is not `value`
 *
 * `MemoryValue.value` is the field the domain types name for "estimated future utility", so it is the obvious
 * place to put a use count — and it is the wrong one. Its contract is `[0, 1]`, the product's admission gate
 * computes it with a caller-supplied `valueFunction`, and the semantic store's entries never pass through that
 * gate. A use count written into `value` would be a second scale sharing one field, which is the defect
 * `math/fsrs.ts` spent a whole docstring repairing in the time domain.
 *
 * So the count lives where it is observed — on the store's own record — and this function takes it as an
 * argument rather than reaching for it.
 *
 * ## Why recency dominates the count
 *
 * An entry quoted forty times an hour ago loses to one quoted once a second ago. The other order would make a
 * corpus that was read in a burst immortal, and the bound would stop bounding — which is the one property the
 * prompt's `UPDATES:` block has to have.
 */

import type { MemoryType, MemoryValue } from '@agentix-e/cortex-core';

/** What a type says about keeping an entry. Larger is retained longer; the store drops the smallest. */
type RetentionRule = (memory: MemoryValue, reads: number) => readonly [number, number];

const RETENTION: Record<MemoryType, RetentionRule> = {
  semantic: (memory, reads) => [memory.lastAccessedAt, reads],
  episodic: (memory) => [memory.createdAt, 0],
  procedural: (memory) => [memory.createdAt, 0],
};

/**
 * The pair the store's eviction compares, for one entry.
 *
 * Lexicographic, and the caller keeps the **largest**. Returned as a tuple rather than as one collated number
 * because the two elements are different quantities on different scales — a stamp in epoch milliseconds and a
 * count of windows — and packing them into one float would be an arithmetic whose precision nobody stated.
 *
 * `reads` is the number of windows that carried the entry, and it is a parameter rather than a field because
 * `MemoryValue` has no field for it: the store observes it, so the store passes it.
 *
 * Not exported: the ranking and the choice it feeds are one decision, and a caller that could compare two ranks
 * itself would be a second eviction rule. The export boundary is {@link leastRetained}.
 */
function retentionRank(memory: MemoryValue, reads: number): readonly [number, number] {
  return RETENTION[memory.type](memory, reads);
}

/**
 * The index of the entry the store gives up, or `0` for an empty list.
 *
 * Lexicographic on {@link retentionRank}, **largest is retained**, ties going to the earlier index. The
 * tie-break direction is a decision rather than an accident: two entries that rank identically are two entries
 * the rule has no opinion about, and dropping the one that has been held longest is the only choice that keeps
 * the store's own history ordered. Returning an index rather than the entry keeps the caller's `splice` and its
 * `dropped` counter in one place.
 *
 * An empty list returns `0` and that index does not exist — the contract is that the caller only reaches this
 * after establishing the store is one past its bound, which is the same guard that makes the `splice` after it
 * safe. A `-1` sentinel for "nothing to drop" would have looked defensive and would have turned the caller's
 * mistake into a silent no-op, which is the failure class this repository has spent three rounds deleting.
 */
export function leastRetained(
  entries: readonly { readonly memory: MemoryValue; readonly reads: number }[],
): number {
  let victim = 0;
  for (let index = 1; index < entries.length; index += 1) {
    const candidate = retentionRank(entries[index]!.memory, entries[index]!.reads);
    const held = retentionRank(entries[victim]!.memory, entries[victim]!.reads);
    const loses = candidate[0] < held[0] || (candidate[0] === held[0] && candidate[1] < held[1]);
    if (loses) victim = index;
  }
  return victim;
}
