import { describe, it, expect } from 'vitest';
import { MemoryGraph, significanceOf } from '../graph/memory-graph.js';

describe('MemoryGraph', () => {
  it('strengthens an edge on repeated co-activation', () => {
    const g = new MemoryGraph();
    g.strengthen('a', 'b');
    const w1 = g.edgeWeight('a', 'b');
    g.strengthen('a', 'b');
    const w2 = g.edgeWeight('a', 'b');
    expect(w2).toBeGreaterThan(w1);
  });

  it('ignores self-loops', () => {
    const g = new MemoryGraph();
    g.strengthen('a', 'a');
    expect(g.edgeCount()).toBe(0);
  });

  it('decay reduces weights and removes near-zero edges', () => {
    const g = new MemoryGraph({ learningRate: 1, decayFactor: 0 });
    g.strengthen('a', 'b');
    expect(g.edgeCount()).toBe(1);
    const removed = g.decay();
    expect(removed).toBe(1);
    expect(g.edgeCount()).toBe(0);
  });

  it('spreading activation reaches neighbors', () => {
    const g = new MemoryGraph();
    g.strengthen('a', 'b');
    g.strengthen('b', 'c');
    const act = g.spreadingActivation(['a'], 3);
    expect(act.get('b')).toBeGreaterThan(0);
    expect(act.get('c')).toBeGreaterThan(0);
  });

  it('significance function is monotonically increasing', () => {
    expect(significanceOf(1)).toBeLessThan(significanceOf(10));
  });
});
