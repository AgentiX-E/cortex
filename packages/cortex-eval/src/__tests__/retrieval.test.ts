import { describe, it, expect } from 'vitest';
import type { EmbeddingModel } from '@agentix-e/cortex-core';
import {
  retrieveTopK,
  expandContextWindow,
  embedManyCached,
  embedOneCached,
  clearEmbeddingCache,
  hashText,
} from '../retrieval.js';

describe('hashText', () => {
  it('is deterministic and stable', () => {
    expect(hashText('hello')).toBe(hashText('hello'));
    expect(hashText('hello')).not.toBe(hashText('world'));
  });
});

describe('embedManyCached', () => {
  it('caches identical texts and returns one vector per input', async () => {
    clearEmbeddingCache();
    let calls = 0;
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => {
        calls += texts.length;
        return texts.map(() => new Float64Array(4));
      },
    };
    const a = await embedManyCached(embedding, ['x', 'y']);
    const b = await embedManyCached(embedding, ['x', 'y']);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    // The second call is served entirely from the cache.
    expect(calls).toBe(2);
  });

  it('falls back to an empty vector when the provider returns fewer vectors', async () => {
    clearEmbeddingCache();
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async () => [],
    };
    const result = await embedManyCached(embedding, ['a', 'b']);
    expect(result).toHaveLength(2);
    expect(result[0]!.length).toBe(0);
    expect(result[1]!.length).toBe(0);
  });
});

describe('embedOneCached', () => {
  it('embeds a single text via the shared cache', async () => {
    clearEmbeddingCache();
    const embedding: EmbeddingModel = {
      dimension: () => 2,
      embed: async (texts) => texts.map(() => new Float64Array([1, 2])),
    };
    const v = await embedOneCached(embedding, 'hello');
    expect(v).toBeInstanceOf(Float64Array);
    expect(v.length).toBe(2);
  });
});

describe('retrieveTopK', () => {
  it('returns top-k hits with text and score', async () => {
    clearEmbeddingCache();
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => texts.map(() => new Float64Array(4)),
    };
    const hits = await retrieveTopK(embedding, 'q', ['turn a', 'turn b'], 2);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.text).toBeDefined();
    expect(hits[0]!.score).toBeGreaterThanOrEqual(0);
  });

  it('returns an empty list for empty context', async () => {
    clearEmbeddingCache();
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => texts.map(() => new Float64Array(4)),
    };
    const hits = await retrieveTopK(embedding, 'q', [], 5);
    expect(hits).toEqual([]);
  });

  it('reports each hit original context index', async () => {
    clearEmbeddingCache();
    const embedding: EmbeddingModel = {
      dimension: () => 4,
      embed: async (texts) => texts.map(() => new Float64Array(4)),
    };
    const hits = await retrieveTopK(embedding, 'q', ['a', 'b', 'c'], 3);
    expect(hits.map((h) => h.index).sort()).toEqual([0, 1, 2]);
  });
});

describe('expandContextWindow', () => {
  it('includes neighbours around each hit and de-duplicates overlaps', () => {
    const context = ['a', 'b', 'c', 'd', 'e', 'f'];
    const expanded = expandContextWindow(context, [1, 4], 1);
    expect(expanded).toBe('a\nb\nc\nd\ne\nf');
  });

  it('clamps the window at the boundaries', () => {
    const context = ['a', 'b', 'c'];
    expect(expandContextWindow(context, [0], 1)).toBe('a\nb');
    expect(expandContextWindow(context, [2], 1)).toBe('b\nc');
  });

  it('skips invalid indices', () => {
    const context = ['a', 'b'];
    expect(expandContextWindow(context, [-1, 5], 1)).toBe('');
  });
});
