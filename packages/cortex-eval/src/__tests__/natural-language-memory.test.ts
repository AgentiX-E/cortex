import { describe, it, expect } from 'vitest';
import type { EmbeddingModel, LLM } from '@agentix-e/cortex-core';
import {
  NaturalLanguageMemorySystem,
  buildQaPrompt,
  buildConservativeQaPrompt,
  buildTemporalQaPrompt,
  buildTemporalEventLookupPrompt,
  buildTemporalEventExtractionPrompt,
  buildAggregationQaPrompt,
  buildLegacyAggregationQaPrompt,
  buildPreferencePrompt,
  buildKnowledgeUpdatePrompt,
  buildFactExtractionPrompt,
  buildQueryExpansionPrompt,
  buildTemporalQueryExpansionPrompt,
  buildMultiSessionQueryExpansionPrompt,
  parseQueryExpansion,
  truncateText,
  truncateSession,
  parseQaAnswer,
  parseAggregationAnswer,
  isUserTurn,
  isAssistantTurn,
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

  it('decomposes reading into note-extraction then reasoning (CoN)', () => {
    const prompt = buildQaPrompt('What is X?', 'context line');
    expect(prompt).toContain('Work in two steps.');
    expect(prompt).toContain('Step 1 — Read each turn');
    expect(prompt).toContain('Step 2 — Answer the question using ONLY those identified facts');
  });

  it('tells the model to choose among candidates instead of abstaining', () => {
    const prompt = buildQaPrompt('What is my current city?', 'context');
    expect(prompt).toContain('more than one possible answer');
    expect(prompt).toContain('NOT a reason to abstain');
    expect(prompt).toContain('offers no answer to the question at all');
  });

  it('accepts a custom abstention token', () => {
    const prompt = buildQaPrompt('Q?', 'ctx', 'NONE');
    expect(prompt).toContain('NONE');
  });
});

describe('buildConservativeQaPrompt', () => {
  it('keeps the loose abstention wording and omits the candidate-choosing instruction', () => {
    const prompt = buildConservativeQaPrompt('What is X?', 'context line');
    expect(prompt).toContain('Question: What is X?');
    expect(prompt).toContain('context line');
    expect(prompt).toContain('UNANSWERABLE');
    expect(prompt).toContain('no relevant information at all');
    expect(prompt).not.toContain('more than one possible answer');
    expect(prompt).not.toContain('NOT a reason to abstain');
  });

  it('accepts a custom abstention token', () => {
    const prompt = buildConservativeQaPrompt('Q?', 'ctx', 'NONE');
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

  it('decomposes reading into note-extraction then reasoning (CoN)', () => {
    const prompt = buildTemporalQaPrompt('How many weeks ago?', 'ctx', '2023/03/15');
    expect(prompt).toContain('Work in two steps.');
    expect(prompt).toContain('Step 1 — Read each turn');
    expect(prompt).toContain('Step 2 — Answer the question using ONLY those identified facts');
  });

  it('omits the reference line when no question date is given', () => {
    const prompt = buildTemporalQaPrompt('Which happened first?', 'ctx');
    expect(prompt).not.toContain('use it as "today"');
  });
});

describe('buildTemporalEventLookupPrompt', () => {
  it('directs the model to extract the entity instead of computing elapsed time', () => {
    const prompt = buildTemporalEventLookupPrompt(
      'What was the event two weeks ago?',
      'ctx',
      '2023/07/01',
    );
    expect(prompt).toContain('What was the event two weeks ago?');
    expect(prompt).toContain('2023/07/01');
    expect(prompt).toContain('Do NOT count, compute elapsed time');
    expect(prompt).toContain('extract the event, person, object, place, or value');
    expect(prompt).not.toContain('compute the elapsed days/weeks/months');
  });

  it('decomposes reading into note-extraction then reasoning (CoN)', () => {
    const prompt = buildTemporalEventLookupPrompt('What was the event?', 'ctx', '2023/07/01');
    expect(prompt).toContain('Work in two steps.');
    expect(prompt).toContain('Step 1 — Read each turn');
    expect(prompt).toContain('Step 2 — Answer the question using ONLY those identified facts');
  });

  it('supplies the question date as the "today" reference', () => {
    const prompt = buildTemporalEventLookupPrompt('Q?', 'ctx', '2023/04/01');
    expect(prompt).toContain('The question was asked on 2023/04/01');
    expect(prompt).toContain('use it as "today"');
  });

  it('omits the reference line when no question date is given', () => {
    const prompt = buildTemporalEventLookupPrompt('Q?', 'ctx');
    expect(prompt).not.toContain('use it as "today"');
  });

  it('accepts a custom abstention token', () => {
    const prompt = buildTemporalEventLookupPrompt('Q?', 'ctx', '2023/04/01', 'NONE');
    expect(prompt).toContain('NONE');
  });
});

describe('buildTemporalEventExtractionPrompt', () => {
  it('asks the LLM to copy event dates without computing arithmetic', () => {
    const prompt = buildTemporalEventExtractionPrompt(
      'How many weeks ago did I receive the chandelier?',
      'context line',
      '2023/04/01',
    );
    expect(prompt).toContain('How many weeks ago did I receive the chandelier?');
    expect(prompt).toContain('context line');
    expect(prompt).toContain('2023/04/01');
    expect(prompt).toContain('Do NOT compute');
    expect(prompt).toContain('JSON');
  });

  it('omits the reference line when no question date is given', () => {
    const prompt = buildTemporalEventExtractionPrompt('Which happened first?', 'ctx');
    expect(prompt).not.toContain('The question was asked on');
  });

  it('instructs the model to report relative dates verbatim, not convert them', () => {
    const prompt = buildTemporalEventExtractionPrompt(
      'How long had I been bird watching when I attended the workshop?',
      'ctx',
      '2023/05/21',
    );
    expect(prompt).toContain('relative to the question date');
    expect(prompt).toContain('VERBATIM');
    expect(prompt).toContain('a month ago');
    expect(prompt).toContain('omit that event entirely');
    expect(prompt).toContain('Do NOT convert it to an absolute date');
  });

  it('never asks the model to convert relative times to absolute dates', () => {
    const prompt = buildTemporalEventExtractionPrompt('Which happened first?', 'ctx');
    // The engine performs relative-to-absolute conversion with exact arithmetic,
    // so the prompt must not ask the model to do that arithmetic itself.
    expect(prompt).not.toContain('2023/04/21');
    expect(prompt).not.toContain('treat the question date as "today"');
  });

  it('lists the pre-identified event hints as guidance', () => {
    const prompt = buildTemporalEventExtractionPrompt(
      'Which happened first, A or B?',
      'ctx',
      '2023/10/01',
      ['event A', 'event B'],
    );
    expect(prompt).toContain('The question likely refers to these event(s):');
    expect(prompt).toContain('- event A');
    expect(prompt).toContain('- event B');
  });

  it('omits the hints section when no event hints are provided', () => {
    const prompt = buildTemporalEventExtractionPrompt('How many weeks ago?', 'ctx');
    expect(prompt).not.toContain('The question likely refers to these event(s):');
  });

  it('includes a worked example that anchors the input-output mapping', () => {
    const prompt = buildTemporalEventExtractionPrompt('How many weeks ago?', 'ctx');
    expect(prompt).toContain('Example:');
    expect(prompt).toContain('"events"');
  });

  it('suppresses generic event hints for ordering questions', () => {
    const prompt = buildTemporalEventExtractionPrompt(
      'What is the order of the three trips I took?',
      'ctx',
      '2023/10/01',
      ['took trip', 'took trip', 'took trip'],
      'ordering',
    );
    expect(prompt).not.toContain('The question likely refers to these event(s):');
    expect(prompt).not.toContain('- took trip');
  });

  it('instructs ordering questions to name each event specifically', () => {
    const prompt = buildTemporalEventExtractionPrompt(
      'What is the order of the three trips I took?',
      'ctx',
      '2023/10/01',
      [],
      'ordering',
    );
    expect(prompt).toContain('SPECIFIC name');
    expect(prompt).toContain('generic phrase');
    expect(prompt).toContain('order');
  });

  it('still lists event hints for non-ordering questions', () => {
    const prompt = buildTemporalEventExtractionPrompt(
      'How many weeks ago did I receive the chandelier?',
      'ctx',
      '2023/10/01',
      ['receive chandelier'],
      'relative',
    );
    expect(prompt).toContain('The question likely refers to these event(s):');
    expect(prompt).toContain('- receive chandelier');
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

describe('buildPreferencePrompt', () => {
  it('instructs the model to generate a preference-aligned recommendation', () => {
    const prompt = buildPreferencePrompt('Can you recommend a show?', 'I like stand-up comedy.');
    expect(prompt).toContain('recommendation');
    expect(prompt).toContain('preference');
    expect(prompt).toContain('I like stand-up comedy.');
    expect(prompt).toContain('Question: Can you recommend a show?');
  });

  it('decomposes reading into note-extraction then reasoning (CoN)', () => {
    const prompt = buildPreferencePrompt('Can you recommend a show?', 'I like stand-up comedy.');
    expect(prompt).toContain('Work in two steps.');
    expect(prompt).toContain('Step 1 — Read each turn');
    expect(prompt).toContain('Step 2 — Answer the question using ONLY those identified facts');
  });

  it('requires the recommendation to name the user-specified options', () => {
    const prompt = buildPreferencePrompt('Any video editing resources?', 'I use Premiere Pro.');
    expect(prompt).toContain('specific');
    expect(prompt).toContain('brands, products, topics');
  });

  it('accepts a custom abstention token', () => {
    const prompt = buildPreferencePrompt('Q?', 'ctx', 'NONE');
    expect(prompt).toContain('NONE');
  });
});

describe('buildKnowledgeUpdatePrompt', () => {
  it('instructs the model to map time qualifiers to the matching value', () => {
    const prompt = buildKnowledgeUpdatePrompt('What was my previous city?', 'I moved to Shanghai.');
    expect(prompt).toContain('previous');
    expect(prompt).toContain('older');
    expect(prompt).toContain('I moved to Shanghai.');
    expect(prompt).toContain('Question: What was my previous city?');
  });

  it('covers current/latest qualifiers with the later-value rule', () => {
    const prompt = buildKnowledgeUpdatePrompt('What is my current city?', 'ctx');
    expect(prompt).toContain('current');
    expect(prompt).toContain('newer');
  });

  it('enumerates distinct values before selecting the time-qualified one', () => {
    const prompt = buildKnowledgeUpdatePrompt('What is my current city?', 'ctx');
    expect(prompt).toContain('Step 1');
    expect(prompt).toContain('Step 2');
    expect(prompt).toContain('Enumerate');
    expect(prompt).toContain('BOTH the old and the new value');
  });

  it('accepts a custom abstention token', () => {
    const prompt = buildKnowledgeUpdatePrompt('Q?', 'ctx', 'NONE');
    expect(prompt).toContain('NONE');
  });
});

describe('buildFactExtractionPrompt', () => {
  it('asks the LLM to extract subject/object/date triples without selecting', () => {
    const prompt = buildFactExtractionPrompt('What is my current city?', 'context line');
    expect(prompt).toContain('What is my current city?');
    expect(prompt).toContain('context line');
    expect(prompt).toContain('subject');
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('Do NOT');
  });

  it('includes a worked example anchoring the triple format', () => {
    const prompt = buildFactExtractionPrompt('What is my current city?', 'ctx');
    expect(prompt).toContain('Example:');
    expect(prompt).toContain('"facts"');
    expect(prompt).toContain('date');
  });
});

describe('truncateText', () => {
  it('returns the text unchanged when within the budget', () => {
    expect(truncateText('short', 10)).toBe('short');
  });

  it('truncates and marks oversized text', () => {
    expect(truncateText('abcdef', 3)).toBe('abc\n[truncated]');
  });

  it('does not split a surrogate pair at the truncation boundary', () => {
    // 'a' + '😀' (a surrogate pair) + 'b'; a cut at 2 code units lands between
    // the two halves of the emoji and would leave a lone high surrogate.
    const result = truncateText('a😀b', 2);
    expect(result).toBe('a\n[truncated]');
    expect(result).not.toContain('\uD83D');
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

  it('instructs pairing an entity with its property instead of a bare noun', () => {
    const prompt = buildQueryExpansionPrompt('What is the name of my cat?');
    expect(prompt).toContain('property');
    expect(prompt).toContain('Do NOT list a bare category noun');
  });

  it('instructs against inventing names not stated in the question', () => {
    const prompt = buildQueryExpansionPrompt('What game did I finally beat?');
    expect(prompt).toContain('Do NOT invent');
  });

  it('includes a worked example anchoring the entity+property mapping', () => {
    const prompt = buildQueryExpansionPrompt('What is the name of my cat?');
    expect(prompt).toContain('Example:');
    expect(prompt).toContain('name of the cat');
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

describe('buildMultiSessionQueryExpansionPrompt', () => {
  it('asks for activity phrases with an action, not bare nouns', () => {
    const prompt = buildMultiSessionQueryExpansionPrompt('How many projects have I led?');
    expect(prompt).toContain('How many projects have I led?');
    expect(prompt).toContain('Specific activities:');
    expect(prompt).toContain('action');
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

  it('extracts the labelled answer from a chain-of-note narration', () => {
    const raw =
      'Step 1 — relevant facts: the user attended a bird watching workshop.\n' +
      'Step 2 — from 2023/04/01 to 2023/05/01 is 30 days.\n\n' +
      'Answer: 4';
    expect(parseQaAnswer(raw)).toBe('4');
  });

  it('keeps a plain answer without an answer label unchanged', () => {
    expect(parseQaAnswer('blue')).toBe('blue');
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

describe('isAssistantTurn', () => {
  it('recognises a date-prefixed assistant turn', () => {
    expect(isAssistantTurn('[2023/01/08] assistant: verbose response')).toBe(true);
    expect(isAssistantTurn('[2023/01/08 (Thu) 03:50] assistant: hello')).toBe(true);
  });

  it('rejects user turns', () => {
    expect(isAssistantTurn('[2023/01/08] user: I visited MoMA')).toBe(false);
    expect(isAssistantTurn('user: no date')).toBe(false);
  });

  it('returns false for plain text without a role prefix', () => {
    expect(isAssistantTurn('My favorite color is blue.')).toBe(false);
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

  it('caps an oversized turn before injecting it into the single-session prompt', async () => {
    const prompts: string[] = [];
    const llm: LLM = {
      complete: async (prompt) => {
        prompts.push(prompt);
        if (prompt.includes('Specific items:')) {
          return 'color';
        }
        return 'blue';
      },
      completeStructured: async <T>() => ({}) as T,
    };
    const system = new NaturalLanguageMemorySystem('s', {
      embedding,
      llm,
      maxTurnChars: 20,
      enableQueryExpansion: false,
    });
    await system.answer('What is the favorite color?', ['[2023/01/09] user: ' + 'x'.repeat(500)]);
    const qaPrompt = prompts[prompts.length - 1]!;
    // The oversized turn is truncated to the per-turn budget, not injected verbatim.
    expect(qaPrompt).not.toContain('x'.repeat(500));
    expect(qaPrompt).toContain('[truncated]');
  });

  it('answerAssistant retrieves from assistant turns instead of filtering them out', async () => {
    const prompts: string[] = [];
    const llm: LLM = {
      complete: async (prompt) => {
        prompts.push(prompt);
        if (prompt.includes('Specific items:')) {
          return 'color';
        }
        return prompt.includes('assistant said blue') ? 'blue' : 'UNANSWERABLE';
      },
      completeStructured: async <T>() => ({}) as T,
    };
    const system = new NaturalLanguageMemorySystem('s', { embedding, llm, topK: 2 });
    const answer = await system.answerAssistant('What did I say my favorite color was?', [
      '[2023/01/08] assistant: The assistant said blue.',
    ]);
    expect(answer).toBe('blue');
    const qaPrompt = prompts[prompts.length - 1]!;
    expect(qaPrompt).toContain('assistant said blue');
  });

  it('answerAbstention uses the conservative prompt with the loose wording', async () => {
    const prompts: string[] = [];
    const llm: LLM = {
      complete: async (prompt) => {
        prompts.push(prompt);
        if (prompt.includes('Specific items:')) {
          return 'color';
        }
        return 'UNANSWERABLE';
      },
      completeStructured: async <T>() => ({}) as T,
    };
    const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
    const answer = await system.answerAbstention('What is the meaning of life?', [
      '[2023/01/08] user: I like the color blue.',
    ]);
    expect(answer).toBeNull();
    // The final QA prompt must use the conservative (loose) abstention wording.
    const qaPrompt = prompts[prompts.length - 1]!;
    expect(qaPrompt).toContain('no relevant information at all');
    expect(qaPrompt).not.toContain('NOT a reason to abstain');
  });

  it('answerPreference generates a recommendation instead of abstaining', async () => {
    const prompts: string[] = [];
    const llm: LLM = {
      complete: async (prompt) => {
        prompts.push(prompt);
        if (prompt.includes('Specific items:')) {
          return 'video editing';
        }
        return 'Adobe Premiere Pro advanced tutorials';
      },
      completeStructured: async <T>() => ({}) as T,
    };
    const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
    const answer = await system.answerPreference(
      'Can you recommend some resources for video editing?',
      ['[2023/05/20] user: I edit with Adobe Premiere Pro.'],
    );
    expect(answer).toBe('Adobe Premiere Pro advanced tutorials');
    // The final prompt must be the generative preference prompt, not the
    // extractive QA prompt that would push the model to abstain.
    const qaPrompt = prompts[prompts.length - 1]!;
    expect(qaPrompt).toContain('recommendation');
    expect(qaPrompt).toContain('I edit with Adobe Premiere Pro.');
  });

  it('answerPreference retrieves from all turns including assistant turns', async () => {
    const llm: LLM = {
      complete: async (prompt) => {
        if (prompt.includes('Specific items:')) {
          return 'show';
        }
        return prompt.includes('assistant noted Netflix')
          ? 'a Netflix stand-up special'
          : 'UNANSWERABLE';
      },
      completeStructured: async <T>() => ({}) as T,
    };
    const system = new NaturalLanguageMemorySystem('s', { embedding, llm, topK: 2 });
    const answer = await system.answerPreference('Can you recommend a show tonight?', [
      '[2023/05/20] assistant: The assistant noted Netflix.',
    ]);
    expect(answer).toBe('a Netflix stand-up special');
  });

  it('answerKnowledgeUpdate uses the time-qualifier-aware prompt', async () => {
    const prompts: string[] = [];
    const llm: LLM = {
      complete: async (prompt) => {
        prompts.push(prompt);
        if (prompt.includes('Specific items:')) {
          return 'city';
        }
        return 'Shanghai';
      },
      completeStructured: async <T>() => ({}) as T,
    };
    const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
    const answer = await system.answerKnowledgeUpdate('What is my current city?', [
      '[2023/01/08] user: I lived in Beijing.',
      '[2023/03/04] user: I moved to Shanghai.',
    ]);
    expect(answer).toBe('Shanghai');
    // The final prompt must be the knowledge-update prompt, not the generic QA
    // prompt, so the model maps "current" to the later value.
    const qaPrompt = prompts[prompts.length - 1]!;
    expect(qaPrompt).toContain('previous');
    expect(qaPrompt).toContain('I moved to Shanghai');
  });

  it('answerKnowledgeUpdate selects the current value bitemporally from extracted facts', async () => {
    const llm: LLM = {
      complete: async () => 'city',
      completeStructured: async <T>() =>
        ({
          facts: [
            { subject: 'city', predicate: 'resides_in', object: 'Beijing', date: '2023/01/08' },
            { subject: 'city', predicate: 'resides_in', object: 'Shanghai', date: '2023/03/04' },
          ],
        }) as T,
    };
    const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
    const answer = await system.answerKnowledgeUpdate('What is my current city?', [
      '[2023/01/08] user: I lived in Beijing.',
      '[2023/03/04] user: I moved to Shanghai.',
    ]);
    expect(answer).toBe('Shanghai');
  });

  it('answerKnowledgeUpdate selects the previous value bitemporally', async () => {
    const llm: LLM = {
      complete: async () => 'city',
      completeStructured: async <T>() =>
        ({
          facts: [
            { subject: 'city', predicate: 'resides_in', object: 'Beijing', date: '2023/01/08' },
            { subject: 'city', predicate: 'resides_in', object: 'Shanghai', date: '2023/03/04' },
          ],
        }) as T,
    };
    const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
    const answer = await system.answerKnowledgeUpdate('What was my previous city?', [
      '[2023/01/08] user: I lived in Beijing.',
      '[2023/03/04] user: I moved to Shanghai.',
    ]);
    expect(answer).toBe('Beijing');
  });

  it('answerKnowledgeUpdate falls back when fact extraction returns empty', async () => {
    const prompts: string[] = [];
    const llm: LLM = {
      complete: async (prompt) => {
        prompts.push(prompt);
        if (prompt.includes('Specific items:')) return 'city';
        return 'Shanghai';
      },
      completeStructured: async <T>() => ({ facts: [] }) as T,
    };
    const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
    const answer = await system.answerKnowledgeUpdate('What is my current city?', [
      '[2023/03/04] user: I moved to Shanghai.',
    ]);
    expect(answer).toBe('Shanghai');
    expect(prompts.some((p) => p.includes('previous'))).toBe(true);
  });

  it('answerKnowledgeUpdate skips the bitemporal path when disabled', async () => {
    let structuredCalled = false;
    const llm: LLM = {
      complete: async (prompt) => (prompt.includes('Specific items:') ? 'city' : 'Shanghai'),
      completeStructured: async <T>() => {
        structuredCalled = true;
        return { facts: [] } as T;
      },
    };
    const system = new NaturalLanguageMemorySystem('s', {
      embedding,
      llm,
      enableBitemporalKnowledgeUpdate: false,
    });
    const answer = await system.answerKnowledgeUpdate('What is my current city?', [
      '[2023/03/04] user: I moved to Shanghai.',
    ]);
    expect(structuredCalled).toBe(false);
    expect(answer).toBe('Shanghai');
  });

  it('answerTemporal runs event expansion and computes weeks from extracted events', async () => {
    const prompts: string[] = [];
    const llm: LLM = {
      complete: async (prompt) => {
        prompts.push(prompt);
        return 'receive crystal chandelier from aunt';
      },
      completeStructured: async <T>() =>
        ({ events: [{ name: 'receive chandelier', date: '2023/03/04' }] }) as T,
    };
    const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
    const answer = await system.answerTemporal(
      'How many weeks ago did I receive the chandelier?',
      ['[2023/03/04] user: I received a crystal chandelier from my aunt.'],
      '2023/04/01',
    );
    // Event-level query expansion runs, then the deterministic engine computes
    // the elapsed weeks from the extracted event date without an LLM QA call.
    expect(prompts[0]).toContain('Specific events:');
    expect(answer).toBe('4');
  });

  it('answerTemporal passes the expansion phrases as event hints to extraction', async () => {
    const structuredPrompts: string[] = [];
    const llm: LLM = {
      complete: async () => 'receive crystal chandelier from aunt',
      completeStructured: async <T>(prompt: string) => {
        structuredPrompts.push(prompt);
        return { events: [{ name: 'receive chandelier', date: '2023/03/04' }] } as T;
      },
    };
    const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
    await system.answerTemporal(
      'How many weeks ago did I receive the chandelier?',
      ['[2023/03/04] user: I received a crystal chandelier from my aunt.'],
      '2023/04/01',
    );
    // The extraction prompt carries the pre-identified event hint so the LLM
    // locates that event instead of re-deriving it from scratch.
    expect(structuredPrompts[0]).toContain('- receive crystal chandelier from aunt');
  });

  it('answerTemporal falls back to the LLM prompt when structured extraction throws', async () => {
    const prompts: string[] = [];
    const llm: LLM = {
      complete: async (prompt) => {
        prompts.push(prompt);
        if (prompt.includes('Specific events:')) {
          return 'chandelier';
        }
        return '4 weeks';
      },
      completeStructured: async () => {
        throw new Error('provider returned non-JSON');
      },
    };
    const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
    const answer = await system.answerTemporal(
      'How many weeks ago did I receive the chandelier?',
      ['[2023/03/04] user: I received a crystal chandelier from my aunt.'],
      '2023/04/01',
    );
    // The extraction failure routes back to the date-reading QA prompt.
    const qaPrompt = prompts[prompts.length - 1]!;
    expect(qaPrompt).toContain('YYYY/MM/DD');
    expect(answer).toBe('4 weeks');
  });

  it('answerTemporal falls back when the extraction returns no events', async () => {
    const prompts: string[] = [];
    const llm: LLM = {
      complete: async (prompt) => {
        prompts.push(prompt);
        if (prompt.includes('Specific events:')) {
          return 'chandelier';
        }
        return 'UNANSWERABLE';
      },
      completeStructured: async <T>() => ({ events: [] }) as T,
    };
    const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
    const answer = await system.answerTemporal(
      'How many weeks ago did I receive the chandelier?',
      ['[2023/03/04] user: I received a crystal chandelier from my aunt.'],
      '2023/04/01',
    );
    // No events extracted → the deterministic engine returns null → LLM QA path.
    expect(answer).toBeNull();
    expect(prompts.some((p) => p.includes('YYYY/MM/DD'))).toBe(true);
  });

  it('answerTemporal routes event-lookup questions to the lookup prompt', async () => {
    const prompts: string[] = [];
    let structuredCalled = false;
    const llm: LLM = {
      complete: async (prompt) => {
        prompts.push(prompt);
        if (prompt.includes('Specific events:')) {
          return 'The Nightingale';
        }
        return 'The Nightingale by Kristin Hannah';
      },
      completeStructured: async <T>() => {
        structuredCalled = true;
        return {} as T;
      },
    };
    const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
    await system.answerTemporal(
      'Which book did I finish a week ago?',
      ['[2023/03/04] user: I finished The Nightingale.'],
      '2023/04/01',
    );
    // "Which book … ago" asks for an event, not a count, so the deterministic
    // path (and its structured extraction) is skipped entirely.
    expect(structuredCalled).toBe(false);
    const qaPrompt = prompts[prompts.length - 1]!;
    // The lookup prompt asks the model to extract the entity at the time anchor
    // instead of computing an elapsed time the question never asked for.
    expect(qaPrompt).toContain('Do NOT count, compute elapsed time');
    expect(qaPrompt).not.toContain('compute the elapsed days/weeks/months');
  });

  it('skips the deterministic path when enableDeterministicTemporal is false', async () => {
    let structuredCalled = false;
    const llm: LLM = {
      complete: async (prompt) => (prompt.includes('Specific events:') ? 'chandelier' : '4 weeks'),
      completeStructured: async <T>() => {
        structuredCalled = true;
        return {} as T;
      },
    };
    const system = new NaturalLanguageMemorySystem('s', {
      embedding,
      llm,
      enableDeterministicTemporal: false,
    });
    const answer = await system.answerTemporal(
      'How many weeks ago did I receive the chandelier?',
      ['[2023/03/04] user: I received a crystal chandelier from my aunt.'],
      '2023/04/01',
    );
    // Without the deterministic path, no structured extraction runs and the
    // LLM QA prompt returns '4 weeks'.
    expect(structuredCalled).toBe(false);
    expect(answer).toBe('4 weeks');
  });

  it('skips the deterministic path when the question date is absent', async () => {
    let structuredCalled = false;
    const llm: LLM = {
      complete: async (prompt) => (prompt.includes('Specific events:') ? 'chandelier' : '4 weeks'),
      completeStructured: async <T>() => {
        structuredCalled = true;
        return {} as T;
      },
    };
    const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
    const answer = await system.answerTemporal('How many weeks ago did I receive the chandelier?', [
      '[2023/03/04] user: I received a crystal chandelier from my aunt.',
    ]);
    expect(structuredCalled).toBe(false);
    expect(answer).toBe('4 weeks');
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

  it('reuses query expansion from a shared cache across system instances', async () => {
    clearEmbeddingCache();
    let expansionCalls = 0;
    const llm: LLM = {
      complete: async (prompt) => {
        if (prompt.includes('Specific items:')) {
          expansionCalls += 1;
          return 'color';
        }
        return 'blue';
      },
      completeStructured: async <T>() => ({}) as T,
    };
    const cache = new Map<string, string[]>();
    const makeSystem = (name: string) =>
      new NaturalLanguageMemorySystem(name, { embedding, llm, queryExpansionCache: cache });
    await makeSystem('a').answer('What is the color?', ['[2023/01/08] user: color is blue.']);
    await makeSystem('b').answer('What is the color?', ['[2023/01/08] user: color is blue.']);
    // The second system reuses the first system's expansion instead of re-calling
    // the LLM for the same question + expansion builder.
    expect(expansionCalls).toBe(1);
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

    it('expands multi-session questions with activity-level phrases', async () => {
      const prompts: string[] = [];
      const llm: LLM = {
        complete: async (prompt) => {
          prompts.push(prompt);
          if (prompt.includes('Specific activities:')) {
            return 'led project';
          }
          return '2';
        },
        completeStructured: async <T>() => ({}) as T,
      };
      const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
      await system.answerSessions('How many projects have I led?', [
        ['I led a consumer research project.'],
      ]);
      // The multi-session path uses activity-level (action + object) expansion,
      // not the bare-object expansion used by single-session questions.
      expect(prompts.some((p) => p.includes('Specific activities:'))).toBe(true);
    });

    it('caps the total injected aggregation evidence to a budget', async () => {
      const prompts: string[] = [];
      const llm: LLM = {
        complete: async (prompt) => {
          prompts.push(prompt);
          if (prompt.includes('Specific activities:')) {
            return 'color';
          }
          return 'blue';
        },
        completeStructured: async <T>() => ({}) as T,
      };
      const system = new NaturalLanguageMemorySystem('s', {
        embedding,
        llm,
        maxAggregationChars: 50,
        enableQueryExpansion: false,
      });
      await system.answerSessions('What is the favorite color?', [
        ['My favorite color is blue and I have many other facts to share.'],
        ['Another session with more unrelated content here.'],
      ]);
      const aggregationPrompt = prompts[prompts.length - 1]!;
      // The joined evidence is capped to the total budget, so it cannot grow
      // unbounded with the number of retrieved sessions.
      expect(aggregationPrompt).toContain('[truncated]');
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
          return prompt.includes('Specific activities:') ? 'color' : 'blue';
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
      expect(prompts[0]).toContain('Specific activities:');
    });

    it('returns null for empty sessions when abstention is enabled', async () => {
      const llm = scriptedLlm(() => 'blue');
      const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
      expect(await system.answerSessions('What is X?', [[], []])).toBeNull();
    });

    it('filters assistant turns out of the aggregated evidence', async () => {
      const prompts: string[] = [];
      const llm: LLM = {
        complete: async (prompt) => {
          prompts.push(prompt);
          if (prompt.includes('Specific activities:')) {
            return 'color';
          }
          return 'blue';
        },
        completeStructured: async <T>() => ({}) as T,
      };
      const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
      await system.answerSessions('What is the favorite color?', [
        [
          '[2023/01/08] user: My favorite color is blue.',
          '[2023/01/08] assistant: verbose noise that should be dropped',
        ],
      ]);
      // The user turn survives; the assistant turn is removed before aggregation.
      const aggregationPrompt = prompts[prompts.length - 1]!;
      expect(aggregationPrompt).toContain('My favorite color is blue');
      expect(aggregationPrompt).not.toContain('verbose noise');
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
      expect(prompts[0]).not.toContain('Specific activities:');
    });

    it('falls back to base recall when query expansion returns empty', async () => {
      const prompts: string[] = [];
      const llm: LLM = {
        complete: async (prompt) => {
          prompts.push(prompt);
          if (prompt.includes('Specific activities:')) {
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
          if (prompt.includes('Specific activities:')) {
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
          if (prompt.includes('Specific activities:')) {
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
