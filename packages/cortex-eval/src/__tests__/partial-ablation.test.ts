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

/**
 * A system that counts its own calls and throws on the one `dieOnCall` names.
 *
 * ## Why the ordinal is a call count rather than a repetition number
 *
 * The harness does not tell a system which repetition it is serving -- `run` goes to
 * the progress sink, not to `answer` -- and that is a property of the measurement
 * rather than an omission: a system that could see its repetition could behave
 * differently in each, which would break the pairing the whole comparison rests on.
 * So a fixture that has to fail in a LATER repetition has to count calls, and the
 * count is a function of the harness's own order (baseline then feature, per
 * repetition) rather than of anything the system is told.
 *
 * `perRun` is the dataset size, so the answer it returns is the correct one for the
 * question and the repetitions that complete before the failure measure as they
 * would in a real run.
 */
function countingSystem(name: string, perRun: number, dieOnCall: number): MemorySystem {
  let calls = 0;
  return {
    name,
    answer: async () => {
      calls += 1;
      if (calls === dieOnCall) throw new TypeError('terminated');
      return `answer-${(calls - 1) % perRun}`;
    },
  };
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

/**
 * A failure in a REPETITION is a measurement too, and it was the one that got away.
 *
 * ## The loss this pins
 *
 * Run `38520676669` repeated this arm's `§13.22` dispatch and died on
 * `TypeError: terminated` after **three hours and eight minutes**. Its log says how far
 * it got:
 *
 *     reference-pipeline run=0 q=500/500
 *     cortex-memory      run=0 q=500/500
 *     reference-pipeline run=1 q=500/500
 *     cortex-memory      run=1 q=500/500
 *     progress: died on cortex-memory run=1 q=500/500 id=778164c6
 *
 * So two of the four repetitions had completed on BOTH sides -- two thousand graded
 * answers -- and the artifact held one file, `benchmark-error.log`, carrying a stack
 * trace. The durability repair described at the top of this file did not fire, and the
 * reason is structural rather than a bug in it: `attachPartial` wraps the evaluation of
 * repetition **0** on each side, and the loop that runs the remaining repetitions had
 * neither a try/catch nor an answer sink. A failure there travelled out unwrapped, so
 * `error.partial` was `undefined` and the failure path had nothing to write.
 *
 * That is the same failure as `37942775447` -- the run this file exists because of --
 * one repetition later, and it is the costlier version: the earlier one lost forty
 * minutes, this one lost three hours.
 *
 * ## What a partial for repetition i means
 *
 * The repetitions are sequential, so `run: i` carries its own extent: repetitions
 * `0..i-1` completed on both sides, and the vectors are repetition `i`'s, up to where
 * it got. No new field is needed for that, and no aggregate is added -- the
 * no-delta rule above applies unchanged.
 */
describe('a failure in a repeated run is a measurement too', () => {
  it('carries the vectors of the repetition that died, and names it', async () => {
    // Two repetitions of three questions, so each system is called six times: its
    // first repetition on calls 1-3 and its second on 4-6. The feature dies on call 5 --
    // its second question of the second repetition -- which is the shape of
    // `38520676669`: the first repetition fully graded and the second lost part-way.
    const dataset = datasetOf(3);
    const baseline = countingSystem('reference-pipeline', 3, 99);
    const feature = countingSystem('cortex-memory', 3, 5);

    const failure = await runAblation(dataset, baseline, feature, {
      runs: 2,
      scorer: exactMatchScorer,
    }).then(
      () => {
        throw new Error('the ablation resolved, but the feature side threw');
      },
      (error: unknown) => error as Error,
    );

    expect(failure).toBeInstanceOf(TypeError);
    const partial = partialOf(failure);
    expect(partial).toBeDefined();
    expect(partial!.run).toBe(1);
    expect(partial!.system).toBe('cortex-memory');
    expect(partial!.reached).toBe(1);
    expect(partial!.total).toBe(3);
    expect(partial!.featureAnswers).toEqual(['answer-0']);
    // The baseline's SECOND repetition completed before the feature's second started,
    // so the vector is that repetition's and not the first one's -- which is what
    // makes `run` and the vectors consistent with each other.
    expect(partial!.baselineAnswers).toEqual(['answer-0', 'answer-1', 'answer-2']);
  });

  it('works at the dispatched repetition count, where the earlier repair covered only the first', async () => {
    // `ABLATION_RUNS` is 4, so the loop that had no sink is the one every run since
    // §13.12 has depended on. This asserts the durability rule at that exact count
    // rather than at the two-repetition case above, because the number is what makes
    // the failure expensive: a later repetition costs more to lose.
    const dataset = datasetOf(2);
    // Two questions and four repetitions is eight calls per system: repetition 0 on
    // calls 1-2, repetition 1 on 3-4, repetition 2 on 5-6, repetition 3 on 7-8. Dying
    // on call 6 loses repetition 2 with one of its two questions answered.
    const failure = await runAblation(
      dataset,
      countingSystem('reference-pipeline', 2, 99),
      countingSystem('cortex-memory', 2, 6),
      { runs: 4, scorer: exactMatchScorer },
    ).then(
      () => {
        throw new Error('the ablation resolved, but the feature side threw');
      },
      (error: unknown) => error as Error,
    );

    const partial = partialOf(failure)!;
    expect(partial.run).toBe(2);
    expect(partial.reached).toBe(1);
    expect(partial.featureAnswers).toEqual(['answer-0']);
  });

  it('reports the baseline side too, if the baseline is what dies in a repetition', async () => {
    // The mirrored case, and it needs its own assertion because the two sides differ in
    // what the partial can say: a baseline-side death in repetition i leaves NO feature
    // vector for that repetition, and `featureAnswers: []` is "the feature had not
    // started" rather than "the feature answered nothing" -- the distinction the
    // run-0 tests make one repetition earlier.
    const dataset = datasetOf(3);
    const failure = await runAblation(
      dataset,
      countingSystem('reference-pipeline', 3, 5),
      countingSystem('cortex-memory', 3, 99),
      { runs: 2, scorer: exactMatchScorer },
    ).then(
      () => {
        throw new Error('the ablation resolved, but the baseline side threw');
      },
      (error: unknown) => error as Error,
    );

    const partial = partialOf(failure)!;
    expect(partial.run).toBe(1);
    expect(partial.system).toBe('reference-pipeline');
    expect(partial.reached).toBe(1);
    expect(partial.baselineAnswers).toEqual(['answer-0']);
    expect(partial.featureAnswers).toEqual([]);
  });

  it('still attaches when a repetition dies on its first question, because run 0 finished', async () => {
    // The no-measurement boundary does NOT transfer from repetition 0, and this is the
    // assertion that says so. `attachPartial` refuses to attach when both vectors are
    // empty because such a partial is byte-identical to a broken capture -- but that is
    // an argument about repetition 0, the only repetition with nothing before it. A
    // death on repetition 1's first question leaves TWO HUNDRED questions graded across
    // the two sides, and the empty pair is then a statement -- "repetition 1 died before
    // it measured anything" -- rather than a broken capture. `run` is what carries that,
    // and it is non-zero here.
    //
    // The distinction is not academic: `38520676669` completed two repetitions and its
    // artifact said so nowhere.
    const dataset = datasetOf(2);
    const failure = await runAblation(
      dataset,
      // Repetition 0 on calls 1-2, repetition 1 on 3-4; the baseline dies on 3.
      countingSystem('reference-pipeline', 2, 3),
      countingSystem('cortex-memory', 2, 99),
      { runs: 2, scorer: exactMatchScorer },
    ).then(
      () => {
        throw new Error('the ablation resolved, but the baseline side threw');
      },
      (error: unknown) => error as Error,
    );

    expect(failure).toBeInstanceOf(TypeError);
    const partial = partialOf(failure);
    expect(partial).toBeDefined();
    expect(partial!.run).toBe(1);
    expect(partial!.reached).toBe(0);
    expect(partial!.baselineAnswers).toEqual([]);
    expect(partial!.featureAnswers).toEqual([]);
  });
});

/**
 * A repetition that FINISHED is as durable as the one that died.
 *
 * ## The loss this pins, and it is the same loss twice
 *
 * The block above quotes run `38520676669`: "completed repetitions 0 and 1 on both
 * sides -- two thousand graded answers -- and died on `TypeError: terminated` at
 * the start of repetition 2". The repair that closed it gave the DYING repetition a
 * sink and a catch. It did not carry the completed ones, and the file's own rule --
 * "a repetition is a measurement, and losing one silently is the defect that file
 * exists to prevent" -- was therefore still violated: two repetitions were lost,
 * and all that survived was the number that said how many had finished.
 *
 * Run `38941095220` is the second instance and it is exact. The reference pipeline's
 * repetition 0 completed 500 of 500, the arm's repetition 0 completed 500 of 500,
 * and the reference pipeline's repetition 1 died at question 391 on a raw
 * `TimeoutError`. The artifact it published was:
 *
 *     {"reached": 390, "total": 500, "run": 1, "baselineAnswers": [390], "featureAnswers": []}
 *
 * A complete, paired, N=500 measurement of repetition 0 -- both sides -- was in
 * memory when the failure path ran, and it was thrown away because `attachPartial`
 * is handed the dying repetition's two arrays and nothing else.
 *
 * ## What "durable" deliberately does not mean
 *
 * The completed repetitions are carried as DATA and nothing is computed from them.
 * `delta` still must not appear: the registered statistic is over four repetitions
 * and a run that finished one of them has a reading labelled `1 of 4`, not the
 * pre-registered one. This is the same boundary `PartialAblation` already draws one
 * field down -- a partial result carries the answers it has and does not carry a
 * delta -- and the reason it is drawn again here is that a recovered repetition is a
 * complete vector, which is exactly the shape that invites a subtraction.
 */
describe('a repetition that finished is durable, not only the one that died', () => {
  /** The failure of a multi-repetition ablation, where the ordinal matters. */
  async function repeatedFailureOf(
    dataset: BenchmarkDataset,
    baseline: MemorySystem,
    feature: MemorySystem,
    runs: number,
  ): Promise<Error> {
    return runAblation(dataset, baseline, feature, { runs, scorer: exactMatchScorer }).then(
      () => {
        throw new Error('the ablation resolved, but a system was asked to throw');
      },
      (error: unknown) => error as Error,
    );
  }

  it('carries the repetitions that completed before the failure', async () => {
    // `countingSystem` counts ITS OWN calls, so the feature's calls 1-5 are
    // repetition 0 and call 6 is the first question of repetition 1 -- the ordinal
    // is per system, which is why dying in a later repetition is expressed as a
    // larger `dieOnCall` on the feature alone.
    const dataset = datasetOf(5);
    const baseline = countingSystem('reference-pipeline', 5, Number.MAX_SAFE_INTEGER);
    const feature = countingSystem('cortex-memory', 5, 6);

    const failure = await repeatedFailureOf(dataset, baseline, feature, 3);

    const partial = partialOf(failure);
    expect(partial).toBeDefined();
    expect(partial!.run).toBe(1);
    expect(partial!.completed).toHaveLength(1);
    const completed = partial!.completed[0]!;
    expect(completed.run).toBe(0);
    expect(completed.baselineAnswers).toHaveLength(5);
    expect(completed.featureAnswers).toHaveLength(5);
  });

  it('carries the answers themselves, not a placeholder of the right length', async () => {
    // A vector of the right length holding `undefined` would satisfy every count
    // above and would be worth nothing, which is the failure mode a length-only
    // assertion invites.
    const dataset = datasetOf(5);
    const failure = await repeatedFailureOf(
      dataset,
      countingSystem('reference-pipeline', 5, Number.MAX_SAFE_INTEGER),
      countingSystem('cortex-memory', 5, 6),
      3,
    );

    const completed = partialOf(failure)!.completed[0]!;
    expect(completed.baselineAnswers).toEqual([
      'answer-0',
      'answer-1',
      'answer-2',
      'answer-3',
      'answer-4',
    ]);
    expect(completed.featureAnswers).toEqual([
      'answer-0',
      'answer-1',
      'answer-2',
      'answer-3',
      'answer-4',
    ]);
  });

  it('does not list the dying repetition among the completed ones', async () => {
    // `completed` and `run` must partition, or a reader would sum the completion
    // count and the dying ordinal and over-report how far the run got -- and the
    // over-report is in the direction of "more evidence than there is".
    const dataset = datasetOf(4);
    const failure = await repeatedFailureOf(
      dataset,
      countingSystem('reference-pipeline', 4, Number.MAX_SAFE_INTEGER),
      countingSystem('cortex-memory', 4, 5),
      3,
    );

    const partial = partialOf(failure)!;
    expect(partial.run).toBe(1);
    expect(partial.completed.map((pass) => pass.run)).toEqual([0]);
  });

  it('is empty when the failure is in the first repetition', async () => {
    // The control. If `completed` were populated by something other than a finished
    // pass -- a pre-allocated slot, say -- this is where it would show, because
    // nothing has finished yet. The feature dies on its own first call, which is
    // repetition 0's first question.
    const dataset = datasetOf(5);
    const failure = await repeatedFailureOf(
      dataset,
      countingSystem('reference-pipeline', 5, Number.MAX_SAFE_INTEGER),
      countingSystem('cortex-memory', 5, 1),
      3,
    );

    const partial = partialOf(failure)!;
    expect(partial.run).toBe(0);
    expect(partial.completed).toEqual([]);
  });

  it('accumulates every completed repetition, not just the first', async () => {
    // The feature's calls 1-5 are repetition 0, 6-10 repetition 1 and 11-15
    // repetition 2, so dying on its call 11 leaves repetitions 0 and 1 complete. A
    // `completed` that only ever held run 0 would pass the earlier tests and fail
    // this one.
    const dataset = datasetOf(5);
    const failure = await repeatedFailureOf(
      dataset,
      countingSystem('reference-pipeline', 5, Number.MAX_SAFE_INTEGER),
      countingSystem('cortex-memory', 5, 11),
      3,
    );

    const partial = partialOf(failure)!;
    expect(partial.run).toBe(2);
    expect(partial.completed.map((pass) => pass.run)).toEqual([0, 1]);
  });
});
