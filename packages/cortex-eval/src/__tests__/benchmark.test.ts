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
