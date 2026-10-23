/**
 * A3's arithmetic, tested against tables whose p-values can be worked out by hand.
 *
 * ## What is being defended
 *
 * A scoring function is the easiest place in a project to be wrong in a way nobody notices: it runs,
 * it prints numbers, and the numbers go into a report. So every assertion below is either an exact
 * value computed from the binomial by hand, or a property that a wrong implementation would break --
 * symmetry, the empty case, the tie case, and the pairing rule.
 *
 * ## The tie case is the one that matters
 *
 * With no discordant pairs there is nothing to test, and the answer must be `1`, not `0`. A scorer
 * that divides by zero and returns a small number turns "the two presentations were indistinguishable"
 * into "p < 0.001", which is the most flattering possible bug.
 */

import { describe, expect, it } from 'vitest';

import { exactMcNemar, scoreA3, type A3Trial } from '../a3.js';

/** A paired trial helper: the same card under both presentations. */
const pair = (
  cardId: string,
  source: 'accept' | 'dismiss',
  atoms: 'accept' | 'dismiss',
): A3Trial[] => [
  { cardId, arm: 'source', decision: source },
  { cardId, arm: 'atoms', decision: atoms },
];

const pairsOf = (
  specs: readonly (readonly ['accept' | 'dismiss', 'accept' | 'dismiss'])[],
): A3Trial[] => specs.flatMap(([source, atoms], index) => pair(`c${index}`, source, atoms));

describe('exactMcNemar', () => {
  it('is 1 when nothing is discordant, because an undefined statistic is not a small one', () => {
    expect(exactMcNemar(0, 0)).toBe(1);
  });

  it('is 1 when the disagreement is symmetric', () => {
    expect(exactMcNemar(3, 3)).toBe(1);
  });

  it('matches the binomial tail by hand: 10 to 0 is 2 * 2^-10', () => {
    expect(exactMcNemar(0, 10)).toBeCloseTo(2 / 1024, 12);
    expect(exactMcNemar(10, 0)).toBeCloseTo(2 / 1024, 12);
  });

  it('matches the binomial tail by hand: 1 to 9 is 2 * 11 * 2^-10', () => {
    // P(X <= 1) = (1 + 10) / 1024
    expect(exactMcNemar(1, 9)).toBeCloseTo((2 * 11) / 1024, 12);
  });

  it('never exceeds 1, even when the doubling would', () => {
    // P(X <= 5) for n = 10 is ~0.623, so 2 * that would be 1.246 without the cap.
    expect(exactMcNemar(5, 5)).toBe(1);
    expect(exactMcNemar(4, 6)).toBeLessThanOrEqual(1);
  });

  it('is symmetric in its two arguments', () => {
    expect(exactMcNemar(2, 7)).toBeCloseTo(exactMcNemar(7, 2), 12);
  });
});

describe('scoreA3', () => {
  it('counts the four cells of the paired table', () => {
    const trials = pairsOf([
      ['accept', 'accept'],
      ['accept', 'accept'],
      ['accept', 'dismiss'],
      ['dismiss', 'accept'],
      ['dismiss', 'accept'],
      ['dismiss', 'dismiss'],
    ]);
    const result = scoreA3(trials);
    expect(result.pairs).toEqual({ both: 2, onlySource: 1, onlyAtoms: 2, neither: 1 });
    expect(result.discordant).toBe(3);
    expect(result.deltaPp).toBeCloseTo(16.67, 2);
  });

  it('is underpowered below the pre-registered pair count, whatever the numbers say', () => {
    // Six pairs, all of them won by the atoms: a p-value of 2^-6 * 2 = 0.031 would pass alpha, and
    // the verdict still has to be "underpowered" because that is what was written down first.
    const trials = pairsOf(Array.from({ length: 6 }, () => ['dismiss', 'accept'] as const));
    const result = scoreA3(trials);
    expect(result.mcnemarP).toBeLessThan(0.05);
    expect(result.verdict).toBe('underpowered');
    expect(result.reason).toContain('6 pair(s)');
  });

  it('calls atoms-better only when both the test and the effect size agree', () => {
    // 20 pairs: 12 won by atoms, 2 lost, 6 tied.
    const trials = pairsOf([
      ...Array.from({ length: 12 }, () => ['dismiss', 'accept'] as const),
      ...Array.from({ length: 2 }, () => ['accept', 'dismiss'] as const),
      ...Array.from({ length: 6 }, () => ['accept', 'accept'] as const),
    ]);
    const result = scoreA3(trials);
    expect(result.verdict).toBe('atoms-better');
    expect(result.deltaPp).toBeCloseTo(50, 6);
    expect(result.mcnemarP).toBeCloseTo(exactMcNemar(2, 12), 12);
  });

  it('says no-difference when the test passes but the effect is under the bar', () => {
    // 40 pairs, 3 won by atoms and 0 lost: p = 2 * 2^-3 = 0.25, and 3/40 = 7.5pp -- under 10.
    const trials = pairsOf([
      ...Array.from({ length: 3 }, () => ['dismiss', 'accept'] as const),
      ...Array.from({ length: 37 }, () => ['accept', 'accept'] as const),
    ]);
    const result = scoreA3(trials);
    expect(result.deltaPp).toBeCloseTo(7.5, 6);
    expect(result.verdict).toBe('no-difference');
  });

  it('calls source-better when the model makes the card worse', () => {
    const trials = pairsOf([
      ...Array.from({ length: 12 }, () => ['accept', 'dismiss'] as const),
      ...Array.from({ length: 8 }, () => ['accept', 'accept'] as const),
    ]);
    const result = scoreA3(trials);
    expect(result.verdict).toBe('source-better');
    expect(result.deltaPp).toBeLessThan(0);
  });

  it('drops a card judged under only one presentation, and says so', () => {
    const trials: A3Trial[] = [
      ...pairsOf(Array.from({ length: 20 }, () => ['dismiss', 'accept'] as const)),
      // A session that was interrupted: `c20` was seen with atoms only.
      { cardId: 'c20', arm: 'atoms', decision: 'accept' },
    ];
    const result = scoreA3(trials);
    expect(result.pairCount).toBe(20);
    // The half-pair counts in the arm summary -- it happened -- but not in the paired test.
    expect(result.arms[1].trials).toBe(21);
    expect(result.arms[0].trials).toBe(20);
    expect(result.verdict).toBe('atoms-better');
  });

  it('keeps the last judgement for a card that was decided twice', () => {
    const trials: A3Trial[] = [
      ...pairsOf(Array.from({ length: 20 }, () => ['dismiss', 'accept'] as const)),
      // Resumed session: the person changed their mind on c0's source arm.
      { cardId: 'c0', arm: 'source', decision: 'accept' },
    ];
    const result = scoreA3(trials);
    expect(result.pairCount).toBe(20);
    // The re-judged card moved from "atoms only" to "both", and the source arm still has 20 trials
    // -- keeping both judgements would have made it 21 and double-counted the card.
    expect(result.pairs.onlySource).toBe(0);
    expect(result.pairs.onlyAtoms).toBe(19);
    expect(result.pairs.both).toBe(1);
    expect(result.arms[0].trials).toBe(20);
  });

  it('reports unpaired rather than guessing when no card was seen twice', () => {
    const trials: A3Trial[] = [{ cardId: 'c0', arm: 'atoms', decision: 'accept' }];
    const result = scoreA3(trials);
    expect(result.verdict).toBe('unpaired');
    expect(result.pairCount).toBe(0);
    expect(result.deltaPp).toBe(0);
  });

  it('counts an edit as an acceptance, and still counts it as an edit', () => {
    const trials: A3Trial[] = [
      { cardId: 'c0', arm: 'source', decision: 'accept' },
      { cardId: 'c0', arm: 'atoms', decision: 'edit', editedTo: 'I moved to Berlin' },
    ];
    const result = scoreA3(trials);
    expect(result.arms[1].accepted).toBe(1);
    expect(result.arms[1].edited).toBe(1);
    expect(result.pairs.both).toBe(1);
  });

  it('reports the median decision time per arm, and null when there is none', () => {
    const trials: A3Trial[] = [
      { cardId: 'c0', arm: 'source', decision: 'accept', elapsedMs: 900 },
      { cardId: 'c0', arm: 'atoms', decision: 'accept', elapsedMs: 300 },
      { cardId: 'c1', arm: 'source', decision: 'dismiss', elapsedMs: 100 },
      { cardId: 'c1', arm: 'atoms', decision: 'dismiss', elapsedMs: 700 },
    ];
    const result = scoreA3(trials);
    expect(result.arms[0].medianMs).toBe(100);
    expect(result.arms[1].medianMs).toBe(300);
    expect(result.arms[0].interval.lower).toBeLessThan(result.arms[0].rate);
  });

  it('gives an empty arm the honest interval, not a zero-width one', () => {
    const result = scoreA3([{ cardId: 'c0', arm: 'atoms', decision: 'accept' }]);
    expect(result.arms[0].trials).toBe(0);
    expect(result.arms[0].interval).toEqual({ lower: 0, upper: 1 });
    expect(result.arms[0].medianMs).toBeNull();
  });
});
