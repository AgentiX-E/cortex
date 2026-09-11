/**
 * Tests for the between-run variance analyzer.
 *
 * This module exists because the P4 iteration discovered that two runs of a
 * byte-identical configuration differed on 25 of 500 questions — sixteen times
 * the two-question floor that every prior verdict reasoned against. The
 * analyzer's job is to turn a set of config-identical observations into a single
 * number an arm must beat, and to expose how many questions actually changed
 * state between any two of them.
 *
 * The tests below pin the arithmetic, not the intent: `questions first,
 * percentages second`, because percentages hide the sample size and the sample
 * size is what P4 got wrong twice.
 */

import { describe, expect, it } from 'vitest';

import { compareQuestionVectors, requiredEffectSize, summarizeVariance } from '../variance.js';
import type { RunObservation } from '../variance.js';

/** Build an observation from a compact "which questions are correct" spec. */
function observation(
  runId: string,
  vectors: Record<string, readonly boolean[]>,
  correctOverride?: number,
): RunObservation {
  const perCapability: Record<string, { correct: number; total: number }> = {};
  for (const [capability, vector] of Object.entries(vectors)) {
    perCapability[capability] = {
      correct: vector.filter(Boolean).length,
      total: vector.length,
    };
  }
  return {
    runId,
    perCapability,
    correct: correctOverride ?? Object.values(perCapability).reduce((a, b) => a + b.correct, 0),
    total: Object.values(perCapability).reduce((a, b) => a + b.total, 0),
  };
}

describe('summarizeVariance', () => {
  it('throws on an empty observation list rather than inventing a spread', () => {
    // A spread over zero observations is not zero — it is undefined. Returning 0
    // here would read as "perfectly stable", which is the most dangerous possible
    // wrong answer for this module.
    expect(() => summarizeVariance([])).toThrow(/at least one observation/);
  });

  it('reports a zero spread for a single observation, and flags it as degenerate', () => {
    const summary = summarizeVariance([
      observation('r1', { IE: [true, true, false], TR: [true, false, false] }),
    ]);

    expect(summary.n).toBe(1);
    // One observation cannot demonstrate stability — it can only fail to
    // demonstrate instability. The flag makes that distinction visible to callers
    // instead of letting them mistake n=1 for "zero drift".
    expect(summary.sufficient).toBe(false);

    const ie = summary.perCapability.IE!;
    expect(ie.n).toBe(1);
    expect(ie.minCorrect).toBe(2);
    expect(ie.maxCorrect).toBe(2);
    expect(ie.rangeQuestions).toBe(0);
    expect(ie.spreadPp).toBe(0);
    expect(ie.sdQuestions).toBe(0);
    expect(ie.accuracy).toBeCloseTo(2 / 3, 10);
  });

  it('computes range and sd in questions, not just percentages', () => {
    // AC@1 counts per run across three config-identical observations: 2, 3, 2.
    // Range 1 question; sd = sqrt(((2-7/3)^2 + (3-7/3)^2 + (2-7/3)^2)/3).
    const summary = summarizeVariance([
      observation('r1', { IE: [true, true, false, false] }),
      observation('r2', { IE: [true, true, true, false] }),
      observation('r3', { IE: [true, true, false, false] }),
    ]);

    const ie = summary.perCapability.IE!;
    expect(ie.n).toBe(3);
    expect(ie.minCorrect).toBe(2);
    expect(ie.maxCorrect).toBe(3);
    expect(ie.rangeQuestions).toBe(1);
    expect(ie.meanCorrect).toBeCloseTo(7 / 3, 10);
    expect(ie.sdQuestions).toBeCloseTo(Math.sqrt(2 / 9), 10);
    // Each run graded 4 questions, so a 1-question swing is 25 pp — and it is 25
    // pp whether the observations are pooled or taken one run at a time.
    expect(ie.spreadPp).toBeCloseTo(25, 10);
    expect(ie.accuracy).toBeCloseTo(7 / 12, 10);
  });

  it('normalizes the range by one run, not by the pooled sample', () => {
    // The bug this guards: dividing a single-run swing by a multiplied
    // denominator. Run 1 varies by 1 question on a 4-question sample = 25 pp; run
    // 2 saturates the same 4-question sample. A pooled denominator of 8 would
    // report 12.5 pp and understate the swing by half.
    const summary = summarizeVariance([
      observation('r1', { IE: [true, true, false, false] }),
      observation('r2', { IE: [true, true, true, false] }),
    ]);

    expect(summary.perCapability.IE!.rangeQuestions).toBe(1);
    expect(summary.perCapability.IE!.spreadPp).toBeCloseTo(25, 10);
  });

  it('uses the smallest sample when observations examined different sample sizes', () => {
    // Conservative by construction: widening the denominator would narrow the
    // reported floor, and a floor that is too low is how an arm gets promoted on
    // noise.
    const summary = summarizeVariance([
      observation('r1', { IE: [true, true, false, false] }),
      observation('r2', { IE: [true, true, true, true, true, true] }),
    ]);

    // Range is 4 questions (6 correct minus 2). The smaller sample is 4, so 4/4 =
    // 100 pp, not 4/6 = 66.67 pp.
    expect(summary.perCapability.IE!.rangeQuestions).toBe(4);
    expect(summary.perCapability.IE!.spreadPp).toBeCloseTo(100, 10);
  });

  it('uses the population sd, so an all-identical set reports exactly zero', () => {
    // Sample sd (n-1) is undefined for n=1 and inflates for small n; a spread
    // meant to be compared against an arm's effect must not carry that bias.
    const summary = summarizeVariance([
      observation('r1', { IE: [true, false, true] }),
      observation('r2', { IE: [true, false, true] }),
      observation('r3', { IE: [true, false, true] }),
    ]);

    const ie = summary.perCapability.IE!;
    expect(ie.rangeQuestions).toBe(0);
    expect(ie.sdQuestions).toBe(0);
    expect(ie.spreadPp).toBe(0);
  });

  it('tracks each capability independently instead of pooling them', () => {
    const summary = summarizeVariance([
      observation('r1', { IE: [true, true], TR: [true, false], ABS: [true] }),
      observation('r2', { IE: [true, true], TR: [false, false], ABS: [true] }),
    ]);

    expect(summary.perCapability.IE!.rangeQuestions).toBe(0);
    expect(summary.perCapability.TR!.rangeQuestions).toBe(1);
    expect(summary.perCapability.ABS!.rangeQuestions).toBe(0);
    expect(Object.keys(summary.perCapability).sort()).toEqual(['ABS', 'IE', 'TR']);
  });

  it('omits a capability that no observation reports', () => {
    // A capability absent from every run is not a zero-accuracy capability; it is
    // an unmeasured one, and inventing a bucket for it would fabricate evidence.
    const summary = summarizeVariance([
      observation('r1', { IE: [true] }),
      observation('r2', { IE: [false] }),
    ]);

    expect(summary.perCapability.TR).toBeUndefined();
    expect(summary.perCapability.IE!.rangeQuestions).toBe(1);
  });

  it('falls back to the capability buckets when the overall count is absent', () => {
    // Ragged inputs happen when a run drops a capability from its sample. The
    // summary must state its own n per capability rather than assume a rectangle.
    const ragged: RunObservation = {
      runId: 'r1',
      perCapability: { IE: { correct: 2, total: 2 }, TR: { correct: 0, total: 2 } },
      total: 4,
    } as unknown as RunObservation;
    delete (ragged as { correct?: number }).correct;

    const summary = summarizeVariance([ragged, observation('r2', { IE: [true, true] })]);

    expect(summary.perCapability.IE!.n).toBe(2);
    expect(summary.perCapability.TR!.n).toBe(1);
    // The absent overall is reconstructed from the buckets: 2 correct of 4.
    expect(summary.series.overall[0]).toBe(2);
  });

  it('summarizes the overall count exactly as it does a capability', () => {
    const summary = summarizeVariance([
      observation('r1', { IE: [true, true], TR: [false, false] }),
      observation('r2', { IE: [true, false], TR: [true, true] }),
    ]);

    expect(summary.overall.n).toBe(2);
    expect(summary.overall.minCorrect).toBe(2);
    expect(summary.overall.maxCorrect).toBe(3);
    expect(summary.overall.rangeQuestions).toBe(1);
    // 1 of 4 questions = 25 pp.
    expect(summary.overall.spreadPp).toBeCloseTo(25, 10);
  });

  it('derives the overall count from the capability buckets when absent', () => {
    const noOverall: RunObservation = {
      runId: 'r1',
      perCapability: { IE: { correct: 2, total: 2 }, TR: { correct: 0, total: 2 } },
      total: 4,
    } as unknown as RunObservation;

    const summary = summarizeVariance([noOverall, observation('r2', { IE: [true], TR: [true] })]);

    // The absent overall is reconstructed from the buckets: 2 correct of 4.
    expect(summary.series.overall).toEqual([2, 2]);
  });

  it('marks two or more observations as sufficient to state a spread', () => {
    const summary = summarizeVariance([
      observation('r1', { IE: [true] }),
      observation('r2', { IE: [true] }),
    ]);

    expect(summary.sufficient).toBe(true);
  });

  it('orders the reported series chronologically by the order given', () => {
    // The plan requires chronological reporting so a monotonic trend (drift) is
    // distinguishable from stationary noise; the analyzer must not sort by value,
    // or every series would look like a trend.
    const summary = summarizeVariance([
      observation('r1', { IE: [true, false, false] }),
      observation('r2', { IE: [true, true, false] }),
      observation('r3', { IE: [true, true, true] }),
    ]);

    expect(summary.series.perCapability.IE).toEqual([1, 2, 3]);
    expect(summary.series.overall).toEqual([1, 2, 3]);
  });

  it('exposes each capability series with its run ids, in the given order', () => {
    const summary = summarizeVariance([
      observation('run-a', { IE: [true] }),
      observation('run-b', { IE: [false] }),
    ]);

    expect(summary.runIds).toEqual(['run-a', 'run-b']);
    expect(summary.series.perCapability.IE).toEqual([1, 0]);
  });
});

describe('compareQuestionVectors', () => {
  it('reports every question stable when the two runs agree exactly', () => {
    const result = compareQuestionVectors(
      ['a', 'b', 'c'],
      [true, false, true],
      [true, false, true],
    );

    expect(result.compared).toBe(3);
    expect(result.stable).toBe(3);
    expect(result.flippedIn).toBe(0);
    expect(result.flippedOut).toBe(0);
    expect(result.changed).toBe(0);
    expect(result.changedRate).toBe(0);
    expect(result.discordant).toEqual([]);
  });

  it('separates questions the second run repaired from those it broke', () => {
    // Asymmetry is the whole point: a run that repairs 5 and breaks 5 has the same
    // accuracy as one that changes nothing, but is far less trustworthy.
    const result = compareQuestionVectors(
      ['a', 'b', 'c', 'd'],
      [true, false, true, false],
      [true, true, false, false],
    );

    expect(result.compared).toBe(4);
    expect(result.stable).toBe(2);
    expect(result.flippedIn).toBe(1);
    expect(result.flippedOut).toBe(1);
    expect(result.changed).toBe(2);
    expect(result.changedRate).toBeCloseTo(0.5, 10);
    expect(result.discordant).toEqual([
      { questionId: 'b', from: false, to: true },
      { questionId: 'c', from: true, to: false },
    ]);
  });

  it('counts a fully inverted run as every question changed', () => {
    const result = compareQuestionVectors(['a', 'b'], [true, false], [false, true]);

    expect(result.stable).toBe(0);
    expect(result.changed).toBe(2);
    expect(result.flippedIn).toBe(1);
    expect(result.flippedOut).toBe(1);
  });

  it('reports a changed rate of zero for an empty comparison instead of NaN', () => {
    const result = compareQuestionVectors([], [], []);

    expect(result.compared).toBe(0);
    expect(result.changed).toBe(0);
    // A rate over an empty denominator is not 0/0; it is undefined, and NaN would
    // silently poison any downstream average.
    expect(result.changedRate).toBe(0);
  });

  it('rejects vectors whose lengths disagree with the id list', () => {
    // Misaligned vectors would compare question i of one run against question j of
    // another, producing a plausible-looking number from meaningless data. That is
    // exactly the failure mode this module was written to catch, so it must fail
    // loudly here.
    expect(() => compareQuestionVectors(['a', 'b'], [true], [true, false])).toThrow(
      /first vector length 1 is not 2/,
    );
    expect(() => compareQuestionVectors(['a'], [true], [true, false])).toThrow(
      /second vector length 2 is not 1/,
    );
  });

  it('matches question ids between runs by position, not by identity', () => {
    // Runs are compared on their shared sample, which the harness guarantees is
    // order-aligned. Positional comparison is what makes the ids meaningful.
    const result = compareQuestionVectors(
      ['q1', 'q2', 'q3'],
      [true, true, true],
      [true, true, false],
    );

    expect(result.discordant).toEqual([{ questionId: 'q3', from: true, to: false }]);
  });
});

describe('requiredEffectSize', () => {
  it('requires an arm to exceed the largest observed single-run swing', () => {
    // With four config-identical observations the operative figure is the total
    // range: an arm of exactly that size changes no more questions than the
    // endpoint changes on its own.
    const summary = summarizeVariance([
      observation('r1', { IE: [true, true, false, false] }),
      observation('r2', { IE: [true, true, true, false] }),
      observation('r3', { IE: [true, true, false, false] }),
      observation('r4', { IE: [true, true, true, true] }),
    ]);

    const required = requiredEffectSize(summary);

    expect(required.overall.rangeQuestions).toBe(2);
    expect(required.overall.floorPp).toBeCloseTo(50, 10);
    // The bar is strictly greater than the floor, not equal to it: matching the
    // noise is not clearing it.
    expect(required.overall.minQuestionsStrictlyGreaterThan).toBe(3);
    expect(required.perCapability.IE!.minQuestionsStrictlyGreaterThan).toBe(3);
  });

  it('derives the required count from the capability it is asked about', () => {
    const summary = summarizeVariance([
      observation('r1', { IE: [true, true, true, true], TR: [true, false, false, false] }),
      observation('r2', { IE: [true, true, true, false], TR: [true, true, true, true] }),
    ]);

    const required = requiredEffectSize(summary);

    // IE moved 1 question, TR moved 3, so the TR bar is the higher one.
    expect(required.perCapability.IE!.minQuestionsStrictlyGreaterThan).toBe(2);
    expect(required.perCapability.TR!.minQuestionsStrictlyGreaterThan).toBe(4);
  });

  it('still produces a bar of one question when the endpoint never moved', () => {
    // A perfectly stable endpoint must not lower the bar to zero: an arm that
    // changes zero questions has demonstrated nothing.
    const summary = summarizeVariance([
      observation('r1', { IE: [true, false] }),
      observation('r2', { IE: [true, false] }),
    ]);

    const required = requiredEffectSize(summary);

    expect(required.overall.rangeQuestions).toBe(0);
    expect(required.overall.minQuestionsStrictlyGreaterThan).toBe(1);
  });

  it('refuses to derive a bar from a single observation', () => {
    // n=1 has no spread to measure, so any bar derived from it is fabricated.
    const summary = summarizeVariance([observation('r1', { IE: [true, false] })]);

    expect(() => requiredEffectSize(summary)).toThrow(/at least two observations/);
  });

  it('carries the observation count so a caller can see what the bar rests on', () => {
    const summary = summarizeVariance([
      observation('r1', { IE: [true] }),
      observation('r2', { IE: [true] }),
    ]);

    expect(requiredEffectSize(summary).basedOnObservations).toBe(2);
  });
});
