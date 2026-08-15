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

  it('finds the shortest path between two nodes', () => {
    const g = new MemoryGraph();
    g.strengthen('a', 'b');
    g.strengthen('b', 'c');
    expect(g.shortestPath('a', 'c')).toEqual(['a', 'b', 'c']);
  });

  it('returns null for disconnected nodes', () => {
    const g = new MemoryGraph();
    g.ensureNode('a');
    g.ensureNode('b');
    expect(g.shortestPath('a', 'b')).toBeNull();
  });

  it('returns a singleton path for a self-path', () => {
    const g = new MemoryGraph();
    g.ensureNode('a');
    expect(g.shortestPath('a', 'a')).toEqual(['a']);
  });

  it('edgeWeight returns 0 for a missing edge', () => {
    const g = new MemoryGraph();
    expect(g.edgeWeight('x', 'y')).toBe(0);
  });

  it('tracks node and edge counts', () => {
    const g = new MemoryGraph();
    g.strengthen('a', 'b');
    g.strengthen('b', 'c');
    expect(g.nodeCount()).toBe(3);
    expect(g.edgeCount()).toBe(2);
  });
});
