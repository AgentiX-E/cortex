/**
 * What the product ranked, in the order it ranked it, for the question it just answered.
 *
 * ## The reading that made this accessor necessary
 *
 * `S18`'s pair read `goldOverlap.carried < total` on sixteen of 121 multi-session questions, and the
 * two readings it licenses point at opposite increments: a gold turn the ranking **never surfaced** is
 * repaired by a different ranking, and one surfaced and **cut by the room** is repaired by a wider room.
 * The artifact could not tell them apart, because the registered signal (`self-index`) builds its pool
 * inside the product, and `goldRanks` is written from a pool the harness holds.
 *
 * The product therefore has to be able to say what it ranked. This accessor is that statement, and the
 * three properties below are what make it a measurement rather than a recollection:
 *
 * 1. **It is the ranking that ran**, not a second one: the pool comes out of the same `search` whose
 *    scores the prompt builder received, so a re-rank here would be a second definition of relevance.
 * 2. **It is bound to a question.** A single-slot accessor read one question late is the defect this
 *    repository has paid for four times (`§13.216`, `§13.220`), so the caller names the question and a
 *    mismatch reads as `undefined` rather than as the previous question's ranking.
 * 3. **Its absence is a statement.** No index configured, an override signal, or no question asked all
 *    read `undefined` -- which is "the product did not rank", never "it ranked nothing".
 */
import { describe, expect, it } from 'vitest';
import type { LLM, MemoryValue, ValueFunction } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
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

const BICYCLE = 'when was the bicycle repaired?';
const PARCEL = 'did the parcel arrive?';

/** A bag-of-words embedder over the corpus vocabulary, so two runs rank identically. */
const VOCABULARY = ['bicycle', 'parcel', 'invoice', 'rain', 'paid', 'late', 'arrived', 'repaired'];

function embed(texts: string[]): Promise<number[][]> {
  return Promise.resolve(
    texts.map((text) => {
      const words = new Set(text.toLowerCase().match(/[a-z]+/g) ?? []);
      return VOCABULARY.map((term) => (words.has(term) ? 1 : 0));
    }),
  );
}

/** An `LLM` that answers a number, because a bare non-answer is the decline shape and this is not about declines. */
const llm: LLM = {
  complete: () => Promise.resolve('42'),
  completeStructured: () => Promise.reject(new Error('unused by this package')),
};

/** One question, so the single slot holds the question the assertions ask about. */
async function asked(
  question: string,
  options: Partial<CortexMemoryOptions>,
): Promise<CortexMemory> {
  const system = new CortexMemory({ now: NOW, gate: OPEN_GATE, llm, ...options });
  await system.answer(question, CORPUS);
  return system;
}

describe('rankingCensusOf', () => {
  it('says nothing before a question was asked', () => {
    // `undefined` rather than `[]`: an empty pool would read as a ranking that fired and offered nothing,
    // which is a finding about the corpus rather than a product that has not run yet.
    const system = new CortexMemory({ now: NOW, gate: OPEN_GATE, llm, index: { embed, k: 4 } });
    expect(system.rankingCensusOf(BICYCLE)).toBeUndefined();
  });

  it('returns the pool the product built, best first, for the question it answered', async () => {
    const system = await asked(BICYCLE, { index: { embed, k: 4 } });
    const pool = system.rankingCensusOf(BICYCLE);
    expect(pool).toBeDefined();
    // The topical turn ranks first: this is the assertion that fails if the accessor reports a pool the
    // prompt did not use, because `selectByRelevance` spends the room on this same order.
    expect(pool![0]).toBe(CORPUS[0]);
    expect(pool).not.toContain(CORPUS[3]);
  });

  it('refuses to answer for a question it did not just rank', async () => {
    // The single-slot hazard. Asked about the previous question, the product says `undefined` rather than
    // handing back the ranking it holds -- which is the shape of a per-question accessor read one question
    // late, the defect `BenchmarkWorkerPool` exists to prevent structurally.
    const system = await asked(PARCEL, { index: { embed, k: 4 } });
    expect(system.rankingCensusOf(BICYCLE)).toBeUndefined();
    expect(system.rankingCensusOf(PARCEL)).toBeDefined();
    expect(system.rankingCensusOf(PARCEL)![0]).toBe(CORPUS[1]);
  });

  it('is a copy, so a caller cannot move the product’s own ranking', async () => {
    // The same rule `abstentionReasons` follows: the arm serialises what it reads, and a consumer that
    // sorted the array in place would change the next reader's answer.
    const system = await asked(BICYCLE, { index: { embed, k: 4 } });
    const pool = system.rankingCensusOf(BICYCLE) as string[];
    pool.push('a turn this index never held');
    expect(system.rankingCensusOf(BICYCLE)).not.toContain('a turn this index never held');
  });

  it('reports no ranking when the product did not build one', async () => {
    // Two configurations, one state: an override signal means the caller ranked, and no `index` means
    // nothing did. Both must read `undefined`, because a product claiming a pool it did not build is the
    // claim `goldAccount` was introduced to stop an artifact from making.
    const overridden = await asked(PARCEL, {
      relevanceFor: (_question, turn) => (turn.includes('bicycle') ? 1 : 0),
    });
    expect(overridden.rankingCensusOf(PARCEL)).toBeUndefined();

    const unordered = await asked(PARCEL, {});
    expect(unordered.rankingCensusOf(PARCEL)).toBeUndefined();
  });

  it('narrows to k, because a turn the prompt had no score for was not ranked', async () => {
    // `k` is what the index spent per channel and what the budget may draw from. A pool wider than `k`
    // would let the artifact say a gold turn was ranked when the prompt never held a score for it.
    const system = await asked(BICYCLE, { index: { embed, k: 1 } });
    expect(system.rankingCensusOf(BICYCLE)).toHaveLength(1);
  });

  it('replaces the previous question’s pool rather than keeping it', async () => {
    // A 500-question run reads this once per question; a pool that survived would rank this question's
    // gold against the previous one's candidates and every rank would still look like a number.
    const system = new CortexMemory({ now: NOW, gate: OPEN_GATE, llm, index: { embed, k: 4 } });
    await system.answer(BICYCLE, CORPUS);
    await system.answer(PARCEL, CORPUS);
    expect(system.rankingCensusOf(BICYCLE)).toBeUndefined();
    expect(system.rankingCensusOf(PARCEL)![0]).toBe(CORPUS[1]);
  });
});
