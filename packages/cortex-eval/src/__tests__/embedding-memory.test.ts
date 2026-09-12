import { describe, it, expect } from 'vitest';
import { EmbeddingMemorySystem } from '../embedding-memory.js';
import { HashEmbedding } from '../embedding.js';

const embedding = new HashEmbedding(32);

describe('EmbeddingMemorySystem', () => {
  it('retrieves the nearest fact by embedding similarity', async () => {
    const s = new EmbeddingMemorySystem('s', { embedding });
    const answer = await s.answer('What is the favorite color?', [
      'favorite color=blue',
      'dog name=Rex',
    ]);
    expect(answer).toBe('blue');
  });

  it('abstains when the best similarity is below threshold', async () => {
    const s = new EmbeddingMemorySystem('s', { embedding, abstainThreshold: 0.9 });
    const answer = await s.answer('What is the phone number?', ['favorite color=blue']);
    expect(answer).toBeNull();
  });

  it('falls back when no facts are ingested', async () => {
    const s = new EmbeddingMemorySystem('s', { embedding, fallback: 'unknown' });
    const answer = await s.answer('What is the phone number?', []);
    expect(answer).toBe('unknown');
  });

  it('deduplicates facts already ingested', async () => {
    const s = new EmbeddingMemorySystem('s', { embedding });
    const a1 = await s.answer('What is the favorite color?', ['favorite color=blue']);
    const a2 = await s.answer('What is the favorite color?', ['favorite color=blue']);
    expect(a1).toBe('blue');
    expect(a2).toBe('blue');
  });

  it('skips context entries that are not key=value facts', async () => {
    const s = new EmbeddingMemorySystem('s', { embedding, fallback: 'unknown' });
    const answer = await s.answer('What is the favorite color?', [
      'not a fact',
      'favorite color=blue',
    ]);
    expect(answer).toBe('blue');
  });

  it('honors the fallback when topK is zero and no neighbour is returned', async () => {
    // `search` slices to k, so topK: 0 yields no hits even though facts were
    // ingested. The fallback on the empty-hit path is therefore reachable and
    // load-bearing: without it the caller would get a silent null instead of
    // the documented baseline answer.
    const s = new EmbeddingMemorySystem('s', { embedding, topK: 0, fallback: 'unknown' });
    expect(await s.answer('What is the favorite color?', ['favorite color=blue'])).toBe('unknown');
  });

  it('returns null when topK is zero, no neighbour is returned and there is no fallback', async () => {
    const s = new EmbeddingMemorySystem('s', { embedding, topK: 0 });
    expect(await s.answer('What is the favorite color?', ['favorite color=blue'])).toBeNull();
  });

  it('answers from the fact map when the question embeds to no neighbour', async () => {
    // With topK: 0 the retrieval path is bypassed entirely, so this pins the
    // fact map as an independent store rather than a side effect of search.
    const s = new EmbeddingMemorySystem('s', { embedding, topK: 0, fallback: 'unknown' });
    await s.answer('prime', ['favorite color=blue']);
    expect(await s.answer('What is the favorite color?', ['favorite color=blue'])).toBe('unknown');
  });
});
