import { describe, it, expect } from 'vitest';
import { createMemory } from '../domain/memory.js';
import { MemoryGraph } from '../graph/memory-graph.js';
import { consolidate } from '../consolidation/consolidate.js';

describe('consolidation', () => {
  it('strengthens graph edges among co-activated memories', () => {
    const mem = new Map<string, ReturnType<typeof createMemory>>();
    const a = createMemory({ content: 'a' });
    const b = createMemory({ content: 'b' });
    mem.set(a.id, a);
    mem.set(b.id, b);
    const g = new MemoryGraph();
    const stats = consolidate(mem, g, [
      { memoryId: a.id, outcome: 'success', coactiveWith: [b.id], at: Date.now() },
    ]);
    expect(stats.strengthened).toBe(1);
    expect(g.edgeWeight(a.id, b.id)).toBeGreaterThan(0);
  });

  it('forgets memories whose retrievability falls below threshold', () => {
    const mem = new Map<string, ReturnType<typeof createMemory>>();
    const a = createMemory({ content: 'a', stability: 1, lastAccessedAt: 0 });
    mem.set(a.id, a);
    const g = new MemoryGraph();
    const stats = consolidate(mem, g, [], { forgettingThreshold: 0.9 });
    expect(stats.forgotten).toBe(1);
    expect(mem.has(a.id)).toBe(false);
  });

  it('skips access records for unknown memories', () => {
    const mem = new Map<string, ReturnType<typeof createMemory>>();
    const g = new MemoryGraph();
    const stats = consolidate(mem, g, [
      { memoryId: 'missing', outcome: 'success', coactiveWith: [], at: Date.now() },
    ]);
    expect(stats.strengthened).toBe(0);
  });

  it('skips graph decay when disabled', () => {
    const mem = new Map<string, ReturnType<typeof createMemory>>();
    const a = createMemory({ content: 'a' });
    const b = createMemory({ content: 'b' });
    mem.set(a.id, a);
    mem.set(b.id, b);
    const g = new MemoryGraph({ decayFactor: 0 });
    g.strengthen('a', 'b');
    const stats = consolidate(mem, g, [], { decay: false });
    expect(stats.decayedEdges).toBe(0);
    expect(g.edgeCount()).toBe(1);
  });
});
