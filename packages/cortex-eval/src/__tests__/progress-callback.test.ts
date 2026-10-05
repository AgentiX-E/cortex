/**
 * The progress callback, and the reason it fires BEFORE a question is answered.
 *
 * Run `37281155088`'s `cortex-memory` arm spent about 52 minutes in the LLM and
 * then died on an HTTP 402 (the account's balance ran out). Its
 * `benchmark-error.log` carried a stack trace and nothing else -- no question,
 * no count, no indication of how far it had got. A 52-minute failure whose only
 * durable record is a stack trace is a failure that cannot be localised, and
 * localising it is the whole point: the next attempt would otherwise repeat the
 * spend up to an unknown point.
 *
 * The embedding path already keeps what it paid for on failure
 * (`run-ablation.ts` persists the cache from its `catch`). These tests are the
 * other half of that symmetry, at the layer where the question index exists.
 *
 * The tests use real minimal systems rather than mocks, for the reason the rest
 * of this suite does: a mock would let the callback record a call the code never
 * makes, which is the property under test.
 */
import { describe, it, expect } from 'vitest';
import { runBenchmark, evaluateWithScorer, evaluateWithScorerDetailed } from '../benchmark.js';
import { exactMatchScorer } from '../metrics.js';
import type { BenchmarkDataset, MemorySystem } from '../types.js';
import type { BenchmarkProgress } from '../benchmark.js';

const dataset: BenchmarkDataset = {
  name: 'progress',
  questions: [
    { id: 'p-1', capability: 'IE', question: 'Q1', expected: 'a', context: ['a'] },
    { id: 'p-2', capability: 'IE', question: 'Q2', expected: 'b', context: ['b'] },
    { id: 'p-3', capability: 'IE', question: 'Q3', expected: 'c', context: ['c'] },
    { id: 'p-4', capability: 'IE', question: 'Q4', expected: 'd', context: ['d'] },
  ],
};

/**
 * A real system that records the order in which its `answer` was entered.
 *
 * `throwOn` makes it fail on the 0-based question it is asked about, which is
 * how the failure-localisation property is tested without simulating a network
 * layer: the callback has to have fired for the question that threw.
 */
function recordingSystem(
  name: string,
  log: string[],
  throwOn?: number,
): MemorySystem & { calls: number } {
  const system = {
    name,
    calls: 0,
    answer: async (): Promise<string> => {
      const index = system.calls++;
      log.push(`answer:${index}`);
      if (throwOn !== undefined && index === throwOn) {
        throw new Error('LLM request failed: 402 Payment Required');
      }
      return 'x';
    },
  };
  return system;
}

describe('runBenchmark progress reporting', () => {
  it('fires once per question, before that question is answered', async () => {
    const log: string[] = [];
    const system = recordingSystem('s', log);
    await runBenchmark(dataset, system, (p) => log.push(`progress:${p.index}`));
    // The interleaving is the assertion. A callback that fired after the answer
    // would still produce four events, and would still pass a "was it called"
    // test -- while being unable to name the question a throw happened on.
    expect(log).toEqual([
      'progress:0',
      'answer:0',
      'progress:1',
      'answer:1',
      'progress:2',
      'answer:2',
      'progress:3',
      'answer:3',
    ]);
  });

  it('reports the question that threw, and does not report past it', async () => {
    const log: string[] = [];
    const system = recordingSystem('s', log, 2);
    await expect(
      runBenchmark(dataset, system, (p) => log.push(`progress:${p.index}`)),
    ).rejects.toThrow('402 Payment Required');
    // The regression this file exists for: question 2 is the one that died, so
    // it must be in the record. Question 3 was never started and must not be.
    expect(log).toContain('progress:2');
    expect(log).not.toContain('progress:3');
    // And the progress event for it must PRECEDE the answer call that threw.
    // This is the ordering a "did it fire" test cannot see: the recording system
    // logs its own entry before throwing, so `answer:2` is present either way --
    // only the index does the discriminating.
    expect(log.indexOf('progress:2')).toBeLessThan(log.indexOf('answer:2'));
  });

  it('carries the system name, a 0-based index, the total and the question id', async () => {
    const events: BenchmarkProgress[] = [];
    await runBenchmark(dataset, recordingSystem('cortex-memory', []), (p) => events.push(p));
    expect(events).toHaveLength(4);
    expect(events[0]).toEqual({
      system: 'cortex-memory',
      index: 0,
      total: 4,
      run: 0,
      questionId: 'p-1',
    });
    expect(events[3]).toEqual({
      system: 'cortex-memory',
      index: 3,
      total: 4,
      run: 0,
      questionId: 'p-4',
    });
  });

  it('is inert when no callback is supplied', async () => {
    // The backward-compatibility control: every existing caller passes two
    // arguments, so the absent-callback path is the one most of this suite
    // exercises. A required parameter here would have been a breaking change.
    const system = recordingSystem('s', []);
    const answers = await runBenchmark(dataset, system);
    expect(answers).toEqual(['x', 'x', 'x', 'x']);
  });
});

describe('the progress callback survives the evaluation wrappers', () => {
  it('reaches the caller through evaluateWithScorer', async () => {
    const events: BenchmarkProgress[] = [];
    await evaluateWithScorer(dataset, recordingSystem('s', []), exactMatchScorer, (p) =>
      events.push(p),
    );
    expect(events.map((e) => e.index)).toEqual([0, 1, 2, 3]);
    expect(events.every((e) => e.run === 0)).toBe(true);
  });

  it('reaches the caller through evaluateWithScorerDetailed, carrying the run ordinal', async () => {
    const events: BenchmarkProgress[] = [];
    await evaluateWithScorerDetailed(
      dataset,
      recordingSystem('s', []),
      exactMatchScorer,
      (p) => events.push(p),
      3,
    );
    // `run` is carried rather than derived: `runBenchmark` cannot know which
    // repetition it is serving, so the wrapper that does know has to say so.
    expect(events.map((e) => e.index)).toEqual([0, 1, 2, 3]);
    expect(events.every((e) => e.run === 3)).toBe(true);
  });
});
