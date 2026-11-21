/**
 * The adapter, against a real `SearchIndex` rather than a stand-in.
 *
 * ## Why the real index
 *
 * Because the claim this file exists to hold up is "the loop ranks with the same code the
 * registered arm ranks with". A fake index would make that a statement about the fake. So the
 * search cases below build a genuine lexical `SearchIndex`, ask it, ask the adapter, and compare --
 * and the comparison is by id and order, since an adapter that returned the right set in a
 * different order would still produce a different prompt.
 */
import { describe, expect, it } from 'vitest';

import { SearchIndex } from '@agentix-e/cortex-memory';

import { indexRetrieval } from '../tools.js';

const TURNS = [
  'I adopted a dog named Biscuit in March.',
  'The vet said Biscuit needs a dental cleaning next month.',
  'My sister moved to Lisbon last spring and loves it.',
  'I ran the charity ten kilometre race in fifty two minutes.',
];

const indexOver = (turns: readonly string[]): SearchIndex => {
  const index = new SearchIndex();
  index.add(turns);
  return index;
};

describe('indexRetrieval', () => {
  it('returns exactly the index answer, in the index order', async () => {
    const index = indexOver(TURNS);
    const retrieval = indexRetrieval(index, TURNS);
    const expected = await index.search('Biscuit', 4);
    const actual = await retrieval.search('Biscuit', 4);
    expect(actual).toEqual(expected);
    // The ranking is not empty and not the whole corpus: an empty result would make the equality
    // above true for the wrong reason.
    expect(actual.length).toBeGreaterThan(0);
    expect(actual.length).toBeLessThan(TURNS.length);
  });

  it('honours k, because the caller bounds what a step may cost', async () => {
    const retrieval = indexRetrieval(indexOver(TURNS), TURNS);
    expect((await retrieval.search('Biscuit', 1)).length).toBe(1);
  });

  it('reads a turn verbatim and reports nothing for an id outside the corpus', () => {
    const retrieval = indexRetrieval(indexOver(TURNS), TURNS);
    expect(retrieval.read(0)).toBe(TURNS[0]);
    expect(retrieval.read(TURNS.length - 1)).toBe(TURNS[TURNS.length - 1]);
    // The three ways an id can be outside the corpus: past the end, negative, and not an index.
    expect(retrieval.read(TURNS.length)).toBeUndefined();
    expect(retrieval.read(-1)).toBeUndefined();
    expect(retrieval.read(1.5)).toBeUndefined();
  });

  it('treats every turn as its own conversation when no boundaries were supplied', () => {
    const retrieval = indexRetrieval(indexOver(TURNS), TURNS);
    expect(retrieval.session(2)).toEqual([2]);
    expect(retrieval.session(TURNS.length)).toEqual([]);
  });

  it('groups by the boundary map, in arrival order, and includes the turn itself', () => {
    const retrieval = indexRetrieval(indexOver(TURNS), TURNS, { sessionOf: [7, 7, 9, 9] });
    expect(retrieval.session(0)).toEqual([0, 1]);
    expect(retrieval.session(1)).toEqual([0, 1]);
    expect(retrieval.session(3)).toEqual([2, 3]);
    expect(retrieval.session(4)).toEqual([]);
  });

  it('falls back to the turn alone when the map has a hole at that id', () => {
    // A sparse map is what a caller who built the array with `new Array(n)` produces, and the
    // fallback has to be "this turn is its own conversation" rather than "every turn with no key is
    // one conversation" -- the latter would merge the corpus.
    const sparse: number[] = [];
    sparse[1] = 0;
    sparse[3] = 0;
    const retrieval = indexRetrieval(indexOver(TURNS), TURNS, { sessionOf: sparse });
    expect(retrieval.session(0)).toEqual([0]);
    expect(retrieval.session(1)).toEqual([1, 3]);
    expect(retrieval.session(2)).toEqual([2]);
  });

  it('refuses a boundary map that does not cover the corpus', () => {
    expect(() => indexRetrieval(indexOver(TURNS), TURNS, { sessionOf: [0, 0] })).toThrow(
      /sessionOf has 2 entries for 4 turns/,
    );
  });

  it('reports the corpus size the loop budgets against', () => {
    expect(indexRetrieval(indexOver(TURNS), TURNS).turns).toBe(TURNS.length);
  });
});
