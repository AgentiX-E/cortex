/**
 * The ordering's precision, checked as arithmetic rather than as behaviour.
 *
 * The behavioural half — that two dispatches whose scores differ by less than the provider can resolve
 * select the same window — lives in `evidence-relevance.test.ts`, because it needs a prompt budget to be
 * about anything. This file pins the three properties the ordering *relies* on and that a rewrite could
 * quietly lose: monotonicity, a tie inside the quantum, and separation outside it.
 */
import { describe, expect, it } from 'vitest';

import { orderableRelevance } from '../relevance-order.js';

describe('orderableRelevance', () => {
  it('is monotone, so ordering by it can never invert two scores', () => {
    // Swept rather than sampled at a few points: an ordering only has to be right where the cut lands,
    // and the cut lands wherever the budget puts it.
    let previous = Number.NEGATIVE_INFINITY;
    for (let step = -1100; step <= 1100; step += 1) {
      const value = orderableRelevance(step / 1000);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('makes a difference inside the quantum a tie', () => {
    // `2e-5` is an order of magnitude below the quantum and four above what a float32 dot product can
    // resolve -- exactly the band the flip lived in.
    expect(orderableRelevance(0.500_000_1)).toBe(orderableRelevance(0.499_999_9));
    expect(orderableRelevance(0.5)).toBe(orderableRelevance(0.5 + 2e-5));
  });

  it('separates a difference the signal carries', () => {
    expect(orderableRelevance(0.52)).toBeGreaterThan(orderableRelevance(0.5));
    expect(orderableRelevance(0)).toBeLessThan(orderableRelevance(1e-3));
  });

  it('rounds negative scores symmetrically, and -0 equals 0', () => {
    // Cosine similarity can be negative, and a signed zero is the one value where two equal scores
    // could have compared unequal through `Object.is`. `-0 === 0` is true, so the ordering is safe, but
    // the test states it rather than leaving it to the reader's memory of IEEE-754.
    expect(orderableRelevance(-0.5)).toBe(-orderableRelevance(0.5));
    expect(orderableRelevance(-0)).toBe(orderableRelevance(0));
    expect(orderableRelevance(-1e-3)).toBeLessThan(0);
  });

  it('resolves ten thousand steps across the score range, and no finer', () => {
    // The constant is module-private -- the census refuses an export nothing calls -- so the grid is
    // measured through the function that uses it. This is the number a reader needs to price the tie:
    // two scores closer than 1e-4 are the same score to this ordering.
    expect(orderableRelevance(1) - orderableRelevance(0)).toBe(10_000);
    expect(orderableRelevance(0.5) - orderableRelevance(0.5 - 1e-4)).toBe(1);
    expect(orderableRelevance(0.5) - orderableRelevance(0.5 - 1e-5)).toBe(0);
  });
});
