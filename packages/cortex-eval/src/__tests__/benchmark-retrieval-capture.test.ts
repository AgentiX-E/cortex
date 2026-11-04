/**
 * Capturing the evidence a reader was shown needs a hook beside the raw-output one.
 *
 * ## Why the artifact could not answer the question §13 raised
 *
 * §13 produced MR `13 -> 0` and TR `16 -> 0` with `b-f+ = 0` on every capability.
 * The next hypothesis is retrieval quality, and it cannot be tested from the
 * artifact as it stands: `QuestionRecord.turns` is `[]` on every record, because
 * `buildArmRoster` supplies `retrieved: ''`. That is honest -- the arm collected
 * no retrieval text -- and it is also the blocker. "The reader was shown the
 * wrong turn" and "the reader was shown nothing" are repaired in different
 * places, and the artifact collapses them.
 *
 * ## Why the hook is shaped exactly like `onRawOutput`
 *
 * The evidence has the same problem the model text had: it exists only during the
 * call, on the system, in a slot that holds one question. A capture read after
 * the loop would attribute the last question's context to every record, which is
 * the defect `raw-output-retention.test.ts` pins one layer down. So it is
 * captured per question, at the point the answer is produced.
 *
 * The two hooks are deliberately parallel rather than merged into one sink
 * object. Each has a distinct consumer and a distinct failure mode -- the raw
 * output explains a decline, the evidence explains whether one was warranted --
 * and a combined sink would make an arm that wants one pay for the other.
 *
 * ## Why the absence of the accessor is not a degraded mode
 *
 * A system that does not expose `lastRetrievedContext` reports `null` for every
 * question, exactly as a system without `lastRawOutput` reports `null` for the
 * model text. `runBenchmark` returns `Answer[]` and many call sites depend on
 * that, so the hook is a trailing optional parameter and a run that omits it
 * behaves as it did before.
 */

import { describe, expect, it } from 'vitest';
import type { Answer, BenchmarkDataset, MemorySystem } from '../types.js';
import { runBenchmark } from '../benchmark.js';

/** A dataset of `count` questions, all on the flat route. */
function datasetOf(count: number): BenchmarkDataset {
  return {
    name: 'retrieval-fixture',
    questions: Array.from({ length: count }, (_unused, i) => ({
      id: `q${i}`,
      question: `Question ${i}?`,
      expected: `answer-${i}`,
      capability: 'IE' as const,
      context: [`evidence ${i}`],
    })),
  };
}

/**
 * A system exposing both optional accessors, so the two captures are separable.
 *
 * The values are derived from the question index rather than held fixed, so an
 * off-by-one in the capture loop shows up as the wrong index rather than as a
 * passing test that cannot tell two questions apart.
 */
function capturingSystem(): MemorySystem & {
  lastRawOutput: () => string | null;
  lastRetrievedContext: () => readonly string[] | null;
  seen: string[];
} {
  let index = 0;
  const seen: string[] = [];
  return {
    name: 'capturing',
    seen,
    async answer(question: string, context: string[]): Promise<Answer> {
      seen.push(context.join('\n'));
      const answered = question.includes('?');
      index += 1;
      return answered ? `answer-${index - 1}` : null;
    },
    lastRawOutput(): string | null {
      return index === 0 ? null : `raw-${index - 1}`;
    },
    lastRetrievedContext(): readonly string[] | null {
      // Two turns per question, so the assertions below cannot be satisfied by a
      // capture that re-joined the list into a string: a one-element comparison would
      // pass on either shape for a single turn, and this one has two.
      return index === 0 ? null : [`retrieved-${index - 1}`, `also-${index - 1}`];
    },
  };
}

describe('the benchmark captures the evidence each reader was shown', () => {
  it('collects one context per question, in question order', async () => {
    // Order is the claim. A capture that ran after the loop, or that read the
    // slot once, would return the last question's context for every record --
    // and the roster pairs these against `featureAnswers` by index, so a
    // misordered vector silently misattributes every explanation.
    const system = capturingSystem();
    const captured: (readonly string[] | null)[] = [];

    await runBenchmark(datasetOf(3), system, undefined, 0, undefined, (retrieved) =>
      captured.push(retrieved),
    );

    expect(captured).toEqual([
      ['retrieved-0', 'also-0'],
      ['retrieved-1', 'also-1'],
      ['retrieved-2', 'also-2'],
    ]);
  });

  it('reports null for a system that does not expose the accessor', async () => {
    // The contract's minimum is `{ name, answer }`, and such a system must keep
    // working unchanged. `null` is the honest value: a system that cannot say
    // what it retrieved has not retrieved nothing.
    const system: MemorySystem = {
      name: 'answer-only',
      answer: async (): Promise<Answer> => 'answer',
    };
    const captured: (readonly string[] | null)[] = [];

    await runBenchmark(datasetOf(2), system, undefined, 0, undefined, (retrieved) =>
      captured.push(retrieved),
    );

    expect(captured).toEqual([null, null]);
  });

  it('captures the two optional values independently', async () => {
    // A combined sink would be one object with two fields, and the failure it
    // invites is a caller that wires one and not the other. Asserted as two
    // vectors here so that regression is visible.
    const system = capturingSystem();
    const raws: (string | null)[] = [];
    const retrieved: (readonly string[] | null)[] = [];

    await runBenchmark(
      datasetOf(2),
      system,
      undefined,
      0,
      (raw) => raws.push(raw),
      (ctx) => retrieved.push(ctx),
    );

    expect(raws).toEqual(['raw-0', 'raw-1']);
    expect(retrieved).toEqual([
      ['retrieved-0', 'also-0'],
      ['retrieved-1', 'also-1'],
    ]);
  });

  it('leaves every answer untouched, which is what makes the hook a hook', async () => {
    // The capture is an observation, not a participant. Asserted by running the
    // same dataset with and without the sink and requiring identical answers,
    // rather than by inspecting the loop -- a rewrite that started reading the
    // accessor before the answer call would change what the system is asked and
    // this would catch it.
    const withSink = await runBenchmark(
      datasetOf(3),
      capturingSystem(),
      undefined,
      0,
      undefined,
      () => {},
    );
    const withoutSink = await runBenchmark(datasetOf(3), capturingSystem());

    expect(withSink).toEqual(withoutSink);
    expect(withSink).toEqual(['answer-0', 'answer-1', 'answer-2']);
  });
});
