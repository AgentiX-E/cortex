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
});
