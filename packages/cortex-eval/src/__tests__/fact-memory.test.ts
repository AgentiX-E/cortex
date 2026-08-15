import { describe, it, expect } from 'vitest';
import { FactMemorySystem, splitKeyValue, tokenize, overlapScore } from '../fact-memory.js';

describe('splitKeyValue', () => {
  it('splits on equals', () => {
    expect(splitKeyValue('color=blue')).toEqual({ key: 'color', value: 'blue' });
  });

  it('splits on colon', () => {
    expect(splitKeyValue('color: blue')).toEqual({ key: 'color', value: 'blue' });
  });

  it('prefers the earliest separator when both are present', () => {
    expect(splitKeyValue('color=blue:red')).toEqual({ key: 'color', value: 'blue:red' });
  });

  it('returns null for malformed input', () => {
    expect(splitKeyValue('no separator here')).toBeNull();
    expect(splitKeyValue('=value')).toBeNull();
    expect(splitKeyValue('key=')).toBeNull();
  });
});

describe('tokenize', () => {
  it('extracts lowercase alphanumeric tokens', () => {
    expect(tokenize('What is the favorite Color?')).toEqual([
      'what',
      'is',
      'the',
      'favorite',
      'color',
    ]);
  });

  it('returns empty for non-alphanumeric input', () => {
    expect(tokenize('!!!')).toEqual([]);
  });
});

describe('overlapScore', () => {
  it('is 1 for identical token sets', () => {
    expect(overlapScore(['a', 'b'], ['a', 'b'])).toBe(1);
  });

  it('is 0 for disjoint token sets', () => {
    expect(overlapScore(['a'], ['b'])).toBe(0);
  });

  it('is 0 when either side is empty', () => {
    expect(overlapScore([], ['a'])).toBe(0);
  });
});

describe('FactMemorySystem', () => {
  it('retrieves the best-matching fact value', async () => {
    const s = new FactMemorySystem('s');
    const answer = await s.answer('What is the favorite color?', ['favorite color=blue']);
    expect(answer).toBe('blue');
  });

  it('abstains when no fact overlaps enough', async () => {
    const s = new FactMemorySystem('s', { abstainThreshold: 0.3 });
    const answer = await s.answer('What is the phone number?', ['favorite color=blue']);
    expect(answer).toBeNull();
  });

  it('falls back when configured and no fact matches', async () => {
    const s = new FactMemorySystem('s', { fallback: 'unknown' });
    const answer = await s.answer('What is the phone number?', ['favorite color=blue']);
    expect(answer).toBe('unknown');
  });

  it('returns null without fallback when no fact matches', async () => {
    const s = new FactMemorySystem('s');
    const answer = await s.answer('What is the phone number?', ['favorite color=blue']);
    expect(answer).toBeNull();
  });
});
