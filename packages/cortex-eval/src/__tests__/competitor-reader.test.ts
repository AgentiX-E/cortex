/**
 * The reading stage, asserted through the one entry a real caller has.
 *
 * A reader prompt is not neutral. Three properties decide whether an `accuracy` column means anything:
 *
 * 1. **It is the same for every provider.** If it varied per system the column would be measuring prompts.
 * 2. **It carries the dates.** LongMemEval's knowledge-update and temporal families are unanswerable from
 *    undated memory, and a provider that supplies dates would be scored as though it did not.
 * 3. **It offers a refusal.** Without one, a model asked a question whose evidence retrieval missed invents an
 *    answer, and the abstention family scores zero for a reason that is about the prompt.
 *
 * Every case below therefore goes through `createProviderReader` with a recording model and asserts on the
 * prompt that was actually sent. Testing the prompt builder directly would be testing a function no caller can
 * reach — and widening the export for that convenience is how a module acquires a second, unaudited reader.
 */

import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';
import { createProviderReader } from '../competitor-reader.js';
import type { Question } from '../types.js';

const QUESTION: Question = {
  id: 'q1',
  capability: 'KU',
  question: 'What is my current phone number?',
  expected: '555-0142',
  context: [],
  questionDate: '2023/06/04 (Sun) 09:00',
};

/** A model that records the prompt it was sent and replies with a fixed string. */
function recorder(reply = 'ok'): { llm: LLM; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    llm: {
      async complete(prompt: string): Promise<string> {
        prompts.push(prompt);
        return reply;
      },
      async completeStructured<T>(): Promise<T> {
        throw new Error('the reader never asks for structured output');
      },
    },
  };
}

/** The prompt one read sends, for the given hits. */
async function promptFor(
  hits: readonly { text: string; at?: number }[],
  question: Question = QUESTION,
): Promise<string> {
  const { llm, prompts } = recorder();
  await createProviderReader(llm)(question, hits);
  return prompts[0]!;
}

describe('the reading prompt', () => {
  it('carries the question, the memory, and a refusal phrase', async () => {
    const prompt = await promptFor([{ text: 'I changed my number to 555-0142 yesterday.' }]);
    expect(prompt).toContain('What is my current phone number?');
    expect(prompt).toContain('555-0142');
    expect(prompt).toContain("I don't know");
  });

  it('numbers the blocks, because the reasoning step refers to them by index', async () => {
    const prompt = await promptFor([{ text: 'alpha' }, { text: 'beta' }]);
    expect(prompt).toContain('[1] alpha');
    expect(prompt).toContain('[2] beta');
  });

  it('prints a date when the provider supplies one, and nothing when it does not', async () => {
    expect(await promptFor([{ text: 'alpha', at: Date.UTC(2023, 4, 1) }])).toContain('2023-05-01');
    expect(await promptFor([{ text: 'alpha' }])).toContain('[1] alpha');
  });

  it('says so when nothing was retrieved, rather than ending at the header', async () => {
    // An empty block would read as a truncation rather than as a miss.
    expect(await promptFor([])).toContain('(no memory retrieved)');
  });

  it('threads the question date, which the temporal and knowledge-update families need', async () => {
    expect(await promptFor([{ text: 'alpha' }])).toContain('2023/06/04');
    // `exactOptionalPropertyTypes` is on, so an absent date is constructed by omission rather than by passing
    // `undefined` -- the same distinction the production types make between "no date" and "a date of undefined".
    const { questionDate: _omitted, ...withoutDate } = QUESTION;
    const undated = await promptFor([{ text: 'alpha' }], withoutDate);
    expect(undated).not.toContain('The question is asked on');
  });

  it('states the recency rule, because the corpus asks for the current value of a changed attribute', async () => {
    const prompt = await promptFor([{ text: 'alpha' }]);
    expect(prompt).toContain('the later');
    expect(prompt).toContain('current value');
  });

  it('asks for a silent first step, so notes do not reach the answer channel', async () => {
    // The production prompt records this as a measured failure: a model that writes its Step 1 notes and never
    // reaches the answer fails an exact-phrase judge.
    expect(await promptFor([{ text: 'alpha' }])).toContain('Do not write them out');
  });

  it('depends on the hits and the question and on nothing else', async () => {
    // The property that makes two accuracy cells subtractable: the reader is a constant, so a difference is
    // retrieval. Nothing here can see which provider produced the hits.
    const hits = [{ text: 'alpha' }, { text: 'beta' }];
    expect(await promptFor(hits)).toBe(await promptFor([...hits]));
  });
});

describe('sanitising the reply', () => {
  it('trims whitespace', async () => {
    const { llm } = recorder('  555-0142 \n');
    expect(await createProviderReader(llm)(QUESTION, [{ text: 'alpha' }])).toBe('555-0142');
  });

  it('removes an echoed Step 3 label', async () => {
    // `Step 3: Berlin` graded against a gold of `Berlin` would otherwise be a miss, and the label could match a
    // gold answer by accident in the other direction.
    const { llm } = recorder('Step 3: Berlin');
    expect(await createProviderReader(llm)(QUESTION, [])).toBe('Berlin');
  });

  it('removes a lowercase, hyphenated or full-width label too', async () => {
    for (const reply of ['step 3 - Berlin', 'STEP 3：Berlin']) {
      const { llm } = recorder(reply);
      expect(await createProviderReader(llm)(QUESTION, [])).toBe('Berlin');
    }
  });

  it('leaves a reply that merely mentions the phrase alone', async () => {
    const reply = 'The Step 3 answer is Berlin';
    const { llm } = recorder(reply);
    expect(await createProviderReader(llm)(QUESTION, [])).toBe(reply);
  });

  it('sends exactly one request per read', async () => {
    const { llm, prompts } = recorder();
    await createProviderReader(llm)(QUESTION, [{ text: 'alpha' }]);
    expect(prompts).toHaveLength(1);
  });
});
