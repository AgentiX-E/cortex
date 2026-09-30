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
  };
}
