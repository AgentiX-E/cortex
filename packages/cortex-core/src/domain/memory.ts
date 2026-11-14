/** Core domain types for Cortex memory entries. */
import { initialFsrsState } from '../math/fsrs.js';

export type MemoryType = 'episodic' | 'semantic' | 'procedural';

export type MemoryValue = {
  /** Stable identifier (surrogate key). */
  id: string;
  /** Human-readable content. */
  content: string;
  /** Estimated future utility in [0, 1]; higher means more valuable to retain. */
  value: number;
  /** Confidence in the memory's truth in [0, 1]. */
  confidence: number;
  /** Origin of the memory, used for provenance and poisoning defense. */
  source: string;
  /** Source trust score in [0, 1]. */
  sourceTrust: number;
  type: MemoryType;
  /** Tags for retrieval filtering. */
  tags: string[];
  /** Epoch milliseconds when the memory was first recorded. */
  createdAt: number;
  /** Epoch milliseconds of the last access; drives forgetting-curve decay. */
  lastAccessedAt: number;
  /**
   * FSRS-style stability in **days** (higher = more durable): the interval at
   * which the memory decays to 1/e of its retrievability. Defaults to one day.
   *
   * The unit is stated because the default used to be `1` with the interval
   * evaluated in milliseconds, which made a new memory expire five milliseconds
   * after it was written and caused `consolidate` to delete the whole store. See
   * `math/fsrs.ts` for the full account.
   */
  stability: number;
  /** FSRS-style difficulty in [1, 10]. */
  difficulty: number;
  /**
   * How many read-backs have carried this memory, as observed by whoever holds it.
   *
   * ## Why this is a field rather than an argument
   *
   * It is the tie-break in `domain/retention.ts`'s rank, and the clock in this domain is injected and
   * fixed: every entry in one store carries the same `lastAccessedAt` whether or not it was ever read, so
   * a rank on the stamp alone orders nothing. This count is what distinguishes a statement the store has
   * used from one no window has quoted yet.
   *
   * It used to be a second parameter to `leastRetained`, passed as `{ memory, reads }`. That signature was
   * the tell: a ranking that needs an input the domain cannot express is a ranking the domain cannot
   * describe, and the argument belonged to nobody. As a field, the count a rule reads is the count that
   * was written on the entry.
   *
   * ## Why not `value`
   *
   * `value` is "estimated future utility" on a stated `[0, 1]` scale, computed by an admission gate from a
   * caller-supplied `valueFunction`. A use count is unbounded, **observed** rather than estimated, and
   * never passes that gate. Two scales sharing one field is the defect `math/fsrs.ts` repaired in the time
   * domain — and the repair there was to stop sharing a literal, not to add a second meaning to one.
   *
   * ## Why it starts at zero and is mutable
   *
   * A read is an event that happens after the write, so zero is the only honest initial value: an entry
   * cannot have been carried before it existed. It is mutable because a read moves it exactly as a read
   * moves `lastAccessedAt`, and `consolidate` already mutates the FSRS fields in place.
   */
  reads: number;
};

export function createMemory(
  partial: Partial<MemoryValue> & Pick<MemoryValue, 'content'>,
): MemoryValue {
  const now = Date.now();
  const fsrs = initialFsrsState();
  return {
    id: partial.id ?? crypto.randomUUID(),
    content: partial.content,
    value: partial.value ?? 0.5,
    confidence: partial.confidence ?? 1,
    source: partial.source ?? 'unknown',
    sourceTrust: partial.sourceTrust ?? 0.5,
    type: partial.type ?? 'episodic',
    tags: partial.tags ?? [],
    createdAt: partial.createdAt ?? now,
    lastAccessedAt: partial.lastAccessedAt ?? now,
    // Derived, not restated. The default was a bare `1` here and a bare `1` in
    // `initialFsrsState()`; two literals that had to agree and did, in the wrong
    // unit. Reading the initial state removes the second place to be wrong.
    stability: partial.stability ?? fsrs.stability,
    difficulty: partial.difficulty ?? fsrs.difficulty,
    // Not derived from anything: a memory that has just been created has been read back zero times.
    reads: partial.reads ?? 0,
  };
}
