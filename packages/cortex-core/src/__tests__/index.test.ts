import { describe, it, expect } from 'vitest';
import * as cortexCore from '../index.js';

describe('cortex-core package exports', () => {
  it('exposes the full public API surface', () => {
    // domain
    expect(typeof cortexCore.createMemory).toBe('function');
    expect(typeof cortexCore.isFactCurrentAt).toBe('function');
    // math
    expect(typeof cortexCore.cosineSimilarity).toBe('function');
    expect(typeof cortexCore.welchTTest).toBe('function');
    expect(typeof cortexCore.sinkhorn).toBe('function');
    expect(typeof cortexCore.retrievability).toBe('function');
    // graph
    expect(typeof cortexCore.MemoryGraph).toBe('function');
    // value
    expect(typeof cortexCore.decideWrite).toBe('function');
    expect(typeof cortexCore.decideRetrieval).toBe('function');
    // temporal + contradiction
    expect(typeof cortexCore.currentValue).toBe('function');
    expect(typeof cortexCore.resolveContradiction).toBe('function');
    // consolidation
    expect(typeof cortexCore.consolidate).toBe('function');
    // vector
    expect(typeof cortexCore.BruteForceVectorIndex).toBe('function');
  });
});
