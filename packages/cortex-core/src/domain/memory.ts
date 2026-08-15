/** Core domain types for Cortex memory entries. */

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
  /** FSRS-style stability (higher = more durable). */
  stability: number;
  /** FSRS-style difficulty in [1, 10]. */
  difficulty: number;
};

export function createMemory(
  partial: Partial<MemoryValue> & Pick<MemoryValue, 'content'>,
): MemoryValue {
  const now = Date.now();
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
    stability: partial.stability ?? 1,
    difficulty: partial.difficulty ?? 5,
  };
}
