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

/**
 * The dispatch arm: one clause, and nothing else different.
 *
 * The first accuracy reading answered 11 of 20 temporal questions whose evidence had been retrieved 20 of 20
 * times. The claim this arm tests is that a prompt which says nothing about dates, arithmetic or block order is
 * the reason. That claim is only testable if the two prompts differ in **one** place, so the last test below
 * removes the clause from a dispatch prompt and asserts it becomes the control byte for byte.
 *
 * No test asserts that the clause is *right* — that is what the run is for. These assert that it is the only
 * thing that moved, which is the precondition for the run meaning anything.
 */
describe('the dispatch arm', () => {
  async function promptOf(mode: 'con' | 'dispatch', question: Question): Promise<string> {
    const { llm, prompts } = recorder();
    await createProviderReader(llm, mode)(question, [{ text: 'alpha', at: Date.UTC(2023, 4, 1) }]);
    return prompts[0]!;
  }

  function questionWith(capability: Question['capability']): Question {
    return { ...QUESTION, capability };
  }

  it('sends the control prompt unchanged when the mode is con', async () => {
    const prompt = await promptOf('con', questionWith('TR'));
    expect(prompt).not.toContain('NOT chronologically');
    expect(prompt).not.toContain('YYYY-MM-DD');
  });

  it('tells a temporal question to write the dates and do the arithmetic', async () => {
    const prompt = await promptOf('dispatch', questionWith('TR'));
    expect(prompt).toContain('NOT chronologically');
    expect(prompt).toContain('YYYY-MM-DD');
    expect(prompt).toContain('one step at a time');
    expect(prompt).toContain('Do not estimate an interval');
  });

  it('tells a knowledge-update question to enumerate the values and take the latest', async () => {
    const prompt = await promptOf('dispatch', questionWith('KU'));
    expect(prompt).toContain('more than one value');
    expect(prompt).toContain('value from the latest date');
  });

  it('tells a multi-session question to collect across conversations', async () => {
    const prompt = await promptOf('dispatch', questionWith('MR'));
    expect(prompt).toContain('more than one conversation');
    expect(prompt).toContain('do not stop at the first one');
  });

  it('tells an abstention question that refusing is a correct answer', async () => {
    const prompt = await promptOf('dispatch', questionWith('ABS'));
    expect(prompt).toContain('correct when the memory holds nothing');
    // The abstention clause does not need the ordering statement: there is nothing to order.
    expect(prompt).not.toContain('NOT chronologically');
  });

  it('gives a single-session question only the ordering statement', async () => {
    const prompt = await promptOf('dispatch', questionWith('IE'));
    expect(prompt).toContain('NOT chronologically');
    expect(prompt).not.toContain('YYYY-MM-DD');
  });

  it('differs from the control by an insertion and nothing else', async () => {
    // The property the whole arm rests on: the dispatch prompt is the control prompt with lines inserted, so a
    // difference between the two readings is attributable to the inserted lines and not to a rewording. Asserted
    // as a subsequence rather than by deleting text, because deletion has to know what the clause says and a test
    // that reimplements the clause cannot catch a change to it.
    const isSubsequence = (small: readonly string[], big: readonly string[]): boolean => {
      let at = 0;
      for (const line of big) {
        if (at < small.length && line === small[at]) at += 1;
      }
      return at === small.length;
    };

    for (const capability of ['IE', 'MR', 'KU', 'TR', 'ABS'] as const) {
      const control = (await promptOf('con', questionWith(capability))).split('\n');
      const dispatched = (await promptOf('dispatch', questionWith(capability))).split('\n');
      expect(isSubsequence(control, dispatched)).toBe(true);
      // And it really inserted something: a mode that changes nothing would make the ablation vacuous.
      expect(dispatched.length).toBeGreaterThan(control.length);
    }
  });
});
