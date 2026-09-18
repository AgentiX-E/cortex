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

/** How many of `requiredIds` appear in `sample`, and which are missing. */
export type CohortCoverage = {
  /** Present in the sample, in the order they appear in `requiredIds`. */
  present: string[];
  /** Absent from the sample, in the order they appear in `requiredIds`. */
  missing: string[];
  /** `present.length / requiredIds.length`, or 1 when nothing was required. */
  ratio: number;
};

/**
 * Measure how much of a named cohort a sample contains.
 *
 * The round-robin sampler is proportional, not guaranteed: a cohort whose
 * members sit in buckets that the cursor reaches late can be entirely absent
 * from a small sample even though the cohort is small. A pre-registered
 * prediction that names specific questions therefore cannot assume it will see
 * them, and the failure is silent — the prediction is scored against the
 * questions that happen to be present, so a cohort of six can score a
 * vacuous 1/1 and read as a pass.
 *
 * Measured on LongMemEval-S: at `limit=60` the seven conjunctive ABS questions
 * reduce to one, at `limit=200` to all seven. The sampler was never wrong; the
 * caller was silent about what it needed.
 */
export function cohortCoverage(
  sample: readonly LongMemEvalInstance[],
  requiredIds: readonly string[],
): CohortCoverage {
  const presentIds = new Set(sample.map((inst) => inst.question_id));
  const present: string[] = [];
  const missing: string[] = [];
  for (const id of requiredIds) {
    if (presentIds.has(id)) {
      present.push(id);
    } else {
      missing.push(id);
    }
  }
  return {
    present,
    missing,
    ratio: requiredIds.length === 0 ? 1 : present.length / requiredIds.length,
  };
}
