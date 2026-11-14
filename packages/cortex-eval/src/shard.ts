/**
 * The population splitter: one dispatch, many jobs, each answering a disjoint part of one population.
 *
 * ## Why this exists
 *
 * `S12` is registered on 500 corpora asked twice, four repetitions, both sides -- 8,000 graded
 * question-runs. Measured on run `43590434060`, that population needs **2 h 09 m at four workers**,
 * and run `43609290786` showed the wall clock is not a function of the worker count: the same
 * population at **thirty-two** workers took the same two hours. The time is spent computing -- the
 * relevance index over ~493 K characters per corpus, the window render, the per-window supersede
 * scan -- and `Promise.all` overlaps waiting, not arithmetic. One Node process uses one core, so
 * the only lever that moves the wall clock is **more processes**.
 *
 * A job's steps are serial; its processes are not. So the shape that fits is one job per shard, and
 * the shards are this module's job.
 *
 * ## Why the split is by position in the corpus population
 *
 * The population `S13` names asks one corpus twice, and `Question.corpus` requires both windows to
 * be answered by **one instance on one store** (`benchmark.ts`'s `claimRun` claims a whole corpus
 * atomically). A split taken after the multiplication would put `#w1` on one machine and `#w2` on
 * another: the first window would absorb an update into a store the second never reads, and the
 * reach would be zero for a reason that is not about the semantic layer. So this runs **between**
 * `capability` and `windows` -- the corpus population is cut, then each piece is multiplied.
 *
 * `dataset.questions` at that point is the sampled, capability-restricted corpus list, so position
 * is a stable function of (file, `LIMIT`, `CORTEX_CAPABILITY`) -- the same three inputs every shard
 * of one dispatch receives. `shard i of N` therefore means the same thing in all N jobs, and the
 * merge's `n` is the population's `n` rather than the sum of N guesses.
 *
 * ## Why the two variables are read together
 *
 * An index without a count cannot know how much of the population it owns, and a count without an
 * index is N jobs all taking shard 0: the artifacts look complete, the merged `n` is right, and
 * `(N-1)/N` of the population was never asked. Both are refused rather than defaulted, and the two
 * messages say which variable is missing so the repair is one line.
 *
 * ## Why `shards === 1` returns its argument rather than a copy
 *
 * Same rule `withWindows` follows: every archived artifact predates this file, and an unsharded run
 * must remain byte-identical to the run that produced it. A copy with the same contents would still
 * be a second code path through the dataset, and a copy also drops the `toBe` a caller can assert.
 */

import type { BenchmarkDataset } from './types.js';

/** The index a job answers. Module-local for the reason `capability-filter.ts` gives for its own. */
const SHARD_VARIABLE = 'CORTEX_SHARD';

/** How many jobs the dispatch was split into. */
const SHARDS_VARIABLE = 'CORTEX_SHARDS';

/**
 * Which part of the population one job answers, or `undefined` when the dispatch was not split.
 *
 * Not exported as a type: the two functions below are its only consumers in this package, and an
 * exported name with no importer is an orphan by the census's own rule.
 */
type ShardPartition = { readonly shard: number; readonly shards: number };

/**
 * A whole number, or a refusal that names the variable.
 *
 * `Number.parseInt` would accept `16abc` and `1e3`; the digits-only test is what makes `CORTEX_SHARDS=16`
 * and `CORTEX_SHARDS=sixteen` differ, and the second is a dispatch that must not start because the
 * alternative is a job whose share is a guess.
 */
function readWhole(raw: string, variable: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `${variable} must be a whole number: got ${JSON.stringify(raw)}. A dispatch that leaves this ` +
        'to interpretation produces a job whose share of the population is a guess, and a guess ' +
        "that is too large silently re-answers another job's questions.",
    );
  }
  return Number(raw);
}

/**
 * The partition this job answers, or `undefined` when it answers the whole population.
 *
 * Absent on both variables is the unsharded dispatch. One absent is refused: see this module's
 * header on why a count without an index and an index without a count are different failures and
 * both silent.
 */
export function readShardPartition(
  rawShard: string | undefined,
  rawShards: string | undefined,
): ShardPartition | undefined {
  const shard = (rawShard ?? '').trim();
  const shards = (rawShards ?? '').trim();
  if (shard === '' && shards === '') return undefined;
  if (shard === '') {
    throw new Error(
      `${SHARDS_VARIABLE}=${shards} was set without ${SHARD_VARIABLE}, so every job in this ` +
        'dispatch would answer the same shard. The artifact set would look complete and fifteen ' +
        'sixteenths of the population would never be asked; the matrix that expands a shard count ' +
        'sets both, so a dispatch carrying one is a dispatch that built the matrix by hand.',
    );
  }
  if (shards === '') {
    throw new Error(
      `${SHARD_VARIABLE}=${shard} was set without ${SHARDS_VARIABLE}, so this job cannot know how ` +
        'much of the population it owns. Read as "the first of one" it would answer everything, and ' +
        "the bill would be the whole dispatch repeated for every shard while each job's own " +
        'report looked correct.',
    );
  }
  const index = readWhole(shard, SHARD_VARIABLE);
  const total = readWhole(shards, SHARDS_VARIABLE);
  if (total < 1) {
    throw new Error(
      `${SHARDS_VARIABLE}=${shards} must divide the population into at least one part, and zero ` +
        'parts means no job owns any question. One is the unsharded dispatch; omit both variables ' +
        'for it.',
    );
  }
  if (index >= total) {
    throw new Error(
      `${SHARD_VARIABLE}=${index} lies outside ${SHARDS_VARIABLE}=${total}: the indices are zero ` +
        'based, so the last one is ' +
        `${total - 1}. A job one past the end answers nothing and spends its setup producing an ` +
        'empty artifact.',
    );
  }
  return { shard: index, shards: total };
}

/**
 * The questions this shard owns, in their original order and with their corpus intact.
 *
 * Refuses a dataset that already carries `corpus` values: that is the post-multiplication
 * population, and splitting it would cut a corpus across two stores. Refuses a shard that would
 * grade nothing, because an empty artifact is indistinguishable from a job that died before its
 * first answer, and the repair for both is a smaller `CORTEX_SHARDS`.
 */
export function shardDataset(
  dataset: BenchmarkDataset,
  partition: ShardPartition,
): BenchmarkDataset {
  const { shard, shards } = partition;
  if (!Number.isInteger(shards) || shards < 1) {
    throw new Error(
      `shardDataset received shards=${String(shards)}, which is not a positive whole number. The ` +
        'harness reads this through `readShardPartition`, which refuses the same range; a caller ' +
        'reaching this line with it bypassed the reader.',
    );
  }
  if (!Number.isInteger(shard) || shard < 0 || shard >= shards) {
    throw new Error(
      `shardDataset received shard=${String(shard)} for shards=${String(shards)}, which is not a ` +
        'whole number inside the zero-based range. A fractional index would own a fraction of a ' +
        'corpus, and a job one past the end answers nothing.',
    );
  }
  // The identity, not a copy. See this module's header.
  if (shards === 1) return dataset;
  const multiplied = dataset.questions.find((question) => question.corpus !== undefined);
  if (multiplied !== undefined) {
    throw new Error(
      `the dataset carries corpus ${JSON.stringify(multiplied.corpus)} on question ` +
        `${JSON.stringify(multiplied.id)}, so the window multiplication has already run over it. ` +
        'Sharding a multiplied population puts the two windows of one corpus in two jobs, which ' +
        'breaks the contiguous-on-one-instance contract Question.corpus states -- the carry would ' +
        'be written on one machine and read on another. Compose as limit, capability, shard, ' +
        'windows.',
    );
  }
  const owned = dataset.questions.filter((_, position) => position % shards === shard);
  if (owned.length === 0) {
    throw new Error(
      `shard ${shard} of ${shards} owns none of ${dataset.questions.length} corpora, so this job ` +
        'would grade nothing. An empty shard means the count exceeds the population; the repair is ' +
        'a smaller ' +
        `${SHARDS_VARIABLE}, because an artifact with no questions is indistinguishable from a job ` +
        'that died before its first answer.',
    );
  }
  return { name: dataset.name, questions: owned };
}
