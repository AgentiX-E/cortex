import { describe, it, expect } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';
import {
  NaturalLanguageMemorySystem,
  buildQaPrompt,
  parseQaAnswer,
} from '../natural-language-memory.js';
import { HashEmbedding } from '../embedding.js';

function scriptedLlm(fn: (prompt: string) => string): LLM {
  return {
    complete: async (prompt) => fn(prompt),
    completeStructured: async <T>() => ({}) as T,
  };
}

describe('buildQaPrompt', () => {
  it('includes the question, context, and abstention instruction', () => {
    const prompt = buildQaPrompt('What is X?', 'context line');
    expect(prompt).toContain('Question: What is X?');
    expect(prompt).toContain('context line');
    expect(prompt).toContain('UNANSWERABLE');
  });

  it('accepts a custom abstention token', () => {
    const prompt = buildQaPrompt('Q?', 'ctx', 'NONE');
    expect(prompt).toContain('NONE');
  });
});

describe('parseQaAnswer', () => {
  it('returns the trimmed answer', () => {
    expect(parseQaAnswer('  blue  ')).toBe('blue');
  });

  it('returns null for the abstention token (case-insensitive)', () => {
    expect(parseQaAnswer('UNANSWERABLE')).toBeNull();
    expect(parseQaAnswer('unanswerable')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseQaAnswer('   ')).toBeNull();
  });

  it('strips surrounding quotes', () => {
    expect(parseQaAnswer('"blue"')).toBe('blue');
    expect(parseQaAnswer("'blue'")).toBe('blue');
  });
});

describe('NaturalLanguageMemorySystem', () => {
  const embedding = new HashEmbedding(64);

  it('generates an answer from the retrieved context via the LLM', async () => {
    const llm = scriptedLlm((prompt) =>
      prompt.includes('favorite color') ? 'blue' : 'UNANSWERABLE',
    );
    const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
    const answer = await system.answer('What is the favorite color?', [
      'My favorite color is blue.',
    ]);
    expect(answer).toBe('blue');
  });

  it('abstains before calling the LLM when retrieval is below threshold', async () => {
    let called = false;
    const llm = scriptedLlm(() => {
      called = true;
      return 'UNANSWERABLE';
    });
    const system = new NaturalLanguageMemorySystem('s', {
      embedding,
      llm,
      abstainThreshold: 0.99,
    });
    const answer = await system.answer('What is the favorite color?', [
      'My favorite color is blue.',
    ]);
    expect(answer).toBeNull();
    expect(called).toBe(false);
  });

  it('returns null when the LLM abstains', async () => {
    const llm = scriptedLlm(() => 'UNANSWERABLE');
    const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
    const answer = await system.answer('What is the phone number?', ['My favorite color is blue.']);
    expect(answer).toBeNull();
  });

  it('never abstains when abstention is disabled (baseline)', async () => {
    const llm = scriptedLlm(() => 'UNANSWERABLE');
    const system = new NaturalLanguageMemorySystem('s', {
      embedding,
      llm,
      enableAbstention: false,
    });
    const answer = await system.answer('What is the phone number?', ['My favorite color is blue.']);
    expect(answer).toBe('unknown');
  });

  it('returns null when no context is ingested and abstention is enabled', async () => {
    const llm = scriptedLlm(() => 'blue');
    const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
    expect(await system.answer('What is X?', [])).toBeNull();
  });
});
