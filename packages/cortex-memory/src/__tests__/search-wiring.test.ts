/**
 * The product's retrieval, wired: the index reaches the prompt, absence is the identity, and the override
 * wins.
 *
 * ## Why this is a second file
 *
 * `search-index.test.ts` pins the ranking, the fusion, the reranker and the census as a mechanism. What it
 * cannot pin is the part that has failed in this package before -- **the signal reaching the prompt**.
 * `§14.131` found a run whose sampler was never forwarded, and `AUDIT-SEMANTIC-REACH.md` §8 is the standing
 * record that retrieval lived in the harness: in both cases the mechanism was correct and the wiring was
 * the defect. So what is asserted here is the plumbing, in the same four shapes the width plan's wiring test
 * uses:
 *
 * 1. **Absence is the identity** -- no `index`, no `relevanceFor`, same bytes as the archived configuration,
 *    on the flat route and on the multi-session one. Every reading on record was taken in that state.
 * 2. **The index changes which turns are delivered**, not merely which are scored: the topical turn is the
 *    **last** of twelve, so a prefix of the arrival order provably cannot contain it and a relevance order
 *    provably can. That is the difference between a ranking and a report about a ranking.
 * 3. **The override wins** -- a run that supplies `relevanceFor` and `index` together must be the run the
 *    signal describes, and the census has to say the product did not rank.
 * 4. **The census is per question** -- a decline clears it, and a second question with a different corpus
 *    rebuilds rather than inheriting. A stale census is indistinguishable, in an artifact, from a stage that
 *    ran on a corpus it never saw.
 */
import { describe, expect, it } from 'vitest';
import type { LLM, MemoryValue, ValueFunction } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;

/** A gate that admits everything, so the only thing the selection can be short of is room. */
const OPEN_GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  valueFunction: ((_memory: MemoryValue) => 1) as ValueFunction,
} as const;

/** Room for one or two turns, so the delivered set is a decision rather than the whole corpus. */
const NARROW = 1_200;

/**
 * Twelve turns of four hundred characters, with the topical one **last**.
 *
 * The position is the experiment. `chooseEvidence` with no signal clips a prefix of the arrival order, so a
 * topical turn at index 11 is not in that prefix; the same turn is rank 1 under any relevance order. A test
 * of the wiring therefore needs the two orders to disagree, and this is the cheapest fixture where they do.
 */
function turns(): string[] {
  return [
    ...Array.from({ length: 11 }, (_, index) => `unrelated ${index} ${'c'.repeat(388)}`),
    `zebra9 shoes packed ${'d'.repeat(380)}`,
  ];
}

function sessions(): string[][] {
  const all = turns();
  return [all.slice(0, 6), all.slice(6)];
}

/** One system, its prompts, and its own census. */
async function oneAnswer(
  options: Partial<CortexMemoryOptions>,
  ask: (system: CortexMemory) => Promise<unknown> = (system) =>
    system.answer('how many shoes were packed?', turns()),
): Promise<{ prompt: string; census: ReturnType<CortexMemory['lastIndexCensus']> }> {
  const seen: string[] = [];
  const llm: LLM = {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return 'answer';
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
  const system = new CortexMemory({ now: NOW, gate: OPEN_GATE, llm, ...options });
  await ask(system);
  return { prompt: seen.join('\n'), census: system.lastIndexCensus() };
}

/**
 * A stand-in embedder that knows `car` and `automobile` are one concept.
 *
 * Enough to test that the vector channel is reachable from the option and that its hits can win the room.
 * The mechanism is what is under test, not an encoder.
 */
function embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
  return Promise.resolve(
    texts.map((text) => {
      const words = new Set(text.toLowerCase().match(/[a-z]+/g) ?? []);
      return [words.has('car') || words.has('automobile') ? 1 : 0, words.has('packed') ? 1 : 0];
    }),
  );
}

describe('the product index', () => {
  it('is the identity when absent, on the flat and multi-session routes', async () => {
    const control = await oneAnswer({ maxPromptChars: NARROW });
    const absent = await oneAnswer({ maxPromptChars: NARROW, index: undefined });
    expect(absent.prompt).toEqual(control.prompt);
    expect(control.census).toBeUndefined();

    const controlSessions = await oneAnswer({ maxPromptChars: NARROW }, (system) =>
      system.answerSessions('how many shoes were packed?', sessions()),
    );
    const absentSessions = await oneAnswer({ maxPromptChars: NARROW, index: undefined }, (system) =>
      system.answerSessions('how many shoes were packed?', sessions()),
    );
    expect(absentSessions.prompt).toEqual(controlSessions.prompt);
    // The control is not trivially empty: a blank prompt would make both equalities vacuous.
    expect(control.prompt.length).toBeGreaterThan(400);
  });

  it('delivers the topical turn that a prefix of the arrival order cannot reach', async () => {
    const control = await oneAnswer({ maxPromptChars: NARROW });
    const indexed = await oneAnswer({ maxPromptChars: NARROW, index: {} });
    expect(control.prompt).not.toContain('zebra9');
    expect(indexed.prompt).toContain('zebra9');
    expect(control.prompt).not.toEqual(indexed.prompt);
  });

  it('carries its own vector channel into the prompt', async () => {
    // The gold turn shares no content term with the question -- it says "automobile" where the question
    // says "car" -- so the lexical channel scores it 0 and only the injected embedder can find it. Without
    // the embedder the turn is absent; with it the turn is delivered. That is the whole value of the
    // injection point, and it is the one thing a lexical index cannot do on its own.
    const corpus = [
      ...Array.from({ length: 11 }, (_, index) => `unrelated ${index} ${'c'.repeat(388)}`),
      `automobile detail zebra9 ${'d'.repeat(376)}`,
    ];
    const question = 'how many car trips were taken?';
    const ask = (system: CortexMemory): Promise<unknown> => system.answer(question, corpus);

    const without = await oneAnswer({ maxPromptChars: NARROW, index: {} }, ask);
    const withVector = await oneAnswer({ maxPromptChars: NARROW, index: { embed } }, ask);
    expect(without.prompt).not.toContain('zebra9');
    expect(withVector.prompt).toContain('zebra9');
    expect(withVector.census?.channels).toContain('vector');
    expect(withVector.census?.vectors).toBe(12);
    // One batch for the corpus and one for the question: the batching is part of the contract, because a
    // per-text call would multiply a run's model bill by the corpus size.
    expect(withVector.census?.embedCalls).toBe(2);
  });

  it('lets a supplied relevanceFor win, and says the product did not rank', async () => {
    // A run that names a signal must be the run the artifact describes. If the index overrode the callback,
    // the delta of every registered arm would silently become a delta of this module.
    const { prompt, census } = await oneAnswer({
      maxPromptChars: NARROW,
      index: {},
      relevanceFor: (_question: string, turn: string) => (turn.startsWith('unrelated 2 ') ? 1 : 0),
    });
    expect(prompt).toContain('unrelated 2 ');
    expect(prompt).not.toContain('zebra9');
    expect(census).toBeUndefined();
  });
});

describe('the index census', () => {
  it('reports the corpus it ranked and the channels it used', async () => {
    const { census } = await oneAnswer({ maxPromptChars: NARROW, index: {} });
    expect(census?.turns).toBe(12);
    expect(census?.channels).toEqual(['lexical']);
    expect(census?.rerankCalls).toBe(0);
    expect(census?.rerankDegraded).toBe(0);
  });

  it('is cleared by a decline instead of describing the previous question', async () => {
    // The arm writes this field once per question. A decline never builds an index, and inheriting the
    // previous counters would attribute this question's ranking to a corpus it never read.
    const seen: string[] = [];
    const llm: LLM = {
      complete: async (prompt: string) => {
        seen.push(prompt);
        return 'answer';
      },
      completeStructured: async () => {
        throw new Error('unused by this package');
      },
    };
    const system = new CortexMemory({ now: NOW, gate: OPEN_GATE, llm, index: {} });
    await system.answer('how many shoes were packed?', turns());
    expect(system.lastIndexCensus()?.turns).toBe(12);
    await system.answer('how many shoes were packed?', []);
    expect(system.lastIndexCensus()).toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  it('rebuilds per question rather than inheriting the last corpus', async () => {
    const seen: string[] = [];
    const llm: LLM = {
      complete: async (prompt: string) => {
        seen.push(prompt);
        return 'answer';
      },
      completeStructured: async () => {
        throw new Error('unused by this package');
      },
    };
    const system = new CortexMemory({ now: NOW, gate: OPEN_GATE, llm, index: {} });
    await system.answer('how many shoes were packed?', turns());
    await system.answer('how many shoes were packed?', ['zebra9 first', 'zebra9 second']);
    expect(system.lastIndexCensus()?.turns).toBe(2);
    expect(seen.at(-1)).toContain('zebra9');
  });
});
