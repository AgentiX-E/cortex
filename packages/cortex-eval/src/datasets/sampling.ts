/**
 * Stratified sampling for LongMemEval instances. Naive `slice(0, limit)` biases
 * the sample toward the first capability in the file (single-session-user/IE),
 * so abstention and multi-session questions never appear in small smoke runs.
 * This module round-robins across capability buckets to keep every capability
 * represented.
 */
import { toCapability, type LongMemEvalInstance } from './longmemeval-loader.js';

/** Sample up to `limit` instances, round-robining across capability buckets. */
export function sampleInstances(
  instances: readonly LongMemEvalInstance[],
  limit: number,
): LongMemEvalInstance[] {
  if (limit <= 0 || limit >= instances.length) {
    return [...instances];
  }
  const buckets = new Map<string, LongMemEvalInstance[]>();
  for (const inst of instances) {
    const capability = toCapability(inst.question_id, inst.question_type);
    const bucket = buckets.get(capability) ?? [];
    bucket.push(inst);
    buckets.set(capability, bucket);
  }
  const keys = [...buckets.keys()];
  const result: LongMemEvalInstance[] = [];
  let cursor = 0;
  // `limit < instances.length` guarantees a non-empty bucket is always
  // reachable, so this loop terminates without an explicit exhaustion guard.
  while (result.length < limit) {
    const key = keys[cursor % keys.length]!;
    const next = buckets.get(key)!.shift();
    if (next) {
      result.push(next);
    }
    cursor++;
  }
  return result;
}
