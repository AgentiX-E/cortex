/**
 * What a run's own retrieval cost, summed rather than estimated.
 *
 * ## Why this is not `index-reuse.test.ts`
 *
 * That file pins one census at a time: what the index for *this* question did. This pins the total, which
 * is the only number an arm can read after the run. The distinction is load-bearing rather than tidy: the
 * per-question census is overwritten by the next question, so a report that read it after a 500-question
 * run would price one question and call it five hundred. Multiplying the last one by the question count
 * is the estimate this file exists to make unnecessary.
 *
 * ## What is asserted, and why each assertion can fail
 *
 * 1. **The total reconciles with the embedder.** `embedTexts` is compared against the number of texts the
 *    fake model was actually asked for. A counter that drifted from the calls would pass every "is it a
 *    number" assertion and price a run wrongly, which is the failure the cost axis cannot see in accuracy.
 * 2. **Three states stay three.** No `index` at all, `index` present but overridden by `relevanceFor`, and
 *    `index` used: the first two return `undefined` and the third returns a record. A product that always
 *    returned a zeroed record would make "the product never ranked anything" indistinguishable from "the
 *    product ranked and the store saved nothing".
 * 3. **`reuse` is a conjunction.** One index without a store makes the total incomparable with a run that
 *    had one throughout, and `and` is the only spelling of that.
 */
import { describe, expect, it } from 'vitest';
import type { LLM, MemoryValue, ValueFunction } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import { foldIndexCost, type SearchCensus } from '../retrieval/search-index.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;

const OPEN_GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  valueFunction: ((_memory: MemoryValue) => 1) as ValueFunction,
} as const;

const CORPUS = [
  'the bicycle was repaired on tuesday',
  'a parcel arrived for the neighbour',
  'the invoice was paid late again',
  'rain cancelled the football match',
];

const QUESTIONS = [
  'when was the bicycle repaired?',
  'did the parcel arrive?',
  'why was the invoice late?',
];

/** A bag-of-words embedder that records every batch, so the counter can be reconciled with the calls. */
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

function recorder(): LLM {
  return {
    complete: () => Promise.resolve('42'),
    completeStructured: () => Promise.reject(new Error('unused by this package')),
  };
}

/** Answer every question in order and return the instance, so the total can be read at the end. */
async function askAll(options: Partial<CortexMemoryOptions>): Promise<CortexMemory> {
  const system = new CortexMemory({ now: NOW, gate: OPEN_GATE, llm: recorder(), ...options });
  for (const question of QUESTIONS) await system.answer(question, [...CORPUS]);
  return system;
}

describe('the product reports what its own retrieval cost a run', () => {
  it('reports nothing when no index is configured', async () => {
    const system = await askAll({});
    expect(system.indexCost()).toBeUndefined();
  });

  it('reports nothing when `relevanceFor` overrode the index, because no index was built', async () => {
    // The product would otherwise build an index it never ranks with, and the artifact would price a stage
    // the run did not use. The override is what a measured arm passes, so this is the state that matters.
    const system = await askAll({
      index: { embed: recordingEmbed().embed },
      relevanceFor: () => 1,
    });
    expect(system.indexCost()).toBeUndefined();
    expect(system.lastIndexCensus()).toBeUndefined();
  });

  it('sums three questions into one record that reconciles with the embedder', async () => {
    const embedder = recordingEmbed();
    const system = await askAll({ index: { embed: embedder.embed } });

    expect(system.indexCost()).toEqual({
      indexes: 3,
      turns: 12,
      embedCalls: 4,
      embedTexts: 7,
      memoHits: 8,
      reuse: true,
      rerankCalls: 0,
      rerankDegraded: 0,
    });
    // The counter and the model agree: four turns once, then one question per question.
    expect(system.indexCost()?.embedTexts).toBe(embedder.texts());
  });

  it('reproduces the cold total when reuse is refused, so the two runs are one variable apart', async () => {
    const embedder = recordingEmbed();
    const system = await askAll({ index: { embed: embedder.embed, reuse: false } });

    expect(system.indexCost()).toMatchObject({
      indexes: 3,
      turns: 12,
      embedTexts: 15,
      memoHits: 0,
      reuse: false,
    });
    expect(system.indexCost()?.embedTexts).toBe(embedder.texts());
  });

  it('reports a lexical index as three indexes that cost no texts and had no store', async () => {
    const system = await askAll({ index: {} });
    expect(system.indexCost()).toMatchObject({
      indexes: 3,
      turns: 12,
      embedCalls: 0,
      embedTexts: 0,
      memoHits: 0,
      reuse: false,
    });
  });

  it('returns a copy, so a caller cannot rewrite the instance it just measured', async () => {
    const system = await askAll({ index: {} });
    const first = system.indexCost();
    const second = system.indexCost();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});

/** One census, as an index would report it. The fold is arithmetic, so the fields are the whole input. */
function census(overrides: Partial<SearchCensus> = {}): SearchCensus {
  return {
    turns: 4,
    terms: 9,
    vectors: 4,
    embedCalls: 2,
    embedTexts: 5,
    memoHits: 0,
    reuse: true,
    rerankCalls: 0,
    rerankDegraded: 0,
    channels: ['lexical', 'vector'],
    ...overrides,
  };
}

describe('foldIndexCost', () => {
  it('counts the first index from nothing, without a seed record', () => {
    expect(foldIndexCost(undefined, census())).toEqual({
      indexes: 1,
      turns: 4,
      embedCalls: 2,
      embedTexts: 5,
      memoHits: 0,
      reuse: true,
      rerankCalls: 0,
      rerankDegraded: 0,
    });
  });

  it('adds every counter across indexes', () => {
    const total = foldIndexCost(
      foldIndexCost(undefined, census()),
      census({
        turns: 5,
        embedCalls: 1,
        embedTexts: 1,
        memoHits: 4,
        rerankCalls: 3,
        rerankDegraded: 1,
      }),
    );
    expect(total).toEqual({
      indexes: 2,
      turns: 9,
      embedCalls: 3,
      embedTexts: 6,
      memoHits: 4,
      reuse: true,
      rerankCalls: 3,
      rerankDegraded: 1,
    });
  });

  it('reports reuse only when every index had a store', () => {
    const withStore = foldIndexCost(undefined, census({ reuse: true }));
    expect(foldIndexCost(withStore, census({ reuse: false })).reuse).toBe(false);
    // And the conjunction does not latch the other way: a cold first index stays cold.
    const cold = foldIndexCost(undefined, census({ reuse: false }));
    expect(foldIndexCost(cold, census({ reuse: true })).reuse).toBe(false);
  });
});
