/**
 * Capturing what the turn cap did to each delivered window.
 *
 * ## Why this capture exists
 *
 * `S10`'s `P1` asks what share of the turns the control cut now carries an elision. `MEASURE-TURN-WINDOW.md`
 * §9.3 records the attempt to answer it from the prompt text and why it failed: blank-line splitting
 * undercounts a cut prefix containing a blank line, `^N. ` overcounts an assistant's own numbered list, and
 * the two disagree on 53 of 200 prompts before any mechanism is involved. §9.4 makes the counter the first
 * item of the next increment, *computed where the cut happens*.
 *
 * ## Why it is a vector and not a run-level number
 *
 * The run-level total is a sum, and a sum cannot say whether one question was counted twice or another not
 * at all. `cut + whole` must equal the delivered turns **per question**; a vector is the shape in which that
 * identity is checkable, and the sum is derived from it rather than trusted on its own.
 *
 * ## Why the absent accessor is `null` and not three zeros
 *
 * The same rule the route and role captures follow: a system that cannot say has said nothing, which is a
 * different statement from a system whose cap cut nothing.
 */
import { describe, expect, it } from 'vitest';

import type {
  Answer,
  BenchmarkDataset,
  DeliveredTurnWindowCensus,
  MemorySystem,
} from '../types.js';
import { evaluateWithScorerDetailed, runBenchmark } from '../benchmark.js';
import { exactMatchScorer } from '../metrics.js';

function datasetOf(count: number): BenchmarkDataset {
  return {
    name: 'turn-window-fixture',
    questions: Array.from({ length: count }, (_unused, i) => ({
      id: `q${i}`,
      question: `Question ${i}?`,
      expected: `answer-${i}`,
      capability: 'IE' as const,
      context: [`evidence ${i}`],
    })),
  };
}

/** A system that reports a census derived from the question index, so an off-by-one cannot pass. */
function reportingSystem(): MemorySystem & {
  lastTurnWindowCensus: () => DeliveredTurnWindowCensus | null;
} {
  let index = 0;
  return {
    name: 'reporting',
    async answer(_question: string): Promise<Answer> {
      index += 1;
      return `answer-${index - 1}`;
    },
    lastTurnWindowCensus(): DeliveredTurnWindowCensus | null {
      // One cut, one of them marked, and `index` whole: the arithmetic `cut + whole === delivered` is
      // checkable per question rather than only in aggregate.
      return { cut: 1, marked: index % 2, whole: index };
    },
  };
}

describe('the benchmark captures the turn window census', () => {
  it('collects one census per question, in question order', async () => {
    const captured: (DeliveredTurnWindowCensus | null)[] = [];

    await runBenchmark(datasetOf(3), reportingSystem(), undefined, 0, undefined, (capture) =>
      captured.push(capture.turnWindow),
    );

    expect(captured).toEqual([
      { cut: 1, marked: 1, whole: 1 },
      { cut: 1, marked: 0, whole: 2 },
      { cut: 1, marked: 1, whole: 3 },
    ]);
  });

  it('reports null for a system that does not expose the accessor', async () => {
    const system: MemorySystem = {
      name: 'answer-only',
      answer: async (): Promise<Answer> => 'answer',
    };
    const captured: (DeliveredTurnWindowCensus | null)[] = [];

    await runBenchmark(datasetOf(2), system, undefined, 0, undefined, (capture) =>
      captured.push(capture.turnWindow),
    );

    expect(captured).toEqual([null, null]);
  });

  it('carries the vector out of the scoring pass under the capture flag', async () => {
    const report = await evaluateWithScorerDetailed(
      datasetOf(3),
      reportingSystem(),
      exactMatchScorer,
      undefined,
      0,
      undefined,
      true,
    );

    expect(report.turnWindowCensuses).toEqual([
      { cut: 1, marked: 1, whole: 1 },
      { cut: 1, marked: 0, whole: 2 },
      { cut: 1, marked: 1, whole: 3 },
    ]);
  });
});

/**
 * The per-form split, from the product's census to the artifact.
 *
 * `PREREGISTRATION-RESOLUTION-LAYERING.md` §6 asks the artifact for `evidenceForms` per question, and
 * `DESIGN-C7-RESOLUTION-LAYERING.md` §11.3 recorded its absence as an ordering decision: no criterion read
 * the split, so projecting it could not flatter or damage a reading. This pins the projection itself, which
 * is a claim about the pipeline rather than about a run -- a field the product produces and the scorer drops
 * is a field no artifact will ever show.
 */
describe('the per-form split survives the capture', () => {
  const FORMS = {
    raw: { turns: 1, chars: 10 },
    excerpt: { turns: 2, chars: 400 },
    record: { turns: 3, chars: 180 },
  } as const;

  function formReportingSystem(): MemorySystem & {
    lastTurnWindowCensus: () => DeliveredTurnWindowCensus | null;
  } {
    return {
      name: 'forms',
      answer: async (): Promise<Answer> => 'answer-0',
      lastTurnWindowCensus: (): DeliveredTurnWindowCensus => ({
        cut: 6,
        marked: 6,
        whole: 0,
        forms: FORMS,
      }),
    };
  }

  it('reaches the capture unchanged, and survives the JSON the artifact is written as', async () => {
    const captured: (DeliveredTurnWindowCensus | null)[] = [];
    await runBenchmark(datasetOf(1), formReportingSystem(), undefined, 0, undefined, (capture) =>
      captured.push(capture.turnWindow),
    );

    // The three counts are the delivered turns, which is the identity `F3` divides by.
    const census = captured[0];
    expect(census?.forms).toEqual(FORMS);
    expect(
      (census?.forms?.raw.turns ?? 0) +
        (census?.forms?.excerpt.turns ?? 0) +
        (census?.forms?.record.turns ?? 0),
    ).toBe(census?.cut);
    // Written out, because a field that only exists in memory is not in the artifact a reader has.
    expect(JSON.parse(JSON.stringify(census)).forms).toEqual(FORMS);
  });

  it('stays absent for a census that reports no form, rather than becoming three zeros', async () => {
    const captured: (DeliveredTurnWindowCensus | null)[] = [];
    await runBenchmark(datasetOf(1), reportingSystem(), undefined, 0, undefined, (capture) =>
      captured.push(capture.turnWindow),
    );
    expect(captured[0]).toEqual({ cut: 1, marked: 1, whole: 1 });
    expect('forms' in (captured[0] as object)).toBe(false);
  });
});
