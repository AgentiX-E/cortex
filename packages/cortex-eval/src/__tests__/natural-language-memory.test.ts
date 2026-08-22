import { describe, it, expect } from 'vitest';
import type { EmbeddingModel, LLM } from '@agentix-e/cortex-core';
import {
  NaturalLanguageMemorySystem,
  buildQaPrompt,
  buildTemporalQaPrompt,
  buildAggregationQaPrompt,
  buildLegacyAggregationQaPrompt,
  buildQueryExpansionPrompt,
  buildTemporalQueryExpansionPrompt,
  parseQueryExpansion,
  truncateText,
  truncateSession,
  parseQaAnswer,
  parseAggregationAnswer,
  isUserTurn,
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

describe('buildTemporalQaPrompt', () => {
  it('supplies the question date and date-reading instructions', () => {
    const prompt = buildTemporalQaPrompt('How many weeks ago?', 'ctx', '2023/03/15');
    expect(prompt).toContain('2023/03/15');
    expect(prompt).toContain('YYYY/MM/DD');
    expect(prompt).toContain('Question: How many weeks ago?');
  });

  it('omits the reference line when no question date is given', () => {
    const prompt = buildTemporalQaPrompt('Which happened first?', 'ctx');
    expect(prompt).not.toContain('use it as "today"');
  });
});

describe('buildAggregationQaPrompt', () => {
  it('instructs the LLM to enumerate items before counting', () => {
    const prompt = buildAggregationQaPrompt('How many X?', 'session evidence');
    expect(prompt).toContain('MULTIPLE conversation sessions');
    expect(prompt).toContain('Step 1 — Enumerate');
    expect(prompt).toContain('exchange');
    expect(prompt).toContain('Question: How many X?');
    expect(prompt).toContain('session evidence');
  });

  it('tells the model not to re-filter the enumerated items in step 2', () => {
    const prompt = buildAggregationQaPrompt('How many X?', 'ctx');
    expect(prompt).toContain('do NOT re-filter or exclude any of them');
  });

  it('instructs the model to compute the answer type the question asks for', () => {
    const prompt = buildAggregationQaPrompt('How many hours in total?', 'ctx');
    expect(prompt).toContain('sum the durations, NOT the item count');
    expect(prompt).toContain('sum the amounts');
    expect(prompt).toContain('report that value or event, NOT a count');
  });

  it('forbids substituting a related verb for the exact action', () => {
    const prompt = buildAggregationQaPrompt('How many projects have I led?', 'ctx');
    expect(prompt).toContain('Do NOT substitute or infer a different verb');
    expect(prompt).toContain('"participated"');
    expect(prompt).toContain('"led"');
  });

  it('accepts a custom abstention token', () => {
    const prompt = buildAggregationQaPrompt('Q?', 'ctx', 'NONE');
    expect(prompt).toContain('NONE');
  });
});

describe('buildLegacyAggregationQaPrompt', () => {
  it('keeps the pre-CoT inline counting rules without enumeration', () => {
    const prompt = buildLegacyAggregationQaPrompt('How many X?', 'session evidence');
    expect(prompt).toContain('MULTIPLE conversation sessions');
    expect(prompt).toContain('Counting rules:');
    expect(prompt).toContain('TWO items total');
    expect(prompt).toContain('Question: How many X?');
    expect(prompt).toContain('session evidence');
    expect(prompt).not.toContain('Step 1 — Enumerate');
  });

  it('accepts a custom abstention token', () => {
    const prompt = buildLegacyAggregationQaPrompt('Q?', 'ctx', 'NONE');
    expect(prompt).toContain('NONE');
  });
});

describe('truncateText', () => {
  it('returns the text unchanged when within the budget', () => {
    expect(truncateText('short', 10)).toBe('short');
  });

  it('truncates and marks oversized text', () => {
    expect(truncateText('abcdef', 3)).toBe('abc\n[truncated]');
  });
});

describe('truncateSession', () => {
  it('returns short text unchanged', () => {
    expect(truncateSession('short', 100)).toBe('short');
  });

  it('preserves user turns while capping verbose assistant turns', () => {
    const text = [
      '[2023/02/15] user: fact about boots',
      `[2023/02/15] assistant: ${'x'.repeat(500)}`,
      '[2023/02/15] user: another fact',
    ].join('\n');
    const result = truncateSession(text, 500);
    expect(result).toContain('fact about boots');
    expect(result).toContain('another fact');
    expect(result).not.toContain('x'.repeat(500));
  });

  it('marks the session when truncation occurs', () => {
    const text = `[2023/02/15] user: fact\n[2023/02/15] assistant: ${'y'.repeat(300)}`;
    expect(truncateSession(text, 150)).toContain('[truncated]');
  });

  it('stops keeping user turns once the budget is exhausted', () => {
    const text = [
      '[2023/02/15] user: first fact',
      '[2023/02/15] user: second fact that exceeds the budget',
    ].join('\n');
    const result = truncateSession(text, 30);
    expect(result).toContain('first fact');
    expect(result).not.toContain('second fact');
    expect(result).toContain('[truncated]');
  });
});

describe('buildQueryExpansionPrompt', () => {
  it('asks for concrete evidence phrases', () => {
    const prompt = buildQueryExpansionPrompt('How many items of clothing?');
    expect(prompt).toContain('How many items of clothing?');
    expect(prompt).toContain('Specific items:');
  });
});

describe('buildTemporalQueryExpansionPrompt', () => {
  it('asks for event descriptions with a verb, not bare nouns', () => {
    const prompt = buildTemporalQueryExpansionPrompt(
      'How many weeks ago did I receive the chandelier?',
    );
    expect(prompt).toContain('How many weeks ago did I receive the chandelier?');
    expect(prompt).toContain('Specific events:');
    expect(prompt).toContain('action verb');
    expect(prompt).toContain('bare object nouns');
  });
});

describe('parseQueryExpansion', () => {
  it('splits comma, newline, and semicolon separated phrases', () => {
    expect(parseQueryExpansion('a, b\n c; d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops empty entries', () => {
    expect(parseQueryExpansion(' a, , b ')).toEqual(['a', 'b']);
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

describe('parseAggregationAnswer', () => {
  it('extracts the labelled final answer', () => {
    const raw = '- navy blazer | pick up | 2023/02/15\n- boots | return | 2023/02/15\nAnswer: 3';
    expect(parseAggregationAnswer(raw)).toBe('3');
  });

  it('accepts a final answer label', () => {
    expect(parseAggregationAnswer('item one\nitem two\nFinal answer: 2')).toBe('2');
  });

  it('ignores an intermediate Count line in favour of the final Answer', () => {
    const raw = 'Count: 5 distinct projects led or currently leading.\n\nAnswer: 5';
    expect(parseAggregationAnswer(raw)).toBe('5');
  });

  it('falls back to the last non-empty line', () => {
    expect(parseAggregationAnswer('evidence line\n3')).toBe('3');
  });

  it('abstains when the last line is an evidence bullet', () => {
    expect(parseAggregationAnswer('- blazer | pick up')).toBeNull();
  });

  it('returns null for the abstention token (case-insensitive)', () => {
    expect(parseAggregationAnswer('UNANSWERABLE')).toBeNull();
    expect(parseAggregationAnswer('unanswerable')).toBeNull();
  });

  it('returns null when the labelled answer is the abstention token', () => {
    // The model can follow the "Answer:" format even while abstaining.
    expect(parseAggregationAnswer('...\nAnswer: UNANSWERABLE')).toBeNull();
    expect(parseAggregationAnswer('Final answer: "UNANSWERABLE"')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseAggregationAnswer('   ')).toBeNull();
  });

  it('strips surrounding quotes from the final answer', () => {
    expect(parseAggregationAnswer('Answer: "blue"')).toBe('blue');
  });
});

describe('isUserTurn', () => {
  it('recognises a date-prefixed user turn', () => {
    expect(isUserTurn('[2023/01/08] user: I visited MoMA')).toBe(true);
    expect(isUserTurn('[2023/01/08 (Thu) 03:50] user: hello')).toBe(true);
  });

  it('rejects assistant turns', () => {
    expect(isUserTurn('[2023/01/08] assistant: verbose response')).toBe(false);
    expect(isUserTurn('assistant: no date')).toBe(false);
  });

  it('recognises an unprefixed user turn', () => {
    expect(isUserTurn('user: My favorite color is blue.')).toBe(true);
  });

  it('returns false for plain text without a role prefix', () => {
    expect(isUserTurn('My favorite color is blue.')).toBe(false);
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
      // Disable expansion so this test exercises the threshold path without an
      // expansion LLM call.
      enableQueryExpansion: false,
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
    const s1 = new NaturalLanguageMemorySystem('s1', {
      embedding: counting,
      llm,
      enableQueryExpansion: false,
    });
    const s2 = new NaturalLanguageMemorySystem('s2', {
      embedding: counting,
      llm,
      enableQueryExpansion: false,
    });
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
    const system = new NaturalLanguageMemorySystem('s', {
      embedding: counting,
      llm,
      enableQueryExpansion: false,
    });
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
    const system = new NaturalLanguageMemorySystem('s', {
      embedding: counting,
      llm,
      enableQueryExpansion: false,
    });
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
    const system = new NaturalLanguageMemorySystem('s', {
      embedding,
      llm,
      topK: 1,
      enableQueryExpansion: false,
    });
    await system.answer('What is zzzalpha?', ['zzzalpha fact']);
    await system.answer('What is zzzbeta?', ['zzzbeta fact']);
    // The second question's retrieved context must not contain the first question's turn.
    expect(prompts[1]).toContain('zzzbeta fact');
    expect(prompts[1]).not.toContain('zzzalpha fact');
  });

  it('expands the question before single-session retrieval by default', async () => {
    const prompts: string[] = [];
    const llm: LLM = {
      complete: async (prompt) => {
        prompts.push(prompt);
        if (prompt.includes('Specific items:')) {
          return 'crystal chandelier';
        }
        return 'blue';
      },
      completeStructured: async <T>() => ({}) as T,
    };
    const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
    await system.answer('How many weeks ago did I receive the chandelier?', [
      'I received a crystal chandelier from my aunt.',
    ]);
    // Query expansion runs first, then the QA answer prompt.
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('Specific items:');
    expect(prompts[1]).toContain('Question: How many weeks ago');
  });

  it('indexes only user turns so assistant chatter never reaches the LLM', async () => {
    const prompts: string[] = [];
    const llm: LLM = {
      complete: async (prompt) => {
        prompts.push(prompt);
        if (prompt.includes('Specific items:')) {
          return 'color';
        }
        return prompt.includes('favorite color is blue') ? 'blue' : 'UNANSWERABLE';
      },
      completeStructured: async <T>() => ({}) as T,
    };
    const system = new NaturalLanguageMemorySystem('s', { embedding, llm, topK: 2 });
    const answer = await system.answer('What is the favorite color?', [
      '[2023/01/08] assistant: verbose chatter that must not be injected',
      '[2023/01/09] user: My favorite color is blue.',
    ]);
    expect(answer).toBe('blue');
    const qaPrompt = prompts[prompts.length - 1]!;
    expect(qaPrompt).toContain('favorite color is blue');
    expect(qaPrompt).not.toContain('verbose chatter');
  });

  it('falls back to all turns when no user turn is present', async () => {
    const llm = scriptedLlm((prompt) =>
      prompt.includes('favorite color is blue') ? 'blue' : 'UNANSWERABLE',
    );
    const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
    const answer = await system.answer('What is the favorite color?', [
      '[2023/01/08] assistant: My favorite color is blue.',
    ]);
    // No user turn exists, so the system falls back to the assistant-only turn.
    expect(answer).toBe('blue');
  });

  it('answerTemporal uses the temporal event expansion and the question date', async () => {
    const prompts: string[] = [];
    const llm: LLM = {
      complete: async (prompt) => {
        prompts.push(prompt);
        if (prompt.includes('Specific events:')) {
          return 'receive crystal chandelier from aunt';
        }
        return '4 weeks';
      },
      completeStructured: async <T>() => ({}) as T,
    };
    const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
    await system.answerTemporal(
      'How many weeks ago did I receive the chandelier?',
      ['[2023/03/04] user: I received a crystal chandelier from my aunt.'],
      '2023/04/01',
    );
    // The temporal path first runs event-level query expansion, then the
    // temporal QA prompt carrying the reference date.
    expect(prompts[0]).toContain('Specific events:');
    const qaPrompt = prompts[prompts.length - 1]!;
    expect(qaPrompt).toContain('2023/04/01');
    expect(qaPrompt).toContain('YYYY/MM/DD');
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
      new NaturalLanguageMemorySystem('s', {
        embedding: counting,
        llm,
        enableQueryExpansion: false,
      });
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

  it('records retrieved evidence, raw LLM output, and answer in the trace', async () => {
    clearEmbeddingCache();
    const traces: DecisionTrace[] = [];
    const llm = scriptedLlm(() => 'blue');
    const system = new NaturalLanguageMemorySystem('s', {
      embedding,
      llm,
      onDecision: (t) => traces.push(t),
    });
    await system.answer('What is the favorite color?', ['My favorite color is blue.']);
    expect(traces[0]!.retrieved).toContain('favorite color is blue');
    expect(traces[0]!.llmRaw).toBe('blue');
    expect(traces[0]!.answer).toBe('blue');
  });

  it('surfaces the expansion phrases in the single-session decision trace', async () => {
    clearEmbeddingCache();
    const traces: DecisionTrace[] = [];
    const llm: LLM = {
      complete: async (prompt) => {
        if (prompt.includes('Specific items:')) {
          return 'crystal chandelier';
        }
        return 'blue';
      },
      completeStructured: async <T>() => ({}) as T,
    };
    const system = new NaturalLanguageMemorySystem('s', {
      embedding,
      llm,
      onDecision: (t) => traces.push(t),
    });
    await system.answer('What is X?', ['turn A']);
    expect(traces[0]!.expansionQueries).toEqual(['crystal chandelier']);
  });

  it('leaves raw LLM output undefined when the LLM is not called', async () => {
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
    expect(traces[0]!.reason).toBe('threshold');
    expect(traces[0]!.llmRaw).toBeUndefined();
    expect(traces[0]!.answer).toBeNull();
  });

  describe('answerSessions', () => {
    it('retrieves whole sessions and answers from the aggregated evidence', async () => {
      const llm = scriptedLlm((prompt) =>
        prompt.includes('favorite color') ? 'blue' : 'UNANSWERABLE',
      );
      const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
      const answer = await system.answerSessions('What is the favorite color?', [
        ['My favorite color is blue.'],
        ['unrelated session'],
      ]);
      expect(answer).toBe('blue');
    });

    it('parses the enumerated final answer from the aggregation response', async () => {
      const llm = scriptedLlm(
        () => '- blazer | pick up | 2023/02/15\n- boots | return | 2023/02/15\nAnswer: 3',
      );
      const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
      const answer = await system.answerSessions('How many items?', [
        ['I need to pick up a blazer.'],
        ['I need to return boots.'],
      ]);
      expect(answer).toBe('3');
    });

    it('does not threshold-abstain the session path with only abstainThreshold set', async () => {
      const prompts: string[] = [];
      const llm: LLM = {
        complete: async (prompt) => {
          prompts.push(prompt);
          return prompt.includes('Specific items:') ? 'color' : 'blue';
        },
        completeStructured: async <T>() => ({}) as T,
      };
      const system = new NaturalLanguageMemorySystem('s', {
        embedding,
        llm,
        // This threshold governs the single-session path only; the session path
        // needs sessionAbstainThreshold to abstain on similarity.
        abstainThreshold: 0.99,
      });
      const answer = await system.answerSessions('What is the favorite color?', [
        ['My favorite color is blue.'],
      ]);
      // The aggregation prompt is still reached and answers, because top-1
      // session similarity is a poor abstention signal for multi-session answers.
      expect(answer).toBe('blue');
      expect(prompts).toHaveLength(2);
    });

    it('threshold-abstains the session path when sessionAbstainThreshold is set', async () => {
      const prompts: string[] = [];
      const llm: LLM = {
        complete: async (prompt) => {
          prompts.push(prompt);
          return 'blue';
        },
        completeStructured: async <T>() => ({}) as T,
      };
      const system = new NaturalLanguageMemorySystem('s', {
        embedding,
        llm,
        sessionAbstainThreshold: 0.99,
      });
      const answer = await system.answerSessions('What is the favorite color?', [
        ['My favorite color is blue.'],
      ]);
      expect(answer).toBeNull();
      // Query expansion calls the LLM once; the aggregation prompt is never
      // reached because the session threshold abstains before it.
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('Specific items:');
    });

    it('returns null for empty sessions when abstention is enabled', async () => {
      const llm = scriptedLlm(() => 'blue');
      const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
      expect(await system.answerSessions('What is X?', [[], []])).toBeNull();
    });

    it('skips query expansion when disabled', async () => {
      const prompts: string[] = [];
      const llm: LLM = {
        complete: async (prompt) => {
          prompts.push(prompt);
          return prompt.includes('favorite color is blue') ? 'blue' : 'UNANSWERABLE';
        },
        completeStructured: async <T>() => ({}) as T,
      };
      const system = new NaturalLanguageMemorySystem('s', {
        embedding,
        llm,
        enableQueryExpansion: false,
      });
      const answer = await system.answerSessions('What is the favorite color?', [
        ['My favorite color is blue.'],
      ]);
      expect(answer).toBe('blue');
      // Only the aggregation LLM call happens; no query-expansion prompt.
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).not.toContain('Specific items:');
    });

    it('falls back to base recall when query expansion returns empty', async () => {
      const prompts: string[] = [];
      const llm: LLM = {
        complete: async (prompt) => {
          prompts.push(prompt);
          if (prompt.includes('Specific items:')) {
            return '';
          }
          return prompt.includes('favorite color is blue') ? 'blue' : 'UNANSWERABLE';
        },
        completeStructured: async <T>() => ({}) as T,
      };
      const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
      const answer = await system.answerSessions('What is the favorite color?', [
        ['My favorite color is blue.'],
      ]);
      expect(answer).toBe('blue');
    });

    it('injects whole sessions and aggregates evidence for multi-session answers', async () => {
      const prompts: string[] = [];
      const llm: LLM = {
        complete: async (prompt) => {
          prompts.push(prompt);
          if (prompt.includes('Specific items:')) {
            return 'color';
          }
          return prompt.includes('favorite color is blue') ? 'blue' : 'UNANSWERABLE';
        },
        completeStructured: async <T>() => ({}) as T,
      };
      const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
      const answer = await system.answerSessions('What is the favorite color?', [
        [
          'My favorite color is blue.',
          'some unrelated chatter about weather',
          'more unrelated chatter',
        ],
        ['another unrelated session'],
      ]);
      expect(answer).toBe('blue');
      // The final prompt is the aggregation prompt, which receives the injected
      // whole-session evidence and the enumerate-then-count instruction.
      const aggregationPrompt = prompts[prompts.length - 1]!;
      expect(aggregationPrompt).toContain('favorite color is blue');
      expect(aggregationPrompt).toContain('Step 1 — Enumerate');
    });

    it('never abstains on empty sessions when abstention is disabled', async () => {
      const llm = scriptedLlm(() => 'blue');
      const system = new NaturalLanguageMemorySystem('s', {
        embedding,
        llm,
        enableAbstention: false,
      });
      expect(await system.answerSessions('What is X?', [[], []])).toBe('unknown');
    });

    it('routes the MR path through a custom aggregation prompt when configured', async () => {
      const prompts: string[] = [];
      const llm: LLM = {
        complete: async (prompt) => {
          prompts.push(prompt);
          if (prompt.includes('Specific items:')) {
            return 'color';
          }
          return prompt.includes('CUSTOM AGGREGATION MARKER') ? 'blue' : 'UNANSWERABLE';
        },
        completeStructured: async <T>() => ({}) as T,
      };
      const system = new NaturalLanguageMemorySystem('s', {
        embedding,
        llm,
        aggregationPrompt: (q, ctx) => `CUSTOM AGGREGATION MARKER\nQuestion: ${q}\n${ctx}`,
      });
      const answer = await system.answerSessions('What is the favorite color?', [
        ['My favorite color is blue.'],
      ]);
      expect(answer).toBe('blue');
      const aggregationPrompt = prompts[prompts.length - 1]!;
      expect(aggregationPrompt).toContain('CUSTOM AGGREGATION MARKER');
      expect(aggregationPrompt).not.toContain('Step 1 — Enumerate');
    });
  });
});
