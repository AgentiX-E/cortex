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
      sessions: [['session d']],
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

  it('routes temporal questions to answerTemporal with sessions and the question date', async () => {
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
      answerTemporal: async (_q, sessions, date) => {
        calls.push(`temporal:${sessions.length}:${date}`);
        return 'z';
      },
    };
    const answers = await runBenchmark(routingDataset, system);
    expect(answers).toEqual(['y', 'x', 'x', 'z']);
    // q4 (TR) has no sessions, so the flattened context is wrapped as one
    // session and passed with the question date.
    expect(calls).toEqual(['sessions', 'answer', 'answer', 'temporal:1:2023/04/01']);
  });

  it('wraps the flattened context as one session when a temporal question has no sessions', async () => {
    const dataset: BenchmarkDataset = {
      name: 'routing',
      questions: [
        {
          id: 'q1',
          capability: 'TR',
          question: 'Q1',
          expected: 'a',
          context: ['flat a', 'flat b'],
          questionDate: '2023/04/01',
        },
      ],
    };
    const calls: string[] = [];
    const system: SessionAwareMemorySystem = {
      name: 's',
      answer: async () => 'x',
      answerSessions: async () => 'y',
      answerTemporal: async (_q, sessions, date) => {
        calls.push(`temporal:${sessions.length}:${sessions[0]!.length}:${date}`);
        return 'z';
      },
    };
    const answers = await runBenchmark(dataset, system);
    expect(answers).toEqual(['z']);
    // The flattened context is wrapped as a single session of two turns.
    expect(calls).toEqual(['temporal:1:2:2023/04/01']);
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
