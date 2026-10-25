/**
 * The comparison rule and the provider contract.
 *
 * The rule is the part worth testing hardest, because it is the one that decides what a number is allowed to
 * claim. A grade that drifts from the fields it is supposed to depend on is how "we are 3 points behind" gets
 * written over a run that used a different top-k.
 */

import { describe, expect, it } from 'vitest';
import {
  comparability,
  LexicalProvider,
  toSessions,
  type MemorySession,
  type RunConfig,
} from '../competitor.js';
import type { LongMemEvalInstance } from '../datasets/longmemeval-loader.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

const BASE: RunConfig = {
  dataset: 'longmemeval-s/500',
  questions: 500,
  reader: 'deepseek-chat',
  judge: 'gpt-4o-2024-08-06',
  judgePolicy: 'official-v1',
  topK: 200,
  tokenBudget: 48_000,
};

describe('comparability: three grades, decided by which fields differ', () => {
  it('calls two identical runs grade A, because nothing differs', () => {
    expect(comparability(BASE, BASE)).toEqual({ grade: 'A', differing: [] });
  });

  it('downgrades to B when only the reader differs', () => {
    const other = { ...BASE, reader: 'gpt-4o' };
    expect(comparability(BASE, other)).toEqual({ grade: 'B', differing: ['reader'] });
  });

  it('downgrades to B when only the judge differs', () => {
    expect(comparability(BASE, { ...BASE, judge: 'gpt-5' }).grade).toBe('B');
  });

  it('downgrades to B when only the judge prompt differs, because two prompts disagree more than systems do', () => {
    expect(comparability(BASE, { ...BASE, judgePolicy: 'binary-v2' }).grade).toBe('B');
  });

  it('refuses a gap when the retrieval depth differs', () => {
    // Not presentation: a run reading 200 hits and one reading 10 are different experiments, and the deeper
    // one wins for reasons unrelated to memory.
    expect(comparability(BASE, { ...BASE, topK: 10 })).toEqual({ grade: 'C', differing: ['topK'] });
  });

  it('refuses a gap when the context ceiling differs', () => {
    expect(comparability(BASE, { ...BASE, tokenBudget: 24_000 }).grade).toBe('C');
  });

  it('refuses a gap when the dataset or the question count differs', () => {
    expect(comparability(BASE, { ...BASE, dataset: 'longmemeval-m/500' }).grade).toBe('C');
    expect(comparability(BASE, { ...BASE, questions: 100 }).grade).toBe('C');
  });

  it('takes the weakest grade when several fields differ', () => {
    const both = { ...BASE, reader: 'gpt-4o', topK: 20 };
    const result = comparability(BASE, both);
    expect(result.grade).toBe('C');
    expect(result.differing).toEqual(['topK', 'reader']);
  });

  it('lists every differing field rather than the first, so a fix list is complete', () => {
    const drifted = { ...BASE, reader: 'x', judge: 'y', judgePolicy: 'z' };
    expect(comparability(BASE, drifted).differing).toEqual(['reader', 'judge', 'judgePolicy']);
  });

  it('is symmetric', () => {
    const other = { ...BASE, reader: 'gpt-4o' };
    expect(comparability(BASE, other)).toEqual(comparability(other, BASE));
  });
});

describe('toSessions: the benchmark history as ingestable sessions', () => {
  function instanceOf(overrides: Partial<LongMemEvalInstance> = {}): LongMemEvalInstance {
    return {
      question_id: 'q1',
      question_type: 'multi-session',
      question: 'how many?',
      answer: '2',
      haystack_session_ids: ['s1', 's2'],
      haystack_dates: ['2026-01-01', '2026-01-05'],
      haystack_sessions: [
        [{ role: 'user', content: 'I have one cat.' }],
        [{ role: 'user', content: 'We adopted a second cat.' }],
      ],
      answer_session_ids: ['s2'],
      ...overrides,
    };
  }

  it('keeps the benchmark timestamp rather than the ingest time', () => {
    const { sessions } = toSessions(instanceOf());
    expect(sessions.map((session) => session.at)).toEqual([
      Date.parse('2026-01-01'),
      Date.parse('2026-01-05'),
    ]);
  });

  it('keeps the session ids, so an evidence hit can be traced back', () => {
    expect(toSessions(instanceOf()).sessions.map((session) => session.id)).toEqual(['s1', 's2']);
  });

  it('drops a session with no parseable date and counts it, instead of defaulting to now', () => {
    // A session that cannot be placed is not a session that happened at ingest time. Defaulting is the exact
    // defect the `time-anchor` assumption exists to record, and a harness must not reintroduce it silently.
    const { sessions, undated } = toSessions(
      instanceOf({ haystack_dates: ['2026-01-01', 'not a date'] }),
    );
    expect(undated).toBe(1);
    expect(sessions).toHaveLength(1);
  });

  it('synthesises an id when the benchmark omits one, so nothing is lost to a short array', () => {
    const { sessions } = toSessions(instanceOf({ haystack_session_ids: [] }));
    expect(sessions.map((session) => session.id)).toEqual(['q1#0', 'q1#1']);
  });

  it('copies turns into the provider shape without touching the text', () => {
    const { sessions } = toSessions(
      instanceOf({
        haystack_sessions: [[{ role: 'assistant', content: '  spaced  ' }]],
        haystack_dates: ['2026-01-01'],
        haystack_session_ids: ['s1'],
      }),
    );
    expect(sessions[0]!.turns).toEqual([{ role: 'assistant', content: '  spaced  ' }]);
  });

  it('returns nothing for an instance with no history rather than throwing', () => {
    const { sessions, undated } = toSessions(
      instanceOf({ haystack_sessions: [], haystack_dates: [], haystack_session_ids: [] }),
    );
    expect(sessions).toEqual([]);
    expect(undated).toBe(0);
  });
});

describe('the reference provider: a pipeline that runs with no model', () => {
  const sessions: MemorySession[] = [
    {
      id: 's1',
      at: T0,
      turns: [{ role: 'user', content: 'I live in London and work as an engineer in the city.' }],
    },
    {
      id: 's2',
      at: T0 + 90 * DAY,
      turns: [
        { role: 'user', content: 'I moved to Berlin last month and work from home in the city.' },
      ],
    },
  ];

  it('reports what it ingested rather than assuming it took everything', async () => {
    const provider = new LexicalProvider();
    const report = await provider.ingest(sessions);
    expect(report).toEqual({ sessions: 2, turns: 2, skipped: [] });
  });

  it('accumulates across ingest calls, which is how a global-mode run feeds it', async () => {
    const provider = new LexicalProvider();
    await provider.ingest([sessions[0]!]);
    const report = await provider.ingest([sessions[1]!]);
    expect(report.sessions).toBe(2);
  });

  it('ranks the session that covers more of the question first', async () => {
    const provider = new LexicalProvider();
    await provider.ingest(sessions);
    const hits = await provider.search('Where does the user live?', { limit: 5 });
    expect(hits[0]!.text).toContain('London');
  });

  it('honours the limit', async () => {
    const provider = new LexicalProvider();
    await provider.ingest(sessions);
    // Both sessions mention the city, so the limit is what decides the count — not the vocabulary.
    expect(await provider.search('the city', { limit: 1 })).toHaveLength(1);
  });

  it('excludes a session that had not happened yet when a date is given', async () => {
    const provider = new LexicalProvider();
    await provider.ingest(sessions);
    const hits = await provider.search('the city', { limit: 5, asOf: T0 + DAY });
    expect(hits.every((hit) => (hit.at ?? 0) <= T0 + DAY)).toBe(true);
    expect(hits).toHaveLength(1);
  });

  it('returns nothing for a question made only of short words', async () => {
    const provider = new LexicalProvider();
    await provider.ingest(sessions);
    expect(await provider.search('a of to', { limit: 5 })).toEqual([]);
  });

  it('returns nothing before anything was ingested', async () => {
    expect(await new LexicalProvider().search('anything at all', { limit: 5 })).toEqual([]);
  });

  it('forgets everything on reset, so the next question starts clean', async () => {
    const provider = new LexicalProvider();
    await provider.ingest(sessions);
    await provider.reset();
    expect(await provider.search('London', { limit: 5 })).toEqual([]);
  });

  it('declares that it builds nothing with a model, which is what makes it a control', () => {
    expect(new LexicalProvider().build).toBe('none');
  });
});
