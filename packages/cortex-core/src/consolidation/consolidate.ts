/**
 * Asynchronous consolidation: retrieval-as-consolidation (Hebbian + FSRS).
 * Runs in a background worker; this module contains the pure, side-effect-free
 * orchestration logic shared by Node and browser workers.
 *
 * Scope note: this implements FSRS state updates, co-activation edge
 * strengthening, and threshold-based forgetting. It does not perform
 * optimal-transport distillation (see `math/ot.ts`, which is exported but not
 * yet wired here) and it does not implement TD(lambda) credit assignment.
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
 *
 * `forgettingThreshold` is a retrievability, so it lives in [0, 1] and `0.01`
 * means "forget after roughly 4.6 stable intervals without an access". That
 * default was unreachable while stability was measured in milliseconds — a
 * constant of `1` meant the 4.6 intervals elapsed in 4.6 ms, so a store that
 * consolidated once was empty. The threshold was never the problem: the unit it
 * was compared against was. See `math/fsrs.ts`.
 */
export function consolidate(
  memories: Map<string, MemoryValue>,
  graph: MemoryGraph,
  accesses: readonly AccessRecord[],
  options: {
    /**
     * Retrievability below which a memory is forgotten. Defaults to `0.01`, i.e.
     * `exp(-4.6)` stable intervals since the last access.
     */
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
    // Measured against the access's own timestamp, not against `now`. A live
    // caller replays a batch of accesses, and some of them are older than the
    // batch; using `now` would credit them with decay they had already suffered.
    // With the default state the two clocks agree (both give `exp(0)`), so this
    // only diverges once stability has moved — which is exactly when it matters.
    const r = retrievability(access.at - mem.lastAccessedAt, state.stability);
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
