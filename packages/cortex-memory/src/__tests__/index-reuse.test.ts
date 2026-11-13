/**
 * The second question does not pay for the first question's corpus.
 *
 * ## Why this is its own file
 *
 * `search-index.test.ts` pins the ranking. This pins a **cost property that is invisible in every accuracy
 * number**: an index over a stable corpus embeds the corpus once and then only the questions. Without it the
 * product re-embeds five hundred texts per question, which is the dominant term on the cost axis and reads, in
 * an artifact, exactly like a run that did not.
 *
 * ## What is asserted, and in what order of importance
 *
 * 1. **The cache does not move the answer.** The same three questions are asked twice -- once with the store,
 *    once with `reuse: false` -- and the prompts and answers are compared **byte for byte**. This is the only
 *    pre-registerable shape for a caching change: it may move work, never output. Any accuracy movement is a
 *    defect (the cache reordered something) rather than a result.
 * 2. **The work actually moves.** Question one embeds `turns + 1` texts, question two embeds `1`, and
 *    `memoHits` accounts for the difference. `embedTexts` is asserted rather than `embedCalls` alone because a
 *    batch count cannot tell five hundred texts from one.
 * 3. **`reuse: false` reproduces the cold numbers exactly**, which is what makes the option a single-variable
 *    switch instead of a silent change to every run already on record.
 * 4. **A store is per instance.** Two instances over one corpus do not share vectors, because a bare embed
 *    function states no vector space and a store spanning two of them would mix two models' outputs.
 */
import { describe, expect, it } from 'vitest';
import type { LLM, MemoryValue, ValueFunction } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;

/** A gate that admits everything: the census is about retrieval, not about admission. */
const OPEN_GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  valueFunction: ((_memory: MemoryValue) => 1) as ValueFunction,
} as const;

/** Four turns, each with its own term, so every question has something to rank. */
function corpus(): string[] {
  return [
    'the bicycle was repaired on tuesday',
    'a parcel arrived for the neighbour',
    'the invoice was paid late again',
    'rain cancelled the football match',
  ];
}

const QUESTIONS = [
  'when was the bicycle repaired?',
  'did the parcel arrive?',
  'why was the invoice late?',
];

/**
 * An embedder that records every batch it is asked for.
 *
 * The vector is a bag of words over a fixed vocabulary, so two runs of the same corpus produce the same
 * numbers and the byte comparison in the first test is a comparison of prompts rather than of noise.
 */
function recordingEmbed(): {
  batches: string[][];
  texts: () => number;
  embed: (texts: string[]) => Promise<number[][]>;
} {
  const batches: string[][] = [];
  const vocabulary = ['bicycle', 'parcel', 'invoice', 'rain', 'paid', 'late', 'arrived'];
  return {
    batches,
    texts: () => batches.reduce((total, batch) => total + batch.length, 0),
    embed: (texts) => {
      batches.push([...texts]);
      return Promise.resolve(
        texts.map((text) => {
          const words = new Set(text.toLowerCase().match(/[a-z]+/g) ?? []);
          return vocabulary.map((term) => (words.has(term) ? 1 : 0));
        }),
      );
    },
  };
}

/** An `LLM` that answers the same way every time and records the prompts it was given. */
function recorder(): { prompts: string[]; llm: LLM } {
  const prompts: string[] = [];
  return {
    prompts,
    llm: {
      complete: (prompt: string) => {
        prompts.push(prompt);
        // A number, because a bare non-answer is the decline shape and this file is not about declines.
        return Promise.resolve('42');
      },
      completeStructured: () => Promise.reject(new Error('unused by this package')),
    },
  };
}

/** Ask every question in order, returning each answer's prompt and the census taken after it. */
async function askAll(options: Partial<CortexMemoryOptions>): Promise<{
  answers: unknown[];
  prompts: string[];
  censuses: ReturnType<CortexMemory['lastIndexCensus']>[];
}> {
  const { prompts, llm } = recorder();
  const system = new CortexMemory({ now: NOW, gate: OPEN_GATE, llm, ...options });
  const answers: unknown[] = [];
  const censuses: ReturnType<CortexMemory['lastIndexCensus']>[] = [];
  for (const question of QUESTIONS) {
    answers.push(await system.answer(question, corpus()));
    censuses.push(system.lastIndexCensus());
  }
  return { answers, prompts, censuses };
}

describe('an index over a stable corpus embeds it once', () => {
  it('does not move the answer: prompts and answers are identical with the store and without it', async () => {
    // Two instances rather than one, because `reuse` is read once at construction -- a single instance could not
    // be both configurations, and an option that cannot be turned off mid-run is the property being asserted.
    const reused = await askAll({ index: { embed: recordingEmbed().embed } });
    const cold = await askAll({ index: { embed: recordingEmbed().embed, reuse: false } });

    expect(reused.prompts).toEqual(cold.prompts);
    expect(reused.answers).toEqual(cold.answers);
    expect(reused.prompts).toHaveLength(QUESTIONS.length);
    // A prompt that carried nothing would make the comparison above vacuous.
    expect(reused.prompts[0]).toContain('bicycle');
  });

  it('embeds turns + 1 texts on the first question and 1 on the second', async () => {
    const embedder = recordingEmbed();
    const { censuses } = await askAll({ index: { embed: embedder.embed } });
    const [first, second, third] = censuses;

    expect(first).toMatchObject({
      turns: 4,
      reuse: true,
      embedCalls: 2,
      embedTexts: 5,
      memoHits: 0,
    });
    // One question and no corpus: the store served the four turns this instance already paid for.
    expect(second).toMatchObject({ reuse: true, embedCalls: 1, embedTexts: 1, memoHits: 4 });
    expect(third).toMatchObject({ reuse: true, embedCalls: 1, embedTexts: 1, memoHits: 4 });

    // And the model was asked five texts in total, not fifteen.
    expect(embedder.texts()).toBe(4 + QUESTIONS.length);
  });

  it('reproduces the cold numbers on every question when reuse is refused', async () => {
    const { censuses } = await askAll({
      index: { embed: recordingEmbed().embed, reuse: false },
    });
    for (const census of censuses) {
      expect(census).toMatchObject({ reuse: false, embedCalls: 2, embedTexts: 5, memoHits: 0 });
    }
  });

  it('reports no reuse on a lexical index, which has nothing to remember', async () => {
    const { censuses } = await askAll({ index: {} });
    expect(censuses[0]).toMatchObject({ reuse: false, embedCalls: 0, embedTexts: 0, memoHits: 0 });
    expect(censuses[0]?.channels).toEqual(['lexical']);
  });

  it('does not share a store between two instances, because a bare embedder states no space', async () => {
    const first = recordingEmbed();
    const second = recordingEmbed();
    await askAll({ index: { embed: first.embed } });
    const { censuses } = await askAll({ index: { embed: second.embed } });

    // The second instance's first question is cold: `embedTexts` covers its whole corpus, and its own embedder
    // was asked, which is the observable form of "one store per instance".
    expect(censuses[0]).toMatchObject({ reuse: true, embedTexts: 5, memoHits: 0 });
    expect(second.texts()).toBe(4 + QUESTIONS.length);
  });

  it('reuses across a corpus that grew, paying only for the new turn', async () => {
    // The property that makes the store worth having in a session that keeps talking: the memo is keyed on the
    // text, so a fifth turn costs one text rather than a rebuilt corpus.
    const embedder = recordingEmbed();
    const { llm } = recorder();
    const system = new CortexMemory({
      now: NOW,
      gate: OPEN_GATE,
      llm,
      index: { embed: embedder.embed },
    });
    await system.answer('when was the bicycle repaired?', corpus());
    await system.answer('did the parcel arrive?', [...corpus(), 'a dog joined the household']);

    expect(system.lastIndexCensus()).toMatchObject({
      turns: 5,
      embedTexts: 2,
      memoHits: 4,
      reuse: true,
    });
  });
});
