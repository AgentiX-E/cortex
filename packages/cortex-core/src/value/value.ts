/**
 * Value-driven memory: decide whether to write and whether to retrieve/answer
 * using an estimated utility function rather than raw similarity. Abstention is
 * the act of refusing to retrieve or answer when no memory is reliable enough.
 */
import type { MemoryValue } from '../domain/memory.js';

export type ValueFunction = (memory: MemoryValue, queryContext?: string) => number;

/**
 * Default value function: a simple, interpretable combination of confidence,
 * source trust, and recency. Replaceable with a learned (MDP) utility function.
 */
export function defaultValueFunction(memory: MemoryValue, _queryContext?: string): number {
  const recencyWeight = Math.exp(
    -(Date.now() - memory.lastAccessedAt) / (1000 * 60 * 60 * 24 * 30),
  );
  return memory.confidence * memory.sourceTrust * (0.5 + 0.5 * recencyWeight);
}

export type WriteDecision = { write: boolean; value: number; reason: 'high-value' | 'low-value' };

/** Decide whether a candidate memory is worth writing, given a value threshold. */
export function decideWrite(
  memory: MemoryValue,
  valueFn: ValueFunction,
  threshold: number,
): WriteDecision {
  const value = clamp01(valueFn(memory));
  return value >= threshold
    ? { write: true, value, reason: 'high-value' }
    : { write: false, value, reason: 'low-value' };
}

export type RetrievalDecision =
  | { retrieve: true; confidence: number }
  | { retrieve: false; confidence: number; reason: 'below-threshold' };

/**
 * Decide whether to retrieve/answer. Returns `retrieve: false` (abstention) when
 * the best candidate utility is below the calibrated threshold.
 */
export function decideRetrieval(
  candidates: MemoryValue[],
  valueFn: ValueFunction,
  threshold: number,
  queryContext?: string,
): RetrievalDecision {
  let best = 0;
  for (const m of candidates) {
    best = Math.max(best, clamp01(valueFn(m, queryContext)));
  }
  const confidence = best;
  return confidence >= threshold
    ? { retrieve: true, confidence }
    : { retrieve: false, confidence, reason: 'below-threshold' };
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
