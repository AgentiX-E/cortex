import { describe, it, expect } from 'vitest';
import { runBenchmark } from '../benchmark.js';
import type { BenchmarkDataset, MemorySystem, SessionAwareMemorySystem } from '../types.js';

const routingDataset: BenchmarkDataset = {
  name: 'routing',
  questions: [
    {
      id: 'q1',
      capability: 'MR',
      question: 'Q1',
      expected: 'a',
      context: ['flat a'],
      sessions: [['session a']],
    },
    {
      id: 'q2',
      capability: 'IE',
      question: 'Q2',
      expected: 'b',
      context: ['flat b'],
    },
    {
      id: 'q3',
      capability: 'IE',
      question: 'Q3',
      expected: 'c',
      context: ['flat c'],
      sessions: [['session c']],
    },
    {
      id: 'q4',
      capability: 'TR',
      question: 'Q4',
      expected: 'd',
      context: ['flat d'],
      questionDate: '2023/04/01',
    },
  ],
};

describe('runBenchmark session routing', () => {
  it('routes only multi-session questions to answerSessions', async () => {
    const calls: string[] = [];
    const system: SessionAwareMemorySystem = {
      name: 's',
      answer: async () => {
        calls.push('answer');
        return 'x';
      },
      answerSessions: async (_q, sessions) => {
        calls.push(`sessions:${sessions.length}`);
        return 'y';
      },
    };
    const answers = await runBenchmark(routingDataset, system);
    expect(answers).toEqual(['y', 'x', 'x', 'x']);
    // q1 (MR) uses answerSessions; q2 (IE), q3 (IE with sessions), and q4 (TR
    // without answerTemporal) use the flattened answer path.
    expect(calls).toEqual(['sessions:1', 'answer', 'answer', 'answer']);
  });

  it('routes temporal questions to answerTemporal with the question date', async () => {
    const calls: string[] = [];
    const system: SessionAwareMemorySystem = {
      name: 's',
      answer: async () => {
        calls.push('answer');
        return 'x';
      },
      answerSessions: async () => {
        calls.push('sessions');
        return 'y';
      },
      answerTemporal: async (_q, _ctx, date) => {
        calls.push(`temporal:${date}`);
        return 'z';
      },
    };
    const answers = await runBenchmark(routingDataset, system);
    expect(answers).toEqual(['y', 'x', 'x', 'z']);
    expect(calls).toEqual(['sessions', 'answer', 'answer', 'temporal:2023/04/01']);
  });

  it('routes single-session-assistant questions to answerAssistant', async () => {
    const dataset: BenchmarkDataset = {
      name: 'routing',
      questions: [
        {
          id: 'q1',
          capability: 'IE',
          questionType: 'single-session-assistant',
          question: 'Q1',
          expected: 'a',
          context: ['assistant fact'],
        },
        {
          id: 'q2',
          capability: 'IE',
          questionType: 'single-session-user',
          question: 'Q2',
          expected: 'b',
          context: ['user fact'],
        },
      ],
    };
    const calls: string[] = [];
    const system: SessionAwareMemorySystem = {
      name: 's',
      answer: async () => {
        calls.push('answer');
        return 'x';
      },
      answerSessions: async () => {
        calls.push('sessions');
        return 'y';
      },
      answerAssistant: async () => {
        calls.push('assistant');
        return 'z';
      },
    };
    const answers = await runBenchmark(dataset, system);
    expect(answers).toEqual(['z', 'x']);
    expect(calls).toEqual(['assistant', 'answer']);
  });

  it('routes single-session-preference questions to answerPreference', async () => {
    const dataset: BenchmarkDataset = {
      name: 'routing',
      questions: [
        {
          id: 'q1',
          capability: 'IE',
          questionType: 'single-session-preference',
          question: 'Can you recommend some video editing resources?',
          expected: 'Adobe Premiere Pro tutorials',
          context: ['I edit with Adobe Premiere Pro.'],
        },
        {
          id: 'q2',
          capability: 'IE',
          questionType: 'single-session-user',
          question: 'Q2',
          expected: 'b',
          context: ['user fact'],
        },
      ],
    };
    const calls: string[] = [];
    const system: SessionAwareMemorySystem = {
      name: 's',
      answer: async () => {
        calls.push('answer');
        return 'x';
      },
      answerSessions: async () => {
        calls.push('sessions');
        return 'y';
      },
      answerPreference: async () => {
        calls.push('preference');
        return 'Adobe Premiere Pro tutorials';
      },
    };
    const answers = await runBenchmark(dataset, system);
    expect(answers).toEqual(['Adobe Premiere Pro tutorials', 'x']);
    expect(calls).toEqual(['preference', 'answer']);
  });

  it('falls back to answer for preference questions without answerPreference', async () => {
    const dataset: BenchmarkDataset = {
      name: 'routing',
      questions: [
        {
          id: 'q1',
          capability: 'IE',
          questionType: 'single-session-preference',
          question: 'Can you recommend a show?',
          expected: 'stand-up specials',
          context: ['I like stand-up comedy.'],
        },
      ],
    };
    const calls: string[] = [];
    const system: SessionAwareMemorySystem = {
      name: 's',
      answer: async () => {
        calls.push('answer');
        return 'x';
      },
      answerSessions: async () => 'y',
    };
    const answers = await runBenchmark(dataset, system);
    expect(answers).toEqual(['x']);
    expect(calls).toEqual(['answer']);
  });

  it('routes knowledge-update questions to answerKnowledgeUpdate', async () => {
    const dataset: BenchmarkDataset = {
      name: 'routing',
      questions: [
        {
          id: 'q1',
          capability: 'KU',
          questionType: 'knowledge-update',
          question: 'What is my current city?',
          expected: 'Shanghai',
          context: ['I moved to Shanghai.'],
        },
        {
          id: 'q2',
          capability: 'IE',
          questionType: 'single-session-user',
          question: 'Q2',
          expected: 'b',
          context: ['user fact'],
        },
      ],
    };
    const calls: string[] = [];
    const system: SessionAwareMemorySystem = {
      name: 's',
      answer: async () => {
        calls.push('answer');
        return 'x';
      },
      answerSessions: async () => {
        calls.push('sessions');
        return 'y';
      },
      answerKnowledgeUpdate: async () => {
        calls.push('knowledge-update');
        return 'Shanghai';
      },
    };
    const answers = await runBenchmark(dataset, system);
    expect(answers).toEqual(['Shanghai', 'x']);
    expect(calls).toEqual(['knowledge-update', 'answer']);
  });

  it('falls back to answer for knowledge-update questions without answerKnowledgeUpdate', async () => {
    const dataset: BenchmarkDataset = {
      name: 'routing',
      questions: [
        {
          id: 'q1',
          capability: 'KU',
          questionType: 'knowledge-update',
          question: 'What is my current city?',
          expected: 'Shanghai',
          context: ['I moved to Shanghai.'],
        },
      ],
    };
    const calls: string[] = [];
    const system: SessionAwareMemorySystem = {
      name: 's',
      answer: async () => {
        calls.push('answer');
        return 'x';
      },
      answerSessions: async () => 'y',
    };
    const answers = await runBenchmark(dataset, system);
    expect(answers).toEqual(['x']);
    expect(calls).toEqual(['answer']);
  });

  it('routes abstention questions to answerAbstention before the assistant path', async () => {
    const dataset: BenchmarkDataset = {
      name: 'routing',
      questions: [
        {
          id: 'q1_abs',
          capability: 'ABS',
          questionType: 'single-session-assistant',
          question: 'Q1',
          expected: null,
          context: ['assistant noise'],
        },
        {
          id: 'q2_abs',
          capability: 'ABS',
          questionType: 'single-session-user',
          question: 'Q2',
          expected: null,
          context: ['user noise'],
        },
      ],
    };
    const calls: string[] = [];
    const system: SessionAwareMemorySystem = {
      name: 's',
      answer: async () => {
        calls.push('answer');
        return 'x';
      },
      answerSessions: async () => 'y',
      answerAssistant: async () => {
        calls.push('assistant');
        return 'z';
      },
      answerAbstention: async () => {
        calls.push('abstention');
        return null;
      },
    };
    const answers = await runBenchmark(dataset, system);
    expect(answers).toEqual([null, null]);
    // Both ABS questions (including the assistant-typed one) route through
    // answerAbstention, not answerAssistant or answer.
    expect(calls).toEqual(['abstention', 'abstention']);
  });

  it('falls back to answer for abstention questions without answerAbstention', async () => {
    const dataset: BenchmarkDataset = {
      name: 'routing',
      questions: [
        {
          id: 'q1_abs',
          capability: 'ABS',
          questionType: 'single-session-user',
          question: 'Q1',
          expected: null,
          context: ['user noise'],
        },
      ],
    };
    const calls: string[] = [];
    const system: SessionAwareMemorySystem = {
      name: 's',
      answer: async () => {
        calls.push('answer');
        return 'x';
      },
      answerSessions: async () => 'y',
    };
    const answers = await runBenchmark(dataset, system);
    expect(answers).toEqual(['x']);
    expect(calls).toEqual(['answer']);
  });

  it('falls back to answer for assistant questions without answerAssistant', async () => {
    const dataset: BenchmarkDataset = {
      name: 'routing',
      questions: [
        {
          id: 'q1',
          capability: 'IE',
          questionType: 'single-session-assistant',
          question: 'Q1',
          expected: 'a',
          context: ['assistant fact'],
        },
      ],
    };
    const calls: string[] = [];
    const system: SessionAwareMemorySystem = {
      name: 's',
      answer: async () => {
        calls.push('answer');
        return 'x';
      },
      answerSessions: async () => 'y',
    };
    const answers = await runBenchmark(dataset, system);
    expect(answers).toEqual(['x']);
    expect(calls).toEqual(['answer']);
  });

  it('uses flat context for non-session-aware systems', async () => {
    const calls: string[] = [];
    const system: MemorySystem = {
      name: 's',
      answer: async (_q, context) => {
        calls.push(`context:${context.length}`);
        return 'x';
      },
    };
    const answers = await runBenchmark(routingDataset, system);
    expect(answers).toEqual(['x', 'x', 'x', 'x']);
    expect(calls).toEqual(['context:1', 'context:1', 'context:1', 'context:1']);
  });
});

/**
 * Session boundaries must REACH the single-session paths, not just the
 * multi-session one.
 *
 * The primitive that consumes the boundary is unit-tested in retrieval.test.ts.
 * These tests cover the integration, which is where a silent no-op would live:
 * a path can accept a `sessions` argument, typecheck, and still ignore it. Each
 * test therefore asserts the ARGUMENT ARRIVES, not merely that a call happened.
 */
describe('runBenchmark session-boundary delivery', () => {
  const dataset: BenchmarkDataset = {
    name: 'delivery',
    questions: [
      {
        id: 'tr',
        capability: 'TR',
        question: 'Q TR',
        expected: 'd',
        context: ['flat d'],
        questionDate: '2023/04/01',
        sessions: [['tr session a'], ['tr session b']],
      },
      {
        id: 'ie',
        capability: 'IE',
        question: 'Q IE',
        expected: 'b',
        context: ['flat b'],
        sessions: [['ie session a'], ['ie session b']],
      },
    ],
  };

  it('delivers sessions to answerTemporal alongside the question date', async () => {
    // Required-with-undefined rather than optional: `exactOptionalPropertyTypes`
    // distinguishes the two, and assigning `undefined` to an optional property is
    // what it forbids.
    const seen: { date: string | undefined; sessions: string[][] | undefined } = {
      date: undefined,
      sessions: undefined,
    };
    const system: SessionAwareMemorySystem = {
      name: 's',
      answer: async () => 'x',
      answerSessions: async () => 'y',
      answerTemporal: async (_q, _ctx, date, sessions) => {
        seen.date = date;
        seen.sessions = sessions;
        return 'z';
      },
    };
    await runBenchmark(dataset, system);
    expect(seen.date).toBe('2023/04/01');
    expect(seen.sessions).toEqual([['tr session a'], ['tr session b']]);
  });

  it('delivers sessions to the flat answer path', async () => {
    const collected: (string[][] | undefined)[] = [];
    const system: MemorySystem = {
      name: 's',
      answer: async (_q, _ctx, sessions) => {
        collected.push(sessions);
        return 'x';
      },
    };
    await runBenchmark(dataset, system);
    // The IE question carries sessions; the TR question falls through to the
    // flat path too because this system exposes no answerTemporal.
    expect(collected).toEqual([
      [['tr session a'], ['tr session b']],
      [['ie session a'], ['ie session b']],
    ]);
  });

  it('passes undefined rather than an empty array when a question has no sessions', async () => {
    const collected: (string[][] | undefined)[] = [];
    const system: MemorySystem = {
      name: 's',
      answer: async (_q, _ctx, sessions) => {
        collected.push(sessions);
        return 'x';
      },
    };
    await runBenchmark(
      {
        name: 'no-sessions',
        questions: [{ id: 'q', capability: 'IE', question: 'Q', expected: 'a', context: ['flat'] }],
      },
      system,
    );
    // `undefined` is what disables session-coherent admission; an empty array
    // would be a different value and the distinction is what keeps the flat
    // fallback honest.
    expect(collected).toEqual([undefined]);
  });
});
