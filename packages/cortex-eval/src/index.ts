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
  type BenchmarkWorkerPool,
} from './benchmark.js';
// The second grading protocol has no barrel surface yet, and the census is what decided that. It was
// exported whole, `tools/export-census.mjs` reported four new orphans, and the reading of that report is
// the honest one: **a protocol with no dispatch is a module, not a stage**.
//
// The chain that would make it a stage is three links long -- `sourceAwareScorer` needs an audit cache,
// the cache needs a 500-call generation pass, and that pass needs the dataset file the artifact
// deliberately does not carry. Two of the three do not exist. Exporting the four names anyway would let
// the census go green while the protocol still never runs, which is worse than the debt, because the
// debt is visible in `tools/export-census-baseline.json` under
// `source-aware-protocol-awaiting-its-dispatch` and a green check would not be.
//
// What does exist is the half that needs no model: `tools/source-aware-audit.mjs` screens an existing
// artifact for lexical reachability and reports the reader/retrieval split, and
// `docs/PROMPT-ROOM-IS-LOAD-BEARING.md` carries the reading it produced on its first run. The four names
// move here in the commit that gives them a caller.
// The two readings and not the record type: `bench/run-ablation.ts` calls `providerRefusals()` and hands
// the result straight to `describeProviderRefusals`, so nothing outside this package ever names the shape
// -- and an exported type with no caller is the orphan the census reported. It stays exported from
// `benchmark.ts`, which is where the record is built and where the test imports it from.
export { describeProviderRefusals, providerRefusals } from './benchmark.js';
// §13.306's second class, exported for the same reason and with the same shape: the arm at the top
// prints the count, and the count has to come from the module that decided the questions.
export { deadlineLossCeiling, describeTransportLosses, lostToTransport } from './benchmark.js';
export { readWorkers } from './worker-pool.js';
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

// The pairing the campaign kept quoting from averages. `featureCorrectByRun` and
// `baselineCorrectByRun` have been in the artifact since they were added to answer exactly one
// question — whether a spread is one question flapping or several moving once — and `§13.187` is the
// first reading of them. The verdicts separate what an intervention can reach (`durable-miss`) from
// what needs a repeat (`contested`) and from what neither arm wins (`agreed-wrong`, a ceiling rather
// than a gap), which a difference of means cannot do. Exported for the reason the screens are:
// `tools/paired-flip.mjs` is a shell over it. The per-question predicate stays in the module:
// the tool reads verdicts from the summary, and a barrel export the tool never calls is the
// advertisement the export census refuses.
export { summarisePaired } from './paired-flip.js';

// The reading stage of the competition harness. Only the factory is exported: the tool needs a reader, and the
// prompt, the renderer and the refusal phrase are its internals — a second caller reaching for them would be
// building a second reader, which is the thing this module exists to prevent. The tests import the module
// directly, which is why the census reports them as referenced-locally rather than as orphans.
export { createProviderReader } from './competitor-reader.js';

// Is the difference real? A paired test over two runs of the same questions, and the reason
// `ProviderScore.records` exists. Two entry points, one statistic: `compareRuns` pairs one arm across two runs,
// `compareArmsInRun` pairs two arms that answered the same questions in one run — which is the shape a competitor
// comparison has, because one harness invocation gives every arm the same sampled list. `mcnemarExact` and
// `compareRecords` stay unexported: a caller reaching for them directly would be building a second comparison
// rather than using this one. The tests import the module directly, which is why the census reports them as
// referenced-locally.
export { compareArmsInRun, compareRuns } from './paired-test.js';
// §13.244: the pool implementation the arm's CLI uses. Exported because it is the only way to build
// an `AblationPool` that can enumerate its instances, and the enumeration is what keeps a pooled
// run's census denominator equal to its question count.
export {
  runAblation,
  createAblationPool,
  type AblationOptions,
  type AblationPool,
} from './ablation.js';
// §13.237: read a recording back through the scorer. The caller is `bench/regrade-partial.ts`, which
// replays the two complete repetitions `41625442265` left in a partial artifact -- the run that was
// dispatched to test §13.234's predictions and died on its own budget.
export { replaySystem, readCompletedPasses, type CompletedPass } from './replay-system.js';
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
  // §13.228: the pass shape. The type is exported because `AblationReport.passShape` is a public
  // field, and the two functions because a second renderer of the same block would otherwise
  // restate the "None of the three is part of the arm" sentence -- the claim a reader needs in
  // order not to read the width as an arm change.
  passShapeLines,
  passShapeReport,
  type PassShape,
} from './pass-shape.js';
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
export { fingerprintBytes } from './dataset-fingerprint.js';
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
  createJudgeFromEnv,
  createLlmFromEnv,
  // §13.197.4's pair: the base reader plus the map a route-scoped `thinking` value asks for. The
  // arm constructs it; `createLlmFromEnv` refuses such a value rather than silently building the
  // base reader and letting the artifact name a treatment it did not administer.
  createReadersFromEnv,
  readThinkingReach,
  // §13.312: which judge a process will use, and whether a dispatch pinned it. Exported because the
  // artifact records it beside the reader's identity -- the two are the same object of a run and
  // different objects of a comparison, which is the distinction the section exists to make.
  resolveJudgeIdentity,
  resolveReaderIdentity,
  type LlmEnv,
  type ThinkingReach,
} from './llm-factory.js';
export {
  // §13.227's transport variables. Exported because the gate line a run prints is the only place
  // the pace is stated, and `bench/run-ablation.ts` has to read it through the same function the
  // reader factory uses -- a second parser is a second answer to "what pace did this run run at".
  readReaderPacing,
  // §13.236's judge pair. The description is exported rather than typed at the entry point for the
  // reason the numbers above are read through one function: a literal in a `console.log` is a
  // second copy of a constant, and it is the copy nobody checks.
  describeJudgeTransport,
  // §13.306's reader bound. The description is exported for the reason the judge's is: `42381840503`
  // lost a 500-question pass to a deadline that no line of its log stated, and a literal in a
  // `console.log` would be the second copy of it.
  describeReaderTransport,
  type ReaderPacing,
} from './reader-transport.js';
export {
  // §13.212: the provider axis. `readModelSelection` is exported because `rerank-factory` reads the
  // same `DEEPSEEK_MODEL` value for a different purpose and has to strip the provider prefix the
  // same way; `resolveReaderProvider` is the resolution the reader factories share. The provider
  // table itself stays module-private -- `READER_PROVIDERS` and `ReaderProvider` have no caller
  // outside the module, and the census treats an export with no caller as dead weight.
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  readModelSelection,
  resolveReaderProvider,
  type EndpointCheck,
  type ReaderProviderId,
} from './reader-provider.js';
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
  repetitionInstability,
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
  windowCompositionOf,
  type EvidenceBoundOptions,
  type EvidenceReduction,
  type QuestionRecord,
  type WindowComposition,
} from './question-record.js';

// §13.241: the per-question half of a report. `41741547141` regraded two complete repetitions and
// carried five aggregate numbers per repetition, which answered three of §13.234's four predictions
// and could not answer the one stated about a cohort. The projection is here rather than in the bench
// script that needs it because a projection that decides what a paired reading can see is not a
// script's business to own untested.
export { pairedRows, type PairedRow } from './paired-readout.js';

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

// The oracle-evidence condition (§1.38.5). Exported for the same reason the restore plan is:
// `cortex-memory/bench/run-ablation.ts` is the only caller and it cannot reach this package's
// module paths. The four names are the transform, its census type, the dataset suffix the
// artifact check compares against, and the two helpers the entry point prints and asserts with
// -- nothing here is exported so a test can reach it.
export {
  oracleEvidenceDataset,
  describeOracleCensus,
  assertOracleReached,
  type OracleEvidenceCensus,
  type OracleEvidenceDataset,
} from './oracle-evidence.js';

// §13.274's restore counterfactual. The decorator, the plan parser and the dataset restriction are
// exported because the bench entry point in `cortex-memory` is the only caller and it cannot reach
// into this package's module paths; the analysis reads `RestoreCall[]` off the ledger the same way.
// The four functions `bench/run-ablation.ts` calls plus the shape of the ledger it writes. Everything
// else in the module stays module-local -- the parser, the banner, the variable name and the three
// types -- because the census refuses an export with no caller, and an export added so a test can
// reach it is an export the package does not support.
export {
  readRestorePlanFromEnv,
  restoringReader,
  restoreBlock,
  restrictDatasetToPlan,
  type RestoreCall,
} from './restore-plan.js';

// The population selector. `bench/run-ablation.ts` is the only caller and it uses both halves: the
// reader to parse the variable once, the restriction to apply it to the sampled dataset. Exported
// as a pair rather than as one function that reads the environment and restricts in one step,
// because the harness prints a census between them and a combined function would have to return
// the parsed filter as well to keep that line honest.
export { readCapabilityFilter, restrictDatasetToCapability } from './capability-filter.js';

// E6's population. `bench/run-ablation.ts` reads the count, applies the multiplication, and prints
// the marker on the configuration line, so all three are named here -- the marker because the log
// clause that explains `#w2` to a reader of a run is the harness's, not this module's.
export { readWindowCount, withWindows, WINDOW_MARKER } from './two-window.js';

// E6's split, for the same reason and one layer out: the population is cut by corpus so one job can
// answer a part of it, and the two windows of a corpus stay on one instance. Read together with the
// count above -- the harness applies this first and multiplies the slice afterwards.
export { readShardPartition, shardDataset } from './shard.js';

// Which two systems a dispatch puts on its two sides. One reader, one call site: the harness builds
// the pair differently when this says `carry`, and the artifact records which pairing it built.
export { readArmPairing } from './arm-pairing.js';

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
  // `self-index`: the one signal whose ranking the product builds, so the entry point has to ask this
  // module which side of the split a run is on. Exported for the same reason the assertion beside it is --
  // the decision belongs where a test can reach it, and `bench/**` is outside the coverage boundary.
  buildsProductIndex,
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

// The portability classifier landed with one in-package consumer and a public contract: a
// deployment classifies its reader once, then reads one row of the matrix. Everything here is
// exported because the operator-facing surface is exactly this — a probe set, a classifier, a
// matrix, a config lookup and a one-way guard — and a consumer that had to reach into the module
// path would be a consumer this package does not support.
export {
  CAPABILITY_PROBES,
  classifyPortability,
  configFor,
  DegradationGuard,
  PORTABILITY_MATRIX,
  type CapabilityDimension,
  type Classification,
  type ConfigCell,
  type DegradationSignal,
  type Downgrade,
  type EvidenceScope,
  type PortabilityBucket,
  type PortabilityConfig,
  type Probe,
  type ProbeOutcome,
} from './model-portability.js';

// The two axes read together. Every other row on the acceptance matrix prices one axis at a time, and
// the reading the field is decided on — more accuracy for fewer tokens — had no row at all: run
// `42373407439` bought 53.7% of the context for 3.20 accuracy points and the matrix could describe it
// as a win on `C1` and a loss on `S1` with nothing computing the joint verdict. The primitive is
// dominance rather than a weighted sum, because the two axes have resolution that differs by two
// orders of magnitude and a scalar turns the verdict into a function of its weights.
// See `docs/DESIGN-EFFICIENCY-FRONTIER.md`.
export {
  CACHE_HIT_PRICE_RATIO,
  DEFAULT_EFFICIENCY_POLICY,
  compareEfficiency,
  efficiencyFrontier,
  profileOf,
  type EfficiencyComparison,
  type EfficiencyFrontier,
  type EfficiencyPoint,
  type EfficiencyPolicy,
  type EfficiencyProfile,
  type EfficiencyReading,
  type ReadingLabel,
} from './efficiency-frontier.js';

// §13.349: what each capability costs and what each returns, which no artifact answered before —
// the run's tokens are per file and its accuracy is per capability, and the two had never been
// joined. `tools/cost-per-capability.mjs` is the caller; the library owns the arithmetic so the
// apportionment rule is a tested function rather than a paragraph in a document.
export {
  COST_BY_CAPABILITY_POLICY,
  COST_REFUSALS,
  costPerCapability,
  renderCostByCapability,
  type CapabilityCostRow,
  type CostArtifactShape,
  type CostByCapability,
  type TokenPrices,
} from './cost-per-capability.js';

// §13.351: which failures are real and which are one draw's. `featureCorrectByRun` has carried one
// mask per repetition since §13.118.5 and nothing read it per question, so every mechanism arm was
// designed against a single repetition's failure list — on `MR` that is 20 rows where 13 are wrong
// in all four and 13 are wrong in at least one. `conversionCeiling` prices a target set as
// `sum(1 - passRate)` and compares it against the population's own repetition spread, because a
// ceiling below the noise is not a result.
export {
  STABILITY_REFUSALS,
  conversionCeiling,
  renderCeilings,
  renderStability,
  repetitionNull,
  stabilityOf,
  type CeilingReading,
  type NullReading,
  type StabilityArtifactShape,
  type StabilityQuestion,
  type StabilityQuestionShape,
  type StabilityReading,
  type StabilitySelection,
} from './failure-stability.js';
