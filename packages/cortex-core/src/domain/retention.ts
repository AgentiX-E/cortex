/**
 * Which memory a bounded store gives up, decided by `MemoryType`.
 *
 * ## Why this module is the read side of a field that had no read side
 *
 * `MemoryType` is `'episodic' | 'semantic' | 'procedural'` and, until this rule existed, the product
 * constructed every `MemoryValue` with a literal `'episodic'` and never branched on the field. A union with
 * three members that one code path writes and no code path reads is a taxonomy the type system asserts and
 * the runtime does not have — `DECISION-SEMANTIC-LAYER-ROUTE.md` §3 calls that out as the shape that would
 * make E3 fake. The eviction is where that opinion has to become arithmetic: a knowledge entry and an
 * observation are not equally worth keeping.
 *
 * ## Why this lives in `cortex-core`
 *
 * It is a pure function over a `MemoryValue`: no clock, no store, no I/O, nothing to await. That is the
 * whole of this package's stated contract — "contracts + pure algorithms (zero I/O, Node + browser)" — and
 * the rule was written in `cortex-memory` anyway, for one round, because half of its input was not in the
 * domain. The count it ranks by was a second parameter, supplied by the caller as `{ memory, reads }`.
 *
 * That signature was the defect and moving the file is the repair. `MemoryValue.reads` now carries the
 * count, so the rule takes entries and nothing else, and the placement follows the purity rather than the
 * accident: a rule that reads a domain field belongs where the domain is defined. What stays in
 * `cortex-memory` is the part that is not pure — deciding *when* to evict, splicing, and counting what was
 * dropped — which is the composition layer's actual job.
 *
 * ## The two rules, and why they are not the same rule twice
 *
 * | type | rank | why |
 * | --- | --- | --- |
 * | `semantic` | `[lastAccessedAt, reads]` | a statement about the world is kept by being *used*; a change no window has quoted yet is the first thing to lose |
 * | `episodic` | `[createdAt, 0]` | a turn is a reading of one window, and how often a later window happened to quote it says nothing about whether the turn is still worth holding |
 * | `procedural` | `[createdAt, 0]` | same as `episodic`, and stated rather than defaulted so the table has no silent member |
 *
 * A single rule with a `type === 'semantic'` guard would have produced the same behaviour and a worse
 * artefact: the other two members would have become a comment, and a fourth member added to the union would
 * fall through to whatever the guard's `else` happened to do. `Record<MemoryType, …>` makes that a compile
 * error here.
 *
 * ## Why the second element is not `value`
 *
 * `MemoryValue.value` is the field the domain names for "estimated future utility", so it is the obvious
 * place to put a use count and it is the wrong one — see `MemoryValue.reads` for the full account. Short
 * version: `value` is `[0, 1]` by contract and computed by an admission gate these entries never pass.
 *
 * ## Why recency dominates the count
 *
 * An entry quoted forty times an hour ago loses to one quoted once a second ago. The other order would make
 * a corpus that was read in a burst immortal, and the bound would stop bounding — which is the one property
 * the prompt's `UPDATES:` block has to have.
 */

import type { MemoryType, MemoryValue } from './memory.js';

/** What a type says about keeping an entry. Larger is retained longer; the store drops the smallest. */
type RetentionRule = (memory: MemoryValue) => readonly [number, number];

const RETENTION: Record<MemoryType, RetentionRule> = {
  semantic: (memory) => [memory.lastAccessedAt, memory.reads],
  episodic: (memory) => [memory.createdAt, 0],
  procedural: (memory) => [memory.createdAt, 0],
};

/**
 * The pair the store's eviction compares, for one entry.
 *
 * Lexicographic, and the caller keeps the **largest**. Returned as a tuple rather than as one collated
 * number because the two elements are different quantities on different scales — a stamp in epoch
 * milliseconds and a count of windows — and packing them into one float would be an arithmetic whose
 * precision nobody stated.
 *
 * Not exported: the ranking and the choice it feeds are one decision, and a caller that could compare two
 * ranks itself would be a second eviction rule. The export boundary is {@link leastRetained}.
 */
function retentionRank(memory: MemoryValue): readonly [number, number] {
  return RETENTION[memory.type](memory);
}

/**
 * The index of the entry the store gives up, or `0` for a list of fewer than two.
 *
 * Lexicographic on {@link retentionRank}, **largest is retained**, ties going to the earlier index. The
 * tie-break direction is a decision rather than an accident: two entries that rank identically are two
 * entries the rule has no opinion about, and dropping the one that has been held longest is the only choice
 * that keeps the store's own history ordered.
 *
 * Returning an index rather than the entry keeps the caller's `splice` and its `dropped` counter in one
 * place, which is also why the empty case returns `0` rather than `-1`: the contract is that the caller
 * only reaches this after establishing the list is over its bound, so a sentinel for "nothing to drop"
 * would turn the caller's mistake into a silent no-op — the failure class this repository has spent
 * several rounds deleting.
 */
export function leastRetained(entries: readonly MemoryValue[]): number {
  let victim = 0;
  for (let index = 1; index < entries.length; index += 1) {
    const candidate = retentionRank(entries[index]!);
    const held = retentionRank(entries[victim]!);
    const loses = candidate[0] < held[0] || (candidate[0] === held[0] && candidate[1] < held[1]);
    if (loses) victim = index;
  }
  return victim;
}
