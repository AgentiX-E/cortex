import { describe, it, expect } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';
import {
  buildJudgePrompt,
  parseJudgeResponse,
  createLlmJudge,
  clearJudgeCache,
  toJudgeQuestionType,
} from '../judge.js';

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
    // The official templates ask for a bare yes/no verdict rather than the
    // YES/NO token the single-prompt form used.
    expect(prompt).toMatch(/yes or no/i);
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

/**
 * The official LongMemEval protocol dispatches its grading prompt by question
 * type and is deliberately looser than straight equivalence: the default and
 * multi-session templates credit a response that CONTAINS the gold answer or
 * that carries all the intermediate steps, the temporal template adds an
 * off-by-one tolerance for day counts, and the knowledge-update template accepts
 * an updated answer stated alongside superseded information.
 */
describe('buildJudgePrompt question-type dispatch', () => {
  it('credits containment rather than requiring equivalence for default questions', () => {
    const prompt = buildJudgePrompt('q', 'a', 'b', 'default');
    expect(prompt).toContain('contains the correct answer');
    expect(prompt).toContain('intermediate steps');
  });

  it('relaxes day arithmetic for temporal questions', () => {
    const prompt = buildJudgePrompt('q', 'a', 'b', 'temporal-reasoning');
    expect(prompt).toContain('off-by-one');
  });

  it('accepts an updated answer stated alongside superseded information', () => {
    const prompt = buildJudgePrompt('q', 'a', 'b', 'knowledge-update');
    expect(prompt).toContain('previous information');
    expect(prompt).toContain('updated answer');
  });

  it('grades abstention against the explanation, not against similarity', () => {
    const prompt = buildJudgePrompt(
      'What is my hamster called?',
      'UNANSWERABLE',
      'You did not mention this information.',
      'abstention',
    );
    expect(prompt).toContain('unanswerable');
    expect(prompt).not.toContain('Correct Answer:');
  });

  it('defaults to the multi-session template when no type is given', () => {
    expect(buildJudgePrompt('q', 'a', 'b')).toBe(buildJudgePrompt('q', 'a', 'b', 'default'));
  });

  it('carries the question, gold, and prediction into every template', () => {
    for (const type of [
      'default',
      'temporal-reasoning',
      'knowledge-update',
      'abstention',
    ] as const) {
      const prompt = buildJudgePrompt('QQQ', 'PPP', 'GGG', type);
      expect(prompt).toContain('QQQ');
      expect(prompt).toContain('PPP');
      expect(prompt).toContain('GGG');
      expect(prompt).toMatch(/yes or no/i);
    }
  });

  it('tells the judge a strict subset is not sufficient', () => {
    // The official default template carries this tension deliberately: extra
    // information is credited, a partial answer is not.
    expect(buildJudgePrompt('q', 'a', 'b', 'default')).toContain('subset');
  });
});

describe('toJudgeQuestionType', () => {
  it('maps the dataset question types onto judge templates', () => {
    expect(toJudgeQuestionType('temporal-reasoning', false)).toBe('temporal-reasoning');
    expect(toJudgeQuestionType('knowledge-update', false)).toBe('knowledge-update');
    expect(toJudgeQuestionType('multi-session', false)).toBe('default');
    expect(toJudgeQuestionType('single-session-user', false)).toBe('default');
  });

  it('routes an abstention question to the abstention template whatever its type', () => {
    expect(toJudgeQuestionType('temporal-reasoning_abs', true)).toBe('abstention');
    expect(toJudgeQuestionType('multi-session_abs', true)).toBe('abstention');
  });
});
