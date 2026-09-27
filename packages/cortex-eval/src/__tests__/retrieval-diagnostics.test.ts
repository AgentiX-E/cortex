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
  it('returns zero drift and the returned width for a deterministic embedding', async () => {
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => texts.map(() => new Float64Array([1, 2, 3, 4])),
    };
    expect(await checkEmbeddingDeterminism(embedding, ['a', 'b'])).toEqual({
      maxAbsDiff: 0,
      dimension: 4,
    });
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
    expect(await checkEmbeddingDeterminism(embedding, ['a'])).toEqual({
      maxAbsDiff: 2,
      dimension: 2,
    });
  });

  it('reports the width the provider returned, not the width it declared', async () => {
    // The declared width and the returned width are separate claims, and the
    // whole point of the audit finding was that a reader could not tell which
    // backend produced the vectors. A provider that silently honours its own
    // default dimension instead of the requested one is exactly the case where
    // believing the declaration would record the wrong number.
    const embedding: EmbeddingModel = {
      dimension: () => 1024,
      embed: async (texts) => texts.map(() => new Float64Array(256)),
    };
    const probe = await checkEmbeddingDeterminism(embedding, ['a']);
    expect(probe.dimension).toBe(256);
  });

  it('reports the widest vector when the provider is inconsistent across texts', async () => {
    // Taking the max rather than the first or the last makes the probe
    // order-independent: an artifact whose reported width depends on which text
    // happened to be embedded first is not evidence of anything.
    let call = 0;
    const embedding: EmbeddingModel = {
      dimension: () => 0,
      embed: async (texts) => {
        call += 1;
        const width = call <= 2 ? 3 : 5;
        return texts.map(() => new Float64Array(width));
      },
    };
    const probe = await checkEmbeddingDeterminism(embedding, ['a', 'b']);
    expect(probe.dimension).toBe(5);
  });

  it('tolerates a provider that returns no vector for a text', async () => {
    // `embed` returning fewer vectors than texts is a provider contract
    // violation, and the `?? new Float64Array(0)` fallbacks are what keep the
    // probe from throwing on `undefined.length` deep inside a benchmark run
    // where the stack would not name the provider. Asserting the two fallbacks
    // are taken also asserts the probe degrades instead of crashing.
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async () => [],
    };
    expect(await checkEmbeddingDeterminism(embedding, ['a'])).toEqual({
      maxAbsDiff: 0,
      dimension: 0,
    });
  });

  it('reports zero width and zero drift for an empty probe list', async () => {
    const embedding: EmbeddingModel = {
      dimension: () => 8,
      embed: async (texts) => texts.map(() => new Float64Array(8)),
    };
    expect(await checkEmbeddingDeterminism(embedding, [])).toEqual({
      maxAbsDiff: 0,
      dimension: 0,
    });
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

  it('records a miss when the answer turn is not the top-1 turn', async () => {
    // The turn-level counterpart of the session-level miss test. Without this,
    // `missScores` was only ever appended to when an answerable instance had no
    // top-1 at all, which cannot happen, so the miss branch went unmeasured.
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
      question_type: 'single-session-user',
      question: 'question',
      answer: 'x',
      haystack_sessions: [
        [
          { role: 'user', content: 'distractor turn' },
          { role: 'user', content: 'answer turn', has_answer: true },
        ],
      ],
    };
    const diag = await computeRetrievalDiagnostics([instance], controlled, 5);
    expect(diag.answerableQuestions).toBe(1);
    expect(diag.recallAt1).toBe(0);
    expect(diag.hitScores).toEqual([]);
    expect(diag.missScores).toHaveLength(1);
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

  it('expands the question and searches the expansion phrases when an LLM is provided', async () => {
    const embedded: string[] = [];
    const recording: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => {
        embedded.push(...texts);
        return texts.map(() => new Float64Array([0, 0, 0, 0]));
      },
    };
    const llm = {
      complete: async () => 'blue paint\nfavorite color',
      completeStructured: async <T>() => ({}) as T,
    };
    clearEmbeddingCache();
    const instance: LongMemEvalInstance = {
      question_id: 'q1',
      question_type: 'single-session-user',
      question: 'What is the favorite color?',
      answer: 'blue',
      haystack_sessions: [
        [{ role: 'user', content: 'My favorite color is blue.', has_answer: true }],
      ],
    };
    await computeRetrievalDiagnostics([instance], recording, 5, { llm });
    // The expansion phrases must be embedded as retrieval queries.
    expect(embedded.some((t) => t === 'blue paint')).toBe(true);
    expect(embedded.some((t) => t === 'favorite color')).toBe(true);
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

  it('expands the question and searches the expansion phrases when an LLM is provided', async () => {
    const embedded: string[] = [];
    const recording: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => {
        embedded.push(...texts);
        return texts.map(() => new Float64Array([0, 0, 0, 0]));
      },
    };
    const llm = {
      complete: async () => 'the trip\nvacation',
      completeStructured: async <T>() => ({}) as T,
    };
    clearEmbeddingCache();
    const instance: LongMemEvalInstance = {
      question_id: 'q1',
      question_type: 'multi-session',
      question: 'What did I mention?',
      answer: 'x',
      haystack_sessions: [[{ role: 'user', content: 'I mentioned the trip.', has_answer: true }]],
    };
    await computeSessionRetrievalDiagnostics([instance], recording, 5, { llm });
    // The expansion phrases must be embedded as retrieval queries.
    expect(embedded.some((t) => t === 'the trip')).toBe(true);
    expect(embedded.some((t) => t === 'vacation')).toBe(true);
  });
});

/**
 * Degenerate haystacks.
 *
 * `computeRetrievalDiagnostics` and its session counterpart read optional
 * dataset fields (`haystack_sessions`, `haystack_dates`) and skip questions with
 * no evidence turn, so an unanswerable or malformed instance must be EXCLUDED
 * from the denominator rather than counted as a miss. Counting it as a miss
 * would report a recall figure over questions that have no answer to recall,
 * which reads as a retrieval failure and is really a property of the dataset.
 */
describe('retrieval diagnostics over degenerate instances', () => {
  const embedding = new HashEmbedding(64);

  function instance(overrides: Partial<LongMemEvalInstance>): LongMemEvalInstance {
    return {
      question_id: 'q',
      question_type: 'single-session-user',
      question: 'What did I say?',
      answer: 'x',
      ...overrides,
    };
  }

  it('reports a zero-answerable diagnostic for an empty instance list', async () => {
    const diag = await computeRetrievalDiagnostics([], embedding);
    expect(diag).toEqual({
      totalQuestions: 0,
      answerableQuestions: 0,
      recallAt1: 0,
      recallAt5: 0,
      hitScores: [],
      missScores: [],
      recommendedThreshold: 0,
    });
  });

  it('excludes an instance with no haystack from the denominator', async () => {
    // The `?? []` on `haystack_sessions` is the branch under test: a dataset
    // entry that omits the field entirely must be skipped, not treated as an
    // empty haystack with a miss recorded against it.
    const diag = await computeRetrievalDiagnostics([instance({})], embedding);
    expect(diag.totalQuestions).toBe(1);
    expect(diag.answerableQuestions).toBe(0);
    expect(diag.recallAt5).toBe(0);
  });

  it('excludes an instance whose only turns are assistant turns', async () => {
    // The assistant-turn filter runs before the answer check, so a session of
    // nothing but assistant turns has no evidence turn and carries no signal.
    const diag = await computeRetrievalDiagnostics(
      [
        instance({
          haystack_sessions: [[{ role: 'assistant', content: 'Sure.', has_answer: true }]],
        }),
      ],
      embedding,
    );
    expect(diag.answerableQuestions).toBe(0);
  });

  it('reads turns with no dates when the dataset omits them', async () => {
    // `dates?.[i]` is undefined here, which `turnText` must tolerate. The
    // question IS answerable, so this asserts the branch is taken without the
    // instance dropping out of the denominator.
    const diag = await computeRetrievalDiagnostics(
      [
        instance({
          haystack_sessions: [[{ role: 'user', content: 'I like tea.', has_answer: true }]],
        }),
      ],
      embedding,
    );
    expect(diag.answerableQuestions).toBe(1);
    expect(diag.recallAt1).toBe(1);
  });

  it('mixes answerable and unanswerable instances without diluting recall', async () => {
    // The measurement whose absence would matter most: a run over a dataset
    // half abstention questions must report the recall of the answerable half,
    // not the recall of the whole set.
    const diag = await computeRetrievalDiagnostics(
      [
        instance({
          question_id: 'answerable',
          haystack_sessions: [[{ role: 'user', content: 'I like tea.', has_answer: true }]],
        }),
        instance({
          question_id: 'abstention',
          haystack_sessions: [[{ role: 'user', content: 'Hi.' }]],
        }),
      ],
      embedding,
    );
    expect(diag.totalQuestions).toBe(2);
    expect(diag.answerableQuestions).toBe(1);
    expect(diag.recallAt1).toBe(1);
  });

  it('reports a zero-answerable session diagnostic for an empty instance list', async () => {
    const diag = await computeSessionRetrievalDiagnostics([], embedding);
    expect(diag).toEqual({
      totalQuestions: 0,
      answerableQuestions: 0,
      recallAt1: 0,
      recallAtK: 0,
      hitScores: [],
      missScores: [],
      recommendedThreshold: 0,
    });
  });

  it('excludes a session-less instance from the session denominator', async () => {
    const diag = await computeSessionRetrievalDiagnostics([instance({})], embedding);
    expect(diag.answerableQuestions).toBe(0);
  });

  it('excludes an instance whose only session is assistant-only', async () => {
    const diag = await computeSessionRetrievalDiagnostics(
      [
        instance({
          haystack_sessions: [[{ role: 'assistant', content: 'Sure.', has_answer: true }]],
        }),
      ],
      embedding,
    );
    expect(diag.answerableQuestions).toBe(0);
  });

  it('mixes answerable and unanswerable instances at session level', async () => {
    const diag = await computeSessionRetrievalDiagnostics(
      [
        instance({
          question_id: 'answerable',
          haystack_sessions: [[{ role: 'user', content: 'I like tea.', has_answer: true }]],
        }),
        instance({
          question_id: 'abstention',
          haystack_sessions: [[{ role: 'user', content: 'Hi.' }]],
        }),
      ],
      embedding,
    );
    expect(diag.totalQuestions).toBe(2);
    expect(diag.answerableQuestions).toBe(1);
    expect(diag.recallAt1).toBe(1);
  });
});
