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
  buildDerivationQaPrompt,
  classifyAggregationKind,
  buildPreferencePrompt,
  buildKnowledgeUpdatePrompt,
  buildFactExtractionPrompt,
  buildQueryExpansionPrompt,
  buildTemporalQueryExpansionPrompt,
  buildMultiSessionQueryExpansionPrompt,
  formatStructuredContext,
  parseQueryExpansion,
  truncateText,
  truncateSession,
  parseQaAnswer,
  parseRecommendationAnswer,
  parseAggregationAnswer,
  isUserTurn,
  isAssistantTurn,
  clearEmbeddingCache,
  type DecisionTrace,
  type NaturalLanguageMemorySystemOptions,
} from '../natural-language-memory.js';
import { HashEmbedding } from '../embedding.js';
import type { Answer } from '../types.js';
import { tableEmbedding } from './test-embedding.js';

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
    expect(prompt).toContain('Work in two steps');
    expect(prompt).toContain('Step 1 — Silently read each turn');
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

  it('renders the context as a JSON array', () => {
    const prompt = buildQaPrompt('What is X?', '[2023/03/04] user: I finished a book.');
    expect(prompt).toContain('Context (a JSON array of turns');
    expect(prompt).toContain('"date":"2023/03/04"');
    expect(prompt).toContain('"role":"user"');
  });
});

describe('chain-of-note output contract', () => {
  // Every prompt that spreads `conInstruction()` must carry the same output
  // contract, or the model writes out its Step 1 notes and never answers.
  const builders: Array<[string, (question: string, context: string) => string]> = [
    ['buildQaPrompt', (q, c) => buildQaPrompt(q, c)],
    ['buildPreferencePrompt', (q, c) => buildPreferencePrompt(q, c)],
    ['buildTemporalQaPrompt', (q, c) => buildTemporalQaPrompt(q, c)],
    ['buildTemporalEventLookupPrompt', (q, c) => buildTemporalEventLookupPrompt(q, c)],
  ];

  it.each(builders)('%s forbids writing the step-1 notes out', (_name, build) => {
    expect(build('Q?', 'ctx')).toContain('do NOT write them out');
  });

  it.each(builders)('%s fixes the reply to a single labelled answer line', (_name, build) => {
    const prompt = build('Q?', 'ctx');
    expect(prompt).toContain('exactly this form');
    expect(prompt).toContain('Answer: <');
  });

  it.each(builders)('%s never asks the model to write notes down', (_name, build) => {
    expect(build('Q?', 'ctx')).not.toMatch(/In Step 1, note\b/);
  });

  it('leaves the deterministic extraction prompt free of the contract', () => {
    // The event-extraction prompt only copies dates, so CoN narration there
    // would add cost without improving the deterministic arithmetic.
    const prompt = buildTemporalEventExtractionPrompt('Q?', 'ctx', undefined, ['hint']);
    expect(prompt).not.toContain('Work in two steps');
  });
});

describe('formatStructuredContext', () => {
  it('returns an empty JSON array for empty input', () => {
    expect(formatStructuredContext('')).toBe('[]');
  });

  it('parses a dated turn into date, role, and content fields', () => {
    const json = formatStructuredContext('[2023/03/04 (Sat) 00:06] user: I finished a book.');
    const parsed = JSON.parse(json);
    expect(parsed).toEqual([{ date: '2023/03/04', role: 'user', content: 'I finished a book.' }]);
  });

  it('parses an undated turn into role and content fields', () => {
    const json = formatStructuredContext('user: I like coffee.');
    const parsed = JSON.parse(json);
    expect(parsed).toEqual([{ role: 'user', content: 'I like coffee.' }]);
  });

  it('preserves a turn without a role prefix as a bare content object', () => {
    const json = formatStructuredContext('plain text turn');
    const parsed = JSON.parse(json);
    expect(parsed).toEqual([{ content: 'plain text turn' }]);
  });

  it('parses multiple turns into an ordered JSON array', () => {
    const json = formatStructuredContext(
      '[2023/03/04] user: first turn\n[2023/03/05] assistant: second turn',
    );
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ date: '2023/03/04', role: 'user', content: 'first turn' });
    expect(parsed[1]).toEqual({ date: '2023/03/05', role: 'assistant', content: 'second turn' });
  });

  it("keeps a truncated turn's marker attached to its own turn", () => {
    const json = formatStructuredContext('[2023/03/04] user: a long turn\n[truncated]');
    const parsed = JSON.parse(json);
    expect(parsed).toEqual([
      { date: '2023/03/04', role: 'user', content: 'a long turn\n[truncated]' },
    ]);
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
    expect(prompt).toContain('Work in two steps');
    expect(prompt).toContain('Step 1 — Silently read each turn');
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
    expect(prompt).toContain('Work in two steps');
    expect(prompt).toContain('Step 1 — Silently read each turn');
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

describe('MR aggregation abstention boundary', () => {
  // Root-caused on LongMemEval-S: 53% of wrong MR answers are LLM abstentions,
  // and 15 of those 20 have every evidence session already retrieved. The model
  // sees the facts but abstains on questions whose answer must be DERIVED
  // (average, percentage, sum, difference, elapsed time) or combined across
  // sessions. The aggregation prompt must say so explicitly.
  it('forbids abstaining merely because facts must be combined across sessions', () => {
    const prompt = buildAggregationQaPrompt('How many X in total?', 'ctx');
    expect(prompt).toContain('Combining facts across several sessions is NOT a reason to abstain');
  });

  it('forbids abstaining when the answer must be computed', () => {
    const prompt = buildAggregationQaPrompt('How much in total?', 'ctx');
    expect(prompt).toContain('Needing to derive the answer is NOT a reason to abstain');
  });

  it('names the derivation forms that must be computed, not abstained', () => {
    const prompt = buildAggregationQaPrompt('What is the average?', 'ctx');
    expect(prompt).toContain('a sum, a difference, an average, a percentage, an elapsed time');
    expect(prompt).toContain('a date read from the context');
    expect(prompt).toContain('compute it');
  });

  it('keeps the original abstention-token line intact', () => {
    const prompt = buildAggregationQaPrompt('Q?', 'ctx');
    expect(prompt).toContain(
      'Respond with exactly "UNANSWERABLE" ONLY if the context contains no relevant information at all.',
    );
  });

  it('keeps the boundary scoped to the aggregation prompt', () => {
    // The other CoN prompts carry their own, tighter abstention wording; the
    // multi-session boundary must not leak into them.
    expect(buildQaPrompt('Q?', 'ctx')).not.toContain(
      'across several sessions is NOT a reason to abstain',
    );
    expect(buildTemporalQaPrompt('Q?', 'ctx')).not.toContain(
      'across several sessions is NOT a reason to abstain',
    );
    expect(buildPreferencePrompt('Q?', 'ctx')).not.toContain(
      'across several sessions is NOT a reason to abstain',
    );
  });

  it('leaves the legacy aggregation baseline untouched', () => {
    // The legacy prompt is the MR ablation control; changing it would confound
    // the ablation that measures the CoT prompt's contribution.
    expect(buildLegacyAggregationQaPrompt('How many X?', 'ctx')).not.toContain(
      'Needing to derive the answer is NOT a reason to abstain',
    );
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

describe('classifyAggregationKind', () => {
  it('routes derivation questions (compute a value from specific numbers)', () => {
    expect(classifyAggregationKind('What percentage of packed shoes did I wear?')).toBe(
      'derivation',
    );
    expect(classifyAggregationKind('What is the average age of my family?')).toBe('derivation');
    expect(classifyAggregationKind('How much older am I than the average?')).toBe('derivation');
    expect(classifyAggregationKind('What is the difference in price between the two?')).toBe(
      'derivation',
    );
    expect(classifyAggregationKind('What is the minimum amount I could get?')).toBe('derivation');
    expect(classifyAggregationKind('How old was I when Alex was born?')).toBe('derivation');
  });

  it('keeps enumeration questions (count / sum / temporal) on the aggregation prompt', () => {
    expect(classifyAggregationKind('How many items of clothing do I need?')).toBe('enumeration');
    expect(classifyAggregationKind('How much money in total did I spend?')).toBe('enumeration');
    expect(classifyAggregationKind('What time did I go to bed?')).toBe('enumeration');
  });
});

describe('buildDerivationQaPrompt', () => {
  it('identifies specific numbers instead of enumerating items', () => {
    const prompt = buildDerivationQaPrompt('What percentage did I wear?', 'ctx');
    expect(prompt).toContain('Identify the specific numbers');
    expect(prompt).not.toContain('Enumerate every item');
  });

  it('names the derivation formulas', () => {
    const prompt = buildDerivationQaPrompt('What is the average?', 'ctx');
    expect(prompt).toContain('part ÷ whole × 100');
    expect(prompt).toContain('sum of the values ÷ number of values');
    expect(prompt).toContain('larger − smaller');
  });

  it('carries the multi-session abstention boundary', () => {
    const prompt = buildDerivationQaPrompt('Q?', 'ctx');
    expect(prompt).toContain('Combining facts across several sessions is NOT a reason to abstain');
    expect(prompt).toContain('Needing to derive the answer is NOT a reason to abstain');
  });

  it('accepts a custom abstention token', () => {
    const prompt = buildDerivationQaPrompt('Q?', 'ctx', 'NONE');
    expect(prompt).toContain('NONE');
  });

  it('leaves the enumeration aggregation prompt untouched', () => {
    expect(buildAggregationQaPrompt('Q?', 'ctx')).not.toContain('Identify the specific numbers');
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
    expect(prompt).toContain('Work in two steps');
    expect(prompt).toContain('Step 1 — Silently read each turn');
    expect(prompt).toContain('Step 2 — Recommend something concrete');
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

describe('recommendation vs extractive answer contract', () => {
  // Preference questions compose a suggestion from the identified preferences,
  // so they must NOT inherit the extractive "restate only, in a short phrase"
  // contract. Measured on LongMemEval-S, that contract pushed abstention on the
  // 29 single-session-preference questions from 3.45% to 21.84%: the model read
  // "add nothing" as "there is nothing to say" and abstained.
  it('frees the preference prompt from the extractive Step 2', () => {
    const prompt = buildPreferencePrompt('Any tips?', 'ctx');
    expect(prompt).not.toContain('using ONLY those identified facts');
    expect(prompt).toContain('builds on those identified preferences');
  });

  it('frees the preference prompt from the short-phrase reply shape', () => {
    const prompt = buildPreferencePrompt('Any tips?', 'ctx');
    expect(prompt).not.toContain('a word, name, number, or short phrase');
    expect(prompt).toContain('one to three sentences');
  });

  it.each([
    ['buildQaPrompt', (q: string, c: string) => buildQaPrompt(q, c)],
    ['buildTemporalQaPrompt', (q: string, c: string) => buildTemporalQaPrompt(q, c)],
    [
      'buildTemporalEventLookupPrompt',
      (q: string, c: string) => buildTemporalEventLookupPrompt(q, c),
    ],
  ])('%s keeps the extractive Step 2 and reply shape untouched', (_name, build) => {
    const prompt = build('Q?', 'ctx');
    expect(prompt).toContain('Step 2 — Answer the question using ONLY those identified facts');
    expect(prompt).toContain('Answer: <a word, name, number, or short phrase>');
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

  it('drops step headers and bullets when the model ignored the output contract', () => {
    // Regression: on `7a349da` the model wrote out its Step 1 notes and never
    // reached Step 2 on 7.5% of questions, leaking the whole narration into the
    // extracted answer.
    const raw =
      '**Step 1 — Relevant user facts:**\n' +
      '- The user is interested in video editing.\n' +
      '- The user uses Adobe Premiere Pro.\n' +
      '\n' +
      'These resources directly build on your Lumetri Color Panel knowledge.';
    expect(parseQaAnswer(raw)).toBe(
      'These resources directly build on your Lumetri Color Panel knowledge.',
    );
  });

  it('drops an ordered-list narration and keeps the concluding line', () => {
    const raw =
      '1. The user flew United in March.\n2. The user flew American in April.\nUnited Airlines';
    expect(parseQaAnswer(raw)).toBe('United Airlines');
  });

  it('drops markdown headings from a narration', () => {
    const raw = '## Relevant turns\nThe user moved to Seattle in March.\n';
    expect(parseQaAnswer(raw)).toBe('The user moved to Seattle in March.');
  });

  it('caps a runaway narration at its first sentence boundary', () => {
    // Regression: one temporal answer ran to 33,504 characters of self-talk.
    const runaway = 'Given the data, the most flights are with United. '.repeat(500);
    const parsed = parseQaAnswer(runaway);
    expect(parsed).toBe('Given the data, the most flights are with United.');
  });

  it('hard-caps a narration that offers no sentence boundary', () => {
    expect(parseQaAnswer('x'.repeat(5000))).toBe('x'.repeat(200));
  });

  it('falls back to the capped original when every line is scaffolding', () => {
    // Deliberate, not an oversight: of the 33 leaked `7a349da` responses only 4
    // contain the ground truth verbatim, and one of those carries it inside a
    // bullet. Returning the capped original keeps that answer reachable while
    // still bounding a runaway generation.
    expect(parseQaAnswer('- bullet one\n- bullet two')).toBe('- bullet one\n- bullet two');
  });

  it('preserves a ground truth that only appears inside a note bullet', () => {
    // Regression for the temporal answer "United Airlines", whose only mention
    // sits in the model's Step 1 bullet list rather than in a conclusion.
    const raw =
      'Step 1 — Relevant turns and dates:\n' +
      '- 2023/04/27: User mentions a March business trip to Chicago with United Airlines.\n' +
      '- 2023/04/27: User mentions a direct flight with Southwest Airlines to Las Vegas.';
    expect(parseQaAnswer(raw)).toContain('United Airlines');
  });

  it('caps the scaffolding fallback so a runaway cannot reach the judge', () => {
    const raw = '- the user flew United in March. - the user flew American in April. '.repeat(200);
    const parsed = parseQaAnswer(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.length).toBeLessThanOrEqual(200);
  });

  it('keeps a short unlabelled answer untouched', () => {
    expect(parseQaAnswer('United Airlines.')).toBe('United Airlines.');
  });

  it('prefers the labelled answer over the surrounding narration', () => {
    const raw =
      'Step 1 — notes that should never have been written.\n- bullet\n\nAnswer: United Airlines';
    expect(parseQaAnswer(raw)).toBe('United Airlines');
  });

  it('recognises an abstention that follows the answer label', () => {
    expect(parseQaAnswer('Step 1 — nothing relevant.\nAnswer: UNANSWERABLE')).toBeNull();
  });
});

describe('parseRecommendationAnswer', () => {
  // A 3-sentence recommendation legitimately exceeds the 200-char extractive cap
  // but must survive the recommendation parser, whose cap is wide enough for a
  // short paragraph yet still tight enough to stop a runaway generation.
  const rec = [
    'Start with a Sony-compatible flash such as the Godox V1 for your A7R IV.',
    'Add a Gitzo GT3543LS tripod that carries your 24-70mm f/2.8 lens.',
    'Finish with an Anker PowerCore 20000 PD battery pack for on-location power.',
  ].join(' ');

  it('returns the trimmed answer', () => {
    expect(parseRecommendationAnswer('  Godox V1.  ')).toBe('Godox V1.');
  });

  it('returns null for the abstention token', () => {
    expect(parseRecommendationAnswer('UNANSWERABLE')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseRecommendationAnswer('   ')).toBeNull();
  });

  it('honours a custom abstention token', () => {
    expect(parseRecommendationAnswer('NONE', 'NONE')).toBeNull();
  });

  it('strips surrounding quotes', () => {
    expect(parseRecommendationAnswer('"Godox V1."')).toBe('Godox V1.');
  });

  it('keeps a multi-sentence recommendation the extractive cap would truncate', () => {
    expect(rec.length).toBeGreaterThan(200);
    expect(rec.length).toBeLessThan(400);
    expect(parseRecommendationAnswer(rec)).toBe(rec);
    // The extractive parser still truncates the same input at 200 chars, proving
    // the recommendation parser is the one that widened the cap.
    expect(parseQaAnswer(rec)).toBe(rec.split('. ')[0] + '.');
  });

  it('drops step scaffolding before applying the wider cap', () => {
    const raw = '**Step 1 — preferences:**\n- Sony A7R IV\n- 24-70mm f/2.8 lens\n\n' + rec;
    expect(parseRecommendationAnswer(raw)).toBe(rec);
  });

  it('caps a runaway recommendation at its first sentence', () => {
    const runaway = 'A Sony-compatible flash like the Godox V1 is ideal. '.repeat(100);
    expect(parseRecommendationAnswer(runaway)).toBe(
      'A Sony-compatible flash like the Godox V1 is ideal.',
    );
  });

  it('hard-caps a boundary-free recommendation at 400 chars', () => {
    expect(parseRecommendationAnswer('x'.repeat(5000))).toBe('x'.repeat(400));
  });

  it('prefers the labelled answer over narration', () => {
    const raw =
      'Step 1 — notes that should never have been written.\n- bullet\n\n' +
      'Answer: Godox V1 flash and a Gitzo tripod.';
    expect(parseRecommendationAnswer(raw)).toBe('Godox V1 flash and a Gitzo tripod.');
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

    it('routes derivation questions to the derivation prompt', async () => {
      const prompts: string[] = [];
      const llm: LLM = {
        complete: async (prompt) => {
          prompts.push(prompt);
          if (prompt.includes('Specific activities:')) {
            return 'packed shoes';
          }
          return '40%';
        },
        completeStructured: async <T>() => ({}) as T,
      };
      const system = new NaturalLanguageMemorySystem('s', { embedding, llm });
      const answer = await system.answerSessions('What percentage of packed shoes did I wear?', [
        ['I packed 5 pairs of shoes and wore 2.'],
      ]);
      expect(answer).toBe('40%');
      const finalPrompt = prompts[prompts.length - 1]!;
      expect(finalPrompt).toContain('Identify the specific numbers');
      expect(finalPrompt).not.toContain('Step 1 — Enumerate');
    });

    it('never overrides a custom aggregation prompt for derivation questions', async () => {
      const prompts: string[] = [];
      const llm: LLM = {
        complete: async (prompt) => {
          prompts.push(prompt);
          if (prompt.includes('Specific activities:')) {
            return 'packed shoes';
          }
          return prompt.includes('CUSTOM AGGREGATION MARKER') ? '40%' : 'UNANSWERABLE';
        },
        completeStructured: async <T>() => ({}) as T,
      };
      const system = new NaturalLanguageMemorySystem('s', {
        embedding,
        llm,
        aggregationPrompt: (q, ctx) => `CUSTOM AGGREGATION MARKER\nQuestion: ${q}\n${ctx}`,
      });
      const answer = await system.answerSessions('What percentage of packed shoes did I wear?', [
        ['I packed 5 pairs of shoes and wore 2.'],
      ]);
      expect(answer).toBe('40%');
      const finalPrompt = prompts[prompts.length - 1]!;
      expect(finalPrompt).toContain('CUSTOM AGGREGATION MARKER');
      expect(finalPrompt).not.toContain('Identify the specific numbers');
    });

    describe('turn-level recall', () => {
      const QUESTION = 'How many model kits have I built?';
      const EVIDENCE = 'I assembled a vintage model kit';
      const FILLER = 'the weather was pleasant that day';
      const DIM = 3;
      /** Place a unit vector at an exact cosine of `x` against [1, 0, 0]. */
      const at = (x: number): number[] => [x, Math.sqrt(1 - x * x), 0];
      const TABLE: Record<string, readonly number[]> = {
        [QUESTION]: [1, 0, 0],
        [EVIDENCE]: at(0.9),
        [FILLER]: [0, 1, 0],
        d0: at(0.5),
        d1: at(0.5),
        d2: at(0.5),
        d3: at(0.5),
      };

      /**
       * One long session whose single on-topic turn is surrounded by turns that
       * are orthogonal to the question, plus four uniformly related distractors.
       * The diluted session's centroid lands at cosine ~0.106 against the
       * question, far below the distractors' 0.5, so session-granularity
       * retrieval drops the evidence session altogether.
       */
      const dilutedSessions = (): string[][] => [
        [FILLER, FILLER, FILLER, FILLER, EVIDENCE, FILLER, FILLER, FILLER],
        ['d0'],
        ['d1'],
        ['d2'],
        ['d3'],
      ];

      /** Answer the fixtures and return the final aggregation prompt. */
      async function finalPrompt(
        overrides: Partial<NaturalLanguageMemorySystemOptions>,
        sessions: string[][],
        table: Record<string, readonly number[]> = TABLE,
        question: string = QUESTION,
      ): Promise<string> {
        const prompts: string[] = [];
        const llm: LLM = {
          complete: async (prompt) => {
            prompts.push(prompt);
            return 'Answer: 2';
          },
          completeStructured: async <T>() => ({}) as T,
        };
        const system = new NaturalLanguageMemorySystem('s', {
          embedding: tableEmbedding(table, DIM),
          llm,
          // Expansion is off so the comparison isolates a single channel.
          enableQueryExpansion: false,
          sessionTopK: 1,
          ...overrides,
        });
        await system.answerSessions(question, sessions);
        return prompts[prompts.length - 1]!;
      }

      it('recovers a session whose evidence turn is diluted by unrelated turns', async () => {
        const off = await finalPrompt({ turnRecallSessions: 0 }, dilutedSessions());
        const on = await finalPrompt({ turnRecallSessions: 3 }, dilutedSessions());
        // Session-granularity retrieval never reaches the evidence session...
        expect(off).not.toContain(EVIDENCE);
        // ...turn-granularity scoring does.
        expect(on).toContain(EVIDENCE);
      });

      it('only ever adds sessions, never drops a retrieved one', async () => {
        const off = await finalPrompt({ turnRecallSessions: 0 }, dilutedSessions());
        const on = await finalPrompt({ turnRecallSessions: 3 }, dilutedSessions());
        // Whatever the centroid path injected stays injected.
        for (const d of ['d0', 'd1', 'd2', 'd3']) {
          if (off.includes(d)) {
            expect(on).toContain(d);
          }
        }
        expect(off).toContain('d0');
        expect(on!.length).toBeGreaterThan(off.length);
      });

      it('leaves the top-1 score (and therefore abstention) untouched', async () => {
        // The diluted session's turn cosine (0.9) beats the best centroid cosine
        // (0.5). Were the two channels merged by score, the added session would
        // become hits[0] and lift the score across this threshold.
        const answer = async (turnRecallSessions: number): Promise<Answer> =>
          new NaturalLanguageMemorySystem('s', {
            embedding: tableEmbedding(TABLE, DIM),
            llm: scriptedLlm(() => 'Answer: 2'),
            enableQueryExpansion: false,
            sessionTopK: 1,
            sessionAbstainThreshold: 0.7,
            turnRecallSessions,
          }).answerSessions(QUESTION, dilutedSessions());
        // Both arms abstain on the same centroid score: the turn channel changes
        // the evidence, never the abstention signal.
        expect(await answer(0)).toBeNull();
        expect(await answer(3)).toBeNull();
      });

      it('admits at most turnRecallSessions extra sessions', async () => {
        const q = 'How many items are there?';
        const texts = ['QX0', 'QX1', 'QX2', 'QX3', 'QX4', 'QX5'];
        const table: Record<string, readonly number[]> = { [q]: [1, 0, 0] };
        texts.forEach((t, i) => {
          table[t] = at(0.9 - i * 0.1);
        });
        const sessions = texts.map((t) => [t]);
        const on = await finalPrompt({ turnRecallSessions: 2 }, sessions, table, q);
        // The centroid channel contributes QX0; the turn channel fills exactly
        // two more slots with the next-best sessions.
        expect(on).toContain('QX0');
        expect(on).toContain('QX1');
        expect(on).toContain('QX2');
        expect(on).not.toContain('QX3');
        expect(on).not.toContain('QX4');
        expect(on).not.toContain('QX5');
      });

      it('adds no embedding traffic once the haystack is cached', async () => {
        const base = tableEmbedding(TABLE, DIM);
        let embedded = 0;
        const counting: EmbeddingModel = {
          dimension: () => DIM,
          embed: async (texts) => {
            embedded += texts.length;
            return base.embed(texts);
          },
        };
        const sessions = dilutedSessions();
        const run = async (turnRecallSessions: number): Promise<void> => {
          await new NaturalLanguageMemorySystem('s', {
            embedding: counting,
            llm: scriptedLlm(() => 'Answer: 2'),
            enableQueryExpansion: false,
            sessionTopK: 1,
            turnRecallSessions,
          }).answerSessions(QUESTION, sessions);
        };
        await run(0);
        const after = embedded;
        // Turn vectors are the same vectors the centroid path already computed,
        // so scoring at turn granularity costs no additional provider traffic.
        await run(3);
        expect(embedded).toBe(after);
      });
    });
  });
});
