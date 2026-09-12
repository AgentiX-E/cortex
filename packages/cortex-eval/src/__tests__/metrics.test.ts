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

  it('cohensD returns 0 for identical zero-variance samples', () => {
    expect(cohensD([1, 1, 1], [1, 1, 1])).toBe(0);
  });

  it('tTestPValue is tiny for clearly separated samples', () => {
    expect(tTestPValue([0.1, 0.2, 0.15], [0.9, 0.95, 0.85])).toBeLessThan(0.01);
  });
});
