import { describe, expect, it } from 'vitest';
import { windowCompositionOf } from '../question-record.js';

/**
 * The room's own account, tested against the one property that makes it usable for a
 * decision: **the two character columns are the whole**, exactly.
 *
 * ## Why every test asserts the identity as well as the split
 *
 * The last defect in this area was a table whose TOTAL clamped two differences that
 * pointed in opposite directions, so a surplus cancelled a shortfall before either
 * clamp ran (`§13.214`: 53 gold turns became a printed `0`). That failure is not
 * specific to gold turns; it is what happens when a total is derived from aggregated
 * parts instead of summed from the parts it is displayed above.
 *
 * So the identity `offeredChars + unscoredChars === sum(delivered lengths)` is
 * asserted on every fixture below, not only on the one built to check it. A future
 * column -- "chars clipped by the per-turn cap", say -- then has to decide whether it
 * is inside the whole or outside it, and cannot be added as a third silent partition.
 *
 * ## Why the fixtures use the shipped numbers where they can
 *
 * `DELIVERED` below is the shape every archived artifact has: a run of scored turns
 * followed by the unscored tail `§13.214.2` measured as 53 gold turns at 48,000. The
 * sizes are not the artifact's -- a 232-turn fixture would be unreadable -- but the
 * **arrangement** is, and the arrangement is what the instrument has to describe.
 */

/** A turn's text, sized so a character total is checkable by hand. */
const turn = (label: string, length: number): string => label.padEnd(length, '.');

describe('windowCompositionOf', () => {
  it('is absent rather than zero when no ranking was consulted', () => {
    // `relevanceSignal: none` is a run where nothing scored the turns, so every turn
    // is unscored by construction and a composition would report `offered: 0` with
    // full `unscoredChars`. That reads as "the ranking offered nothing", which is a
    // measurement of a signal that failed, and the truth is that no signal existed.
    // The same rule `goldOverlap.pool` follows for the same reason.
    expect(windowCompositionOf(['a', 'b'], undefined)).toBeNull();
  });

  it('reports a wholly-offered window as one column', () => {
    const a = turn('a', 10);
    const b = turn('b', 20);
    const result = windowCompositionOf([a, b], [a, b]);
    expect(result).toEqual({ turns: 2, offered: 2, offeredChars: 30, unscoredChars: 0 });
  });

  it('splits the characters when the room overflowed past the pool', () => {
    // The shape of the failure this instrument exists for: the ranking scored two
    // turns, the room also held two it never saw, and the question is whether the
    // room was spent on evidence or on leftovers.
    const a = turn('a', 10);
    const b = turn('b', 20);
    const delivered = [a, turn('x', 40), b, turn('y', 70)];
    const result = windowCompositionOf(delivered, [a, b]);
    expect(result).toEqual({ turns: 4, offered: 2, offeredChars: 30, unscoredChars: 110 });
    expect((result?.offeredChars ?? 0) + (result?.unscoredChars ?? 0)).toBe(140);
  });

  it('counts a turn the ranking scored at the floor as offered', () => {
    // Membership is the index's own set, not a threshold this function invents. A
    // turn the ranking scored *low* is still a turn a better order could move, so it
    // belongs in `offered`; only a turn the index never saw belongs in the other
    // column. Getting this backwards would report the pool's width as the pool's
    // failure.
    const weak = turn('weak', 5);
    const strong = turn('strong', 5);
    // The pool's order is best-first, so the weak turn is last in it -- and last is not
    // the same as absent. This is the distinction a threshold would erase.
    const result = windowCompositionOf([weak, strong], [strong, weak]);
    expect(result?.offered).toBe(2);
    expect(result?.unscoredChars).toBe(0);
  });

  it('counts a repeated turn once per delivery', () => {
    // `retrieved` is the list the reader read, so a turn text that appears twice spent
    // its characters twice. A `Set` here would report a window smaller than the one
    // the budget actually paid for -- and the budget is what the number is about.
    const a = turn('a', 10);
    const result = windowCompositionOf([a, a, turn('x', 10)], [a]);
    expect(result).toEqual({ turns: 3, offered: 2, offeredChars: 20, unscoredChars: 10 });
  });

  it('reports an empty window as zeroes rather than as absent', () => {
    // A question the system declined to answer from no evidence is a measured window
    // of zero turns, and its absence is a fact about the run. `null` is reserved for
    // "no ranking was consulted", which is a different fact -- the collapse
    // `§13.11.2` requires an absence never to make.
    expect(windowCompositionOf([], [turn('a', 1)])).toEqual({
      turns: 0,
      offered: 0,
      offeredChars: 0,
      unscoredChars: 0,
    });
    expect(windowCompositionOf([], [])).toEqual({
      turns: 0,
      offered: 0,
      offeredChars: 0,
      unscoredChars: 0,
    });
  });

  it('treats an empty pool as a ranking that offered nothing', () => {
    // An empty array and an absent array are different facts: the caller holds an
    // index that answered this question with no candidates, which is a ranking that
    // fired and found nothing. Reporting that as `null` would send a reader looking
    // for a missing `relevanceSignal`.
    const result = windowCompositionOf([turn('a', 7)], []);
    expect(result).toEqual({ turns: 1, offered: 0, offeredChars: 0, unscoredChars: 7 });
  });

  it('keeps the identity on a window whose pool is wider than the delivery', () => {
    // The case `§13.68`'s per-turn cap creates in the other direction: a 256-wide pool
    // and a window that holds fewer turns than it. `offered <= turns` still holds
    // because the count is over the delivery, and the pool's unused width is nobody's
    // character cost.
    const delivered = [turn('a', 3)];
    const pool = Array.from({ length: 256 }, (_, index) => turn(`p${index}`, 3));
    const result = windowCompositionOf(delivered, pool);
    expect(result).toEqual({ turns: 1, offered: 0, offeredChars: 0, unscoredChars: 3 });
  });
});
