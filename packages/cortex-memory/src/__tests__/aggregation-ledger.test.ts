/**
 * The ledger compiler: every field is copied or counted, none is inferred.
 *
 * The tests here are written against a property rather than a list of examples: **a row's text must
 * survive the parse byte for byte**, because the ledger's whole claim to being evidence is that it is
 * a copy of the history with fields attached. A parser that trimmed, normalised or re-joined the text
 * would make `support` point at something the reader never saw.
 */

import { describe, expect, it } from 'vitest';

import { buildLedger, ledgerVocabulary } from '../aggregation/ledger.js';

describe('buildLedger', () => {
  it('reads the timestamp, the speaker and the words out of the turn prefix', () => {
    const ledger = buildLedger([['[2023/05/21 (Sun) 19:38] user: I baked four loaves.']]);
    expect(ledger.steps).toBe(1);
    const row = ledger.rows[0]!;
    expect(row.date).toBe('2023/05/21');
    expect(row.role).toBe('user');
    expect(row.text).toBe('I baked four loaves.');
    expect(row.step).toBe(0);
    expect(row.session).toBe(0);
  });

  it('keeps a turn without a prefix as a row rather than dropping it', () => {
    const ledger = buildLedger([['a bare line with no timestamp']]);
    const row = ledger.rows[0]!;
    expect(row.date).toBeNull();
    expect(row.role).toBe('unknown');
    expect(row.text).toBe('a bare line with no timestamp');
  });

  it('numbers steps across sessions and records the session each row came from', () => {
    const ledger = buildLedger([
      ['[2023/01/01 (Sun) 10:00] user: one', '[2023/01/01 (Sun) 10:01] assistant: two'],
      ['[2023/01/02 (Mon) 10:00] user: three'],
    ]);
    expect(ledger.rows.map((row) => [row.step, row.session])).toEqual([
      [0, 0],
      [1, 0],
      [2, 1],
    ]);
    expect(ledger.sessions).toBe(2);
  });

  it('admits an empty history without inventing a row', () => {
    expect(buildLedger([])).toEqual({ rows: [], steps: 0, sessions: 0 });
    expect(buildLedger([[]]).steps).toBe(0);
  });

  it('lowercases the speaker and preserves the words byte for byte', () => {
    const text = '  I sold the bike for $3,750 — and the helmet for $120.  ';
    const ledger = buildLedger([[`[2023/03/04 (Sat) 08:00] User: ${text}`]]);
    expect(ledger.rows[0]!.role).toBe('user');
    expect(ledger.rows[0]!.text).toBe(text);
  });
});

describe('the numbers a row carries', () => {
  const numbersOf = (text: string) =>
    buildLedger([[`[2023/01/01 (Sun) 00:00] user: ${text}`]]).rows[0]!.numbers;

  it('reads a currency symbol as the unit and strips the thousands separator', () => {
    expect(numbersOf('it cost $3,750 in total')).toEqual([{ value: 3750, unit: '$' }]);
  });

  it('reads a trailing percent as the unit', () => {
    expect(numbersOf('20% of the shoes')).toEqual([{ value: 20, unit: '%' }]);
  });

  it('reads the following word as the unit', () => {
    expect(numbersOf('440 pages long')).toEqual([{ value: 440, unit: 'pages' }]);
  });

  it('keeps a decimal part', () => {
    expect(numbersOf('0.5 hours a week')).toEqual([{ value: 0.5, unit: 'hours' }]);
  });

  it('refuses to read a function word as a unit', () => {
    // `5 to 6 days` is two numbers and one unit; without the stoplist the first would be `5 to`.
    expect(numbersOf('5 to 6 days a week')).toEqual([
      { value: 5, unit: null },
      { value: 6, unit: 'days' },
    ]);
  });

  it('does not read a numeral inside a word', () => {
    expect(numbersOf('the COVID-19 year was odd')).toEqual([]);
  });

  it('does not read the parts of a ratio', () => {
    expect(numbersOf('a 1:1:1 ratio of flour')).toEqual([]);
  });

  it('reads every numeral when a turn states several', () => {
    expect(numbersOf('17 poems, 3 short stories and 3 challenge pieces')).toEqual([
      { value: 17, unit: 'poems' },
      { value: 3, unit: 'short' },
      { value: 3, unit: 'challenge' },
    ]);
  });

  it('finds nothing in a turn without numerals', () => {
    expect(numbersOf('nothing numeric here')).toEqual([]);
  });
});

describe('ledgerVocabulary', () => {
  it('summarises the fields a specification may name, in sorted order', () => {
    const ledger = buildLedger([
      [
        '[2023/01/05 (Thu) 10:00] user: I paid $40 for 3 books.',
        '[2023/02/09 (Thu) 10:00] assistant: That is 20% off.',
      ],
      ['[2022/12/01 (Thu) 09:00] user: no numbers here'],
    ]);
    const vocabulary = ledgerVocabulary(ledger);
    expect(vocabulary.steps).toBe(3);
    expect(vocabulary.sessions).toBe(2);
    expect(vocabulary.roles).toEqual(['assistant', 'user']);
    expect(vocabulary.units).toEqual(['$', '%', 'books']);
    expect(vocabulary.firstDate).toBe('2022/12/01');
    expect(vocabulary.lastDate).toBe('2023/02/09');
  });

  it('reports null dates for a history that carries none', () => {
    const vocabulary = ledgerVocabulary(buildLedger([['prose only']]));
    expect(vocabulary.firstDate).toBeNull();
    expect(vocabulary.lastDate).toBeNull();
    expect(vocabulary.units).toEqual([]);
    expect(vocabulary.roles).toEqual(['unknown']);
  });
});
