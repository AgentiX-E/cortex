/**
 * A census is only a census if its denominator is the run's denominator.
 *
 * ## The defect these tests were written from
 *
 * §14.22 gave the ablation a worker pool, and a pool hands **each worker its own instance** -- that is
 * the whole reason it exists, because a `MemorySystem` carries per-question state in single slots. Every
 * census in the arm (`abstentionReasons`, `recoveryCensus`, `bareRetryCensus`, `voteCounts`) is
 * per-**instance** state, and the arm read it from **one** instance: the `feature` it was handed, which
 * under a pool is worker 0.
 *
 * So a four-worker run published a census covering a quarter of its questions. `41773546221` reported
 * `llm=28, answered=460` against 2,000 question-answers -- 488, which is 122 per pass, which is what
 * worker 0 claims out of 500 at four workers. The registered arm's artifact sums to exactly 2,000
 * because that run predates the pool and its log line still ends at `maxPromptChars=48000` with no
 * `workers=` field at all.
 *
 * **The number looked plausible, which is why it needed an audit rather than a reader.** An abstention
 * rate computed against a truncated numerator is not "slightly low": it is wrong by the worker count,
 * and it is comparable with no other run in the campaign.
 *
 * ## What the contract is
 *
 * The census must cover **every instance that answered a question in this run**, and it must be absent
 * rather than partial when any of them cannot report. Absence is already this repository's answer for a
 * capability that is not there; a sum over a subset is the shape that produced the defect, so it cannot
 * also be the shape of the repair.
 */
import { describe, expect, it } from 'vitest';

import { runCortexMemoryArm } from '../bench-memory-arm.js';
import { createAblationPool } from '../ablation.js';
import { exactMatchScorer } from '../metrics.js';
import { DEFAULT_RELEVANCE_TOP_K } from '../relevance-index.js';

import type { MemoryArmConfig } from '../report.js';
import type { Answer, BenchmarkDataset, MemorySystem } from '../types.js';

const GATE: MemoryArmConfig = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: null,
  sourceTrust: 0.5,
  confidenceSignal: 'none',
  promptContract: 'abstention',
  relevanceSignal: 'none',
  relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
};

/**
 * A system whose census is per-instance, which is what the product's is.
 *
 * `#reasons` in `CortexMemory` is an instance field incremented by the answering path, so a test double
 * that returned a **shared** object would pass under the defect: the shared object would accumulate
 * across workers and the sum would be right by accident. Every instance here owns its counters.
 */
class CountingSystem implements MemorySystem {
  readonly name: string;
  #answered = 0;
  #declined = 0;

  constructor(name: string) {
    this.name = name;
  }

  async answer(): Promise<Answer> {
    this.#answered += 1;
    return 'one';
  }

  abstentionReasons(): { empty: number; threshold: number; llm: number; answered: number } {
    return { empty: 0, threshold: 0, llm: this.#declined, answered: this.#answered };
  }
}

/** A system with no census at all, for the mixed-pool rule. */
function bareSystem(name: string): MemorySystem {
  return { name, answer: () => 'one' };
}

function dataset(questions: number): BenchmarkDataset {
  return {
    name: 'fixture',
    questions: Array.from({ length: questions }, (_, index) => ({
      id: `q${index}`,
      capability: 'IE',
      question: `Question ${index}?`,
      expected: 'one',
      context: [],
    })),
  };
}

function armRun(questions: number, runs: number, pool: ReturnType<typeof createAblationPool>) {
  // Worker 0's instance is the one the arm is handed, exactly as the CLI does it: the pool is
  // built from `first`, and `first.feature` is the object `runCortexMemoryArm` receives. A test
  // that handed the arm a *different* instance would be testing the guard below, not the sum.
  return runCortexMemoryArm(
    dataset(questions),
    bareSystem('reference-pipeline'),
    pool.featureInstances()[0]!,
    {
      runs,
      scorer: exactMatchScorer,
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: { ...GATE },
      pool,
    },
  );
}

describe('the pool does not shrink the census denominator', () => {
  it('sums the abstention census over every worker instance', async () => {
    // Nine questions, two passes, three workers: eighteen answers, and the census has to say so.
    // Under the defect it says six -- worker 0's share -- and every rate derived from it is a
    // quarter of the truth. This is the assertion the whole file exists for.
    const pool = createAblationPool({
      workers: 3,
      first: { baseline: bareSystem('reference-pipeline'), feature: new CountingSystem('f0') },
      baselineFor: () => bareSystem('reference-pipeline'),
      featureFor: (worker) => new CountingSystem(`f${worker}`),
    });

    const result = await armRun(9, 2, pool);

    expect(result.abstentionReasons).toEqual({ empty: 0, threshold: 0, llm: 0, answered: 18 });
  });

  it('sums the abstention census on the serial path without any pool', async () => {
    // The control. Every archived artifact up to §14.22 was produced here, and the fix must not move
    // this number by even one: a repair that changes the serial reading would invalidate the
    // registration it is meant to make quotable.
    const result = await runCortexMemoryArm(
      dataset(5),
      bareSystem('reference-pipeline'),
      new CountingSystem('cortex-memory'),
      {
        runs: 2,
        scorer: exactMatchScorer,
        generatedAt: '1970-01-01T00:00:00.000Z',
        memoryArmConfig: { ...GATE },
      },
    );

    expect(result.abstentionReasons).toEqual({ empty: 0, threshold: 0, llm: 0, answered: 10 });
  });

  it('omits the census rather than summing the instances that happened to have one', async () => {
    // The rule that makes the defect impossible rather than merely fixed. A pool whose instances
    // disagree about the capability produces a **truncated** sum, and a truncated sum is precisely
    // what `census-unit` caught in the wild. Absence says "not measured"; a partial sum says a lie
    // in the same shape as a measurement.
    const pool = createAblationPool({
      workers: 2,
      first: { baseline: bareSystem('reference-pipeline'), feature: new CountingSystem('f0') },
      baselineFor: () => bareSystem('reference-pipeline'),
      // Worker 1 has no census capability at all.
      featureFor: () => bareSystem('f1'),
    });

    const result = await armRun(4, 1, pool);

    expect(result.abstentionReasons).toBeUndefined();
    expect('abstentionReasons' in result).toBe(false);
  });

  it('refuses a pool that does not enumerate the instance it measured', async () => {
    // The mismatch this guard exists for is the shape the CLI used to have: a pool built from one
    // pair of factories while the arm was handed another object. Reading the pool alone silently
    // drops worker 0's share, reading `feature` alone reproduces the original defect, and both
    // produce a number a reader would believe -- so the arm stops instead of choosing.
    const pool = createAblationPool({
      workers: 2,
      first: { baseline: bareSystem('reference-pipeline'), feature: new CountingSystem('f0') },
      baselineFor: () => bareSystem('reference-pipeline'),
      featureFor: (worker) => new CountingSystem(`f${worker}`),
    });

    await expect(
      runCortexMemoryArm(
        dataset(2),
        bareSystem('reference-pipeline'),
        new CountingSystem('other'),
        {
          runs: 1,
          scorer: exactMatchScorer,
          generatedAt: '1970-01-01T00:00:00.000Z',
          memoryArmConfig: { ...GATE },
          pool,
        },
      ),
    ).rejects.toThrow(/does not enumerate the feature instance/);
  });

  it('sums vote verdicts across workers without discarding one that took no votes', async () => {
    // Rule two of the vote census -- three zeros is not a census -- belongs to the total, not to a
    // part. Under a pool a worker that drew no voting questions reports `0/0/0` legitimately, and a
    // reader applying the rule per instance would drop that worker's questions from the denominator
    // while still publishing a well-formed table.
    const voter = (
      name: string,
      counts: { unanimous: number; majority: number; split: number },
    ) => {
      const system = new CountingSystem(name) as unknown as {
        voteCounts: () => typeof counts;
      } & MemorySystem;
      system.voteCounts = () => counts;
      return system;
    };
    const pool = createAblationPool({
      workers: 2,
      first: {
        baseline: bareSystem('reference-pipeline'),
        feature: voter('f0', { unanimous: 2, majority: 1, split: 0 }),
      },
      baselineFor: () => bareSystem('reference-pipeline'),
      featureFor: () => voter('f1', { unanimous: 0, majority: 0, split: 0 }),
    });

    const result = await armRun(4, 1, pool);

    expect(result.report.memoryArmConfig?.voteCounts).toEqual({
      unanimous: 2,
      majority: 1,
      split: 0,
    });
  });

  it('reports no vote census when every worker reports three zeros', async () => {
    const silent = (name: string) => {
      const system = new CountingSystem(name) as unknown as {
        voteCounts: () => { unanimous: number; majority: number; split: number };
      } & MemorySystem;
      system.voteCounts = () => ({ unanimous: 0, majority: 0, split: 0 });
      return system;
    };
    const pool = createAblationPool({
      workers: 2,
      first: { baseline: bareSystem('reference-pipeline'), feature: silent('f0') },
      baselineFor: () => bareSystem('reference-pipeline'),
      featureFor: () => silent('f1'),
    });

    const result = await armRun(4, 1, pool);

    expect(result.report.memoryArmConfig?.voteCounts).toBeUndefined();
  });

  it('hands one instance per worker and the same one on every pass', async () => {
    // `BenchmarkWorkerPool.systemFor` documents "called at most `min(workers, questions)` times", and
    // the CLI's factory was `worker === 0 ? feature0 : buildFeature()` -- a **new instance per call**,
    // so worker 1 of pass 2 did not exist in the census of pass 1 and no reader could have found them
    // all. Memoising is what makes "every instance" an enumerable set rather than a hunt.
    const seen: MemorySystem[] = [];
    const serial = new CountingSystem('f0');
    const pool = createAblationPool({
      workers: 2,
      first: { baseline: bareSystem('reference-pipeline'), feature: serial },
      baselineFor: () => bareSystem('reference-pipeline'),
      featureFor: () => {
        const built = new CountingSystem('fresh');
        seen.push(built);
        return built;
      },
    });

    const first = pool.featureFor(1);
    const second = pool.featureFor(1);

    expect(second).toBe(first);
    expect(seen).toHaveLength(1);
    // Worker 0 is the serial instance, not a fifth one: a pool that rebuilt it would leave the
    // instance the arm actually measured out of the enumeration.
    expect(pool.featureInstances()).toEqual([serial, first]);
  });
});
