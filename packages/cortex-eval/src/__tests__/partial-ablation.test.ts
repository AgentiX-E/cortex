/**
 * A run that dies mid-measurement must leave the measurement behind.
 *
 * ## The loss this pins
 *
 * Run `37942775447` spent ~40 minutes grading questions across six routes and two
 * sides, then died on `TypeError: terminated` -- a TLS socket closed under the
 * fetch. The artifact it left held exactly one thing for this arm:
 *
 *   cortex-memory/benchmark-error.log          the progress line and the stack
 *   cortex-memory/benchmark-*.json             absent
 *   cortex-memory/benchmark-*.md               absent
 *
 * `bench/run-ablation.ts` writes its report only after `runCortexMemoryArm`
 * returns, and the arm returns only on success, so every graded answer was
 * discarded. The failure path persists the EMBEDDING cache and not the answers,
 * which is the wrong way round: re-embedding repeats a deterministic, already paid
 * computation, while re-answering repeats the measurement itself.
 *
 * ## Why the assertions are about what a partial result may CLAIM
 *
 * The tempting repair -- write whatever the vectors hold when the process dies --
 * is worse than the loss it fixes. `delta` is computed from
 * `featureAggregate.avg - baselineAggregate.avg` over the SAME index vector, so a
 * partial capture gives a real number for a comparison that was never made: the
 * feature side dies at question 157 of 500, the baseline answered all 500, and the
 * subtraction is meaningful arithmetic over meaningless data. That is what
 * `variance.ts` throws to prevent one layer down, and what `buildQuestionRecords`
 * throws for on a length mismatch.
 *
 * So a partial result carries the answers it has, reports how far it got, and does
 * NOT carry a delta or an aggregate.
 *
 * ## Why this lives in `cortex-eval` and not in `bench/`
 *
 * `bench/**` is excluded from coverage as an entry point -- "deleting it,
 * defaulting it on, or reading the wrong environment variable each left every test
 * green, because no test could import the file the line lived in"
 * (`bench-arm-options.ts`). A durability rule written there would be a rule no
 * test could reach, which is the defect this whole round is about.
 */

import { describe, expect, it } from 'vitest';

import { runAblation } from '../ablation.js';
import { exactMatchScorer } from '../metrics.js';
import type { Answer, BenchmarkDataset, MemorySystem, PartialAblation } from '../types.js';

/** A dataset of `count` single-session questions whose expected answer is `answer-i`. */
function datasetOf(count: number): BenchmarkDataset {
  return {
    name: 'partial-fixture',
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
 * A system that answers from `answers` until index `dieAt`, then throws.
 *
 * The message is the one `37942775447` actually produced, because the point of the
 * fixture is to be the failure that happened rather than a convenient stand-in.
 */
function dyingSystem(name: string, answers: Answer[], dieAt: number): MemorySystem {
  let cursor = 0;
  return {
    name,
    answer: async () => {
      if (cursor === dieAt) throw new TypeError('terminated');
      return answers[cursor++]!;
    },
  };
}

/** A system that answers every question, so only the feature side can die. */
function healthySystem(name: string, answers: Answer[]): MemorySystem {
  let cursor = 0;
  return { name, answer: async () => answers[cursor++]! };
}

/** Run the ablation and hand back the thrown error, flipping the pass/fail polarity. */
async function failureOf(
  dataset: BenchmarkDataset,
  baseline: MemorySystem,
  feature: MemorySystem,
): Promise<Error> {
  return runAblation(dataset, baseline, feature, { runs: 1, scorer: exactMatchScorer }).then(
    () => {
      throw new Error('the ablation resolved, but the feature side threw');
    },
    (error: unknown) => error as Error,
  );
}

/** The partial record an error carries, or `undefined` when it carries none. */
function partialOf(error: Error): PartialAblation | undefined {
  return (error as Error & { partial?: PartialAblation }).partial;
}

describe('a run that dies mid-measurement still reports what it measured', () => {
  it('carries the answers graded before the failure instead of discarding them', async () => {
    // The load-bearing assertion. `runAblation` cannot return -- it must reject --
    // so the partial vector travels out on the error. `partial` is the field the
    // reader reads; without it the 40 minutes leave nothing behind.
    const dataset = datasetOf(5);
    const feature = dyingSystem('cortex-memory', ['answer-0', 'answer-1', 'answer-2'], 2);

    const failure = await failureOf(dataset, healthySystem('reference-pipeline', []), feature);

    expect(failure.name).toBe('TypeError');
    const partial = partialOf(failure);
    expect(partial).toBeDefined();
    expect(partial!.featureAnswers).toEqual(['answer-0', 'answer-1']);
  });

  it('reports how far the run got, because a count is not a claim', async () => {
    // A reviewer asking "did this capture 157 of 500 or 499 of 500" is answered by a
    // length and by nothing else. §13.11's predictions are read per capability, and
    // a partial vector that did not state its extent would make every rate computed
    // from it a rate over an unknown denominator.
    const dataset = datasetOf(6);
    const feature = dyingSystem('cortex-memory', ['answer-0', 'answer-1'], 2);

    const failure = await failureOf(dataset, healthySystem('reference-pipeline', []), feature);

    const partial = partialOf(failure)!;
    expect(partial.featureAnswers.length).toBe(2);
    expect(partial.reached).toBe(2);
    expect(partial.total).toBe(6);
    expect(partial.system).toBe('cortex-memory');
    expect(partial.run).toBe(0);
  });

  it('keeps the baseline vector, because the loss is usually one side only', async () => {
    // `runAblation` evaluates the baseline to completion before the feature starts,
    // so a feature-side death leaves a COMPLETE baseline. Discarding it would throw
    // away half of an already-paid measurement, and it is the half a later run can
    // reuse: the baseline's answers are the control arm's, and a re-dispatch with
    // the same dataset would otherwise re-buy them.
    const dataset = datasetOf(4);
    const feature = dyingSystem('cortex-memory', [], 0);

    const failure = await failureOf(
      dataset,
      healthySystem('reference-pipeline', ['answer-0', 'answer-1', 'answer-2', 'answer-3']),
      feature,
    );

    const partial = partialOf(failure)!;
    expect(partial.baselineAnswers).toEqual(['answer-0', 'answer-1', 'answer-2', 'answer-3']);
    expect(partial.featureAnswers).toEqual([]);
  });

  it('does not carry the baseline vector before the baseline has run', async () => {
    // The mirror of the test above, and the reason the field is not simply always
    // present. `runAblation` runs the baseline FIRST, so a baseline-side death
    // leaves no feature vector and a partial baseline -- and at that point the
    // distinction is between "the baseline answered nothing" and "the baseline had
    // not started".
    const dataset = datasetOf(4);
    const failure = await failureOf(
      dataset,
      dyingSystem('reference-pipeline', ['answer-0'], 1),
      healthySystem('cortex-memory', []),
    );

    const partial = partialOf(failure)!;
    expect(partial.baselineAnswers).toEqual(['answer-0']);
    expect(partial.system).toBe('reference-pipeline');
    expect(partial.reached).toBe(1);
  });

  it('refuses to report a delta, because a partial comparison is not a comparison', async () => {
    // The claim that must NOT be made. `delta` subtracts two aggregates over the
    // same index vector; with one side short, the subtraction produces a number for
    // a comparison that never happened. A reviewer reading `delta: -0.04` cannot
    // tell it from a complete run's -- which is the §12.6 defect, a value that
    // describes the intent rather than the data.
    const dataset = datasetOf(4);
    const failure = await failureOf(
      dataset,
      healthySystem('reference-pipeline', ['answer-0']),
      dyingSystem('cortex-memory', ['answer-0'], 1),
    );

    const partial = partialOf(failure)!;
    expect('delta' in partial).toBe(false);
    expect('pValue' in partial).toBe(false);
    expect('mcnemarPValue' in partial).toBe(false);
    expect('effectSize' in partial).toBe(false);
  });

  it('does not invent a per-capability table for questions it never reached', async () => {
    // A rate over an empty denominator is the shape §12.7 records as unreadable:
    // 0/0 renders identically to 0/121 in a table, so an unreached capability would
    // read as a measured zero. A partial artifact must not carry one.
    const dataset = datasetOf(3);
    const failure = await failureOf(
      dataset,
      healthySystem('reference-pipeline', []),
      // Dies on index 1, so one answer WAS graded and a partial record exists --
      // which is what makes the absence of the derived fields a decision rather
      // than a consequence of there being nothing to describe.
      dyingSystem('cortex-memory', ['answer-0'], 1),
    );

    const partial = partialOf(failure)!;
    expect(partial.featureAnswers).toEqual(['answer-0']);
    expect('perCapability' in partial).toBe(false);
    expect('baselineAggregate' in partial).toBe(false);
    expect('featureAggregate' in partial).toBe(false);
  });

  it('leaves the original error intact, because a diagnostic must not mask the cause', async () => {
    // The failure that starts this section is a transport error. Replacing it with a
    // wrapper would lose the stack that names `Fetch.onAborted`, which is the only
    // thing in the record saying the loss was infrastructure rather than a defect in
    // the arm -- the distinction §13.11.7 rests on.
    const dataset = datasetOf(2);
    const failure = await failureOf(
      dataset,
      healthySystem('reference-pipeline', []),
      dyingSystem('cortex-memory', ['answer-0'], 1),
    );

    expect(failure).toBeInstanceOf(TypeError);
    expect(failure.name).toBe('TypeError');
    expect(failure.message).toBe('terminated');
    expect(failure.stack).toContain('at ');
  });

  it('attaches nothing when there was no measurement to lose', async () => {
    // A dataset with no questions produces no answers on either side, so `partial`
    // would be a record of zero answers -- the same bytes as "the capture is
    // broken". The honest answer is no field at all, which is the `null` vs `''`
    // distinction the evidence capture keeps one layer up.
    const empty: BenchmarkDataset = { name: 'empty', questions: [] };
    const failure = await failureOf(
      empty,
      healthySystem('reference-pipeline', []),
      dyingSystem('cortex-memory', [], 0),
    ).catch((error: unknown) => error as Error);

    expect(failure).toBeInstanceOf(Error);
    expect(partialOf(failure)).toBeUndefined();
  });
});

describe('the no-measurement boundary, pinned directly', () => {
  it('attaches nothing when both sides are empty, because zero answers is not a record', async () => {
    // The early-return arm. A `partial` of two empty vectors is byte-identical to a
    // broken capture, so attaching it would claim a measurement happened. Asserted
    // on an error that reached the seam with BOTH sides empty, which is the empty
    // dataset case below and only that case.
    const empty: BenchmarkDataset = { name: 'empty', questions: [] };
    const failure = await runAblation(
      empty,
      healthySystem('reference-pipeline', []),
      dyingSystem('cortex-memory', [], 0),
      { runs: 1, scorer: exactMatchScorer },
    ).then(
      (result) => result,
      (error: unknown) => error as Error,
    );

    // An empty dataset resolves rather than throwing -- nothing to answer, nothing to
    // fail on -- so the assertion is that no partial was fabricated either way.
    expect(partialOf(failure as Error)).toBeUndefined();
  });

  it('attaches nothing when the FIRST side dies before answering anything', async () => {
    // The reachable form of the joint condition. The baseline runs first, so a
    // baseline-side death at index 0 leaves BOTH vectors empty -- there is no
    // measurement on either side, and a `partial` carrying two empty vectors would be
    // byte-identical to a broken capture. This is the arm where the `&&` matters:
    // the feature-side equivalent is covered above and DOES attach, because the
    // baseline is complete by then.
    const dataset = datasetOf(4);
    const failure = await runAblation(
      dataset,
      dyingSystem('reference-pipeline', [], 0),
      healthySystem('cortex-memory', []),
      { runs: 1, scorer: exactMatchScorer },
    ).then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(failure).toBeInstanceOf(TypeError);
    expect(partialOf(failure!)).toBeUndefined();
  });

  it('rethrows a non-object throw unchanged, because the seam must not replace it', async () => {
    // A `throw 'string'` reaches this seam with a primitive, which cannot carry a
    // property. The honest behaviour is to pass it through rather than convert it into
    // an Error: converting would change the type a caller catches on, and the primitive
    // is what the throwing code chose.
    const dataset = datasetOf(3);
    const weird: MemorySystem = {
      name: 'cortex-memory',
      answer: async () => {
        throw 'a primitive throw';
      },
    };

    const thrown = await runAblation(dataset, healthySystem('reference-pipeline', []), weird, {
      runs: 1,
      scorer: exactMatchScorer,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(thrown).toBe('a primitive throw');
  });
});
