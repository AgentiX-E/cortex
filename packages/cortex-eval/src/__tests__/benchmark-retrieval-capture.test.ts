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
import { evaluateWithScorerDetailed, runBenchmark } from '../benchmark.js';
import { exactMatchScorer } from '../metrics.js';

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

    await runBenchmark(datasetOf(3), system, undefined, 0, undefined, (capture) =>
      captured.push(capture.context),
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

    await runBenchmark(datasetOf(2), system, undefined, 0, undefined, (capture) =>
      captured.push(capture.context),
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
      (capture) => retrieved.push(capture.context),
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

/**
 * The two facts about a request that the four captures above cannot answer.
 *
 * ## The ambiguity they end, stated once
 *
 * Screening run `43465626013` failed its own audit with
 * `FAIL roles evidenceRoles=['user'] on ['multi-session','temporal']; 4 window(s) carry an assistant
 * turn`. The artifact recorded the filter's **configuration** on every record and nothing about what it
 * did, so two readings were equally consistent with it: the filter stopped working, or the audit checked
 * a path the question never took. Settling it took reconstructing four records by hand — and the answer
 * was a third thing neither reading had.
 *
 * `route` and `roleCensus` are the two readings the artifact should have carried. Neither is derivable
 * from what it did carry: `capability` is the dataset's word for a shape, and `featureConfig.evidenceRoles`
 * is the filter's instruction rather than its result.
 */
function routedSystem(reports: { route: boolean; census: boolean }): MemorySystem {
  let index = 0;
  const system: MemorySystem = {
    name: 'routed',
    async answer(question: string): Promise<Answer> {
      const answered = question.includes('?');
      index += 1;
      return answered ? `answer-${index - 1}` : null;
    },
  };
  if (reports.route) {
    Object.defineProperty(system, 'lastRoute', {
      value: (): string | null => (index === 0 ? null : index % 2 === 1 ? 'flat' : 'multi-session'),
    });
  }
  if (reports.census) {
    Object.defineProperty(system, 'lastRoleCensus', {
      value: () =>
        index === 0 ? null : { counts: { user: index }, unclassified: 0, total: index },
    });
  }
  return system;
}

describe('the benchmark captures the route and the roles of each request', () => {
  it('collects one of each per question, in question order', async () => {
    // Order is the claim, for the reason the context vector's own test states: the roster pairs these with
    // `featureAnswers` by index, and a misordered vector would attribute one question's path to another --
    // which is the misattribution class with an audit reading it as a filter defect.
    const captures: { route: string | null; total: number }[] = [];
    await runBenchmark(
      datasetOf(4),
      routedSystem({ route: true, census: true }),
      undefined,
      0,
      undefined,
      (capture) => captures.push({ route: capture.route, total: capture.roleCensus?.total ?? -1 }),
    );

    expect(captures.map((c) => c.route)).toEqual([
      'flat',
      'multi-session',
      'flat',
      'multi-session',
    ]);
    expect(captures.map((c) => c.total)).toEqual([1, 2, 3, 4]);
  });

  it('reports null rather than a default for a system that answers neither', async () => {
    // The three-state rule the whole capture follows: `null` is "this system cannot say", which is a
    // different statement from `'flat'` and from an empty census. A default of `'flat'` here would have an
    // audit check a role filter against a path nothing was said about -- which is exactly the reading
    // `43465626013` could not rule out.
    const captures: { route: string | null; census: unknown }[] = [];
    await runBenchmark(
      datasetOf(2),
      routedSystem({ route: false, census: false }),
      undefined,
      0,
      undefined,
      (capture) => captures.push({ route: capture.route, census: capture.roleCensus }),
    );

    expect(captures).toEqual([
      { route: null, census: null },
      { route: null, census: null },
    ]);
  });

  it('keeps the two capabilities independent', async () => {
    // They are separate accessors because they are separate facts, and a system may expose one. A capture
    // that inferred the census from the route -- or the route from the census -- would have to invent the
    // half it was not given, and the invention would be indistinguishable from a measurement in the artifact.
    const captures: { route: string | null; census: unknown }[] = [];
    await runBenchmark(
      datasetOf(2),
      routedSystem({ route: true, census: false }),
      undefined,
      0,
      undefined,
      (capture) => captures.push({ route: capture.route, census: capture.roleCensus }),
    );

    expect(captures.every((c) => c.route !== null)).toBe(true);
    expect(captures.every((c) => c.census === null)).toBe(true);
  });
});

describe('the evaluation carries the two vectors it captured', () => {
  it('returns them, in question order, when the capture was requested', async () => {
    // The layer the loop's own test cannot reach. `runBenchmark` hands each capture to `onRetrieved`, which is
    // what the test above observes; `evaluateWithScorerDetailed` is what turns the same loop into an
    // `AblationResult` field, and a vector collected and not returned is a vector the artifact never sees.
    // Both halves are asserted because the two hops fail independently.
    const evaluation = await evaluateWithScorerDetailed(
      datasetOf(3),
      routedSystem({ route: true, census: true }),
      exactMatchScorer,
      undefined,
      0,
      false,
      true,
    );

    expect(evaluation.routes).toEqual(['flat', 'multi-session', 'flat']);
    expect(evaluation.roleCensuses?.map((census) => census?.total)).toEqual([1, 2, 3]);
  });

  it('omits both when the capture was not requested', async () => {
    // The rule `captureRawOutput` states for its own vector: "not requested" must stay distinguishable from
    // "requested and every system declined". An all-`null` vector for a run that never asked would read as an
    // arm in which no system reports a route, which is a statement about the corpus.
    const evaluation = await evaluateWithScorerDetailed(
      datasetOf(2),
      routedSystem({ route: true, census: true }),
      exactMatchScorer,
      undefined,
      0,
      false,
      false,
    );

    expect('routes' in evaluation).toBe(false);
    expect('roleCensuses' in evaluation).toBe(false);
  });
});
