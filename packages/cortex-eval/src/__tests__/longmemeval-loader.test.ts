import { describe, it, expect } from 'vitest';
import {
  loadLongMemEval,
  toCapability,
  DIAGNOSED_CAPABILITIES,
  hasDiagnosticRecord,
  flattenSessions,
  sessionsToContext,
  turnText,
  type LongMemEvalInstance,
} from '../datasets/longmemeval-loader.js';

describe('toCapability', () => {
  it('maps abstention questions', () => {
    expect(toCapability('q1_abs', 'single-session-user')).toBe('ABS');
  });

  it('maps single-session types to IE', () => {
    expect(toCapability('q1', 'single-session-user')).toBe('IE');
    expect(toCapability('q2', 'single-session-assistant')).toBe('IE');
    expect(toCapability('q3', 'single-session-preference')).toBe('IE');
  });

  it('maps temporal-reasoning to TR', () => {
    expect(toCapability('q4', 'temporal-reasoning')).toBe('TR');
  });

  it('maps knowledge-update to KU', () => {
    expect(toCapability('q5', 'knowledge-update')).toBe('KU');
  });

  it('maps multi-session to MR', () => {
    expect(toCapability('q6', 'multi-session')).toBe('MR');
  });

  it('falls back to IE for unknown types', () => {
    expect(toCapability('q7', 'unknown-type')).toBe('IE');
  });
});

describe('hasDiagnosticRecord', () => {
  it('covers every capability except MR, which has its own diagnostics file', () => {
    // The regression this pins: ABS was excluded by a name-list filter, so the
    // capability with the smallest sample and the largest percentage spread had no
    // per-question record at all, and no cross-run analysis could see it move.
    expect(hasDiagnosticRecord('q1', 'single-session-user')).toBe(true);
    expect(hasDiagnosticRecord('q2', 'knowledge-update')).toBe(true);
    expect(hasDiagnosticRecord('q3', 'temporal-reasoning')).toBe(true);
    expect(hasDiagnosticRecord('q1_abs', 'single-session-user')).toBe(true);
    expect(hasDiagnosticRecord('q4', 'multi-session')).toBe(false);
  });

  it('agrees with the capability it derives from, for every diagnosed capability', () => {
    const instances: Array<[string, string]> = [
      ['q1', 'single-session-user'],
      ['q2', 'single-session-assistant'],
      ['q3', 'single-session-preference'],
      ['q4', 'temporal-reasoning'],
      ['q5', 'knowledge-update'],
      ['q6_abs', 'knowledge-update'],
    ];
    for (const [id, type] of instances) {
      expect(hasDiagnosticRecord(id, type)).toBe(
        DIAGNOSED_CAPABILITIES.includes(toCapability(id, type)),
      );
    }
  });

  it('lists ABS among the diagnosed capabilities', () => {
    expect(DIAGNOSED_CAPABILITIES).toContain('ABS');
    expect(DIAGNOSED_CAPABILITIES).not.toContain('MR');
  });
});

describe('turnText', () => {
  it('prefixes the session date when provided', () => {
    expect(turnText({ role: 'user', content: 'hello' }, '2023-05-01')).toBe(
      '[2023-05-01] user: hello',
    );
  });

  it('omits the date prefix when absent', () => {
    expect(turnText({ role: 'user', content: 'hello' })).toBe('user: hello');
  });
});

describe('flattenSessions', () => {
  it('flattens turns into role-prefixed strings', () => {
    const flat = flattenSessions([
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    ]);
    expect(flat).toEqual(['user: hello', 'assistant: hi']);
  });

  it('injects session dates when provided', () => {
    const flat = flattenSessions(
      [[{ role: 'user', content: 'a' }], [{ role: 'user', content: 'b' }]],
      ['2023-05-01', '2023-05-02'],
    );
    expect(flat).toEqual(['[2023-05-01] user: a', '[2023-05-02] user: b']);
  });

  it('returns empty for undefined sessions', () => {
    expect(flattenSessions(undefined)).toEqual([]);
  });
});

describe('sessionsToContext', () => {
  it('preserves session boundaries as grouped context strings', () => {
    const grouped = sessionsToContext([
      [{ role: 'user', content: 'a' }],
      [
        { role: 'user', content: 'b' },
        { role: 'assistant', content: 'c' },
      ],
    ]);
    expect(grouped).toEqual([['user: a'], ['user: b', 'assistant: c']]);
  });

  it('injects session dates into each grouped session', () => {
    const grouped = sessionsToContext(
      [[{ role: 'user', content: 'a' }], [{ role: 'user', content: 'b' }]],
      ['2023-05-01', '2023-05-02'],
    );
    expect(grouped).toEqual([['[2023-05-01] user: a'], ['[2023-05-02] user: b']]);
  });

  it('returns an empty list for undefined sessions', () => {
    expect(sessionsToContext(undefined)).toEqual([]);
  });
});

describe('loadLongMemEval', () => {
  const sample: LongMemEvalInstance[] = [
    {
      question_id: 'q1',
      question_type: 'single-session-user',
      question: 'What is the color?',
      answer: 'blue',
      haystack_sessions: [[{ role: 'user', content: 'My color is blue.' }]],
    },
    {
      question_id: 'q2_abs',
      question_type: 'single-session-user',
      question: 'What is the food?',
      answer: 'none',
      haystack_sessions: [[{ role: 'user', content: 'My color is blue.' }]],
    },
  ];

  it('loads instances into a benchmark dataset', () => {
    const ds = loadLongMemEval(sample);
    expect(ds.name).toBe('longmemeval');
    expect(ds.questions).toHaveLength(2);
    expect(ds.questions[0]!.capability).toBe('IE');
    expect(ds.questions[0]!.expected).toBe('blue');
    expect(ds.questions[1]!.capability).toBe('ABS');
    expect(ds.questions[1]!.expected).toBeNull();
    expect(ds.questions[0]!.context).toEqual(['user: My color is blue.']);
    expect(ds.questions[0]!.sessions).toEqual([['user: My color is blue.']]);
  });

  it('injects session dates into the context for temporal reasoning', () => {
    const dated: LongMemEvalInstance[] = [
      {
        question_id: 'q1',
        question_type: 'temporal-reasoning',
        question: 'When did X happen?',
        answer: '2023-05-02',
        haystack_sessions: [[{ role: 'user', content: 'X happened' }]],
        haystack_dates: ['2023-05-02'],
      },
    ];
    const ds = loadLongMemEval(dated);
    expect(ds.questions[0]!.context).toEqual(['[2023-05-02] user: X happened']);
  });

  it('forwards the question date for temporal reasoning', () => {
    const dated: LongMemEvalInstance[] = [
      {
        question_id: 'q1',
        question_type: 'temporal-reasoning',
        question: 'How many weeks ago did X happen?',
        answer: '2',
        question_date: '2023/05/15',
        haystack_sessions: [[{ role: 'user', content: 'X happened' }]],
        haystack_dates: ['2023/05/02'],
      },
    ];
    const ds = loadLongMemEval(dated);
    expect(ds.questions[0]!.questionDate).toBe('2023/05/15');
  });

  it('preserves the raw question type for sub-type-aware routing', () => {
    const assistant: LongMemEvalInstance[] = [
      {
        question_id: 'q1',
        question_type: 'single-session-assistant',
        question: 'What did I say?',
        answer: 'blue',
        haystack_sessions: [[{ role: 'assistant', content: 'blue' }]],
      },
    ];
    const ds = loadLongMemEval(assistant);
    expect(ds.questions[0]!.questionType).toBe('single-session-assistant');
    expect(ds.questions[0]!.capability).toBe('IE');
  });

  it('normalizes a JSON numeric answer to a string', () => {
    const numeric: LongMemEvalInstance[] = [
      {
        question_id: 'q1',
        question_type: 'multi-session',
        question: 'How many?',
        // The raw dataset stores some answers as JSON numbers.
        answer: 3 as unknown as string,
        haystack_sessions: [[{ role: 'user', content: 'three' }]],
      },
    ];
    const ds = loadLongMemEval(numeric);
    expect(ds.questions[0]!.expected).toBe('3');
  });
});

/**
 * The dataset's own answer-turn annotation, which the loader used to discard.
 *
 * Discarding it is why `§13.11.5` -- was the gold turn inside what the model saw --
 * had no direct answer: the first reading approximated it with a session-index rule
 * and the second with a substring search on the answer text, and the artifact
 * refuted the second by matching `3. **Humidity:**` for a gold of `3`.
 */
function instance(overrides: Partial<LongMemEvalInstance> = {}): LongMemEvalInstance {
  return {
    question_id: 'q1',
    question_type: 'multi-session',
    question: 'How many events?',
    answer: '2',
    haystack_session_ids: ['s-a', 's-b', 's-c'],
    haystack_dates: ['2023/01/01 (Sun) 00:00', '2023/01/02 (Mon) 00:00', '2023/01/03 (Tue) 00:00'],
    haystack_sessions: [
      [{ role: 'user', content: 'first' }],
      [
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'ok' },
      ],
      [{ role: 'user', content: 'third' }],
    ],
    answer_session_ids: ['s-b'],
    ...overrides,
  };
}

/**
 * The instance with one optional key removed.
 *
 * `{ answer_session_ids: undefined }` is not the same value under
 * `exactOptionalPropertyTypes`: this workspace distinguishes an absent optional key from
 * one holding `undefined`, and the loader tests the absent spelling because that is what
 * a dataset missing the field actually looks like.
 */
function without(
  inst: LongMemEvalInstance,
  key: 'answer_session_ids' | 'haystack_session_ids',
): LongMemEvalInstance {
  const copy = { ...inst };
  delete copy[key];
  return copy;
}

/**
 * The gold turns the loader would carry for `inst`, read through the public path.
 *
 * `goldTurnsOf` is deliberately not exported: it is the loader's own step, and an
 * export nothing outside this module calls is an export the census reports as an
 * orphan. Going through `loadLongMemEval` also means these tests exercise the wiring
 * that ships rather than a helper beside it.
 */
function goldOf(inst: LongMemEvalInstance): readonly string[] {
  return loadLongMemEval([inst]).questions[0]!.goldTurns ?? [];
}

describe('goldTurnsOf', () => {
  it('selects the turns of the sessions the answer ids name', () => {
    const inst = instance();
    expect(goldOf(inst)).toEqual([
      '[2023/01/02 (Mon) 00:00] user: second',
      '[2023/01/02 (Mon) 00:00] assistant: ok',
    ]);
  });

  it('renders them exactly as the context does, which is what makes membership decidable', () => {
    // The property the field rests on. `goldTurnsOf` and `sessionsToContext` both go
    // through `turnText`, so a downstream membership test is an equality test between
    // two applications of one renderer rather than a natural-language match. If this
    // fails, every coverage number computed from the field is a guess.
    const question = loadLongMemEval([instance()]).questions[0]!;
    const gold = question.goldTurns ?? [];
    expect(gold.length).toBeGreaterThan(0);
    for (const turn of gold) expect(question.context).toContain(turn);
  });

  it('returns nothing when the instance names no answer sessions', () => {
    expect(goldOf(without(instance(), 'answer_session_ids'))).toEqual([]);
  });

  it('returns nothing when the answer list is empty', () => {
    const inst = instance({ answer_session_ids: [] });
    expect(goldOf(inst)).toEqual([]);
  });

  it('returns nothing when the haystack carries no session ids', () => {
    // Without `haystack_session_ids` there is no way to relate a positional session to
    // an id, so the annotation is unusable rather than empty. Returning nothing is what
    // makes the record omit `goldOverlap` instead of reporting a measured miss.
    expect(goldOf(without(instance(), 'haystack_session_ids'))).toEqual([]);
  });

  it('returns nothing when an answer id names no haystack session', () => {
    const inst = instance({ answer_session_ids: ['s-z'] });
    expect(goldOf(inst)).toEqual([]);
  });

  it('gathers several gold sessions in haystack order, not id order', () => {
    const inst = instance({ answer_session_ids: ['s-c', 's-a'] });
    expect(goldOf(inst)).toEqual([
      '[2023/01/01 (Sun) 00:00] user: first',
      '[2023/01/03 (Tue) 00:00] user: third',
    ]);
  });
});

describe('loadLongMemEval carries the gold annotation as an absence or a value', () => {
  it('omits the field when the dataset names no evidence', () => {
    // `[]` would be a claim -- "this question has no gold turns, so nothing was
    // missed" -- and an abstention question supports no such claim.
    const dataset = loadLongMemEval([
      {
        question_id: 'q1_abs',
        question_type: 'single-session-user',
        question: 'q?',
        answer: 'n/a',
      },
    ]);
    expect(dataset.questions[0]).not.toHaveProperty('goldTurns');
  });

  it('carries the field when it does name evidence', () => {
    const dataset = loadLongMemEval([instance()]);
    expect(dataset.questions[0]!.goldTurns).toHaveLength(2);
  });
});
