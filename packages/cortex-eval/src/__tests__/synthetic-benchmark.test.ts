import { describe, it, expect } from 'vitest';
import { generateSyntheticBenchmark, mulberry32 } from '../datasets/synthetic-benchmark.js';
import { HashEmbedding } from '../embedding.js';
import { EmbeddingMemorySystem } from '../embedding-memory.js';
import { evaluate } from '../benchmark.js';

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect(a()).toBe(b());
    expect(a()).toBe(b());
  });

  it('returns values in [0, 1)', () => {
    const rand = mulberry32(1);
    for (let i = 0; i < 100; i++) {
      const v = rand();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('generateSyntheticBenchmark', () => {
  it('throws on invalid parameters', () => {
    expect(() => generateSyntheticBenchmark({ numPeople: 0 })).toThrow();
  });

  it('produces IE and ABS questions in deterministic order', () => {
    const ds = generateSyntheticBenchmark({
      numPeople: 4,
      attributesPerPerson: 3,
      abstentionPerPerson: 2,
      seed: 7,
    });
    const ie = ds.questions.filter((q) => q.capability === 'IE');
    const abs = ds.questions.filter((q) => q.capability === 'ABS');
    expect(ie.length).toBe(12); // 4 people × 3 attributes
    expect(abs.length).toBe(8); // 4 people × 2 abstention questions
    for (const q of abs) {
      expect(q.expected).toBeNull();
    }
    for (const q of ie) {
      expect(q.expected).toBeTruthy();
    }
  });

  it('is reproducible for the same seed', () => {
    const a = generateSyntheticBenchmark({ numPeople: 5, seed: 99 });
    const b = generateSyntheticBenchmark({ numPeople: 5, seed: 99 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('supports an abstention ablation with the embedding system', async () => {
    const ds = generateSyntheticBenchmark({
      numPeople: 8,
      attributesPerPerson: 3,
      abstentionPerPerson: 2,
      seed: 3,
    });
    const embedding = new HashEmbedding(256);
    const baseline = new EmbeddingMemorySystem('naive', { embedding, fallback: 'unknown' });
    const feature = new EmbeddingMemorySystem('abstain', { embedding, abstainThreshold: 0.5 });
    const baseMetrics = await evaluate(ds, baseline);
    const featMetrics = await evaluate(ds, feature);
    // The abstaining feature must beat the naive baseline on abstention-aware accuracy.
    expect(featMetrics.abstentionAwareAccuracy).toBeGreaterThan(
      baseMetrics.abstentionAwareAccuracy,
    );
  });
});
