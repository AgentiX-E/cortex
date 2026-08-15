/**
 * Asynchronous consolidation: retrieval-as-consolidation (Hebbian + FSRS) plus
 * cross-layer distillation. Runs in a background worker; this module contains the
 * pure, side-effect-free orchestration logic shared by Node and browser workers.
 */
import type { MemoryValue } from '../domain/memory.js';
import type { MemoryGraph } from '../graph/memory-graph.js';
import { review, retrievability, type FsrsState } from '../math/fsrs.js';

export type ConsolidationStats = {
  strengthened: number;
  decayedEdges: number;
  forgotten: number;
};

export type AccessRecord = {
  memoryId: string;
  outcome: 'success' | 'failure';
  coactiveWith?: string[];
  at: number;
};

/**
 * Apply one batch of access records: update FSRS stability/difficulty for each
 * memory, strengthen graph edges among co-activated memories, and drop memories
 * whose retrievability has fallen below a forgetting threshold.
 */
export function consolidate(
  memories: Map<string, MemoryValue>,
  graph: MemoryGraph,
  accesses: readonly AccessRecord[],
  options: {
    forgettingThreshold?: number;
    decay?: boolean;
  } = {},
): ConsolidationStats {
  const forgettingThreshold = options.forgettingThreshold ?? 0.01;
  const now = Date.now();
  let strengthened = 0;
  let forgotten = 0;

  for (const access of accesses) {
    const mem = memories.get(access.memoryId);
    if (!mem) {
      continue;
    }
    const state: FsrsState = { stability: mem.stability, difficulty: mem.difficulty };
    const r = retrievability(now - mem.lastAccessedAt, state.stability);
    const next = review(state, access.outcome, r);
    mem.stability = next.stability;
    mem.difficulty = next.difficulty;
    mem.lastAccessedAt = access.at;
    strengthened++;

    for (const other of access.coactiveWith ?? []) {
      graph.strengthen(access.memoryId, other, 'cooccurrence', access.at);
    }
  }

  // Forgetting: drop memories whose retrievability is below the threshold.
  for (const [id, mem] of memories) {
    const r = retrievability(now - mem.lastAccessedAt, mem.stability);
    if (r < forgettingThreshold) {
      memories.delete(id);
      forgotten++;
    }
  }

  const decayedEdges = options.decay === false ? 0 : graph.decay(now);

  return { strengthened, decayedEdges, forgotten };
}
