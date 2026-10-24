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
  MIN_STABILITY,
  MAX_REVIEW_BOOST,
  type FsrsState,
  type ReviewOutcome,
} from './math/fsrs.js';

// vector
export { BruteForceVectorIndex } from './vector/brute-force.js';

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
  CardQueue,
  type CardQueueOptions,
  type CardState,
  type KnowledgeCard,
} from './triage/card.js';
export { claimsIn, isClaim, splitSentences } from './triage/claims.js';
export {
  MAX_FACTS,
  MAX_FACT_CHARS,
  PROPOSER_PROMPT_VERSION,
  TriageProposer,
  buildProposerPrompt,
  groundedIn,
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
