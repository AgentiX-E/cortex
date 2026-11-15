/**
 * A stored corpus answers the way a passed one does, and saying so is a byte comparison.
 *
 * ## Why this is the test the whole iteration rests on
 *
 * Moving the transcript into the product changes the *input path* of every route. If the stored path also
 * took part in prompt assembly — reordering, filtering, de-duplicating, stamping dates — then "the two paths
 * agree" would degrade to "the two paths are similar", and no assertion could fail on the difference that
 * matters. The corpus therefore does one thing: it produces `context: string[]` and `sessions: string[][]`
 * and hands them to the public method. Equality is then a statement about arguments, and the observable form
 * of it is that the two prompts are the **same string**.
 *
 * ## The five clauses of the acceptance, and where each one lives
 *
 * | clause | assertion |
 * | --- | --- |
 * | `corpus` absent changes nothing | every route's prompt, with and without a corpus attached, is identical |
 * | a replay does not double the corpus | `remember` twice reports `{appended: 0, duplicates: n}` and `context()` keeps its length |
 * | the same ordinal with other text is refused | `remember` throws `rewrite`, and the corpus is unchanged |
 * | `askStored` equals a hand-passed context | same question, same turns, same prompt string |
 * | the surface is reachable | `remember`/`askStored` throw with a message naming `corpus` when it is absent |
 *
 * ## The control that makes the first clause mean something
 *
 * The corpus in the first group holds **different** turns from the ones being asked about. A route that
 * quietly read the corpus instead of its argument would therefore produce a visibly different prompt rather
 * than the same one, which is the difference between "the corpus is ignored on this path" and "the corpus
 * happens to be empty".
 */
import { describe, expect, it } from 'vitest';
import type { Answer, LLM, MemoryValue, ValueFunction } from '@agentix-e/cortex-core';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';

import { Corpus } from '../corpus.js';
import { CortexMemory } from '../memory.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;
const QUESTION = 'Where did I move in March?';

function recordingLlm(seen: string[]): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return 'Berlin';
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

function constantValue(value: number): ValueFunction {
  return (_memory: MemoryValue) => value;
}

/** The configuration every `answerSessions` reading in this repository was taken under, minus the index. */
const OPEN_GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  valueFunction: constantValue(1),
};

function system(seen: string[], corpus?: Corpus): CortexMemory {
  return new CortexMemory({
    llm: recordingLlm(seen),
    now: NOW,
    gate: OPEN_GATE,
    ...(corpus === undefined ? {} : { corpus }),
  } as CortexMemoryOptions);
}

const TURNS = [
  [
    '[2023/05/20 (Sat) 10:00] user: I moved to Berlin in March.',
    '[2023/05/20 (Sat) 10:01] user: My landlord is called Anke.',
  ],
  ['[2023/06/02 (Fri) 09:00] user: The invoice was paid late again.'],
];
const FLAT = TURNS.flat();
const UNRELATED = [{ sessionId: 'other', ordinal: 0, text: 'Nothing to do with any of this.' }];

/** Every route the contract declares, called the way the harness calls it. */
const ROUTES: readonly { name: string; call: (memory: CortexMemory) => Promise<Answer> }[] = [
  { name: 'flat', call: (memory) => memory.answer(QUESTION, FLAT) },
  { name: 'multi-session', call: (memory) => memory.answerSessions(QUESTION, TURNS) },
  { name: 'temporal', call: (memory) => memory.answerTemporal(QUESTION, FLAT, '2023/06/02') },
  { name: 'abstention', call: (memory) => memory.answerAbstention(QUESTION, FLAT) },
  { name: 'assistant', call: (memory) => memory.answerAssistant(QUESTION, FLAT) },
  { name: 'knowledge-update', call: (memory) => memory.answerKnowledgeUpdate(QUESTION, FLAT) },
];

describe('a corpus changes nothing on a route that was given its context', () => {
  it.each(ROUTES)(
    '$name asks the same prompt with and without a transcript attached',
    async (route) => {
      const withoutCorpus: string[] = [];
      const withCorpus: string[] = [];
      const corpus = new Corpus({ store: new SqliteStorage(), now: NOW });
      // The control: the corpus is populated, so "same prompt" cannot be "both paths read nothing".
      await corpus.append(UNRELATED);

      await route.call(system(withoutCorpus));
      await route.call(system(withCorpus, corpus));

      expect(withCorpus).toHaveLength(1);
      expect(withCorpus[0]).toBe(withoutCorpus[0]);
    },
  );
});

describe('askStored', () => {
  /** A corpus holding exactly the turns the hand-passed call uses. */
  async function stored(): Promise<{ corpus: Corpus; memory: CortexMemory; seen: string[] }> {
    const corpus = new Corpus({ store: new SqliteStorage(), now: NOW });
    const seen: string[] = [];
    const memory = system(seen, corpus);
    // Through `remember`, not through `corpus.append`: the clause is about the two methods a user has.
    await memory.remember(
      TURNS.flatMap((turns, session) =>
        turns.map((text, ordinal) => ({ sessionId: `s${String(session + 1)}`, ordinal, text })),
      ),
    );
    return { corpus, memory, seen };
  }

  it('asks the same prompt as the same turns passed by hand', async () => {
    const { memory, seen } = await stored();
    const answer = await memory.askStored(QUESTION);

    expect(answer).toBe('Berlin');
    expect(memory.lastRoute()).toBe('multi-session');
    // The clause, stated as the strongest form available: not "the same digest" but the same string.
    const manual: string[] = [];
    await system(manual).answerSessions(QUESTION, TURNS);
    expect(seen[0]).toBe(manual[0]);
  });

  it('refuses to answer when the corpus is empty, rather than answering from nowhere', async () => {
    const empty = new Corpus({ store: new SqliteStorage(), now: NOW });
    const memory = system([], empty);
    // `answerSessions` already has the right behaviour for an empty input, and this asserts the stored path
    // inherits it instead of inventing a second one.
    expect(await memory.askStored(QUESTION)).toBeNull();
    expect(memory.abstentionReasons().empty).toBe(1);
  });
});

describe('remember', () => {
  it('reports a replay as duplicates and does not double the transcript', async () => {
    const corpus = new Corpus({ store: new SqliteStorage(), now: NOW });
    const memory = system([], corpus);
    const batch = [{ sessionId: 's1', ordinal: 0, text: 'I moved to Berlin in March.' }];

    expect(await memory.remember(batch)).toEqual({ appended: 1, duplicates: 0 });
    expect(await memory.remember(batch)).toEqual({ appended: 0, duplicates: 1 });
    expect(await corpus.context()).toEqual(['I moved to Berlin in March.']);
  });

  it('refuses a rewrite at a taken ordinal, and writes nothing of the batch that carried it', async () => {
    const corpus = new Corpus({ store: new SqliteStorage(), now: NOW });
    const memory = system([], corpus);
    await memory.remember([{ sessionId: 's1', ordinal: 0, text: 'I moved to Berlin in March.' }]);

    await expect(
      memory.remember([
        { sessionId: 's1', ordinal: 1, text: 'She raised the rent.' },
        { sessionId: 's1', ordinal: 0, text: 'I moved to Lisbon in March.' },
      ]),
    ).rejects.toMatchObject({ code: 'rewrite' });
    // The sibling in the same batch was not written: a batch is one statement about history, and half of it
    // landing would be a corpus that no longer matches the caller's own view of what it sent.
    expect(await corpus.context()).toEqual(['I moved to Berlin in March.']);
  });

  it('names the missing option rather than failing later with no transcript', async () => {
    const memory = system([]);
    await expect(memory.remember([{ sessionId: 's1', ordinal: 0, text: 'x' }])).rejects.toThrow(
      /needs options\.corpus/,
    );
    await expect(memory.askStored(QUESTION)).rejects.toThrow(/needs options\.corpus/);
  });
});

describe('the corpus reads back in the order the conversation happened', () => {
  it('gives sessions in arrival order and turns in ordinal order, whatever order they were appended', async () => {
    const corpus = new Corpus({ store: new SqliteStorage(), now: NOW });
    const memory = system([], corpus);
    await memory.remember([{ sessionId: 'second', ordinal: 0, text: 'b0' }]);
    await memory.remember([
      { sessionId: 'first', ordinal: 1, text: 'a1' },
      { sessionId: 'first', ordinal: 0, text: 'a0' },
    ]);
    expect(await corpus.sessions()).toEqual([['b0'], ['a0', 'a1']]);
    expect(await corpus.context()).toEqual(['b0', 'a0', 'a1']);
  });
});
