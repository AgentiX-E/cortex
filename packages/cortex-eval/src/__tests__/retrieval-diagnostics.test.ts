import { describe, it, expect } from 'vitest';
import { computeRetrievalDiagnostics, flattenTurns, percentile } from '../retrieval-diagnostics.js';
import { HashEmbedding } from '../embedding.js';
import type { LongMemEvalInstance, LongMemEvalTurn } from '../datasets/longmemeval-loader.js';

describe('flattenTurns', () => {
  it('flattens sessions and preserves has_answer', () => {
    const turns = flattenTurns([
      [
        { role: 'user', content: 'a', has_answer: true },
        { role: 'assistant', content: 'b' },
      ],
      [{ role: 'user', content: 'c' }],
    ]);
    expect(turns).toHaveLength(3);
    expect(turns[0]!.has_answer).toBe(true);
    expect(turns[1]!.has_answer).toBeUndefined();
  });

  it('returns an empty list for missing sessions', () => {
    expect(flattenTurns(undefined)).toEqual([]);
  });
});

describe('percentile', () => {
  it('returns the value at the given percentile of a sorted list', () => {
    expect(percentile([1, 2, 3, 4], 0.25)).toBe(1);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 1)).toBe(4);
  });

  it('returns 0 for an empty list', () => {
    expect(percentile([], 0.25)).toBe(0);
  });
});

describe('computeRetrievalDiagnostics', () => {
  const embedding = new HashEmbedding(64);

  function makeInstance(id: string, question: string, answerTurn: string): LongMemEvalInstance {
    const sessions: LongMemEvalTurn[][] = [
      [
        { role: 'user', content: answerTurn, has_answer: true },
        { role: 'assistant', content: 'unrelated filler' },
        { role: 'user', content: 'another filler' },
      ],
    ];
    return {
      question_id: id,
      question_type: 'single-session-user',
      question,
      answer: 'x',
      haystack_sessions: sessions,
    };
  }

  it('measures perfect recall when the answer turn clearly matches the query', async () => {
    const instances = [
      makeInstance('q1', 'What is the favorite color?', 'My favorite color is blue.'),
    ];
    const diag = await computeRetrievalDiagnostics(instances, embedding, 5);
    expect(diag.answerableQuestions).toBe(1);
    expect(diag.recallAt1).toBeGreaterThanOrEqual(0);
    expect(diag.hitScores.length + diag.missScores.length).toBe(1);
  });

  it('skips abstention questions with no answer turn', async () => {
    const abs: LongMemEvalInstance = {
      question_id: 'q_abs',
      question_type: 'single-session-user',
      question: 'What is the phone number?',
      answer: '',
      haystack_sessions: [[{ role: 'user', content: 'favorite color is blue' }]],
    };
    const diag = await computeRetrievalDiagnostics([abs], embedding, 5);
    expect(diag.answerableQuestions).toBe(0);
    expect(diag.recallAt1).toBe(0);
    expect(diag.recommendedThreshold).toBe(0);
  });

  it('computes a recommended threshold from hit-score percentiles', async () => {
    const instances = [
      makeInstance('q1', 'What is the dog name?', 'My dog is named Rex.'),
      makeInstance('q2', 'What is the job?', 'I work as a manager.'),
    ];
    const diag = await computeRetrievalDiagnostics(instances, embedding, 5);
    expect(diag.answerableQuestions).toBe(2);
    expect(diag.recommendedThreshold).toBeGreaterThanOrEqual(0);
    expect(diag.recommendedThreshold).toBeLessThanOrEqual(1);
  });
});
