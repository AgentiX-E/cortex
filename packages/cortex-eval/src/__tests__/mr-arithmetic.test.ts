import { describe, expect, it } from 'vitest';
import {
  classifyArithmeticQuestion,
  computeSum,
  formatArithmeticAnswer,
} from '../mr-arithmetic.js';

describe('classifyArithmeticQuestion', () => {
  it('recognizes sum questions with an explicit total/in-total signal', () => {
    expect(classifyArithmeticQuestion('How much total money have I spent?')).toBe('sum');
    expect(classifyArithmeticQuestion('How many hours in total did I spend driving?')).toBe('sum');
    expect(classifyArithmeticQuestion('What is the total cost of A and B?')).toBe('sum');
    expect(classifyArithmeticQuestion('What was the page count of the two novels?')).toBe('sum');
    expect(classifyArithmeticQuestion('What is the combined weight of A and B?')).toBe('sum');
    expect(classifyArithmeticQuestion('What is the sum of A and B?')).toBe('sum');
  });

  it('rejects deduplication count questions', () => {
    expect(classifyArithmeticQuestion('How many different doctors did I visit?')).toBeNull();
    expect(classifyArithmeticQuestion('How many distinct cuisines have I tried?')).toBeNull();
  });

  it('rejects non-arithmetic questions', () => {
    expect(classifyArithmeticQuestion('What is my favorite color?')).toBeNull();
    expect(classifyArithmeticQuestion('Which book did I finish first?')).toBeNull();
  });
});

describe('computeSum', () => {
  it('sums the extracted numbers', () => {
    expect(computeSum([1, 2, 3])).toBe(6);
    expect(computeSum([400, 456])).toBe(856);
    expect(computeSum([0.5, 0.25])).toBe(0.75);
    expect(computeSum([185])).toBe(185);
  });

  it('returns null for an empty list (no numbers extracted)', () => {
    expect(computeSum([])).toBeNull();
  });
});

describe('formatArithmeticAnswer', () => {
  it('renders integers without a decimal part', () => {
    expect(formatArithmeticAnswer(856)).toBe('856');
    expect(formatArithmeticAnswer(0)).toBe('0');
  });

  it('renders decimals with at most two places and no float noise', () => {
    expect(formatArithmeticAnswer(0.75)).toBe('0.75');
    expect(formatArithmeticAnswer(3.3)).toBe('3.3');
    // 0.1 + 0.2 = 0.30000000000000004 in IEEE-754; the formatter must clean it.
    expect(formatArithmeticAnswer(0.1 + 0.2)).toBe('0.3');
  });
});
