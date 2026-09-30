import { describe, it, expect } from 'vitest';
import { daysBetween } from '../temporal.js';

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
