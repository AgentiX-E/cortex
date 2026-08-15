import { describe, it, expect } from 'vitest';
import { consolidate } from '../consolidation/consolidate.js';
import { resolveContradiction } from '../contradiction/resolve.js';
import { MemoryGraph } from '../graph/memory-graph.js';
import { sinkhorn } from '../math/ot.js';
import { studentTCdf, logGamma } from '../math/stats.js';
import { currentValue } from '../temporal/bitemporal.js';
import { createMemory } from '../domain/memory.js';
import type { Fact } from '../domain/fact.js';

describe('branch coverage', () => {
  it('consolidate handles undefined coactiveWith', () => {
    const mem = new Map<string, ReturnType<typeof createMemory>>();
    const a = createMemory({ content: 'a' });
    mem.set(a.id, a);
    const g = new MemoryGraph();
    const stats = consolidate(mem, g, [{ memoryId: a.id, outcome: 'success', at: Date.now() }]);
    expect(stats.strengthened).toBe(1);
  });

  it('resolveContradiction breaks ties by most recent validFrom', () => {
    const mk = (over: Partial<Fact>): Fact => ({
      id: 'f',
      subject: 'u',
      predicate: 'p',
      object: 'x',
      validFrom: 0,
      validUntil: Infinity,
      systemFrom: 0,
      systemUntil: Infinity,
      source: 's',
      sourceTrust: 0.5,
      confidence: 0.5,
      ...over,
    });
    const facts = [
      mk({ id: 'older', object: 'x', validFrom: 100 }),
      mk({ id: 'newer', object: 'x', validFrom: 200 }),
      mk({ id: 'worse', object: 'y', confidence: 0.1 }),
    ];
    const r = resolveContradiction(facts);
    expect(r.winner.id).toBe('newer');
  });

  it('resolveContradiction picks the highest score within a group', () => {
    const mk = (over: Partial<Fact>): Fact => ({
      id: 'f',
      subject: 'u',
      predicate: 'p',
      object: 'x',
      validFrom: 0,
      validUntil: Infinity,
      systemFrom: 0,
      systemUntil: Infinity,
      source: 's',
      sourceTrust: 1,
      confidence: 0.5,
      ...over,
    });
    const facts = [
      mk({ id: 'low', object: 'x', confidence: 0.2 }),
      mk({ id: 'high', object: 'x', confidence: 0.9 }),
      mk({ id: 'mid', object: 'x', confidence: 0.5 }),
    ];
    const r = resolveContradiction(facts);
    expect(r.winner.id).toBe('high');
  });

  it('currentValue skips non-current facts', () => {
    const mk = (over: Partial<Fact>): Fact => ({
      id: 'f',
      subject: 'u',
      predicate: 'job',
      object: 'x',
      validFrom: 0,
      validUntil: Infinity,
      systemFrom: 0,
      systemUntil: Infinity,
      source: 's',
      sourceTrust: 1,
      confidence: 0.5,
      ...over,
    });
    const expired = mk({ id: 'old', object: 'engineer', validUntil: 50 });
    const current = mk({ id: 'now', object: 'manager', validFrom: 50 });
    const best = currentValue([expired, current], 'u', 'job', 100);
    expect(best?.id).toBe('now');
  });

  it('sinkhorn updates scaling on an asymmetric problem', () => {
    const res = sinkhorn(
      [0.9, 0.1],
      [0.1, 0.9],
      [
        [0, 1],
        [1, 0],
      ],
      0.5,
      50,
      1e-12,
    );
    expect(res.cost).toBeGreaterThan(0);
  });

  it('shortestPath returns null for a non-existent node', () => {
    const g = new MemoryGraph();
    g.ensureNode('a');
    expect(g.shortestPath('a', 'missing')).toBeNull();
    expect(g.shortestPath('missing', 'a')).toBeNull();
  });

  it('sinkhorn returns non-converged when maxIter is exhausted', () => {
    const res = sinkhorn(
      [0.5, 0.5],
      [0.5, 0.5],
      [
        [0, 1],
        [1, 0],
      ],
      0.01,
      1,
      0,
    );
    expect(res.converged).toBe(false);
  });

  it('logGamma reflection formula handles z < 0.5', () => {
    expect(Number.isFinite(logGamma(0.3))).toBe(true);
    // Γ(z)Γ(1-z) = π/sin(πz)
    const gz = Math.exp(logGamma(0.3));
    const g1z = Math.exp(logGamma(0.7));
    expect(gz * g1z).toBeCloseTo(Math.PI / Math.sin(Math.PI * 0.3), 6);
  });

  it('studentTCdf is a valid CDF at extremes', () => {
    expect(studentTCdf(0, 10)).toBeCloseTo(0.5, 12);
    expect(studentTCdf(Infinity, 10)).toBeCloseTo(1, 12);
    expect(studentTCdf(-Infinity, 10)).toBeCloseTo(0, 12);
    expect(studentTCdf(1, 10)).toBeGreaterThan(0.5);
  });

  it('currentValue replaces the best candidate by confidence', () => {
    const mk = (over: Partial<Fact>): Fact => ({
      id: 'f',
      subject: 'u',
      predicate: 'job',
      object: 'x',
      validFrom: 0,
      validUntil: Infinity,
      systemFrom: 0,
      systemUntil: Infinity,
      source: 's',
      sourceTrust: 1,
      confidence: 0.5,
      ...over,
    });
    const low = mk({ id: 'low', object: 'engineer', confidence: 0.3 });
    const high = mk({ id: 'high', object: 'manager', confidence: 0.9 });
    const best = currentValue([low, high], 'u', 'job', 100);
    expect(best?.id).toBe('high');
  });
});
