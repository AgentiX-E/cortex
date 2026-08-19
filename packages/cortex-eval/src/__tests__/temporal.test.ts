import { describe, it, expect } from 'vitest';
import { isTemporalQuestion, extractDate, daysBetween } from '../temporal.js';

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
