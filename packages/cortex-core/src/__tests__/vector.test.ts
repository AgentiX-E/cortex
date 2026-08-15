import { describe, it, expect } from 'vitest';
import { BruteForceVectorIndex } from '../vector/brute-force.js';

describe('BruteForceVectorIndex', () => {
  it('returns nearest neighbour by cosine similarity', async () => {
    const idx = new BruteForceVectorIndex();
    await idx.add('a', new Float64Array([1, 0]));
    await idx.add('b', new Float64Array([0, 1]));
    const hits = await idx.search(new Float64Array([1, 0]), 1);
    expect(hits[0]!.id).toBe('a');
    expect(hits[0]!.score).toBeCloseTo(1, 12);
  });

  it('filters by tags', async () => {
    const idx = new BruteForceVectorIndex();
    await idx.add('a', new Float64Array([1, 0]), { tags: ['x'] });
    await idx.add('b', new Float64Array([1, 0]), { tags: ['y'] });
    const hits = await idx.search(new Float64Array([1, 0]), 10, { tags: ['x'] });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe('a');
  });

  it('removes entries', async () => {
    const idx = new BruteForceVectorIndex();
    await idx.add('a', new Float64Array([1, 0]));
    await idx.remove('a');
    expect(await idx.size()).toBe(0);
  });

  it('excludes entries whose metadata has no matching tags', async () => {
    const idx = new BruteForceVectorIndex();
    await idx.add('a', new Float64Array([1, 0])); // no meta
    await idx.add('b', new Float64Array([1, 0]), { other: 'x' }); // no tags array
    await idx.add('c', new Float64Array([1, 0]), { tags: ['x'] });
    const hits = await idx.search(new Float64Array([1, 0]), 10, { tags: ['x'] });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe('c');
  });
});
