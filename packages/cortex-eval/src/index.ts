/** cortex-eval: scientific evaluation harness for agent memory systems. */
export type {
  Capability,
  Question,
  BenchmarkDataset,
  Answer,
  MemorySystem,
  SessionAwareMemorySystem,
  PerCapabilityResult,
  Metrics,
  AggregateStats,
  AblationResult,
  PerCapabilityPairedStats,
} from './types.js';
export {
  normalizeAnswer,
  exactMatch,
  computeMetrics,
  computeMetricsAsync,
  scoreEvaluation,
  mcnemarPValue,
  exactMatchScorer,
  judgeScorer,
  extractLeadingNumber,
  isCountingQuestion,
  numericAnswerVerdict,
  aggregate,
  cohensD,
  tTestPValue,
  type AnswerScorer,
  type ScoredEvaluation,
} from './metrics.js';
export {
  runBenchmark,
  evaluate,
  evaluateWithScorer,
  evaluateWithScorerDetailed,
} from './benchmark.js';
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
  runMrAggregationAblation,
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
  sessionsToContext,
  turnText,
  type LongMemEvalTurn,
  type LongMemEvalInstance,
} from './datasets/longmemeval-loader.js';
export { sampleInstances } from './datasets/sampling.js';
export {
  computeRetrievalDiagnostics,
  computeSessionRetrievalDiagnostics,
  checkEmbeddingDeterminism,
  flattenTurns,
  percentile,
  type RetrievalDiagnostic,
  type SessionRetrievalDiagnostic,
} from './retrieval-diagnostics.js';
export {
  retrieveTopK,
  retrieveTopKSessions,
  retrieveByQueries,
  retrieveTopKByQueries,
  expandContextWindow,
  meanPool,
  embedManyCached,
  embedOneCached,
  clearEmbeddingCache,
  hashText,
  type RetrievalHit,
  type SessionHit,
} from './retrieval.js';
export { FactMemorySystem, type FactMemorySystemOptions } from './fact-memory.js';
export { EmbeddingMemorySystem, type EmbeddingMemorySystemOptions } from './embedding-memory.js';
export {
  NaturalLanguageMemorySystem,
  buildQaPrompt,
  buildConservativeQaPrompt,
  buildTemporalQaPrompt,
  buildAggregationQaPrompt,
  buildLegacyAggregationQaPrompt,
  buildQueryExpansionPrompt,
  buildTemporalQueryExpansionPrompt,
  parseQueryExpansion,
  truncateText,
  truncateSession,
  parseQaAnswer,
  parseAggregationAnswer,
  isUserTurn,
  type NaturalLanguageMemorySystemOptions,
  type AbstainReason,
  type DecisionTrace,
} from './natural-language-memory.js';
export { isTemporalQuestion, extractDate, daysBetween } from './temporal.js';
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
