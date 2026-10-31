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
  scorerChannelStats,
  describeScorerChannels,
  type AnswerScorer,
  type ScoredEvaluation,
} from './metrics.js';
export {
  runBenchmark,
  evaluateWithScorerDetailed,
  type BenchmarkProgress,
  type BenchmarkProgressCallback,
} from './benchmark.js';
export { describeFailure } from './bench-failure.js';
export { drawUnjudged, type Draw, type DrawableRow } from './a3-draw.js';
export {
  createLlmJudge,
  buildJudgePrompt,
  parseJudgeResponse,
  clearJudgeCache,
  toJudgeQuestionType,
  type AnswerJudge,
} from './judge.js';

// The judge's own audit. Exported because `tools/judge-audit.mjs` is the only thing that can run it
// (it needs a model and a key), and because the planner is the half that has to be reviewable
// without a key: every case it emits is wrong by construction, and that is asserted rather than
// promised.
// Only the two functions are exported. The types they mention are declared in `judge-audit.ts` and
// used there; a caller that needs one imports it from the module, which is what the tool's JS does not
// do and the tests do. Re-exporting six type names from the package barrel would advertise a surface
// nothing consumes — the exact claim-shape `tools/export-census.mjs` refuses.
export { planAudit, summariseAudit } from './judge-audit.js';

// The audit's reading, applied to every answer instead of to a sample. `nameScreen` is what makes the
// 19.38% usable: it turns a rate into a list of answers whose names are disjoint from the gold's, on an
// artifact that already exists, with no model and no key. Exported for the same reason as the audit —
// `tools/mr-entity-recheck.mjs` is a thin shell and the predicate has to be testable without one.
export { nameScreen } from './mr-entity-recheck.js';

// The same question asked of the channel MR actually has. `§13.185` found 82 of 84 accepted MR golds
// naming nothing, and the golds are `$5,850`, `20%`, `3 days`: the capability is arithmetic, so the
// screen that can see it compares the number the answer states against the number the gold states — and
// that comparison needs no judge at all, which makes it the only reading in this repository that can
// report accuracy for a capability without the instrument under audit.
export { numericScreen } from './numeric-recheck.js';

// The reading stage of the competition harness. Only the factory is exported: the tool needs a reader, and the
// prompt, the renderer and the refusal phrase are its internals — a second caller reaching for them would be
// building a second reader, which is the thing this module exists to prevent. The tests import the module
// directly, which is why the census reports them as referenced-locally rather than as orphans.
export { createProviderReader } from './competitor-reader.js';

// Is the difference real? A paired test over two runs of the same questions, and the reason
// `ProviderScore.records` exists. Only the two-run entry is exported: the tool compares runs, and a caller
// reaching for `mcnemarExact` or `compareRecords` directly would be building a second comparison rather than
// using this one. The tests import the module directly, which is why the census reports them as
// referenced-locally.
export { compareRuns } from './paired-test.js';
export { runAblation, type AblationOptions } from './ablation.js';
// §13.125: what two increments are worth together. `tools/ledger.mjs` is the caller, reading the
// `discordantQuestions` lists out of archived reports.
export { ledgerOf, portfolioOf, type IncrementLedger, type Portfolio } from './ledger.js';

// A3: the arithmetic behind the card-acceptance criterion, so the criterion is computable before
// there is data to compute it from.
export {
  parseReviewPageArgs,
  planReview,
  readReviewCards,
  renderA3ReviewPage,
  resolveOutPath,
  resumeKey,
  type ReviewCard,
  type ReviewCardsFile,
  type ReviewPageArgs,
  type ReviewPageInput,
  type ReviewPair,
  type ReviewPlan,
} from './review-page.js';
export {
  exactMcNemar,
  positionEffect,
  scoreA3,
  type A3Arm,
  type A3ArmSummary,
  type A3Decision,
  type A3Options,
  type A3Pairs,
  type A3Result,
  type A3Trial,
  type A3Verdict,
  type PositionEffect,
} from './a3.js';
export {
  runAblationReport,
  formatAblationReport,
  retryFireLines,
  type AblationReport,
  type AblationReportOptions,
  type FeatureConfig,
  type MemoryArmConfig,
  type RetryFireCounts,
} from './report.js';
export {
  runEmbeddingBenchmark,
  runNaturalLanguageBenchmark,
  runMrAggregationAblation,
  runTemporalEngineAblation,
  runTimeWindowAnnotationAblation,
  runDeterministicCoverageAblation,
  runBitemporalKnowledgeUpdateAblation,
  runAbstentionRetryAblation,
  runQueryExpansionDecompositionAblation,
  runRerankAblation,
  readRerankFallbacks,
  CONJUNCTION_ABS_COHORT,
  CONJUNCTION_ABS_CONTROLS,
  CONJUNCTION_ABS_TARGET,
  formatRetryFireSection,
  type BenchmarkRunnerOptions,
  type RerankFallbackReport,
  type RetryAblationReport,
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
  DIAGNOSED_CAPABILITIES,
  hasDiagnosticRecord,
  flattenSessions,
  sessionsToContext,
  turnText,
  type LongMemEvalTurn,
  type LongMemEvalInstance,
} from './datasets/longmemeval-loader.js';
export { sampleInstances, cohortCoverage, type CohortCoverage } from './datasets/sampling.js';
export {
  computeRetrievalDiagnostics,
  computeSessionRetrievalDiagnostics,
  checkEmbeddingDeterminism,
  flattenTurns,
  percentile,
  type RetrievalDiagnostic,
  type SessionRetrievalDiagnostic,
  type EmbeddingDeterminism,
  transportRetryReport,
  formatIdPreview,
  type TransportRetryReport,
  type TransportRetryScope,
} from './retrieval-diagnostics.js';
export {
  attributeRecallGap,
  rankingGapFailureCount,
  type AttributeRecallGapOptions,
  type CapabilityAccuracy,
  type CurveMembership,
  type CurveSummary,
  type RetrievalGapAttribution,
} from './retrieval-attribution.js';
export {
  decomposeFailures,
  type CapabilityCensus,
  type DiagnosticRecord,
  type FailureCensus,
} from './failure-census.js';
export {
  answerTokens,
  classifyTrFailure,
  GRAMMATICAL_TOKENS,
  type TrFailureClass,
  type TrFailureDetail,
  type TrFailureInput,
} from './tr-failure-class.js';
export {
  adjudicateGroundedFailure,
  distinguishingTokens,
  type CandidateInput,
  type CandidateVerdict,
  type DistinguishingTokens,
} from './candidate-discrimination.js';
export {
  CANDIDATE_ANNOTATION_VERSION,
  CANDIDATE_DISCRIMINATION_INSTRUCTION,
  CANDIDATE_RECORD_SCHEMA_KEY,
  candidateSides,
  candidateSpanCount,
  clusterCandidates,
  contentTerms,
  discriminateContext,
  discriminatingQuestionTerms,
  renderDiscriminatedContext,
  type CandidateCluster,
  type DiscriminatedContext,
  type DiscriminatedContextOptions,
  type TurnLike,
} from './candidate-context.js';
export {
  buildRecallCurve,
  computeRecallCurve,
  classifyExclusion,
  rankOfFirstAnswer,
  DEFAULT_CURVE_CUTOFFS,
  type QuestionRank,
  type RecallCurveOptions,
  type RecallCurvePoint,
  type RecallCurveResult,
  type RecallCurveExclusion,
  type RecallCurveMeasurementOptions,
} from './recall-curve.js';
export {
  ABLATION_SKIP_FILENAME,
  parseMissingCohortMembers,
  buildAblationSkipRecord,
  serializeAblationSkips,
  type AblationSkipRecord,
} from './ablation-skip.js';
export {
  retrieveTopK,
  retrieveTopKSessions,
  retrieveByQueries,
  retrieveSessionsByTurns,
  retrieveTopKByQueries,
  retrieveTopKByQueriesHybrid,
  extractLexicalKeywords,
  countLexicalMatches,
  expandContextWindow,
  meanPool,
  embedManyCached,
  embedOneCached,
  embeddingSourceStats,
  resetEmbeddingSourceStats,
  embeddingBatchIntervalMs,
  setEmbeddingBatchIntervalMs,
  clearEmbeddingCache,
  snapshotEmbeddingCache,
  mergeEmbeddingCache,
  serializeEmbeddingCache,
  deserializeEmbeddingCache,
  hashText,
  reciprocalRankFusion,
  type EmbedManyCachedOptions,
  type EmbeddingSourceStats,
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
  buildTemporalEventLookupPrompt,
  buildTemporalEventExtractionPrompt,
  buildAggregationQaPrompt,
  buildLegacyAggregationQaPrompt,
  buildDerivationQaPrompt,
  classifyAggregationKind,
  buildPreferencePrompt,
  buildKnowledgeUpdatePrompt,
  buildFactExtractionPrompt,
  buildQueryExpansionPrompt,
  buildQueryExpansionPromptWith,
  buildTemporalQueryExpansionPrompt,
  buildMultiSessionQueryExpansionPrompt,
  buildDerivationQueryExpansionPrompt,
  parseQueryExpansion,
  expandLexicalVariants,
  truncateText,
  truncateSession,
  parseQaAnswer,
  parseRecommendationAnswer,
  parseAggregationAnswer,
  isUserTurn,
  isAssistantTurn,
  type NaturalLanguageMemorySystemOptions,
  type AbstainReason,
  type DecisionTrace,
} from './natural-language-memory.js';
export { daysBetween } from './temporal.js';
export {
  classifyTemporalQuestion,
  hasSecondEventReference,
  normalizeDate,
  isValidDate,
  parseRelativeOffset,
  resolveTemporalDate,
  resolveTimeRange,
  TIME_WINDOW_ANNOTATION_HORIZON_DAYS,
  EXTENDED_ENGINE_OPTIONS,
  type TemporalEngineOptions,
  elapsedDays,
  elapsedWeeks,
  elapsedMonths,
  intervalDays,
  orderByDate,
  computeTemporalAnswer,
  type TemporalKind,
  type TemporalEvent,
  type TimeRange,
} from './temporal-engine.js';
// The values only: `TurnStamp` and `TurnClockCensus` are the return and census shapes of the four
// readers below, and every caller in this checkout either infers them or imports them from the
// module. Re-exporting a type nothing names is what `tools/export-census.mjs` reports as an orphan,
// and it is right to: an unused type export is a second public spelling of a shape one module owns.
export { readTurnStamp, readTurnClocks, partitionByWindow, deliveredWindow } from './turn-clock.js';
export {
  timelineFor,
  currentObject,
  previousObject,
  classifyKnowledgeUpdateQualifier,
  type ExtractedFact,
} from './fact-store.js';
export { HashEmbedding, embedOne, tokenize, fnv1a } from './embedding.js';
export {
  createEmbeddingFromEnv,
  createEmbeddingWithProvenanceFromEnv,
  resolveEmbeddingProvenance,
  DEFAULT_HASH_DIMENSION,
  DEFAULT_ZHIPU_BASE_URL,
  DEFAULT_ZHIPU_EMBEDDING_MODEL,
  DEFAULT_ZHIPU_EMBEDDING_DIMENSIONS,
  type EmbeddingEnv,
  type EmbeddingProvenance,
  type EmbeddingWithProvenance,
} from './embedding-factory.js';
export {
  createLlmFromEnv,
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  resolveReaderIdentity,
  type LlmEnv,
} from './llm-factory.js';
export {
  createMemoryArmReranker,
  createRerankerFromEnv,
  DEFAULT_RERANK_BASE_URL,
  DEFAULT_RERANK_MODEL,
  resolveRerankBounds,
  resolveRerankIdentity,
  type RerankBounds,
  type RerankEnv,
  type RerankFactoryOptions,
  type RerankIdentity,
} from './rerank-factory.js';
export { countedRerank, type CountedRerank, type RerankCensus } from './rerank-census.js';
export {
  compareQuestionVectors,
  requiredEffectSize,
  summarizeVariance,
  type CapabilityRequirement,
  type QuestionFlip,
  type QuestionVectorComparison,
  type RequiredEffectSize,
  type RunObservation,
  type VarianceStats,
  type VarianceSummary,
} from './variance.js';
export {
  boundRetrievedContexts,
  buildRecordsFromDataset,
  correctnessVector,
  evidenceReductionOf,
  goldOverlapOf,
  recordIds,
  REDUCED_TURNS_MARKER,
  type EvidenceBoundOptions,
  type EvidenceReduction,
  type QuestionRecord,
} from './question-record.js';

export { preflightEmbedding, type EmbeddingPreflight } from './embedding-preflight.js';
export { serializeReportOrReduce } from './report-write.js';

export {
  buildRetrievalRelevanceIndex,
  DEFAULT_RELEVANCE_TOP_K,
  type RelevanceCase,
  type RelevanceIndex,
  type RelevanceIndexOptions,
  type Retrieval,
} from './relevance-index.js';
export { buildSessionRelevanceIndex, type SessionRelevanceCase } from './session-relevance.js';

export {
  expandMultiSessionQueries,
  type ExpansionTarget,
  type QuestionExpansion,
} from './query-expansion.js';

export { readToggle, type ReadToggleOptions } from './env-toggle.js';

// `withTemperature` stays module-private: `llm-factory` is its only consumer, and an exported
// decorator with one in-package caller is an export the census reports as an orphan. The reader
// is `readTemperature`, which `bench/run.ts` needs so the `default` sentinel does not arrive as
// `NaN` in the reference pipeline (§13.119).
export { readTemperature } from './reader-temperature.js';

export {
  parseCritiqueMode,
  rerankArmOptions,
  type RerankArmOptionsInput,
} from './bench-arm-options.js';

export {
  assertRerankReachesRanking,
  cortexMemoryArmEmbeddingCachePath,
  cortextMemoryArmOptions,
  describeEmbeddingCachePersist,
  evidenceRouteOf,
  persistEmbeddingCache,
  restoreArmEmbeddingCache,
  roleOfTurn,
  runCortexMemoryArm,
  toMemoryArmConfig,
  toRerankRecord,
  type CortexMemoryArmEnv,
  type CortexMemoryArmOptions,
  type CortexMemoryArmResult,
  type CortexMemoryArmRunOptions,
} from './bench-memory-arm.js';

export {
  computeTargetCohort,
  judgeCriterion,
  sidesLandInDistinctClusters,
  verifyTargetCohort,
  type ArmOutcome,
  type CohortQuestion,
  type CohortVerdict,
  type CriterionVerdict,
  type TargetCohort,
  type TargetMember,
} from './b7-cohort.js';

export {
  comparability,
  LexicalProvider,
  toSessions,
  type BuildCost,
  type Comparability,
  type IngestReport,
  type MemoryProvider,
  type MemorySession,
  type MemoryTurn,
  type RunConfig,
  type SearchHit,
  type SearchOptions,
} from './competitor.js';

export {
  measureRetrieval,
  NullProvider,
  sessionsOf,
  type CapabilityScore,
  type HarnessOptions,
  type ProviderScore,
  type RetrievalMode,
} from './harness.js';
