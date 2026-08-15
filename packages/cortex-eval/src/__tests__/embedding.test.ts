import { describe, it, expect } from 'vitest';
import { HashEmbedding, embedOne, tokenize, fnv1a } from '../embedding.js';

describe('tokenize', () => {
  it('extracts lowercase alphanumeric tokens', () => {
    expect(tokenize('Hello, World 123!')).toEqual(['hello', 'world', '123']);
  });

  it('returns empty for non-alphanumeric input', () => {
    expect(tokenize('!!!')).toEqual([]);
  });
});

describe('fnv1a', () => {
  it('is deterministic', () => {
    expect(fnv1a('hello')).toBe(fnv1a('hello'));
  });

  it('differs for different inputs', () => {
    expect(fnv1a('hello')).not.toBe(fnv1a('world'));
  });

  it('returns a 32-bit unsigned integer', () => {
    expect(fnv1a('hello')).toBeGreaterThanOrEqual(0);
    expect(fnv1a('hello')).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('embedOne', () => {
  it('returns a unit vector of the requested dimension', () => {
    const v = embedOne('hello world', 8);
    expect(v).toHaveLength(8);
    const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
    expect(norm).toBeCloseTo(1, 12);
  });

  it('returns the zero vector for empty input', () => {
    const v = embedOne('', 8);
    expect(v.reduce((a, x) => a + x, 0)).toBe(0);
  });
});

describe('HashEmbedding', () => {
  it('exposes its dimension', () => {
    const e = new HashEmbedding(16);
    expect(e.dimension()).toBe(16);
  });

  it('throws on a non-positive dimension', () => {
    expect(() => new HashEmbedding(0)).toThrow();
    expect(() => new HashEmbedding(-1)).toThrow();
  });

  it('embeds multiple texts', async () => {
    const e = new HashEmbedding(8);
    const vecs = await e.embed(['hello', 'world']);
    expect(vecs).toHaveLength(2);
    expect(vecs[0]).toHaveLength(8);
  });
});
