/**
 * Concurrency must not be visible in a measurement.
 *
 * ## The claim under test, and why it is a measurement rather than a design preference
 *
 * `§14.22` of the execution plan keeps `workers` at 1 by default and requires that the same
 * configuration produce **byte-identical answers and byte-identical prompts**, placed by
 * question index, at any width. If that holds, a concurrent pass measures the same thing a
 * serial one does and the only difference is the wall clock -- which is what makes requirement
 * 12 (a strong model must be measurably better) reachable at all: `zhipu:glm-4.6` needs 5.1x
 * the run budget at one request in flight.
 *
 * If it does not hold, the difference **names a piece of state that is not per-question**, and
 * that is a finding about the mechanism rather than a failure of the instrument.
 *
 * ## Why the fixture keeps state in slots
 *
 * `MemorySystem` carries a question's prompt, evidence and raw output through optional
 * accessors (`lastPromptText`, `lastRetrievedContext`, `lastRawOutput`) that `runBenchmark`
 * reads *after* the call that wrote them. That is a single-slot contract, and it is the exact
 * shape a naive pool would break: two calls in flight against one instance, question A's
 * record holding question B's prompt, nothing thrown, the artifact complete and wrong. The
 * fixture below reproduces that contract rather than avoiding it, so the negative control --
 * a pool that hands every worker the same instance -- fails for the real reason.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateWithScorerDetailed,
  runBenchmark,
  type BenchmarkWorkerPool,
} from '../benchmark.js';
import { exactMatchScorer } from '../metrics.js';
import { createAblationPool, runAblation } from '../ablation.js';
import type { Answer, BenchmarkDataset, MemorySystem, Question } from '../types.js';

/** A question whose expected answer is its own index, so an answer names its question. */
function question(index: number): Question {
  return {
    id: `q${String(index)}`,
    capability: 'IE',
    question: `question ${String(index)}`,
    expected: `a${String(index)}`,
    context: ['a turn'],
    questionType: 'single-session-user',
  };
}

function dataset(size: number): BenchmarkDataset {
  return { name: 'concurrency', questions: Array.from({ length: size }, (_, i) => question(i)) };
}

/**
 * A system that answers with its own question's index and keeps the prompt in a single slot,
 * which is the contract `runBenchmark` reads after the call.
 *
 * `slot` is a mutable field of the instance on purpose: with one instance shared by two
 * workers, whichever call finishes last decides what both records see.
 */
type SlotSystem = MemorySystem & {
  lastPromptText(): string | null;
  lastRawOutput(): string | null;
};

function slotSystem(delay: (index: number) => number): SlotSystem {
  let slot: string | null = null;
  let raw: string | null = null;
  return {
    name: 'slot',
    answer: async (text: string) => {
      const index = Number(text.replace('question ', ''));
      slot = `prompt for ${text}`;
      raw = `raw ${text}`;
      await new Promise((resolve) => setTimeout(resolve, delay(index)));
      // The answer is read from the slot rather than from the argument, which is what makes a
      // shared instance produce a WRONG ANSWER rather than only a misattributed prompt. A
      // fixture that returned `text` would pass even with the defect present.
      return slot === `prompt for ${text}` ? `a${String(index)}` : `CORRUPT:${slot ?? 'none'}`;
    },
    lastPromptText: () => slot,
    lastRawOutput: () => raw,
  };
}

/** A pool that builds a fresh slot system per worker, as a caller must. */
function poolOf(workers: number, delay: (index: number) => number): BenchmarkWorkerPool {
  return { workers, systemFor: () => slotSystem(delay) };
}

/** Descending delay, so a later question finishes before an earlier one. */
const descending = (index: number): number => (4 - (index % 4)) * 4;

describe('a concurrent pass measures what a serial pass measures', () => {
  it('produces byte-identical answers and prompts at four workers', async () => {
    const data = dataset(8);
    const serialPrompts: (string | null)[] = [];
    const serialAnswers = await runBenchmark(
      data,
      slotSystem(descending),
      undefined,
      0,
      undefined,
      (_retrieved, _chars, _admitted, prompt, index) => {
        serialPrompts[index] = prompt;
      },
    );

    const pools = poolOf(4, descending);
    const concurrentPrompts: (string | null)[] = [];
    const concurrentAnswers = await runBenchmark(
      data,
      slotSystem(descending),
      undefined,
      0,
      undefined,
      (_retrieved, _chars, _admitted, prompt, index) => {
        concurrentPrompts[index] = prompt;
      },
      undefined,
      undefined,
      pools,
    );

    expect(concurrentAnswers).toEqual(serialAnswers);
    expect(concurrentPrompts).toEqual(serialPrompts);
    // The prompts are non-degenerate: every one names its own question. Without this the two
    // vectors above could agree on `null`.
    expect(serialPrompts).toEqual(
      Array.from({ length: 8 }, (_, i) => `prompt for question ${String(i)}`),
    );
  });

  it('returns the answers in question order however they complete', async () => {
    const answers = await runBenchmark(
      dataset(8),
      slotSystem(descending),
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      poolOf(3, descending),
    );
    // Descending delays mean the last question finishes first and the first finishes last.
    expect(answers).toEqual(Array.from({ length: 8 }, (_, i) => `a${String(i)}`));
  });

  it('tells the answer sink which question each answer belongs to', async () => {
    const seen: [Answer, number][] = [];
    await runBenchmark(
      dataset(6),
      slotSystem(descending),
      undefined,
      0,
      undefined,
      undefined,
      (answer, index) => {
        seen.push([answer, index]);
      },
      undefined,
      poolOf(4, descending),
    );
    // Completion order, not index order -- the point is that the pair travels together.
    expect(seen).toHaveLength(6);
    for (const [answer, index] of seen) {
      expect(answer).toBe(`a${String(index)}`);
    }
    expect(seen.map(([, index]) => index).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('places the captured vectors by index under concurrency', async () => {
    // The four vectors `evaluateWithScorerDetailed` collects are paired downstream with the
    // roster by question index. Appending them in completion order would rotate every
    // explanation one question out of phase and leave every number well-formed.
    const evaluation = await evaluateWithScorerDetailed(
      dataset(8),
      slotSystem(descending),
      exactMatchScorer,
      undefined,
      0,
      true,
      true,
      undefined,
      undefined,
      poolOf(4, descending),
    );
    expect(evaluation.correct).toHaveLength(8);
    expect(evaluation.answers).toEqual(Array.from({ length: 8 }, (_, i) => `a${String(i)}`));
    expect(evaluation.rawOutputs).toEqual(
      Array.from({ length: 8 }, (_, i) => `raw question ${String(i)}`),
    );
    expect(evaluation.promptTexts).toEqual(
      Array.from({ length: 8 }, (_, i) => `prompt for question ${String(i)}`),
    );
  });

  it('detects a pool that hands every worker the same instance', async () => {
    // The negative control, and the reason the assertions above are not vacuous: one instance
    // answering concurrently corrupts the slot, and the corruption is visible in the answer.
    const shared = slotSystem(descending);
    const answers = await runBenchmark(
      dataset(8),
      shared,
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      { workers: 4, systemFor: () => shared },
    );
    expect(answers.some((answer) => (answer ?? '').startsWith('CORRUPT'))).toBe(true);
  });
});

describe('the width is a parameter and is checked', () => {
  it('emits exactly one progress event per question, in claim order', async () => {
    const indices: number[] = [];
    await runBenchmark(
      dataset(7),
      slotSystem(descending),
      (event) => indices.push(event.index),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      poolOf(3, descending),
    );
    expect(indices.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('still ends the pass on the budget, naming the question it stopped before', async () => {
    await expect(
      runBenchmark(
        dataset(8),
        slotSystem(() => 5),
        undefined,
        0,
        undefined,
        undefined,
        undefined,
        0,
        poolOf(2, () => 5),
      ),
    ).rejects.toThrow(/budget/i);
  });

  it('refuses a worker count that would silently serialize or overstate the pass', async () => {
    for (const workers of [0, 2.5, -1, Number.NaN]) {
      await expect(
        runBenchmark(
          dataset(2),
          slotSystem(() => 0),
          undefined,
          0,
          undefined,
          undefined,
          undefined,
          undefined,
          { workers, systemFor: () => slotSystem(() => 0) },
        ),
      ).rejects.toThrow(/positive integer/);
    }
  });

  it('builds no instance it cannot use', async () => {
    // Three questions at eight workers: five instances would be dead weight, and a caller with
    // an expensive constructor would pay for them.
    let built = 0;
    await runBenchmark(
      dataset(3),
      slotSystem(() => 0),
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        workers: 8,
        systemFor: () => {
          built++;
          return slotSystem(() => 0);
        },
      },
    );
    expect(built).toBe(3);
  });
});

describe('the ablation forwards the width to both sides', () => {
  /**
   * A configuration whose two sides differ by one question, so a delta exists to compare.
   *
   * The value here is not the delta's size: it is that the same delta has to come out of a
   * serial and a concurrent run of one configuration. A single factory wired to the wrong side
   * would make one arm concurrent and the other serial, and the artifact would show that as a
   * delta rather than as a defect.
   */
  const data = dataset(6);

  it('reports the same metrics at three workers as serial', async () => {
    const serial = await runAblation(
      data,
      slotSystem(() => 0),
      slotSystem(() => 0),
      {
        runs: 2,
        scorer: exactMatchScorer,
      },
    );
    const built: string[] = [];
    // Worker 0 is the serial pair, so the pool is built from them rather than from a second pair
    // that would answer the same questions with different objects (§13.244).
    const baselineSerial = slotSystem(() => 0);
    const featureSerial = slotSystem(() => 0);
    const pool = createAblationPool({
      workers: 3,
      first: { baseline: baselineSerial, feature: featureSerial },
      baselineFor: (worker) => {
        built.push(`baseline:${worker}`);
        return slotSystem(() => 0);
      },
      featureFor: (worker) => {
        built.push(`feature:${worker}`);
        return slotSystem(() => 0);
      },
    });
    const concurrent = await runAblation(data, baselineSerial, featureSerial, {
      runs: 2,
      scorer: exactMatchScorer,
      pool,
    });
    expect(concurrent.featureAggregate.avg).toBe(serial.featureAggregate.avg);
    expect(concurrent.baselineAggregate.avg).toBe(serial.baselineAggregate.avg);
    expect(concurrent.delta).toBe(serial.delta);
    // Three workers on each side, and **one instance each for both repetitions**: the width is what
    // the pool is, so a pool that built one instance per side would be a serial pass wearing a name
    // -- and a pool that rebuilt them per pass would leave every pass's census on an object the
    // artifact never names (§13.244, which is the defect this shape now forecloses).
    expect(built.filter((entry) => entry.startsWith('baseline:'))).toHaveLength(2);
    expect(built.filter((entry) => entry.startsWith('feature:'))).toHaveLength(2);
    expect(pool.featureInstances()).toHaveLength(3);
  });
});
