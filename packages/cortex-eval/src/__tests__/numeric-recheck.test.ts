/**
 * The numeric screen's own tests.
 *
 * ## What is being protected
 *
 * This instrument produces an accuracy with no judge in it, so its errors do not cancel: a parsing rule
 * that picked the wrong token would move MR's reading in one direction on every question at once, and
 * nothing downstream would notice. The cases below are the ones the real artifact contains — currency
 * with commas, a percentage, a gold with a unit, a gold with no digits at all, and the arm's habit of
 * printing its arithmetic before its answer.
 */
import { describe, it, expect } from 'vitest';

import { numericScreen } from '../numeric-recheck.js';

// Derived rather than imported: the barrel exports the predicate alone, and a type exported for a test
// is the advertisement `tools/export-census.mjs` refuses.
type NumericSource = Parameters<typeof numericScreen>[0][number];

function answer(overrides: Partial<NumericSource> & { questionId: string }): NumericSource {
  return {
    capability: 'MR',
    gold: '2',
    answer: '2',
    accepted: true,
    ...overrides,
  };
}

function rowOf(source: NumericSource) {
  return numericScreen([source]).rows[0]!;
}

describe('the five relations', () => {
  it('agrees on a currency gold printed with a comma and an answer without one', () => {
    // `$5,850` is a real gold; the arm prints `5850`.
    expect(rowOf(answer({ questionId: 'n1', gold: '$5,850', answer: '5850' }))).toMatchObject({
      relation: 'agrees',
      goldValues: [5850],
      stated: 5850,
    });
  });

  it('agrees on a percentage, because both sides state the same number', () => {
    // Deliberately not scale-aware: `20%` is 20 here, so an answer stating `0.2` differs. A normaliser
    // that guessed the scale would be deciding the answer.
    expect(rowOf(answer({ questionId: 'n2', gold: '20%', answer: '20%' })).relation).toBe('agrees');
    expect(rowOf(answer({ questionId: 'n2b', gold: '20%', answer: '0.2' })).relation).toBe(
      'differs',
    );
  });

  it('agrees on a gold with a unit when the answer states the number', () => {
    // `3 days` against `3`. Units are ignored on both sides, which is the same blind spot that makes
    // `72 hours` differ from `3 days` — one rule, stated once.
    expect(rowOf(answer({ questionId: 'n3', gold: '3 days', answer: 'It took 3.' })).relation).toBe(
      'agrees',
    );
    expect(
      rowOf(answer({ questionId: 'n3b', gold: '3 days', answer: 'It took 72 hours.' })).relation,
    ).toBe('differs');
  });

  it('reads the last number as the answer, not the first', () => {
    // The arm prints its arithmetic. `440 - 250 = 190 190`: the last token is what it committed to, and
    // an answer that computes 190 and then states 440 is a disagreement rather than an agreement.
    expect(
      rowOf(answer({ questionId: 'n4', gold: '190', answer: '440 - 250 = 190 190' })).relation,
    ).toBe('agrees');
    expect(
      rowOf(answer({ questionId: 'n4b', gold: '190', answer: '440 - 250 = 190. So 440.' }))
        .relation,
    ).toBe('agrees-early');
  });

  it('separates a reader that computed the gold and stated something else', () => {
    // The failure that most resembles success: the right number is *in* the answer. Folding this into
    // `agrees` would score it right; folding it into `differs` would hide why it is worth reading.
    const row = rowOf(
      answer({ questionId: 'n5', gold: '12', answer: '$60 ÷ 5 = $12 per mug, so $13 total. 13' }),
    );
    expect(row.relation).toBe('agrees-early');
    expect(row.stated).toBe(13);
  });

  it('reports a gold with no digits as unreachable rather than as agreement', () => {
    // `an hour and a half` is a real MR gold. Counting it either way would be inventing a reading.
    expect(
      rowOf(answer({ questionId: 'n6', gold: 'an hour and a half', answer: '90 minutes' }))
        .relation,
    ).toBe('gold-unreachable');
    expect(rowOf(answer({ questionId: 'n7', gold: '2', answer: 'I cannot tell.' })).relation).toBe(
      'answer-unreachable',
    );
  });
});

describe('the reading', () => {
  const SOURCES: NumericSource[] = [
    answer({ questionId: 'a1', gold: '2', answer: '2' }),
    answer({ questionId: 'a2', gold: '$50', answer: '60 - 10 = 50 50' }),
    // False accept: accepted, and it states a different number.
    answer({ questionId: 'a3', gold: '3', answer: '2' }),
    // False reject: rejected, and it states the gold's number.
    answer({ questionId: 'r1', gold: '5', answer: '4 + 1 = 5 5', accepted: false }),
    answer({ questionId: 'r2', gold: '2', answer: '1', accepted: false }),
    answer({ questionId: 'a4', gold: 'an hour and a half', answer: '90 minutes' }),
  ];

  it('tallies the judge’s two populations separately', () => {
    const reading = numericScreen(SOURCES);
    expect(reading.accepted).toEqual({
      total: 4,
      agrees: 2,
      'agrees-early': 0,
      differs: 1,
      'gold-unreachable': 1,
      'answer-unreachable': 0,
    });
    expect(reading.rejected).toEqual({
      total: 2,
      agrees: 1,
      'agrees-early': 0,
      differs: 1,
      'gold-unreachable': 0,
      'answer-unreachable': 0,
    });
  });

  it('names the false accepts and the false rejects, which are different failures', () => {
    // Both directions come out of the same pass, and the second one is what the audit structurally
    // cannot produce: it perturbs answers the judge accepted, so a rejected answer that was right never
    // enters its sample.
    const reading = numericScreen(SOURCES);
    expect(reading.falseAccepts.map((row) => row.questionId)).toEqual(['a3']);
    expect(reading.falseRejects.map((row) => row.questionId)).toEqual(['r1']);
  });

  it('computes accuracy over the rows it can read, and reports the ones it cannot', () => {
    // Five reachable rows, three of which agree. The unreadable gold is excluded from the denominator
    // *and* counted, so the number cannot improve by the instrument going blind.
    expect(numericScreen(SOURCES).judgeFree).toEqual({ correct: 3, total: 5, unreachable: 1 });
  });

  it('bounds the false-accept rate, because a zero on its own is not a measurement', () => {
    // `0 of 80` is consistent with a rate as high as the Wilson upper bound, and the bound is what makes
    // the claim quotable: with 0 of 5 the same zero could hide 52%.
    const five = numericScreen([
      answer({ questionId: 'b1', gold: '1', answer: '1' }),
      answer({ questionId: 'b2', gold: '1', answer: '1' }),
      answer({ questionId: 'b3', gold: '1', answer: '1' }),
      answer({ questionId: 'b4', gold: '1', answer: '1' }),
      answer({ questionId: 'b5', gold: '1', answer: '1' }),
    ]);
    expect(five.falseAccept).toMatchObject({ accepted: 0, readable: 5, rate: 0 });
    expect(five.falseAccept.upper).toBeGreaterThan(0.4);

    // And the denominator is the readable accepted rows: the unreadable gold is not counted as a row the
    // instrument examined and cleared.
    const mixed = numericScreen([
      answer({ questionId: 'c1', gold: '1', answer: '1' }),
      answer({ questionId: 'c2', gold: 'an hour and a half', answer: '90 minutes' }),
    ]);
    expect(mixed.falseAccept.readable).toBe(1);
  });

  it('keeps both value lists on every row, so the predicate can be audited from the reading', () => {
    const reading = numericScreen([
      answer({ questionId: 'v1', gold: '$60 ÷ 5 = $12', answer: '12 per mug' }),
    ]);
    expect(reading.rows[0]).toMatchObject({
      goldValues: [60, 5, 12],
      answerValues: [12],
      stated: 12,
      relation: 'agrees',
    });
  });

  it('preserves input order and is empty rather than wrong on nothing', () => {
    expect(numericScreen(SOURCES).rows.map((row) => row.questionId)).toEqual([
      'a1',
      'a2',
      'a3',
      'r1',
      'r2',
      'a4',
    ]);
    const empty = numericScreen([]);
    expect(empty.rows).toEqual([]);
    expect(empty.judgeFree).toEqual({ correct: 0, total: 0, unreachable: 0 });
  });

  it('carries the capability through, so the reading can be split by it', () => {
    const reading = numericScreen([
      answer({ questionId: 'm1', capability: 'MR', gold: '2', answer: '2' }),
      { questionId: 'n1', gold: '2', answer: '2', accepted: true },
    ]);
    expect(reading.rows.map((row) => row.capability)).toEqual(['MR', '']);
  });
});
