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
export type { EmbeddingIdentity, EmbeddingModel } from './interfaces/embedding.js';

// domain
export type { MemoryValue, MemoryType } from './domain/memory.js';
export { createMemory } from './domain/memory.js';
export type { Fact } from './domain/fact.js';
export { isFactCurrentAt } from './domain/fact.js';
export { leastRetained } from './domain/retention.js';

// math
export { dot, norm, normalize, cosineSimilarity, l2Distance } from './math/vector.js';
// `#25`. `kahanSum` is the one statistic the product itself computes: `norm` reduces a vector with
// it. Everything else that lived beside it -- `mean`, `variance`, `stddev`, `welchTTest`,
// `studentTCdf`, `logGamma`, `binomialCdf`, `wilsonScoreInterval` and `type ConfidenceInterval` from
// this barrel, plus the file-level `degenerateDfPValue` and `clampAwayFromZero` -- moved to
// `@agentix-e/cortex-eval`, where every consumer already was. They were exported here for as long as
// the barrel was treated as "where arithmetic lives", and the cost was a product surface advertising
// a paired t-test the product never ran.
export { kahanSum } from './math/kahan.js';
export { sinkhorn, squaredEuclideanCostMatrix, type SinkhornResult } from './math/ot.js';
export {
  retrievability,
  review,
  initialFsrsState,
  MIN_STABILITY,
  MAX_REVIEW_BOOST,
  type FsrsState,
  type ReviewOutcome,
} from './math/fsrs.js';

// vector
export { BruteForceVectorIndex } from './vector/brute-force.js';
export {
  EmbeddingSpace,
  EmbeddingSpaceError,
  type EmbeddingSpaceOptions,
  type EmbeddingSpaceRefusal,
} from './vector/embedding-space.js';

// cache: a text is embedded once, on both surfaces that can ask
export {
  EmbeddingMemo,
  CachingEmbedding,
  MemoryEmbeddingCacheStore,
  defaultEmbeddingCacheKey,
  type EmbedFn,
  type EmbeddingVector,
  type EmbeddingCacheStats,
  type EmbeddingCacheStore,
  type EmbeddingMemoOptions,
  type CachingEmbeddingOptions,
  type VectorEraser,
} from './cache/embedding-cache.js';

// cache, durable: the same memo over the `Storage` a deployment already has
export {
  StorageEmbeddingCache,
  DEFAULT_EMBEDDING_CACHE_TABLE,
  type StorageEmbeddingCacheOptions,
  type StorageEmbeddingCacheReport,
} from './cache/storage-embedding-cache.js';

// retrieval
export {
  rerankHits,
  fuseRerank,
  type RerankCandidate,
  type RerankPair,
  type RerankScoreFn,
  type FuseRerankOptions,
} from './retrieval/rerank.js';

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

// federation: routing across two stores, and the read-side policy over them
export {
  FederatedStorage,
  FederationError,
  scopeOf,
  type MemoryScope,
  type ScopedRow,
} from './federation/federated-storage.js';
export {
  ReadSideAssembler,
  ScopeViolation,
  type AssembleRequest,
  type ReadSideOptions,
  type TaskScope,
} from './federation/read-side.js';

// triage: the deterministic disclosure layer and the write side of the boundary
export {
  RULE_TABLE,
  RuleTableError,
  assertRuleTable,
  classify,
  destinationOf,
  type TriageDecision,
  type TriageRule,
  type TriageScope,
} from './triage/rules.js';
export {
  TriageError,
  TriageWriter,
  type Admission,
  type AdmittedFact,
  type TriageRecord,
  type TriageWriterOptions,
} from './triage/writer.js';
export { RELEASE_TOKEN, type ReleaseRecord } from './triage/release.js';
export {
  ERASURE_REASONS,
  ERASURE_TOKEN,
  isErased,
  type ErasureReason,
  type ErasureRecord,
  // The contract for a copy of a wording that lives outside the enumerated rows. Exported because the
  // objects that implement it are owned by other packages: `Corpus` here is the transcript surface, and a
  // deployment's own store is a third. A contract no implementer can name is a contract nobody can meet.
  type TextEraser,
} from './triage/erasure.js';
export {
  CardQueue,
  type CardQueueOptions,
  type CardState,
  type KnowledgeCard,
} from './triage/card.js';
export { claimsIn, isClaim, splitSentences } from './triage/claims.js';
export {
  contentGrounded,
  contentGroundedIn,
  distillationOf,
  isVerbatimRun,
  looksTemporal,
  type BorrowedWord,
  type DistillationOf,
  type GroundingInResult,
  type GroundingProblem,
  type GroundingResult,
  type GroundingSource,
} from './triage/grounding.js';
export {
  MAX_FACTS,
  MAX_FACT_CHARS,
  PROPOSER_PROMPT_VERSION,
  TriageProposer,
  buildProposerPrompt,
  type ProposalFailure,
  type ProposalResult,
  type ProposedFact,
  type ProposedRedaction,
  type RedactionKind,
  type TriageProposal,
  type TriageProposerOptions,
  type WithheldFact,
} from './triage/proposer.js';
export {
  DEFAULT_ECHO_WIDTH,
  EchoCorpus,
  hashWindow,
  rollingHashes,
  type EchoCorpusStats,
} from './triage/echo-corpus.js';
export {
  OutputGuard,
  type FindingKind,
  type OutputFinding,
  type OutputScan,
  type OutputScanRequest,
} from './triage/output-guard.js';

// knowledge: typed facts, licensed edges, and the gates that keep a split faithful
export {
  DERIVED_EDGE_TYPES,
  EDGE_TYPES,
  EXTRACTED_EDGE_TYPES,
  FACT_TYPES,
  MODALITIES,
  POLARITIES,
  RELATION_KINDS,
  isEdgeType,
  isFactType,
  isModality,
  isPolarity,
  licenceClassOf,
  licensedEdgeTypes,
  type EdgeType,
  type FactType,
  type Modality,
  type Polarity,
  type RelationKind,
} from './knowledge/taxonomy.js';
export {
  MARKER_TOKENS,
  NOT_MARKERS,
  isMarkerOf,
  kindsIn,
  relationMarkers,
  type RelationMarker,
} from './knowledge/markers.js';
export {
  checkFact,
  covers,
  envelope,
  locate,
  type FactProblem,
  type KnowledgeFact,
  type KnowledgeFrame,
  type Span,
} from './knowledge/frame.js';
export {
  checkEdge,
  deriveSupersedes,
  edgeId,
  extractedSpan,
  type EdgeOrigin,
  type EdgeProblem,
  type KnowledgeEdge,
} from './knowledge/edge.js';
export {
  buildKnowledgeUnit,
  censusOf,
  type BuildUnitInput,
  type KnowledgeUnit,
  type MarkerPolicy,
  type UnitCensus,
  type UnitProblem,
  type UnitResult,
} from './knowledge/unit.js';

export {
  assumptionOf,
  assumptionPenalty,
  deriveAssumptions,
  describeAssumptions,
  isAnswerable,
  slotKey,
  type Assumption,
  type AssumptionKind,
  type AssumptionOrigin,
  type AssumptionStatus,
  type Penalty,
  type PenaltyOptions,
} from './knowledge/assumption.js';
export {
  describePlan,
  inferTemporality,
  isImmutable,
  isPlan,
  modalityOf,
  planFactor,
  reconcilePlans,
  type Certainty,
  type Futurity,
  type PlanState,
  type PlanTransition,
} from './knowledge/temporality.js';
export {
  reviseLedger,
  type Revision,
  type RevisionOptions,
  type RevisionResult,
  type RevisionVerdict,
} from './knowledge/revision.js';

export {
  assemble,
  effectiveAt,
  type AssembleCensus,
  type AssembleInput,
  type AssemblePolicy,
  type AssembleResult,
  type Exclusion,
  type ExclusionReason,
  type Ranked,
  type RetrievalIntent,
  type ServedFact,
} from './context/assemble.js';

// retrieval: fusion, budget, and the block a reader receives
export {
  fillBudget,
  fuseWithScores,
  reciprocalRankFusion,
  type BudgetFill,
  type RankedItem,
} from './retrieval/fuse.js';
export {
  expandTyped,
  renderBlock,
  renderBlocks,
  tokenEstimate,
  type BlockOptions,
  type ExpansionOptions,
  type Reached,
} from './retrieval/typed.js';

// tooling: the export census that `tools/export-census.mjs` drives through dist
export {
  isSourceFile,
  isTestFile,
  isBarrelFile,
  isCallerOnlyFile,
  packageOf,
  extractExportedSymbols,
  countCallers,
  identifierPattern,
  censusPackage,
  buildCensusReport,
  listOrphans,
  listReferencedLocally,
  listUnreferenced,
  isReferencedLocally,
  bodyEndLine,
  type ExportKind,
  type ExportedSymbol,
  type SymbolCensusEntry,
  type PackageCensus,
  type CensusReport,
} from './export-census.js';

// The memory-system protocol: the contract between a memory system and whatever measures it.
// Lives here rather than in the harness because the shipping class implements it and the product may
// not depend on the instrument that measures it -- see `protocol/memory-system.ts`.
export type { Answer, MemorySystem, SessionAwareMemorySystem } from './protocol/memory-system.js';
