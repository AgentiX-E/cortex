import { describe, it, expect } from 'vitest';
import {
  loadLongMemEval,
  toCapability,
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
});
