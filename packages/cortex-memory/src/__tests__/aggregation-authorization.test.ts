/**
 * The veto's arithmetic, before the veto exists.
 *
 * §13.365 registers an authorization for the `spec` pass: substitute the plan's value for the first answer
 * **only if** the first answer's own token appears among the rows the plan selected. The four numbers it asks
 * for — `selected`, `ledgerRows`, `supportHits`, `authorized` — have to land before the dispatch that prices
 * them, because a relation nobody recorded cannot be measured afterwards, and this campaign has already paid
 * for that shape twice (`support` was computed on every call and dropped at `memory.ts`).
 *
 * So this file pins the arithmetic while it is still free: the identity that makes the census checkable, the
 * normalisation that makes a gold of `1,998` match a row that says `$1,998`, and the two asymmetries that are
 * decisions rather than consequences — a numberless answer is never authorized, and a hit counts rows rather
 * than occurrences.
 */

import { describe, expect, it } from 'vitest';

import type { AggregationResult } from '../aggregation/execute.js';
import { authoriseSpecSubstitution } from '../aggregation/authorization.js';
import type { Ledger, LedgerRow } from '../aggregation/ledger.js';
import { numeralsIn } from '../aggregation/ledger.js';

/** A row carrying the numbers a test gives it, so nothing depends on the tokeniser. */
function row(step: number, text: string, numbers: LedgerRow['numbers'] = []): LedgerRow {
  return { step, session: 0, date: '2023/01/01', role: 'user', text, numbers };
}

const ledgerOf = (rows: LedgerRow[]): Ledger => ({ rows, steps: rows.length, sessions: 1 });

/** A `sum` result over the named steps, which is the only shape the pass renders. */
function sum(steps: number[], value = 1): AggregationResult {
  return { kind: 'value', operation: 'sum', value, support: steps, unit: null, mixed: false };
}

const never: AggregationResult = { kind: 'empty', operation: 'sum' };

describe('authoriseSpecSubstitution', () => {
  const ledger = ledgerOf([
    row(0, 'I watched 1998 views', [{ value: 1998, unit: 'views' }]),
    row(1, 'unrelated turn about lunch', [{ value: 12, unit: null }]),
    row(2, 'another 1998 mention', [{ value: 1998, unit: null }]),
  ]);

  it('authorizes when a selected row carries the first answer’s own numeral', () => {
    const reading = authoriseSpecSubstitution(sum([0, 2]), ledger, '1998');
    expect(reading.authorized).toBe(true);
    expect(reading.supportHits).toBe(2);
    expect(reading.selected).toBe(2);
    expect(reading.ledgerRows).toBe(3);
  });

  it('authorizes a thousands-separated answer against a row that carries the same number', () => {
    // The gold is `1,998` and the answer is `1998`; the ledger stores the value, so both sides normalise to
    // the same integer and the authorization is about the quantity rather than about its spelling.
    expect(authoriseSpecSubstitution(sum([0]), ledger, '1,998').authorized).toBe(true);
    expect(authoriseSpecSubstitution(sum([0]), ledger, '$1,998').authorized).toBe(true);
  });

  it('refuses when no selected row carries the answer’s numeral', () => {
    const reading = authoriseSpecSubstitution(sum([1]), ledger, '1998');
    expect(reading.authorized).toBe(false);
    expect(reading.supportHits).toBe(0);
    expect(reading.selected).toBe(1);
  });

  it('refuses when the numeral exists in the ledger but outside the selection', () => {
    // Step 0 carries 1998 and is *not* in the support. The relation is about the selected rows, so a ledger
    // that contains the answer everywhere still refuses a selection that contains it nowhere.
    const reading = authoriseSpecSubstitution(sum([1]), ledger, '1998');
    expect(reading.ledgerRows).toBe(3);
    expect(reading.supportHits).toBe(0);
  });

  it('counts rows rather than occurrences', () => {
    const twice = ledgerOf([
      row(0, '1998 and 1998', [
        { value: 1998, unit: null },
        { value: 1998, unit: null },
      ]),
    ]);
    expect(authoriseSpecSubstitution(sum([0]), twice, '1998').supportHits).toBe(1);
  });

  it('never authorizes a first answer with no numeral', () => {
    // Deliberate asymmetry, not an oversight: a numeric aggregate substituted for a word answer cannot be
    // authorized by comparing numbers, and the safe direction is to keep the answer that was actually read.
    const reading = authoriseSpecSubstitution(sum([0]), ledger, 'Friday');
    expect(reading.tokens).toBe(0);
    expect(reading.supportHits).toBe(0);
    expect(reading.authorized).toBe(false);
  });

  it('reports zero support for an empty selection and still reports the ledger size', () => {
    const reading = authoriseSpecSubstitution(never, ledger, '1998');
    expect(reading.selected).toBe(0);
    expect(reading.supportHits).toBe(0);
    expect(reading.authorized).toBe(false);
    expect(reading.ledgerRows).toBe(3);
  });

  it('holds the identity supportHits <= selected <= ledgerRows on every shape', () => {
    for (const result of [sum([0]), sum([0, 1, 2]), sum([]), never]) {
      for (const answer of ['1998', '12', 'Friday', '']) {
        const reading = authoriseSpecSubstitution(result, ledger, answer);
        expect(reading.supportHits).toBeLessThanOrEqual(reading.selected);
        expect(reading.selected).toBeLessThanOrEqual(reading.ledgerRows);
        expect(reading.authorized).toBe(reading.supportHits > 0);
      }
    }
  });

  it('matches on the value and not on the unit', () => {
    // Units are already a field of the plan (`number unit-is views`), so requiring them here would refuse
    // `1998` against `$1,998` while adding no information the plan does not already carry.
    const dollars = ledgerOf([row(0, 'paid $1998', [{ value: 1998, unit: '$' }])]);
    expect(authoriseSpecSubstitution(sum([0]), dollars, '1998').authorized).toBe(true);
  });

  it('takes a decimal answer literally', () => {
    const hours = ledgerOf([row(0, 'spent 2.5 hours', [{ value: 2.5, unit: 'hours' }])]);
    expect(authoriseSpecSubstitution(sum([0]), hours, '2.5 hours').authorized).toBe(true);
    expect(authoriseSpecSubstitution(sum([0]), hours, '2.25 hours').authorized).toBe(false);
  });
});

describe('numeralsIn', () => {
  it('reads the numerals of an answer the way the ledger reads a turn', () => {
    // The same tokeniser on both sides is what makes "the answer's token appears in the row" a statement
    // about one vocabulary rather than about two.
    expect(numeralsIn('1998')).toEqual([1998]);
    expect(numeralsIn('1,998')).toEqual([1998]);
    expect(numeralsIn('$1,998')).toEqual([1998]);
    expect(numeralsIn('Friday')).toEqual([]);
    expect(numeralsIn('5 days. 6 days is also acceptable.')).toEqual([5, 6]);
  });

  it('does not read a hyphenated name as a count', () => {
    expect(numeralsIn('COVID-19')).toEqual([]);
  });
});
