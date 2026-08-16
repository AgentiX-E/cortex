/** cortex-core: value-driven cognitive memory contracts and pure algorithms. */

// interfaces
export type {
  Storage,
  StorageTransaction,
  PutOptions,
  QueryPredicate,
} from './interfaces/storage.js';
export type { VectorIndex, VectorHit, VectorFilter } from './interfaces/vector.js';
export type { LLM, CompleteOptions, JsonSchema } from './interfaces/llm.js';
export type { EmbeddingModel } from './interfaces/embedding.js';

// domain
export type { MemoryValue, MemoryType } from './domain/memory.js';
export { createMemory } from './domain/memory.js';
export type { Fact } from './domain/fact.js';
export { isFactCurrentAt } from './domain/fact.js';
export type { ProvenanceNode } from './domain/provenance.js';

// math
export { dot, norm, normalize, cosineSimilarity, l2Distance } from './math/vector.js';
export {
  kahanSum,
  mean,
  variance,
  stddev,
  welchTTest,
  studentTCdf,
  logGamma,
  binomialCdf,
  wilsonScoreInterval,
  type ConfidenceInterval,
} from './math/stats.js';
export { sinkhorn, squaredEuclideanCostMatrix, type SinkhornResult } from './math/ot.js';
export {
  retrievability,
  review,
  initialFsrsState,
  type FsrsState,
  type ReviewOutcome,
} from './math/fsrs.js';

// vector
export { BruteForceVectorIndex } from './vector/brute-force.js';

// graph
export { MemoryGraph, significanceOf, type MemoryGraphOptions } from './graph/memory-graph.js';

// value
export {
  defaultValueFunction,
  decideWrite,
  decideRetrieval,
  type ValueFunction,
  type WriteDecision,
  type RetrievalDecision,
} from './value/value.js';

// temporal
export { currentFacts, currentValue, findContradictions } from './temporal/bitemporal.js';

// contradiction
export { resolveContradiction, type Resolution } from './contradiction/resolve.js';

// consolidation
export {
  consolidate,
  type ConsolidationStats,
  type AccessRecord,
} from './consolidation/consolidate.js';
