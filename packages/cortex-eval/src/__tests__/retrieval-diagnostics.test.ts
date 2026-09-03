import { describe, it, expect } from 'vitest';
import type { EmbeddingModel } from '@agentix-e/cortex-core';
import {
  computeRetrievalDiagnostics,
  computeSessionRetrievalDiagnostics,
  checkEmbeddingDeterminism,
  flattenTurns,
  percentile,
} from '../retrieval-diagnostics.js';
import { HashEmbedding } from '../embedding.js';
import { clearEmbeddingCache } from '../retrieval.js';
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

describe('checkEmbeddingDeterminism', () => {
  it('returns zero for a deterministic embedding', async () => {
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => texts.map(() => new Float64Array([1, 2, 3, 4])),
    };
    expect(await checkEmbeddingDeterminism(embedding, ['a', 'b'])).toBe(0);
  });

  it('returns the maximum drift for a non-deterministic embedding', async () => {
    let flip = false;
    const embedding: EmbeddingModel = {
      dimension: () => 2,
      embed: async (texts) => {
        flip = !flip;
        return texts.map(() => new Float64Array(flip ? [1, 2] : [3, 4]));
      },
    };
    expect(await checkEmbeddingDeterminism(embedding, ['a'])).toBe(2);
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

  it('never embeds assistant turns', async () => {
    // The single-session path filters assistant turns before retrieval; the
    // diagnostics must do the same, or it bills for vectors the system never
    // uses and measures recall on a retrieval the system does not perform.
    const embedded: string[] = [];
    const recording: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => {
        embedded.push(...texts);
        return texts.map(() => new Float64Array([0, 0, 0, 0]));
      },
    };
    clearEmbeddingCache();
    const instance: LongMemEvalInstance = {
      question_id: 'q1',
      question_type: 'single-session-user',
      question: 'What is the favorite color?',
      answer: 'blue',
      haystack_sessions: [
        [
          { role: 'user', content: 'My favorite color is blue.', has_answer: true },
          { role: 'assistant', content: 'A long generated reply that must not be embedded.' },
        ],
      ],
    };
    await computeRetrievalDiagnostics([instance], recording, 5);
    expect(embedded.some((t) => t.includes('assistant:'))).toBe(false);
    expect(embedded.some((t) => t.includes('My favorite color is blue'))).toBe(true);
  });
});

describe('computeSessionRetrievalDiagnostics', () => {
  const embedding = new HashEmbedding(64);

  function makeInstance(
    id: string,
    question: string,
    answerSessions: string[][],
  ): LongMemEvalInstance {
    const sessions: LongMemEvalTurn[][] = answerSessions.map((contents) =>
      contents.map((content, i) => ({
        role: 'user',
        content,
        has_answer: i === 0,
      })),
    );
    return {
      question_id: id,
      question_type: 'multi-session',
      question,
      answer: 'x',
      haystack_sessions: sessions,
    };
  }

  it('measures session-level recall and score distributions', async () => {
    const instances = [
      makeInstance('q1', 'What is the favorite color?', [
        ['My favorite color is blue.'],
        ['unrelated session'],
      ]),
    ];
    const diag = await computeSessionRetrievalDiagnostics(instances, embedding, 5);
    expect(diag.answerableQuestions).toBe(1);
    expect(diag.recallAt1).toBeGreaterThanOrEqual(0);
    expect(diag.recallAtK).toBeGreaterThanOrEqual(0);
    expect(diag.hitScores.length + diag.missScores.length).toBe(1);
  });

  it('skips abstention questions with no answer session', async () => {
    const abs: LongMemEvalInstance = {
      question_id: 'q_abs',
      question_type: 'multi-session',
      question: 'What is the phone number?',
      answer: '',
      haystack_sessions: [[{ role: 'user', content: 'favorite color is blue' }]],
    };
    const diag = await computeSessionRetrievalDiagnostics([abs], embedding, 5);
    expect(diag.answerableQuestions).toBe(0);
    expect(diag.recallAt1).toBe(0);
    expect(diag.recallAtK).toBe(0);
    expect(diag.recommendedThreshold).toBe(0);
  });

  it('records a miss when the answer session is not the top-1 session', async () => {
    const controlled: EmbeddingModel = {
      dimension: () => 2,
      embed: async (texts) =>
        texts.map((t) => {
          if (t.includes('distractor') || t === 'question') {
            return new Float64Array([1, 0]);
          }
          return new Float64Array([0, 1]);
        }),
    };
    const instance: LongMemEvalInstance = {
      question_id: 'q1',
      question_type: 'multi-session',
      question: 'question',
      answer: 'x',
      haystack_sessions: [
        [{ role: 'user', content: 'answer turn', has_answer: true }],
        [{ role: 'user', content: 'distractor turn' }],
      ],
    };
    const diag = await computeSessionRetrievalDiagnostics([instance], controlled, 5);
    expect(diag.answerableQuestions).toBe(1);
    expect(diag.recallAt1).toBe(0);
    expect(diag.hitScores).toEqual([]);
    expect(diag.missScores).toHaveLength(1);
  });

  it('never embeds assistant turns', async () => {
    // The multi-session path filters assistant turns before retrieval; the
    // session diagnostics must match, or it bills for vectors the system never
    // uses and measures recall on a session index the system never builds.
    const embedded: string[] = [];
    const recording: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => {
        embedded.push(...texts);
        return texts.map(() => new Float64Array([0, 0, 0, 0]));
      },
    };
    clearEmbeddingCache();
    const instance: LongMemEvalInstance = {
      question_id: 'q1',
      question_type: 'multi-session',
      question: 'What did I mention?',
      answer: 'x',
      haystack_sessions: [
        [
          { role: 'user', content: 'I mentioned the trip.', has_answer: true },
          { role: 'assistant', content: 'A long generated reply that must not be embedded.' },
        ],
      ],
    };
    await computeSessionRetrievalDiagnostics([instance], recording, 5);
    expect(embedded.some((t) => t.includes('assistant:'))).toBe(false);
    expect(embedded.some((t) => t.includes('I mentioned the trip'))).toBe(true);
  });
});
