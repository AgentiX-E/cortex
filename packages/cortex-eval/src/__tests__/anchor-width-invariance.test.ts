import { describe, it, expect } from 'vitest';
import { restoreAnchorNeighbourhoods } from '../anchor-recall.js';

/**
 * The pool must not be a function of the retrieval width.
 *
 * §13.280.1 measured 63 of 500 questions delivering a different gold set under one `top_k` change,
 * and §13.280.6 argues the mechanism: the anchor walk's bound is the pool's length and its first
 * ordering key is question-term coverage, so a worse-ranked hit in a wider pool can **displace** a
 * better-ranked anchor -- and the displaced anchor's neighbourhood is what leaves the delivered
 * window.
 *
 * The fixture keeps three properties of the real run, because dropping any of them makes the defect
 * invisible and the test would pass against the broken code:
 *
 *   * scores are reciprocal-rank (`1/(60+rank)`), the arm's fusion output. A restored turn scores
 *     `0.5 x anchor`; on a cosine-like band that is below every hit and restoration never reaches
 *     the window, so nothing can move.
 *   * the corpus is far larger than the pool, so a neighbourhood holds turns the retriever did not
 *     score. On a dense pool every neighbour is already a hit and restoration adds nothing.
 *   * one candidate past the narrow cut names **two** question terms, so it wins an anchor slot on
 *     coverage instead of merely adding one.
 *
 * `DELIVERED` is 232, the largest delivered count in either archived artifact (232 at `top_k=256`,
 * 238 at 512, both under 256) -- so the window is always narrower than the narrow pool, which is
 * what makes the invariance claim exact rather than approximate.
 */
const QUESTION = 'alpha beta gamma delta';
const TURNS = 4000;
const DELIVERED = 232;
const NARROW = 256;
const WIDE = 512;

const SESSION: readonly string[] = Array.from({ length: TURNS }, (_, index) =>
  index === 0
    ? 'alpha beta top'
    : index === 45
      ? 'gamma here'
      : index === 225
        ? 'delta here'
        : index === 3900
          ? 'gamma delta together'
          : `turn ${index} filler word`,
);
const CONTEXT: readonly string[] = [...SESSION];

/** `top_k` hits in rank order, spaced so a restored neighbour is usually an unscored turn. */
function hits(width: number): { text: string; score: number }[] {
  const head = [0, 45, 225];
  const spaced: number[] = [];
  for (let index = 15; spaced.length < WIDE && index < TURNS; index += 15) {
    if (!head.includes(index) && index !== 3900) spaced.push(index);
  }
  const order = [...head, ...spaced];
  // The displacing candidate sits just past the narrow cut, so the narrow pool cannot hold it and
  // the wide pool holds it at the worst rank that pool has.
  order.splice(NARROW, 0, 3900);
  return order
    .slice(0, width)
    .map((index, rank) => ({ text: SESSION[index]!, score: 1 / (60 + rank) }));
}

function pool(width: number) {
  return restoreAnchorNeighbourhoods(hits(width), CONTEXT, [SESSION], { question: QUESTION });
}

describe('the anchor set under two retrieval widths', () => {
  it('keeps the anchors the same names in the same order', () => {
    const narrow = pool(NARROW);
    const wide = pool(WIDE);
    expect(wide.anchors.map((position) => wide.order[position])).toEqual(
      narrow.anchors.map((position) => narrow.order[position]),
    );
  });

  it('restores the same number of turns, not merely some of the same', () => {
    expect(pool(WIDE).restored).toBe(pool(NARROW).restored);
  });

  it('delivers the same window, which is the property the reader consumes', () => {
    expect(pool(WIDE).order.slice(0, DELIVERED)).toEqual(pool(NARROW).order.slice(0, DELIVERED));
  });

  it('reads the same scores for every turn it delivers at either width', () => {
    const narrow = pool(NARROW);
    const wide = pool(WIDE);
    for (const text of narrow.order.slice(0, DELIVERED)) {
      expect(wide.scores.get(text)).toBe(narrow.scores.get(text));
    }
  });

  it('still holds the narrow pool as a subset, so widening adds evidence', () => {
    const narrow = new Set(pool(NARROW).order);
    const wide = new Set(pool(WIDE).order);
    for (const text of narrow) expect(wide.has(text)).toBe(true);
  });

  it('keeps the fixture discriminating: the wider pool does hold the displacing candidate', () => {
    // Without this the test above would pass on a fixture where widening changed nothing at all.
    const wide = pool(WIDE);
    const narrow = pool(NARROW);
    expect(wide.scores.has('gamma delta together')).toBe(true);
    expect(narrow.scores.has('gamma delta together')).toBe(false);
    expect(wide.order.length).toBeGreaterThan(narrow.order.length);
  });
});
