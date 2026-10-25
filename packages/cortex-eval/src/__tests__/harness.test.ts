/**
 * The loop, and the two things that make its numbers trustworthy: an empty provider scores zero, and a
 * question without gold is excluded rather than counted as a miss.
 *
 * Both are cheap to check and expensive to discover later. A harness that quietly scores an unmeasurable
 * question as wrong reports every system as worse than it is, by an amount that depends on the dataset; a
 * harness whose floor is above zero reports differences that are arithmetic rather than retrieval.
 */

import { describe, expect, it } from 'vitest';
import { measureRetrieval, NullProvider, sessionsOf, type HarnessOptions } from '../harness.js';
import { LexicalProvider } from '../competitor.js';
import type { BenchmarkDataset, Question } from '../types.js';

function questionOf(overrides: Partial<Question> & Pick<Question, 'id'>): Question {
  return {
    capability: 'MR',
    question: 'Where does the user live?',
    expected: 'London',
    context: [],
    ...overrides,
  };
}

const DATASET: BenchmarkDataset = {
  name: 'fixture',
  questions: [
    questionOf({
      id: 'q1',
      question: 'Where does the user live now?',
      sessions: [['I live in London and work as an engineer in the city.']],
      goldTurns: ['I live in London and work as an engineer in the city.'],
    }),
    questionOf({
      id: 'q2',
      question: 'How many cats does the user have?',
      capability: 'KU',
      sessions: [
        ['I have one cat.'],
        ['We adopted a second cat and now have two cats in the city.'],
      ],
      goldTurns: ['We adopted a second cat and now have two cats in the city.'],
    }),
    questionOf({
      id: 'q3',
      question: 'What is the user working on?',
      capability: 'TR',
      sessions: [['I am rewriting the reporting layer.']],
      // No gold: excluded from every rate and counted, never scored as a miss.
    }),
  ],
};

const GOLD: HarnessOptions = { limit: 10 };

describe('measureRetrieval: the loop', () => {
  it('scores a lexical provider above zero, which is the minimum a working loop must do', async () => {
    const [score] = await measureRetrieval(DATASET, [new LexicalProvider()], GOLD);
    expect(score!.measured).toBe(2);
    expect(score!.found).toBeGreaterThan(0);
  });

  it('scores the null provider at exactly zero, so the floor is known', async () => {
    const [score] = await measureRetrieval(DATASET, [new NullProvider()], GOLD);
    expect(score!.found).toBe(0);
    expect(score!.recallAtK).toBe(0);
    expect(score!.mrr).toBe(0);
    expect(score!.empty).toBe(2);
  });

  it('reports both providers from one call, which is what makes them comparable', async () => {
    const scores = await measureRetrieval(
      DATASET,
      [new LexicalProvider(), new NullProvider()],
      GOLD,
    );
    expect(scores.map((score) => score.provider)).toEqual(['lexical-reference', 'null-floor']);
    expect(scores[0]!.recallAtK).toBeGreaterThan(scores[1]!.recallAtK);
  });

  it('excludes a question with no gold and counts it, rather than scoring it as a miss', async () => {
    const [score] = await measureRetrieval(DATASET, [new LexicalProvider()], GOLD);
    expect(score!.questions).toBe(3);
    expect(score!.measured).toBe(2);
    expect(score!.unmeasurable).toBe(1);
    // The rate is over the two measured questions: 1 of 2 would be 0.5, 1 of 3 would be 0.33.
    expect(score!.recallAtK).toBe(score!.found / 2);
  });

  it('counts the unmeasurable question in its capability bucket without inflating measured', async () => {
    const [score] = await measureRetrieval(DATASET, [new LexicalProvider()], GOLD);
    expect(score!.byCapability.TR).toEqual({ questions: 1, measured: 0, found: 0 });
    expect(score!.byCapability.KU!.measured).toBe(1);
  });

  it('lets the caller supply the gold, which is how a normalising provider is compared', async () => {
    const [score] = await measureRetrieval(DATASET, [new LexicalProvider()], {
      ...GOLD,
      goldOf: () => [],
    });
    expect(score!.measured).toBe(0);
    expect(score!.unmeasurable).toBe(3);
    expect(score!.recallAtK).toBe(0);
  });

  it('distinguishes containment from equality on a multi-turn session', async () => {
    // A one-turn session makes the two modes identical, so the fixture needs a session with two turns: the
    // provider returns both joined, and only containment can match one of them.
    const multi = questionOf({
      id: 'q7',
      question: 'Where does the user live now?',
      sessions: [['I live in London and work as an engineer in the city.', 'I have one cat.']],
      goldTurns: ['I have one cat.'],
    });
    const dataset: BenchmarkDataset = { name: 'multi', questions: [multi] };
    const [byContainment] = await measureRetrieval(dataset, [new LexicalProvider()], GOLD);
    const [byEquality] = await measureRetrieval(dataset, [new LexicalProvider()], {
      ...GOLD,
      hitsContainGold: false,
    });
    expect(byContainment!.found).toBe(1);
    expect(byEquality!.found).toBe(0);
  });

  it('reports all-gold coverage separately from any-gold coverage', async () => {
    const two = questionOf({
      id: 'q4',
      question: 'Where does the user live now?',
      sessions: [['I live in London and work as an engineer in the city.'], ['I have one cat.']],
      goldTurns: ['I live in London and work as an engineer in the city.', 'I have one cat.'],
    });
    const [score] = await measureRetrieval(
      { name: 'two', questions: [two] },
      [new LexicalProvider()],
      GOLD,
    );
    // Only the first session is about the question, so the second gold turn is unreachable at limit 1.
    expect(score!.found).toBe(1);
    expect(score!.foundAll).toBe(0);
    const [narrow] = await measureRetrieval(
      { name: 'two', questions: [two] },
      [new LexicalProvider()],
      {
        ...GOLD,
        limit: 1,
      },
    );
    expect(narrow!.foundAll).toBe(0);
  });

  it('measures the reciprocal rank of the first covered hit', async () => {
    // Both sessions are about the question, so both are returned and the gold is genuinely second. A fixture
    // where the first session is irrelevant ranks the gold first and cannot measure a reciprocal rank at all.
    const one = questionOf({
      id: 'q5',
      question: 'Where does the user live now?',
      sessions: [
        ['I have one cat and live in the city.'],
        ['I live in London and work as an engineer.'],
      ],
      goldTurns: ['I live in London and work as an engineer.'],
    });
    const [score] = await measureRetrieval(
      { name: 'one', questions: [one] },
      [new LexicalProvider()],
      GOLD,
    );
    expect(score!.found).toBe(1);
    // Second hit of two: the reciprocal rank is 1/2, and the mean over one measured question is the same.
    expect(score!.mrr).toBeCloseTo(0.5, 5);
  });

  it('returns a zero rate rather than NaN when nothing is measurable', async () => {
    const [score] = await measureRetrieval(
      { name: 'none', questions: [questionOf({ id: 'q6' })] },
      [new LexicalProvider()],
      GOLD,
    );
    expect(score!.recallAtK).toBe(0);
    expect(score!.mrr).toBe(0);
  });

  it('accumulates ingestion across questions in global mode and resets between them in isolated mode', async () => {
    const [isolated] = await measureRetrieval(DATASET, [new LexicalProvider()], GOLD);
    const [global] = await measureRetrieval(DATASET, [new LexicalProvider()], {
      ...GOLD,
      mode: 'global',
    });
    // Isolated: 1 + 2 + 1 sessions, each question alone. Global: the store grows, so the counts are 1, 3, 4.
    // The totals differ because the stores differ, which is why the mode belongs in the run configuration.
    expect(isolated!.sessions).toBe(4);
    expect(global!.sessions).toBe(8);
    expect(global!.found).toBeGreaterThanOrEqual(isolated!.found);
  });

  it('is deterministic: two runs over one fixture agree exactly', async () => {
    const first = await measureRetrieval(
      DATASET,
      [new LexicalProvider(), new NullProvider()],
      GOLD,
    );
    const second = await measureRetrieval(
      DATASET,
      [new LexicalProvider(), new NullProvider()],
      GOLD,
    );
    expect(first).toEqual(second);
  });
});

describe('sessionsOf: the benchmark history in the provider shape', () => {
  it('keeps session boundaries rather than flattening them', () => {
    const sessions = sessionsOf(
      questionOf({ id: 'q', sessions: [['a turn'], ['another turn', 'a second']] }),
    );
    expect(sessions.map((session) => session.turns.length)).toEqual([1, 2]);
  });

  it('falls back to one session per context turn when the dataset has no session structure', () => {
    const sessions = sessionsOf(questionOf({ id: 'q', context: ['one', 'two'] }));
    expect(sessions.map((session) => session.turns)).toEqual([
      [{ role: 'user', content: 'one' }],
      [{ role: 'user', content: 'two' }],
    ]);
  });

  it('uses the question date for every session and says so in the signature of the data', () => {
    const sessions = sessionsOf(
      questionOf({ id: 'q', questionDate: '2026-01-05', sessions: [['a'], ['b']] }),
    );
    expect(sessions.every((session) => session.at === Date.parse('2026-01-05'))).toBe(true);
  });

  it('uses zero when the dataset carries no date, rather than inventing one', () => {
    expect(sessionsOf(questionOf({ id: 'q', sessions: [['a']] }))[0]!.at).toBe(0);
  });

  it('ignores a date that does not parse', () => {
    expect(
      sessionsOf(questionOf({ id: 'q', questionDate: 'not a date', sessions: [['a']] }))[0]!.at,
    ).toBe(0);
  });

  it('names sessions by position, which is stable under normalisation', () => {
    const sessions = sessionsOf(questionOf({ id: 'q', sessions: [['a'], ['b']] }));
    expect(sessions.map((session) => session.id)).toEqual(['q#0', 'q#1']);
  });
});
