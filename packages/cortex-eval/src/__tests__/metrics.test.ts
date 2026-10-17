import { describe, it, expect } from 'vitest';
import {
  normalizeAnswer,
  exactMatch,
  computeMetrics,
  computeMetricsAsync,
  scoreEvaluation,
  mcnemarPValue,
  exactMatchScorer,
  judgeScorer,
  describeScorerChannels,
  scorerChannelStats,
  extractLeadingNumber,
  isCountingQuestion,
  numericAnswerVerdict,
  aggregate,
  cohensD,
  tTestPValue,
} from '../metrics.js';
import type { BenchmarkDataset, Question } from '../types.js';
import type { AnswerJudge } from '../judge.js';

const q = (capability: Question['capability'], expected: string | null): Question => ({
  id: `q-${capability}`,
  capability,
  question: 'q',
  expected,
  context: [],
});

describe('normalizeAnswer', () => {
  it('lowercases, trims, and collapses whitespace', () => {
    expect(normalizeAnswer('  New   York ')).toBe('new york');
    expect(normalizeAnswer('Blue')).toBe('blue');
  });

  it('coerces a JSON numeric answer to a string', () => {
    expect(normalizeAnswer(3)).toBe('3');
    expect(normalizeAnswer(3.5)).toBe('3.5');
  });
});

describe('exactMatch', () => {
  it('matches case-insensitively', () => {
    expect(exactMatch('Blue', 'blue')).toBe(true);
  });

  it('treats null expected as abstain-only', () => {
    expect(exactMatch(null, null)).toBe(true);
    expect(exactMatch('x', null)).toBe(false);
    expect(exactMatch(null, 'x')).toBe(false);
  });
});

describe('computeMetrics', () => {
  it('throws on answer count mismatch', () => {
    const ds: BenchmarkDataset = { name: 'd', questions: [q('IE', 'x')] };
    expect(() => computeMetrics(ds, [])).toThrow();
  });

  it('computes accuracy and abstention-aware accuracy', () => {
    const ds: BenchmarkDataset = {
      name: 'd',
      questions: [q('IE', 'a'), q('ABS', null)],
    };
    const m = computeMetrics(ds, ['a', null]);
    // Both answers are exact matches (abstention on an ABS question is correct).
    expect(m.accuracy).toBe(1);
    expect(m.abstentionRate).toBeCloseTo(0.5, 12);
    expect(m.abstentionCorrectRate).toBeCloseTo(1, 12);
    expect(m.abstentionAwareAccuracy).toBe(1);
  });

  it('tracks per-capability results', () => {
    const ds: BenchmarkDataset = {
      name: 'd',
      questions: [q('IE', 'a'), q('IE', 'b')],
    };
    const m = computeMetrics(ds, ['a', 'x']);
    expect(m.perCapability['IE'].total).toBe(2);
    expect(m.perCapability['IE'].correct).toBe(1);
    expect(m.perCapability['IE'].accuracy).toBeCloseTo(0.5, 12);
  });

  it('handles an empty dataset', () => {
    const m = computeMetrics({ name: 'd', questions: [] }, []);
    expect(m.accuracy).toBe(0);
    expect(m.abstentionCorrectRate).toBe(0);
  });
});

describe('aggregate', () => {
  it('throws on empty input', () => {
    expect(() => aggregate([])).toThrow();
  });

  it('computes min/max/avg/median', () => {
    const s = aggregate([0.2, 0.8, 0.4]);
    expect(s.min).toBe(0.2);
    expect(s.max).toBe(0.8);
    expect(s.avg).toBeCloseTo(0.4666, 3);
    expect(s.median).toBeCloseTo(0.4, 12);
  });

  it('averages the two middle values for even-length input', () => {
    expect(aggregate([1, 2, 3, 4]).median).toBeCloseTo(2.5, 12);
  });
});

describe('answer scorers', () => {
  it('exactMatchScorer mirrors exactMatch', () => {
    expect(exactMatchScorer(q('IE', 'blue'), 'Blue')).toBe(true);
    expect(exactMatchScorer(q('IE', 'blue'), 'red')).toBe(false);
    expect(exactMatchScorer(q('ABS', null), null)).toBe(true);
  });

  it('judgeScorer grades abstentions structurally', async () => {
    const judge: AnswerJudge = async () => true;
    const scorer = judgeScorer(judge);
    expect(await scorer(q('ABS', null), null)).toBe(true);
    expect(await scorer(q('ABS', null), 'wrong')).toBe(false);
    expect(await scorer(q('IE', 'x'), null)).toBe(false);
  });

  it('judgeScorer delegates non-abstention answers to the judge', async () => {
    const judge: AnswerJudge = async (_q, predicted, expected) => predicted === expected;
    const scorer = judgeScorer(judge);
    expect(await scorer(q('IE', 'blue'), 'blue')).toBe(true);
    expect(await scorer(q('IE', 'blue'), 'red')).toBe(false);
  });

  it('judgeScorer passes the judge template selected by the question type', async () => {
    // Without this wiring the official per-type templates are never used, and
    // the benchmark silently keeps grading everything as a default question.
    const seen: (string | undefined)[] = [];
    const judge: AnswerJudge = async (_q, _predicted, _expected, type) => {
      seen.push(type);
      return true;
    };
    const scorer = judgeScorer(judge);
    const typed = (questionType: string) => ({
      id: 't',
      capability: 'TR' as const,
      questionType,
      question: 'When did that happen?',
      expected: 'yesterday',
      context: [],
    });
    await scorer(typed('temporal-reasoning'), 'today');
    await scorer(typed('knowledge-update'), 'today');
    await scorer(typed('multi-session'), 'today');
    await scorer(typed('single-session-user'), 'today');
    expect(seen).toEqual(['temporal-reasoning', 'knowledge-update', 'default', 'default']);
  });

  it('judgeScorer routes an abstention question to the abstention template', async () => {
    const seen: (string | undefined)[] = [];
    const judge: AnswerJudge = async (_q, _predicted, _expected, type) => {
      seen.push(type);
      return true;
    };
    const scorer = judgeScorer(judge);
    // An abstention question sampled from the temporal category: the id carries
    // the `_abs` suffix but the nominal type is still temporal-reasoning.
    await scorer(
      {
        id: 'x_abs',
        capability: 'ABS' as const,
        questionType: 'temporal-reasoning_abs',
        question: 'How many days did I spend in Kyoto?',
        // Not null: the dataset stores the explanation as the gold, so the
        // scorer does not short-circuit on the structural abstention path.
        expected: 'You did not mention this information.',
        context: [],
      },
      'UNANSWERABLE',
    );
    expect(seen).toEqual(['abstention']);
  });

  it('judgeScorer grades counting questions numerically without the judge', async () => {
    let judgeCalled = false;
    const judge: AnswerJudge = async () => {
      judgeCalled = true;
      return true;
    };
    const scorer = judgeScorer(judge);
    const counting = (expected: string) => {
      const question = {
        id: 'c',
        capability: 'MR' as const,
        question: 'How many items?',
        expected,
        context: [],
      };
      return question;
    };
    // "3" vs "3" is accepted, and "5" vs "2" is rejected, both without the judge.
    expect(await scorer(counting('3'), '3')).toBe(true);
    expect(await scorer(counting('2'), '5')).toBe(false);
    expect(judgeCalled).toBe(false);
  });

  it('judgeScorer short-circuits exact string matches without the judge', async () => {
    let judgeCalled = false;
    const judge: AnswerJudge = async (_q, predicted, expected) => {
      judgeCalled = true;
      return predicted === expected;
    };
    const scorer = judgeScorer(judge);
    // Normalized equality is the strongest equivalence signal: no judge needed.
    expect(await scorer(q('IE', 'Paris'), 'Paris')).toBe(true);
    expect(await scorer(q('IE', 'Golden Retriever'), 'golden retriever')).toBe(true);
    expect(judgeCalled).toBe(false);
    // A non-matching answer still delegates to the judge.
    expect(await scorer(q('IE', 'Shanghai'), 'Beijing')).toBe(false);
    expect(judgeCalled).toBe(true);
  });

  it('judgeScorer tolerates a JSON numeric expected answer', async () => {
    const judge: AnswerJudge = async () => true;
    const scorer = judgeScorer(judge);
    // A dataset may store "3" as the JSON number 3; the exact-match short-circuit
    // must coerce it rather than crash on `.trim()`.
    const numericQuestion: Question = {
      id: 'n',
      capability: 'IE',
      question: 'q',
      expected: 3 as unknown as string,
      context: [],
    };
    expect(await scorer(numericQuestion, '3')).toBe(true);
  });
});

describe('numeric answer helpers', () => {
  it('extracts the leading number', () => {
    expect(extractLeadingNumber('5 distinct projects')).toBe(5);
    expect(extractLeadingNumber('  3.5 ')).toBe(3.5);
    expect(extractLeadingNumber('two')).toBeUndefined();
  });

  it('tolerates a leading currency sign and comma grouping', () => {
    expect(extractLeadingNumber('$185')).toBe(185);
    expect(extractLeadingNumber('$2,500')).toBe(2500);
  });

  it('returns undefined for verbose answers without a leading number', () => {
    // A digit embedded later (e.g. the "15" in "F-15") must not be mistaken for
    // the answer's leading number.
    expect(extractLeadingNumber('I have worked on F-15 and five kits')).toBeUndefined();
    expect(extractLeadingNumber('I viewed four properties, one a 1-bedroom condo')).toBeUndefined();
  });

  it('accepts a numeric answer stored as a JSON number', () => {
    // Some datasets store counting answers as JSON numbers, not strings.
    expect(extractLeadingNumber(3)).toBe(3);
    // A value that is neither a string nor a number has no leading number, and the
    // exported reader has to say so rather than throw: it is public API, and the
    // gate's own narrowing means nothing else in this package reaches this arm.
    expect(extractLeadingNumber(null)).toBeUndefined();
    expect(extractLeadingNumber(undefined)).toBeUndefined();
    expect(extractLeadingNumber({})).toBeUndefined();
    expect(numericAnswerVerdict('How many?', 3, 3)).toBe(true);
    expect(numericAnswerVerdict('How many?', 5, 2)).toBe(false);
  });

  it('detects counting questions', () => {
    expect(isCountingQuestion('How many items do I need?')).toBe(true);
    expect(isCountingQuestion('What is the number of items?')).toBe(true);
    expect(isCountingQuestion('What color is it?')).toBe(false);
  });

  it('returns a numeric verdict for counting questions with numeric answers', () => {
    expect(numericAnswerVerdict('How many?', '3', '3')).toBe(true);
    expect(numericAnswerVerdict('How many?', '5', '2')).toBe(false);
    expect(numericAnswerVerdict('How many?', '5 distinct projects', '2')).toBe(false);
  });

  it('returns undefined when numeric comparison does not apply', () => {
    expect(numericAnswerVerdict('What color?', 'blue', 'blue')).toBeUndefined();
    expect(numericAnswerVerdict('How many?', 'blue', '2')).toBeUndefined();
    expect(numericAnswerVerdict('How many?', '2', 'two')).toBeUndefined();
  });

  it('defers a gold that states more than one acceptable value to the judge', () => {
    // Observed in LongMemEval: the gold explicitly sanctions the alternative,
    // but the leading-number gate read only "11" and rejected a prediction of
    // "12 days" without ever consulting the judge.
    expect(
      numericAnswerVerdict(
        'What is the total number of days I spent in Japan and Chicago?',
        '12 days',
        '11 days (or 12 days, if April 15th to 22nd is considered as 8 days)',
      ),
    ).toBeUndefined();
  });

  it('still grades a gold that states a single value numerically', () => {
    expect(numericAnswerVerdict('How many?', '3', '3 days')).toBe(true);
    expect(numericAnswerVerdict('How many?', '5', '3 days')).toBe(false);
  });

  it('does not mistake a thousands separator or decimal point for a second value', () => {
    expect(numericAnswerVerdict('How much money?', '$2,500', '$2,500')).toBe(true);
    expect(numericAnswerVerdict('How many weeks?', '3.5 weeks', '3.5 weeks')).toBe(true);
  });

  it('defers a gold that offers several distinct values to the judge', () => {
    expect(numericAnswerVerdict('How many?', '4', '3 or 4')).toBeUndefined();
  });

  it('accepts a total that follows its own arithmetic', () => {
    // ## The defect this closes, and how it was found
    //
    // Run `38985220145` was the first run whose answers were the model's ANSWER
    // rather than its transcript (§13.40.5's repair). Its multi-session answers
    // therefore became ledgers:
    //
    //     10 days + 7 days = 17 days
    //     17
    //
    // and the gate read the LEADING number -- 10 -- compared it with the gold's 17
    // and returned false. Each of the quotes below is a record from that run that
    // the run itself marked wrong while the arithmetic in it is right:
    //
    //     gold "17 days"   answer "10 days + 7 days = 17 days / 17"
    //     gold "$2,500"    answer "$800 + $1,200 + $500 = $2,500 / $2,500"
    //     gold "$495"      answer "$225 + (20 x $7.5) + $120 = ... = $495."
    //     gold "190"       answer "440 total pages - 250 pages read = 190 pages left."
    //
    // 28 multi-session records flipped from false to true under this rule and
    // **none** flipped the other way, which is what makes it a correction rather
    // than a trade: the rule only ever accepts more, never less.
    expect(numericAnswerVerdict('How many days?', '10 days + 7 days = 17 days', '17 days')).toBe(
      true,
    );
    expect(
      numericAnswerVerdict('How much did I spend?', '$800 + $1,200 + $500 = $2,500', '$2,500'),
    ).toBe(true);
  });

  it('still rejects a wrong total however it was reached', () => {
    // The other half, and the reason the rule is "a number the answer states"
    // rather than "the last number it states": run `38985220145` also contains
    // `5 + 30 + 10 + 25 = 70 hours` against a gold of `140 hours`, and
    // `Distinct citrus fruits: orange, lemon, lime, grapefruit, yuzu = 5` against
    // a gold of `3`. Both are wrong totals and both must stay wrong.
    expect(
      numericAnswerVerdict('How many hours?', '5 + 30 + 10 + 25 = 70 hours', '140 hours'),
    ).toBe(false);
    expect(numericAnswerVerdict('How many citrus fruits?', '5 citrus fruits', '3')).toBe(false);
    // And the citrus record from that run, which does NOT lead with a number and
    // is therefore not this gate's to decide -- it defers, and the judge rejects
    // it. Written as `undefined` rather than `false` because the first version of
    // this test asserted `false` and was wrong: the gate that reads a leading
    // number cannot reject an answer that has none.
    expect(
      numericAnswerVerdict(
        'How many citrus fruits?',
        'Distinct citrus fruits: orange, lemon, lime, grapefruit, yuzu = 5',
        '3',
      ),
    ).toBeUndefined();
  });

  it('still rejects a leading number that is not the gold', () => {
    expect(numericAnswerVerdict('How many tanks?', '4 tanks', '3')).toBe(false);
    expect(numericAnswerVerdict('How many?', '5 distinct projects', '2')).toBe(false);
  });

  it('still defers an answer that does not lead with a number', () => {
    // The property that makes the widening monotone. `extractLeadingNumber` is
    // anchored to the start precisely so a verbose answer that embeds a digit is
    // not mistaken for a numeric one, and that deferral is load-bearing: the three
    // archived runs contain answers whose only numbers appear mid-prose, and they
    // reach the judge today. Accepting them here would make the gate answer
    // questions it was built to decline.
    expect(
      numericAnswerVerdict('How many?', 'Based on the evidence: five in total', '5'),
    ).toBeUndefined();
  });

  it('defers when an operand is not a value at all', () => {
    // `judgeScorer` returns before reaching here for a null answer, so this is the
    // gate's own contract rather than the scorer's: a value it cannot read is a
    // question it declines. Pinned because the narrowing that keeps `statedNumbers`
    // branch-total is only honest if its declining arm is exercised.
    expect(numericAnswerVerdict('How many?', null, '3')).toBeUndefined();
    expect(numericAnswerVerdict('How many?', '3', {})).toBeUndefined();
  });

  it('is a no-op for an answer whose leading number is its only number', () => {
    // The inertness that keeps every archived number comparable. Runs
    // `38595325261`, `38828538851` and `38953157688` were re-graded against this
    // rule offline: **0 verdicts change** in any of the three, because their
    // answers lead with the value the question asks for. Only run `38985220145`
    // shows a difference, and only in the direction this rule exists to fix.
    const cases: [string, string][] = [
      ['3', '3'],
      ['5', '2'],
      ['$2,500', '$2,500'],
      ['3.5 weeks', '3.5 weeks'],
      ['5 distinct projects', '2'],
    ];
    for (const [predicted, expected] of cases) {
      expect(numericAnswerVerdict('How many?', predicted, expected)).toBe(
        extractLeadingNumber(predicted) === extractLeadingNumber(expected),
      );
    }
  });

  it('handles a gold that carries no number at all', () => {
    // A gold with no digits leaves the numeric comparison undefined, so the
    // question reaches the judge instead of being rejected by the gate.
    expect(numericAnswerVerdict('How many?', '3', 'several')).toBeUndefined();
    expect(numericAnswerVerdict('How many?', '3', null)).toBeUndefined();
    expect(numericAnswerVerdict('How many?', '3', undefined)).toBeUndefined();
  });

  it('counts a numeric gold as a single value', () => {
    // A JSON-number gold is one value by construction, so the deferral rule
    // must not send it to the judge.
    expect(numericAnswerVerdict('How many?', 3, 3)).toBe(true);
    expect(numericAnswerVerdict('How many?', 5, 3)).toBe(false);
  });
});

describe('computeMetricsAsync', () => {
  it('throws on answer count mismatch', async () => {
    const ds: BenchmarkDataset = { name: 'd', questions: [q('IE', 'x')] };
    await expect(computeMetricsAsync(ds, [], exactMatchScorer)).rejects.toThrow();
  });

  it('computes accuracy with an async scorer', async () => {
    const ds: BenchmarkDataset = {
      name: 'd',
      questions: [q('IE', 'a'), q('ABS', null)],
    };
    const m = await computeMetricsAsync(ds, ['a', null], exactMatchScorer);
    expect(m.accuracy).toBe(1);
    expect(m.abstentionCorrectRate).toBeCloseTo(1, 12);
  });
});

describe('scoreEvaluation', () => {
  it('returns per-question correctness aligned with the dataset', async () => {
    const ds: BenchmarkDataset = {
      name: 'd',
      questions: [q('IE', 'a'), q('IE', 'b'), q('ABS', null)],
    };
    const scored = await scoreEvaluation(ds, ['a', 'wrong', null], exactMatchScorer);
    expect(scored.correct).toEqual([true, false, true]);
    expect(scored.metrics.correct).toBe(2);
  });

  it('handles an empty dataset', async () => {
    const scored = await scoreEvaluation({ name: 'd', questions: [] }, [], exactMatchScorer);
    expect(scored.correct).toEqual([]);
    expect(scored.metrics.accuracy).toBe(0);
    expect(scored.metrics.abstentionCorrectRate).toBe(0);
  });
});

describe('mcnemarPValue', () => {
  it('matches hand-computed exact binomial tails', () => {
    // One discordant pair cannot distinguish the systems: p = 2 * 0.5 = 1.
    expect(mcnemarPValue(0, 1)).toBeCloseTo(1, 12);
    // Five discordant pairs all favouring the feature: p = 2 * 0.5^5 = 0.0625.
    expect(mcnemarPValue(0, 5)).toBeCloseTo(0.0625, 12);
    // Ten discordant pairs all favouring the feature: p = 2 * 0.5^10.
    expect(mcnemarPValue(0, 10)).toBeCloseTo(0.001953125, 12);
  });

  it('returns 1 when the systems agree on every question', () => {
    expect(mcnemarPValue(0, 0)).toBe(1);
  });

  it('is symmetric in its arguments', () => {
    expect(mcnemarPValue(2, 5)).toBeCloseTo(mcnemarPValue(5, 2), 12);
  });

  it('rejects non-integer or negative counts', () => {
    expect(() => mcnemarPValue(-1, 0)).toThrow();
    expect(() => mcnemarPValue(0.5, 1)).toThrow();
  });
});

describe('cohensD and tTestPValue', () => {
  it('cohensD returns 0 for fewer than 2 samples', () => {
    expect(cohensD([1], [1, 2])).toBe(0);
  });

  it('cohensD is positive when feature mean exceeds baseline', () => {
    const d = cohensD([0.1, 0.2, 0.15], [0.9, 0.95, 0.85]);
    expect(d).toBeGreaterThan(0);
  });

  it('cohensD returns -Infinity for a perfect negative effect', () => {
    expect(cohensD([1, 1, 1], [0, 0, 0])).toBe(-Infinity);
  });

  it('cohensD returns +Infinity for a perfect positive effect', () => {
    // The mirror of the test above. Only the NEGATIVE direction had a test, so the
    // `mb > ma ? Infinity` arm of the zero-pooled branch was never taken — and that
    // arm is the one this function exists to report: a feature that wins on every
    // single run has an unbounded effect size, not a large finite one. Reporting it
    // as a number would understate it and imply a precision the data does not have.
    expect(cohensD([0, 0, 0], [1, 1, 1])).toBe(Infinity);
  });

  it('cohensD returns 0 for identical zero-variance samples', () => {
    expect(cohensD([1, 1, 1], [1, 1, 1])).toBe(0);
  });

  it('tTestPValue is tiny for clearly separated samples', () => {
    expect(tTestPValue([0.1, 0.2, 0.15], [0.9, 0.95, 0.85])).toBeLessThan(0.01);
  });
});

/**
 * The scorer reports WHICH channel decided each verdict.
 *
 * ## Why this is an instrument and not a convenience
 *
 * Run `38953157688` (`ask: enumerated`) raised MR's accuracy by 4.95pp, and the
 * rise was entirely decided by the LLM judge: across MR the mechanical channels --
 * normalized equality and the numeric gate -- decided 86 of 121 verdicts before the
 * ask changed and 33 after, and **not one of their post-change verdicts was true**,
 * while the median answer length went from 3 characters to 349. Every number the
 * register recorded for that ask was therefore a joint statement about the answer
 * contract and about `judgeScorer`'s tolerance of a long enumerated list, and the
 * register named only the first half.
 *
 * That split had to be reverse-engineered from the artifact offline, with a stubbed
 * judge, because nothing in the run reported it. This makes the run report it.
 *
 * ## What is counted, and why the four are enough
 *
 * A verdict leaves `judgeScorer` through one of exactly four doors: the structural
 * rule for a gold that expects an abstention, normalized equality, the numeric gate,
 * or the judge. Counting the doors is therefore exhaustive by construction rather
 * than by a convention a later edit could break, and the test below asserts the
 * identity so that a fifth door cannot be added without being counted.
 */
describe('scorerChannelStats', () => {
  const judge = async (): Promise<boolean> => true;

  /**
   * The change in each channel across `body`.
   *
   * A delta rather than an absolute, because the counters are cumulative and have no
   * reset: that is deliberate (one arm's process serves one run), and asserting the
   * change is the stronger form anyway -- a counter that had been zeroed between the
   * two reads would satisfy an absolute assertion and would prove less.
   */
  async function delta(body: () => Promise<void>): Promise<{
    structural: number;
    exact: number;
    numeric: number;
    judge: number;
    verdicts: number;
  }> {
    const before = scorerChannelStats();
    await body();
    const after = scorerChannelStats();
    return {
      structural: after.structural - before.structural,
      exact: after.exact - before.exact,
      numeric: after.numeric - before.numeric,
      judge: after.judge - before.judge,
      verdicts: after.verdicts - before.verdicts,
    };
  }

  it('attributes each verdict to the door it left by', async () => {
    const scorer = judgeScorer(judge as never);
    const moved = await delta(async () => {
      // structural: the gold expects an abstention, decided without any comparison.
      await scorer({ question: 'q', expected: null, questionType: undefined } as never, null);
      // exact: normalized equality, decided without the judge.
      await scorer({ question: 'q', expected: 'Paris', questionType: undefined } as never, 'paris');
      // numeric: the counting gate, decided without the judge.
      await scorer(
        { question: 'How many books?', expected: '3', questionType: undefined } as never,
        '3 books',
      );
      // judge: nothing mechanical could decide it. The stub returns true.
      await scorer(
        { question: 'Why did they move?', expected: 'for work', questionType: undefined } as never,
        'because of a new job',
      );
    });

    expect(moved).toEqual({ structural: 1, exact: 1, numeric: 1, judge: 1, verdicts: 4 });
  });

  it('does not charge a mechanically decided verdict to the judge', async () => {
    // The precision the whole instrument rests on. A counter that incremented
    // `judge` on every call would report the same total and would say nothing about
    // the shift that made run 38953157688 unreadable.
    let judgeCalls = 0;
    const counting = async (): Promise<boolean> => {
      judgeCalls += 1;
      return true;
    };
    const scorer = judgeScorer(counting as never);
    const moved = await delta(async () => {
      await scorer({ question: 'q', expected: 'Paris', questionType: undefined } as never, 'paris');
    });

    expect(judgeCalls).toBe(0);
    expect(moved.judge).toBe(0);
    expect(moved.exact).toBe(1);
  });

  it('the four doors partition the verdicts', async () => {
    // Asserted as an identity rather than intended, for the reason `RetryStats`
    // gives one package down: a partition that is only intended lets a fifth door
    // report nothing and leave the total still looking complete.
    const scorer = judgeScorer(judge as never);
    const cases: [string | null, string | null][] = [
      [null, null],
      [null, 'an answer where none was wanted'],
      ['Paris', 'paris'],
      ['Paris', 'London'],
      ['3', '4'],
      ['3', ''],
      ['for work', 'because of a new job'],
      ['for work', null],
    ];
    const moved = await delta(async () => {
      for (const [expected, answer] of cases) {
        await scorer(
          { question: 'How many books?', expected, questionType: undefined } as never,
          answer as never,
        );
      }
    });

    expect(moved.structural + moved.exact + moved.numeric + moved.judge).toBe(moved.verdicts);
    expect(moved.verdicts).toBe(cases.length);
    // Both abstention shapes are structural, and neither is scored as a match.
    expect(moved.structural).toBe(3);
  });
});

describe('describeScorerChannels', () => {
  it('names the share the judge decided, which is the number a reader needs', () => {
    const line = describeScorerChannels({
      structural: 0,
      exact: 37,
      numeric: 0,
      judge: 35,
      verdicts: 72,
    });
    expect(line).toContain('judge 35/72 = 48.6%');
    expect(line).toContain('exact 37');
  });

  it('does not divide by zero before any verdict', () => {
    const line = describeScorerChannels({
      structural: 0,
      exact: 0,
      numeric: 0,
      judge: 0,
      verdicts: 0,
    });
    expect(line).toContain('judge 0/0 = n/a');
  });
});
