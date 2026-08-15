/** cortex-eval: scientific evaluation harness for agent memory systems. */
export type {
  Capability,
  Question,
  BenchmarkDataset,
  Answer,
  MemorySystem,
  PerCapabilityResult,
  Metrics,
  AggregateStats,
  AblationResult,
} from './types.js';
export {
  normalizeAnswer,
  exactMatch,
  computeMetrics,
  aggregate,
  cohensD,
  tTestPValue,
} from './metrics.js';
export { runBenchmark, evaluate } from './benchmark.js';
export { runAblation, type AblationOptions } from './ablation.js';
export { createLongMemEvalMini } from './datasets/longmemeval-mini.js';
export {
  loadLongMemEval,
  toCapability,
  flattenSessions,
  type LongMemEvalTurn,
  type LongMemEvalInstance,
} from './datasets/longmemeval-loader.js';
export { FactMemorySystem, type FactMemorySystemOptions } from './fact-memory.js';
export { EmbeddingMemorySystem, type EmbeddingMemorySystemOptions } from './embedding-memory.js';
export { HashEmbedding, embedOne, tokenize, fnv1a } from './embedding.js';
