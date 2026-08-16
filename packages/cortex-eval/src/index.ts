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
  computeMetricsAsync,
  exactMatchScorer,
  judgeScorer,
  aggregate,
  cohensD,
  tTestPValue,
  type AnswerScorer,
} from './metrics.js';
export { runBenchmark, evaluate, evaluateWithScorer } from './benchmark.js';
export {
  createLlmJudge,
  buildJudgePrompt,
  parseJudgeResponse,
  clearJudgeCache,
  type AnswerJudge,
} from './judge.js';
export { runAblation, type AblationOptions } from './ablation.js';
export {
  runAblationReport,
  formatAblationReport,
  type AblationReport,
  type AblationReportOptions,
} from './report.js';
export {
  runEmbeddingBenchmark,
  runNaturalLanguageBenchmark,
  type BenchmarkRunnerOptions,
} from './runner.js';
export { createLongMemEvalMini } from './datasets/longmemeval-mini.js';
export {
  generateSyntheticBenchmark,
  mulberry32,
  type SyntheticBenchmarkOptions,
} from './datasets/synthetic-benchmark.js';
export {
  loadLongMemEval,
  toCapability,
  flattenSessions,
  type LongMemEvalTurn,
  type LongMemEvalInstance,
} from './datasets/longmemeval-loader.js';
export { sampleInstances } from './datasets/sampling.js';
export {
  computeRetrievalDiagnostics,
  checkEmbeddingDeterminism,
  flattenTurns,
  percentile,
  type RetrievalDiagnostic,
} from './retrieval-diagnostics.js';
export {
  retrieveTopK,
  expandContextWindow,
  embedManyCached,
  embedOneCached,
  clearEmbeddingCache,
  hashText,
  type RetrievalHit,
} from './retrieval.js';
export { FactMemorySystem, type FactMemorySystemOptions } from './fact-memory.js';
export { EmbeddingMemorySystem, type EmbeddingMemorySystemOptions } from './embedding-memory.js';
export {
  NaturalLanguageMemorySystem,
  buildQaPrompt,
  parseQaAnswer,
  type NaturalLanguageMemorySystemOptions,
  type AbstainReason,
  type DecisionTrace,
} from './natural-language-memory.js';
export { HashEmbedding, embedOne, tokenize, fnv1a } from './embedding.js';
export {
  createEmbeddingFromEnv,
  DEFAULT_HASH_DIMENSION,
  DEFAULT_ZHIPU_BASE_URL,
  DEFAULT_ZHIPU_EMBEDDING_MODEL,
  DEFAULT_ZHIPU_EMBEDDING_DIMENSIONS,
  type EmbeddingEnv,
} from './embedding-factory.js';
export {
  createLlmFromEnv,
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  type LlmEnv,
} from './llm-factory.js';
