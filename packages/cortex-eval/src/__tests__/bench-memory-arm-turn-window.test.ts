/**
 * `S10`'s `P1` reaches the artifact as a field, or the dispatch cannot answer the question it was made for.
 *
 * ## The defect this is written against
 *
 * `MEASURE-TURN-WINDOW.md` §9.3 records the attempt to answer `P1` -- *what share of the turns the control cut
 * carries an elision* -- by parsing the prompt text. Both parsers available were wrong, they disagreed with
 * each other on 53 of 200 prompts, and the reading was **unread rather than failed**. §9.4 makes the counter
 * the first item of the next increment: *computed where the cut happens, so that `P1` is a field and not a
 * parse*.
 *
 * The counter now exists on the product (`CortexMemory.lastTurnWindowCensus`), which is necessary and not
 * sufficient. This campaign has caught three fields that were validated at a boundary, recorded on the
 * artifact, and never branched on -- and a fourth would be a census the arm's fold dropped on the floor. So
 * these tests read the **artifact**, not the accessor.
 *
 * ## Why absence is one of the assertions
 *
 * `MemorySystem`'s conformant minimum is `{ name, answer }`, so a system that cannot report a census must
 * still be gradable, and it must produce no field rather than a zeroed one: `{ cut: 0, marked: 0, whole: 0 }`
 * beside a system that never rendered a window is the same bytes as a run whose cap cut nothing, and only one
 * of those is a measurement.
 */
import { describe, expect, it } from 'vitest';

import { runCortexMemoryArm } from '../bench-memory-arm.js';

import type { MemoryArmConfig } from '../report.js';
import { exactMatchScorer } from '../metrics.js';
import { DEFAULT_RELEVANCE_TOP_K } from '../relevance-index.js';
import type { Answer, BenchmarkDataset, DeliveredTurnWindowCensus, MemorySystem } from '../types.js';

const GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: null,
  sourceTrust: 0.5,
  confidenceSignal: 'none',
  promptContract: 'abstention',
  relevanceSignal: 'none',
  relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
} as const;

function dataset(count = 1): BenchmarkDataset {
  return {
    name: 'turn-window-fixture',
    questions: Array.from({ length: count }, (_unused, i) => ({
      id: `q${i}`,
      capability: 'IE' as const,
      question: `Question ${i}?`,
      expected: 'one',
      context: [],
    })),
  };
}

function constantSystem(answer: Answer): MemorySystem {
  return { name: 'reference-pipeline', answer: () => answer };
}

/** A system that reports `census()` per call, so a per-question field has somewhere to differ. */
function reporting(census: () => DeliveredTurnWindowCensus | null): MemorySystem {
  return {
    name: 'cortex-memory',
    answer: () => 'one',
    lastTurnWindowCensus: census,
  } as unknown as MemorySystem;
}

async function run(feature: MemorySystem, count = 1) {
  return runCortexMemoryArm(dataset(count), constantSystem('one'), feature, {
    runs: 1,
    scorer: exactMatchScorer,
    generatedAt: '1970-01-01T00:00:00.000Z',
    memoryArmConfig: { ...GATE } as MemoryArmConfig,
  });
}

type WithWindow = { turnWindow?: { cut: number; marked: number; whole: number; questions: number; unreported: number } };

describe('the arm records the turn window census on the artifact', () => {
  it('sums what each question reported', async () => {
    const result = await run(reporting(() => ({ cut: 2, marked: 1, whole: 5 })), 2);

    expect((result.report as WithWindow).turnWindow).toEqual({
      cut: 4,
      marked: 2,
      whole: 10,
      questions: 2,
      unreported: 0,
    });
  });

  it('writes no field at all when the system cannot report one', async () => {
    // `undefined` rather than three zeros: the arm's minimum contract does not include this capability, and a
    // zeroed default is the shape that made §10.10's wrong reading possible one census over.
    const result = await run(constantSystem('one'));

    expect((result.report as WithWindow).turnWindow).toBeUndefined();
  });

  it('counts a question that declined to report rather than dropping it silently', async () => {
    // A sum over a subset of the population and a sum over all of it are different readings, and only one of
    // them is a measurement of the mechanism. The count travels with the total.
    let call = 0;
    const result = await run(
      reporting(() => {
        call += 1;
        return call === 1 ? { cut: 3, marked: 3, whole: 1 } : null;
      }),
      2,
    );

    expect((result.report as WithWindow).turnWindow).toEqual({
      cut: 3,
      marked: 3,
      whole: 1,
      questions: 1,
      unreported: 1,
    });
  });

  it('writes no field when every question declined', async () => {
    const result = await run(reporting(() => null), 2);

    expect((result.report as WithWindow).turnWindow).toBeUndefined();
  });
});
