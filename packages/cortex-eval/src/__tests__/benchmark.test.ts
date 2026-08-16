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
  ],
};

describe('runBenchmark session routing', () => {
  it('routes session-grouped questions to answerSessions and falls back otherwise', async () => {
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
    expect(answers).toEqual(['y', 'x']);
    expect(calls).toEqual(['sessions:1', 'answer']);
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
    expect(answers).toEqual(['x', 'x']);
    expect(calls).toEqual(['context:1', 'context:1']);
  });
});
