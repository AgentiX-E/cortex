import { describe, it, expect } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';
import { buildJudgePrompt, parseJudgeResponse, createLlmJudge, clearJudgeCache } from '../judge.js';

function scriptedLlm(fn: (prompt: string) => string): LLM {
  return {
    complete: async (prompt) => fn(prompt),
    completeStructured: async <T>() => ({}) as T,
  };
}

describe('buildJudgePrompt', () => {
  it('includes question, predicted, and expected answers', () => {
    const prompt = buildJudgePrompt('What is the color?', 'blue', 'Blue');
    expect(prompt).toContain('What is the color?');
    expect(prompt).toContain('blue');
    expect(prompt).toContain('Blue');
    expect(prompt).toContain('YES or NO');
  });
});

describe('parseJudgeResponse', () => {
  it('accepts YES and NO case-insensitively', () => {
    expect(parseJudgeResponse('YES')).toBe(true);
    expect(parseJudgeResponse('yes')).toBe(true);
    expect(parseJudgeResponse('NO')).toBe(false);
    expect(parseJudgeResponse('no')).toBe(false);
  });

  it('accepts numeric and boolean encodings', () => {
    expect(parseJudgeResponse('1')).toBe(true);
    expect(parseJudgeResponse('TRUE')).toBe(true);
    expect(parseJudgeResponse('0')).toBe(false);
    expect(parseJudgeResponse('FALSE')).toBe(false);
  });

  it('defaults to false on ambiguous input', () => {
    expect(parseJudgeResponse('maybe')).toBe(false);
    expect(parseJudgeResponse('')).toBe(false);
  });
});

describe('createLlmJudge', () => {
  it('returns the parsed verdict', async () => {
    const judge = createLlmJudge(scriptedLlm(() => 'YES'));
    expect(await judge('q', 'a', 'a')).toBe(true);
  });

  it('caches verdicts by prompt', async () => {
    clearJudgeCache();
    let calls = 0;
    const llm = scriptedLlm(() => {
      calls++;
      return 'YES';
    });
    const judge = createLlmJudge(llm);
    await judge('q', 'a', 'a');
    await judge('q', 'a', 'a');
    expect(calls).toBe(1);
  });
});
