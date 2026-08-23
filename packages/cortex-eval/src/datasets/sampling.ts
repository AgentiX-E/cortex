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
    const key = sampleBucketKey(inst);
    const bucket = buckets.get(key) ?? [];
    bucket.push(inst);
    buckets.set(key, bucket);
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

/**
 * A sampling bucket key that separates the `single-session-*` sub-types. The
 * plain capability key ("IE") lumps `single-session-user`, `-assistant`, and
 * `-preference` together, so a small round-robin sample takes the first
 * sub-type in file order and biases the estimate. Splitting IE by question type
 * keeps every sub-type represented.
 */
function sampleBucketKey(inst: LongMemEvalInstance): string {
  const capability = toCapability(inst.question_id, inst.question_type);
  if (capability === 'IE') {
    return `IE:${inst.question_type}`;
  }
  return capability;
}
