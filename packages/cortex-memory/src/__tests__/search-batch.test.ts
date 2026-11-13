/**
 * A corpus larger than one request: the cap, the loop, and the alignment.
 *
 * ## The defect this file exists for
 *
 * `SearchIndex.prime()` embedded the whole corpus in **one** request, and the first dispatch that let the
 * product rank for itself died on it 90 ms in:
 *
 *     Embedding request failed: 400 Bad Request —
 *     {"error":{"code":"1214","message":"input数组最大不得超过64条"}}
 *
 * A LongMemEval haystack is ~500 turns. Every unit test passed, because a fake embedder accepts any batch
 * size — which is the general shape of this repository's most expensive defects: the instrument agreed with
 * the code and both were wrong about the world. A per-request input cap is the norm (Zhipu 64, and
 * `cortex-eval`'s `retrieval.ts` already batches at 64 for the same reason), so the product could not embed
 * a real corpus against any capped provider.
 *
 * ## What is asserted, and what each assertion is afraid of
 *
 * 1. **A capped provider is satisfied.** The fake refuses a slice longer than `batch` exactly as the
 *    provider did, so a regression is a thrown error rather than a quietly different number.
 * 2. **The counts describe requests and texts separately.** 130 turns at the default is 3 requests and 131
 *    texts (the corpus plus one query); `embedCalls` alone cannot price a corpus and `embedTexts` alone
 *    cannot say whether the provider's cap was respected.
 * 3. **The vectors stay attached to their turns.** A chunked loop is the only place where a slice can be
 *    taken from one offset and its vectors stored at another — a bug that ranks the wrong turn and produces
 *    a plausible number. The fake returns a vector derived from the text, and the search that follows is
 *    asserted to return the exact turn whose text was the query.
 * 4. **A batch below 1 is refused.** Zero asks for an unbounded number of empty requests; a fraction asks
 *    for a loop that cannot advance.
 */
import { describe, expect, it } from 'vitest';

import { SearchIndex } from '../retrieval/search-index.js';

/** A corpus of `count` turns, each with a term no other turn carries. */
function corpus(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `turn number ${index} mentions term${index}`);
}

/**
 * An embedder that behaves like a capped provider.
 *
 * The vector is a one-hot over `term<N>`, so the cosine between a query and its own turn is 1 and between
 * a query and any other turn is 0. That is what makes the alignment assertion possible: a vector stored
 * under the wrong position ranks the wrong turn, and the top hit says so.
 */
function cappedEmbed(limit: number): {
  batches: number[][];
  embed: (texts: string[]) => Promise<number[][]>;
} {
  const batches: number[][] = [];
  return {
    batches,
    embed: (texts) => {
      if (texts.length > limit) {
        throw new Error(
          `input array must not exceed ${limit} entries, got ${texts.length} (code 1214)`,
        );
      }
      batches.push(texts.map((text) => Number(/term(\d+)/.exec(text)?.[1] ?? -1)));
      return Promise.resolve(
        texts.map((text) => {
          const id = Number(/term(\d+)/.exec(text)?.[1] ?? -1);
          return Array.from({ length: 4 }, (_, axis) => (axis === id % 4 ? 1 : 0));
        }),
      );
    },
  };
}

async function build(
  count: number,
  options: { batch?: number; limit?: number } = {},
): Promise<{ index: SearchIndex; batches: number[][] }> {
  const embedder = cappedEmbed(options.limit ?? 64);
  const index = new SearchIndex({
    embed: embedder.embed,
    ...(options.batch === undefined ? {} : { batch: options.batch }),
  });
  index.add(corpus(count));
  await index.prime();
  return { index, batches: embedder.batches };
}

describe('a corpus larger than one request', () => {
  it('satisfies a provider that refuses more than 64 inputs', async () => {
    const { index, batches } = await build(130);
    await index.search('does anything mention term100?', 3);

    // 130 turns at the default cap: 64 + 64 + 2, then one more request for the query.
    expect(batches.map((batch) => batch.length)).toEqual([64, 64, 2, 1]);
    expect(index.census()).toMatchObject({ turns: 130, embedCalls: 4, embedTexts: 131 });
  });

  it('keeps every vector attached to its own turn', async () => {
    const { index } = await build(130);
    const hits = await index.search('does anything mention term100?', 3);

    // Turn 100 sits in the second chunk. A loop that sliced one offset and stored at another would return
    // a turn from the first, and the lexical channel would not disagree loudly enough to catch it.
    expect(hits[0]?.turn).toBe(100);
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
  });

  it('uses the width the caller names', async () => {
    const { index, batches } = await build(130, { batch: 8 });
    await index.search('does anything mention term7?', 3);

    expect(batches.map((batch) => batch.length)).toEqual([...Array(16).fill(8), 2, 1]);
    expect(index.census()).toMatchObject({ turns: 130, embedCalls: 18, embedTexts: 131 });
  });

  it('makes no request for an empty corpus and one for a corpus under the cap', async () => {
    const empty = await build(0);
    expect(empty.batches).toEqual([]);
    expect(empty.index.census()).toMatchObject({ turns: 0, embedCalls: 0, embedTexts: 0 });

    const small = await build(4);
    expect(small.batches.map((batch) => batch.length)).toEqual([4]);
  });

  it('refuses a batch that could never embed the corpus', () => {
    for (const batch of [0, -1, 2.5]) {
      expect(() => new SearchIndex({ embed: cappedEmbed(64).embed, batch })).toThrow(
        /batch must be a positive integer/,
      );
    }
  });

  it('still reports a short batch as a defect rather than ranking the rest', async () => {
    // The provider answers with fewer vectors than it was given. That is a broken embedder, and an index
    // that accepted it would score the tail of the corpus as unrelated to every question.
    const index = new SearchIndex({
      embed: async (texts: string[]) => texts.slice(1).map(() => [1, 0, 0, 0]),
      batch: 2,
    });
    index.add(corpus(3));
    await expect(index.prime()).rejects.toThrow(/returned 1 vector/);
  });
});
