import { describe, it, expect } from 'vitest';
import type { EmbeddingModel, LLM } from '@agentix-e/cortex-core';
import {
  NaturalLanguageMemorySystem,
  buildQaPrompt,
  parseQaAnswer,
  clearEmbeddingCache,
  type DecisionTrace,
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

  it('passes temperature 0 to the LLM by default for determinism', async () => {
    let captured: number | undefined;
    const llm: LLM = {
      complete: async (_prompt, opts) => {
        captured = opts?.temperature;
        return 'blue';
      },
      completeStructured: async <T>() => ({}) as T,
    };
    const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
    await system.answer('What is the favorite color?', ['My favorite color is blue.']);
    expect(captured).toBe(0);
  });

  it('caches embeddings across instances to avoid recomputation', async () => {
    clearEmbeddingCache();
    let embedCalls = 0;
    const counting: EmbeddingModel = {
      dimension: () => 64,
      embed: async (texts) => {
        embedCalls += texts.length;
        return texts.map(() => new Float64Array(64));
      },
    };
    const llm = scriptedLlm(() => 'blue');
    const s1 = new NaturalLanguageMemorySystem('s1', { embedding: counting, llm });
    const s2 = new NaturalLanguageMemorySystem('s2', { embedding: counting, llm });
    await s1.answer('What is X?', ['turn A']);
    await s2.answer('What is X?', ['turn A']);
    // 'What is X?' and 'turn A' are each embedded once despite two instances.
    expect(embedCalls).toBe(2);
  });

  it('skips re-ingesting turns already indexed in the same instance', async () => {
    clearEmbeddingCache();
    let embedCalls = 0;
    const counting: EmbeddingModel = {
      dimension: () => 64,
      embed: async (texts) => {
        embedCalls += texts.length;
        return texts.map(() => new Float64Array(64));
      },
    };
    const llm = scriptedLlm(() => 'blue');
    const system = new NaturalLanguageMemorySystem('s', { embedding: counting, llm });
    await system.answer('What is X?', ['turn A']);
    await system.answer('What is X?', ['turn A']);
    // The shared embedding cache serves the second call, so the turn and query
    // are each embedded exactly once despite two independent per-question indexes.
    expect(embedCalls).toBe(2);
  });

  it('batches multiple turns into a single embedding request', async () => {
    clearEmbeddingCache();
    let embedCallCount = 0;
    const counting: EmbeddingModel = {
      dimension: () => 64,
      embed: async (texts) => {
        embedCallCount++;
        return texts.map(() => new Float64Array(64));
      },
    };
    const llm = scriptedLlm(() => 'blue');
    const system = new NaturalLanguageMemorySystem('s', { embedding: counting, llm });
    await system.answer('What is X?', ['turn A', 'turn B', 'turn C']);
    // One batched ingest for the three turns plus one query embedding.
    expect(embedCallCount).toBe(2);
  });

  it('isolates retrieval per question (no cross-question leakage)', async () => {
    clearEmbeddingCache();
    const prompts: string[] = [];
    const llm: LLM = {
      complete: async (prompt) => {
        prompts.push(prompt);
        return 'blue';
      },
      completeStructured: async <T>() => ({}) as T,
    };
    const system = new NaturalLanguageMemorySystem('s', { embedding, llm, topK: 1 });
    await system.answer('What is zzzalpha?', ['zzzalpha fact']);
    await system.answer('What is zzzbeta?', ['zzzbeta fact']);
    // The second question's retrieved context must not contain the first question's turn.
    expect(prompts[1]).toContain('zzzbeta fact');
    expect(prompts[1]).not.toContain('zzzalpha fact');
  });

  it('clearEmbeddingCache invalidates the shared cache', async () => {
    clearEmbeddingCache();
    let embedCalls = 0;
    const counting: EmbeddingModel = {
      dimension: () => 64,
      embed: async (texts) => {
        embedCalls += texts.length;
        return texts.map(() => new Float64Array(64));
      },
    };
    const llm = scriptedLlm(() => 'blue');
    const makeSystem = (): NaturalLanguageMemorySystem =>
      new NaturalLanguageMemorySystem('s', { embedding: counting, llm });
    await makeSystem().answer('What is X?', ['turn A']);
    clearEmbeddingCache();
    // A fresh instance has an empty turn index, so both the query and the turn
    // are re-embedded after the cache is cleared.
    await makeSystem().answer('What is X?', ['turn A']);
    expect(embedCalls).toBe(4);
  });

  it('traces the abstain reason via onDecision', async () => {
    clearEmbeddingCache();
    const traces: DecisionTrace[] = [];
    const llm = scriptedLlm(() => 'blue');
    const system = new NaturalLanguageMemorySystem('s', {
      embedding,
      llm,
      abstainThreshold: 0.99,
      onDecision: (t) => traces.push(t),
    });
    await system.answer('What is X?', ['turn A']);
    expect(traces).toHaveLength(1);
    expect(traces[0]!.abstained).toBe(true);
    expect(traces[0]!.reason).toBe('threshold');
  });

  it('traces the llm abstain reason when the LLM returns UNANSWERABLE', async () => {
    clearEmbeddingCache();
    const traces: DecisionTrace[] = [];
    const llm = scriptedLlm(() => 'UNANSWERABLE');
    const system = new NaturalLanguageMemorySystem('s', {
      embedding,
      llm,
      onDecision: (t) => traces.push(t),
    });
    await system.answer('What is X?', ['turn A']);
    expect(traces).toHaveLength(1);
    expect(traces[0]!.abstained).toBe(true);
    expect(traces[0]!.reason).toBe('llm');
  });

  it('traces the answered reason when the LLM produces an answer', async () => {
    clearEmbeddingCache();
    const traces: DecisionTrace[] = [];
    const llm = scriptedLlm(() => 'blue');
    const system = new NaturalLanguageMemorySystem('s', {
      embedding,
      llm,
      onDecision: (t) => traces.push(t),
    });
    await system.answer('What is X?', ['turn A']);
    expect(traces[0]!.abstained).toBe(false);
    expect(traces[0]!.reason).toBe('answered');
  });

  it('traces the empty reason for empty context', async () => {
    clearEmbeddingCache();
    const traces: DecisionTrace[] = [];
    const llm = scriptedLlm(() => 'blue');
    const system = new NaturalLanguageMemorySystem('s', {
      embedding,
      llm,
      onDecision: (t) => traces.push(t),
    });
    await system.answer('What is X?', []);
    expect(traces[0]!.abstained).toBe(true);
    expect(traces[0]!.reason).toBe('empty');
  });
});
