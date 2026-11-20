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
 * 1. **It is the order the room was spent from**, not the index's pool. Round 147 shipped
 *    `SearchIndex.lastPool()` here and `44768451597` contradicted it: `a1cc6108`'s gold turn sits at pool
 *    rank 199 on a question whose window delivered 204 turns. The two are different orders by construction
 *    -- the selector quantises scores to a `1e-4` grid and breaks the ties by arrival (`R1`), and it scores
 *    turns the index deduplicated -- so a rank read off the pool is a position in an order the room never
 *    spent. `AssembledPrompt.ranking` is the array the selector sorted, which is why it cannot disagree with
 *    the delivery cut from it.
 * 2. **It is bound to a question.** A single-slot accessor read one question late is the defect this
 *    repository has paid for four times (`§13.216`, `§13.220`), so the caller names the question and a
 *    mismatch reads as `undefined` rather than as the previous question's ranking.
 * 3. **Its absence is a statement.** No index configured, a caller-supplied signal, or no question asked all
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

/**
 * Four turns, each padded past a hundred characters with a token no query shares.
 *
 * The padding is what makes the window cuttable: four short turns fit any room that fits the instruction
 * block, and a window that fits reports no order at all. `x` is not in {@link VOCABULARY}, so the padding
 * moves the character budget and not the scores.
 */
const PADDING = ` ${'x'.repeat(120)}`;
const CORPUS = [
  `the bicycle was repaired on tuesday${PADDING}`,
  `a parcel arrived for the neighbour${PADDING}`,
  `the invoice was paid late again${PADDING}`,
  `rain cancelled the football match${PADDING}`,
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
/**
 * A room smaller than the fixture's evidence, so the window is **cut** and an order exists.
 *
 * Load-bearing rather than incidental: a prompt that fits its whole corpus reports no order at all, because
 * the builder does not spend a ranking on a cut that does not happen. Every assertion below is about the
 * order behind a cut.
 */
const BINDING_ROOM = 400;

async function asked(
  question: string,
  options: Partial<CortexMemoryOptions>,
): Promise<CortexMemory> {
  const system = new CortexMemory({
    now: NOW,
    gate: OPEN_GATE,
    llm,
    maxPromptChars: BINDING_ROOM,
    ...options,
  });
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

  it('is the order the window was cut from, best first, for the question it answered', async () => {
    const system = await asked(BICYCLE, { index: { embed, k: 4 } });
    const order = system.rankingCensusOf(BICYCLE);
    expect(order).toBeDefined();
    // The topical turn ranks first: this is the assertion that fails if the accessor reports an order the
    // prompt did not use, because `selectByRelevance` spends the room on this same array's prefix.
    expect(order![0]).toBe(CORPUS[0]);
    // And the turn with no shared vocabulary ranks last rather than being missing: the selection scored every
    // candidate it was handed, including the ones the index's `k` never returned.
    expect(order![order!.length - 1]).toBe(CORPUS[3]);
    expect(order).toHaveLength(CORPUS.length);
    // The window, by contrast, is a prefix of it -- which is the statement the rank makes readable.
    expect(system.lastRetrievedContext()!.length).toBeLessThan(CORPUS.length);
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

  it('lists the candidates the index never scored, because the room could still have spent on them', async () => {
    // This is the opposite of the narrowing round 147 shipped, and the reversal is the point. `k` bounds what
    // the index returns; the selection then scores every turn it was handed -- the ones outside `k` at zero --
    // and the room can still reach the tail of that order when the scored candidates do not fill it. A census
    // clipped to `k` would deny a turn the window could have delivered, and would report its gold as "never
    // surfaced" when the honest statement is "surfaced at the bottom".
    const narrow = await asked(BICYCLE, { index: { embed, k: 1 } });
    expect(narrow.rankingCensusOf(BICYCLE)).toHaveLength(CORPUS.length);
    // The one the index scored still leads, so the widening is a tail and not a reshuffle.
    expect(narrow.rankingCensusOf(BICYCLE)![0]).toBe(CORPUS[0]);
  });

  it('holds a repeated turn twice, which the index’s own pool did not', async () => {
    // `lookup` keeps one entry per text -- the first occurrence, its best score -- while the selection scores
    // every turn it was given. On a corpus that repeats a turn the two orders therefore differ in *length*,
    // and a rank read off the shorter one silently becomes the rank of a different candidate.
    const repeated = [CORPUS[0]!, CORPUS[1]!, CORPUS[0]!];
    const system = new CortexMemory({
      now: NOW,
      gate: OPEN_GATE,
      llm,
      maxPromptChars: BINDING_ROOM,
      index: { embed, k: 4 },
    });
    await system.answer(BICYCLE, repeated);
    const order = system.rankingCensusOf(BICYCLE);
    expect(order).toHaveLength(3);
    expect(order!.filter((text) => text === CORPUS[0])).toHaveLength(2);
  });

  it('replaces the previous question’s pool rather than keeping it', async () => {
    // A 500-question run reads this once per question; a pool that survived would rank this question's
    // gold against the previous one's candidates and every rank would still look like a number.
    const system = new CortexMemory({
      now: NOW,
      gate: OPEN_GATE,
      llm,
      maxPromptChars: BINDING_ROOM,
      index: { embed, k: 4 },
    });
    await system.answer(BICYCLE, CORPUS);
    await system.answer(PARCEL, CORPUS);
    expect(system.rankingCensusOf(BICYCLE)).toBeUndefined();
    expect(system.rankingCensusOf(PARCEL)![0]).toBe(CORPUS[1]);
  });
});
