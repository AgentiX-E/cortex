import { describe, it, expect } from 'vitest';
import {
  isTemporalQuestion,
  extractDate,
  daysBetween,
  extractDatedTurns,
  buildTemporalEvidence,
} from '../temporal.js';

describe('isTemporalQuestion', () => {
  it('detects relative-time and ordering questions', () => {
    expect(isTemporalQuestion('How many weeks ago did I receive the chandelier?')).toBe(true);
    expect(isTemporalQuestion('How many days passed between my visit to X and Y?')).toBe(true);
    expect(isTemporalQuestion('Which event happened first, X or Y?')).toBe(true);
    expect(isTemporalQuestion('Did X happen before or after Y?')).toBe(true);
  });

  it('rejects non-temporal questions', () => {
    expect(isTemporalQuestion('What is my favorite color?')).toBe(false);
    expect(isTemporalQuestion('Where do I take yoga classes?')).toBe(false);
  });
});

describe('extractDate', () => {
  it('extracts the date prefix', () => {
    expect(extractDate('[2023/03/04] user: I received a chandelier')).toBe('2023/03/04');
    expect(extractDate('[2023/03/04 (Sat) 22:43] user: hello')).toBe('2023/03/04');
  });

  it('returns undefined without a date prefix', () => {
    expect(extractDate('user: no date')).toBeUndefined();
    expect(extractDate('plain text')).toBeUndefined();
  });
});

describe('daysBetween', () => {
  it('returns positive days when b is later', () => {
    expect(daysBetween('2023/01/08', '2023/01/15')).toBe(7);
  });

  it('returns negative days when b is earlier', () => {
    expect(daysBetween('2023/01/15', '2023/01/08')).toBe(-7);
  });

  it('handles month and year boundaries', () => {
    expect(daysBetween('2023/02/28', '2023/03/01')).toBe(1);
    expect(daysBetween('2022/12/31', '2023/01/01')).toBe(1);
  });

  it('throws on a malformed date', () => {
    expect(() => daysBetween('2023-01-08', '2023/01/15')).toThrow();
  });
});

describe('extractDatedTurns', () => {
  it('extracts the date and keeps the full turn text', () => {
    const turns = extractDatedTurns([
      '[2023/03/04] user: received a chandelier',
      'user: no date',
      '[2023/01/08] user: earlier fact',
    ]);
    expect(turns).toEqual([
      { date: '2023/03/04', text: '[2023/03/04] user: received a chandelier' },
      { date: '2023/01/08', text: '[2023/01/08] user: earlier fact' },
    ]);
  });

  it('drops turns without a date prefix', () => {
    expect(extractDatedTurns(['plain text', 'assistant: reply'])).toEqual([]);
  });

  it('returns an empty list for an empty input', () => {
    expect(extractDatedTurns([])).toEqual([]);
  });
});

describe('buildTemporalEvidence', () => {
  const turns = [
    { date: '2023/03/04', text: '[2023/03/04] user: recent' },
    { date: '2023/01/08', text: '[2023/01/08] user: older' },
    { date: '2023/02/10', text: '[2023/02/10] user: middle' },
  ];

  it('returns turns in chronological order', () => {
    expect(buildTemporalEvidence(turns, 10_000)).toBe(
      '[2023/01/08] user: older\n[2023/02/10] user: middle\n[2023/03/04] user: recent',
    );
  });

  it('drops the oldest turns first when the budget is exceeded', () => {
    const middle = '[2023/02/10] user: middle';
    const recent = '[2023/03/04] user: recent';
    // Each kept turn costs `text.length + 1` (for the newline separator), so a
    // budget sized for exactly the two newest turns drops the oldest.
    const budget = middle.length + 1 + recent.length + 1;
    expect(buildTemporalEvidence(turns, budget)).toBe(
      '[2023/02/10] user: middle\n[2023/03/04] user: recent',
    );
  });

  it('keeps at least one turn even when the budget is tiny', () => {
    expect(buildTemporalEvidence(turns, 1)).toBe('[2023/03/04] user: recent');
  });

  it('returns an empty string for no turns', () => {
    expect(buildTemporalEvidence([], 10_000)).toBe('');
  });

  it('preserves the input order for turns sharing the same date', () => {
    const sameDay = [
      { date: '2023/03/04', text: '[2023/03/04] user: first' },
      { date: '2023/03/04', text: '[2023/03/04] user: second' },
    ];
    expect(buildTemporalEvidence(sameDay, 10_000)).toBe(
      '[2023/03/04] user: first\n[2023/03/04] user: second',
    );
  });
});
