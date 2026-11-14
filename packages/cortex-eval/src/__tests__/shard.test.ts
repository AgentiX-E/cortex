import { describe, expect, it } from 'vitest';

import { readShardPartition, shardDataset } from '../shard.js';
import type { BenchmarkDataset, Question } from '../types.js';

function question(id: string): Question {
  return {
    id,
    capability: 'KU',
    questionType: 'knowledge-update',
    question: `question ${id}`,
    expected: 'a',
    context: ['turn one', 'turn two'],
    sessions: [['turn one'], ['turn two']],
    questionDate: '2024/03/01',
    goldTurns: ['turn one'],
  };
}

function dataset(ids: readonly string[]): BenchmarkDataset {
  return { name: 'fixture', questions: ids.map(question) };
}

const SIX = dataset(['q0', 'q1', 'q2', 'q3', 'q4', 'q5']);

describe('readShardPartition', () => {
  it('treats two absent variables as one shard, which is the whole population', () => {
    // The state every archived artifact was produced in. Blank is the same state as unset for the
    // reason `readWindowCount` gives: a workflow that passes an empty input still dispatches.
    expect(readShardPartition(undefined, undefined)).toBeUndefined();
    expect(readShardPartition('', '')).toBeUndefined();
    expect(readShardPartition('  ', '  ')).toBeUndefined();
  });

  it('reads a partition inside its own range', () => {
    expect(readShardPartition('0', '16')).toEqual({ shard: 0, shards: 16 });
    expect(readShardPartition('15', '16')).toEqual({ shard: 15, shards: 16 });
  });

  it('reads an explicit single shard as the identity rather than as a special case', () => {
    // `0/1` has to survive: it is what a matrix of one expands to, and refusing it would make the
    // sharded path untested by every run that does not need it.
    expect(readShardPartition('0', '1')).toEqual({ shard: 0, shards: 1 });
  });

  it('refuses a shard index with no count, because it cannot know how much of the population it owns', () => {
    // The failure this prevents is silent rather than loud: an index with no total reads as "the
    // first of one", every job answers every question, and the bill is `shards` times the estimate
    // while each job's own report looks correct.
    expect(() => readShardPartition('3', undefined)).toThrow(/CORTEX_SHARDS/);
    expect(() => readShardPartition('3', '')).toThrow(/CORTEX_SHARDS/);
  });

  it('refuses a count with no index, because every job would answer the same shard', () => {
    // Sixteen jobs all taking shard 0 is one shard executed sixteen times: the artifact set looks
    // complete, the merged `n` is right, and fifteen sixteenths of the population was never asked.
    // Asserted on the sentence rather than on the variable name: `CORTEX_SHARD must be a whole
    // number: got ""` also names the variable, and it would be the message of a reader that had no
    // idea the count was the thing that was set.
    expect(() => readShardPartition(undefined, '16')).toThrow(/was set without CORTEX_SHARD/);
    expect(() => readShardPartition('', '16')).toThrow(/was set without CORTEX_SHARD/);
  });

  it('refuses an index outside the range it declares', () => {
    // `shard=16, shards=16` is the one-past-the-end mistake a zero-based index invites, and it
    // answers nothing -- which is a job that spends its setup and produces an empty artifact.
    expect(() => readShardPartition('16', '16')).toThrow(/outside/);
    expect(() => readShardPartition('99', '16')).toThrow(/outside/);
  });

  it('refuses a count below one', () => {
    expect(() => readShardPartition('0', '0')).toThrow(/at least one|positive/);
  });

  it('refuses values that are not whole numbers rather than rounding them', () => {
    // Same rule as `readWindowCount`: `1 ` trims, `one`, `1.5` and `-1` do not survive. A clamped
    // or rounded index produces a job that grades a shard no other job skips.
    expect(() => readShardPartition('one', '16')).toThrow(/whole number/);
    expect(() => readShardPartition('1.5', '16')).toThrow(/whole number/);
    expect(() => readShardPartition('-1', '16')).toThrow(/whole number/);
    expect(() => readShardPartition('0', 'sixteen')).toThrow(/whole number/);
  });
});

describe('shardDataset', () => {
  it('returns its argument for one shard, because that run must stay byte-identical', () => {
    expect(shardDataset(SIX, { shard: 0, shards: 1 })).toBe(SIX);
  });

  it('partitions by position, so the union is the population and the parts are disjoint', () => {
    const parts = [0, 1, 2].map((shard) => shardDataset(SIX, { shard, shards: 3 }));
    const ids = parts.map((part) => part.questions.map((row) => row.id));
    expect(ids).toEqual([
      ['q0', 'q3'],
      ['q1', 'q4'],
      ['q2', 'q5'],
    ]);
    // Asserted as a property and not only as the literal above: the literal is one population's
    // answer, and the property is what makes the merge's `n` the population's `n`.
    expect(new Set(ids.flat()).size).toBe(SIX.questions.length);
    expect(ids.flat().sort()).toEqual(SIX.questions.map((row) => row.id).sort());
  });

  it('keeps a corpus whole, which is the whole point of sharding here rather than there', () => {
    // The population this exists for asks one corpus twice (`Question.corpus`), and the contract is
    // that both windows are answered by one instance. A shard taken after the multiplication would
    // split a corpus across two jobs -- the carry would be written on one machine and read on
    // another, and the reach would be zero for a reason that has nothing to do with the layer.
    const twoWindow = shardDataset(SIX, { shard: 1, shards: 2 });
    expect(twoWindow.questions.map((row) => row.id)).toEqual(['q1', 'q3', 'q5']);
  });

  it('refuses a population that was already multiplied by windows', () => {
    // The order is `limit` then `capability` then `shard` then `windows`. A dataset carrying
    // `corpus` is one the multiplication has already been applied to, and sharding it would cut a
    // corpus in half -- so this refuses instead of producing the split it cannot detect later.
    const multiplied: BenchmarkDataset = {
      name: 'fixture',
      questions: [
        { ...question('q0'), id: 'q0#w1', corpus: 'q0' },
        { ...question('q0'), id: 'q0#w2', corpus: 'q0' },
      ],
    };
    expect(() => shardDataset(multiplied, { shard: 0, shards: 2 })).toThrow(/corpus/);
  });

  it('refuses a shard that would grade nothing', () => {
    // A count larger than the population leaves trailing shards empty, and an empty shard is an
    // artifact with `questionCount: 0` that a merge cannot tell from a job that died before its
    // first answer. The repair is a smaller count, so it is refused with that sentence.
    expect(() => shardDataset(SIX, { shard: 7, shards: 8 })).toThrow(/empty|nothing/);
  });

  it('refuses a partition that is not a partition', () => {
    // `shardDataset` is exported and callable without `readShardPartition`, which is what the
    // merge tool and any future caller do; the same range check therefore lives here too. The
    // negative index is its own case: `readShardPartition` refuses `-1` at the digits test, so a
    // caller that typed the number in code rather than in a workflow is the only one who can reach
    // this branch -- and `questions[-1]` would be `undefined` rather than a question.
    expect(() => shardDataset(SIX, { shard: 3, shards: 3 })).toThrow(/zero-based range/);
    expect(() => shardDataset(SIX, { shard: -1, shards: 3 })).toThrow(/zero-based range/);
    expect(() => shardDataset(SIX, { shard: 0, shards: 0 })).toThrow(/at least one|positive/);
    expect(() => shardDataset(SIX, { shard: 0.5, shards: 2 })).toThrow(/whole number/);
  });
});
