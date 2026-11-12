/**
 * cortex-ai: the remote providers, and the contracts they implement.
 *
 * ## What is deliberately not here
 *
 * Nothing in this file's import closure may reach `@huggingface/transformers`. A Node service that
 * talks to an HTTP provider should not carry an ONNX runtime and 90 MB of weights in its image, and
 * the only reliable way to guarantee that is to make the local path a separate entry: `./local`.
 * `tools/entry-guard.mjs` enforces it, with `./local` as the positive control.
 *
 * The same reasoning applies to `./web`, which reaches the browser's built-in model and nothing
 * else. Three entries, three dependency profiles:
 *
 * | entry | needs | typical caller |
 * |---|---|---|
 * | `.` | `fetch` | server-side pipeline, edge function |
 * | `./local` | `@huggingface/transformers` (optional peer) | offline Node, browser with weights |
 * | `./web` | `globalThis.LanguageModel` | browser with a built-in model |
 */
export {
  DEFAULT_LOCAL_MODEL,
  DEFAULT_WEIGHT_HOST,
  PROFILE_ENV,
  ProfileError,
  describeProfile,
  readApiKey,
  resolveLlmProfile,
  type LlmProfile,
  type LocalProfile,
  type ProfileEnv,
  type ProfileRequest,
  type RemoteProfile,
} from './profile.js';
export {
  OpenAICompatibleLLM,
  /**
   * Exported because a benchmark has to decide a question the provider will not read.
   *
   * The consumer is `cortex-eval`'s worker: it catches exactly this class and records the question
   * as refused, and it must catch this class rather than a message because a substring guard over a
   * reworded message is the failure mode `bench-failure.ts` documents.
   */
  ProviderContentRefusal,
  buildChatBody,
  parseJson,
  sanitizePrompt,
  type OpenAICompatibleLLMOptions,
  type ThinkingMode,
} from './llm/openai-compatible.js';
/**
 * What the provider said each call cost.
 *
 * Three readings and one attribution door. The aggregate class, the parser and the recording entry
 * stay internal -- the adapter is their only writer, and exporting a "record your own usage" call
 * would let a caller double-count a call the adapter has already recorded. What a consumer outside
 * this package needs is the reading (`llmUsage`), the arithmetic that turns two readings into one
 * run's spend (`usageDelta`), the shape both return, and -- since `42054107910` measured the delta
 * method overcounting by 3.43x under a concurrent pool -- the two names that make a per-side split
 * exact: `createUsageTally` builds a ledger and `observeUsage` is the hook the instrument installs to
 * say which calls belong to it. The hook exists rather than the scope because `AsyncLocalStorage` is a
 * Node builtin and this entry is portable (`tools/entry-guard.mjs`).
 */
export {
  createUsageTally,
  llmUsage,
  observeUsage,
  usageDelta,
  type UsageSnapshot,
  type UsageTally,
} from './usage.js';
export { OpenAIEmbedding, type OpenAIEmbeddingOptions } from './embedding/openai.js';
/**
 * The embedder cache is exported because it is a **wrapping** decision, and a wrapper a caller cannot name is a
 * wrapper a caller cannot put in a report. `EmbeddingCacheStore` is the extension point: the default store lives
 * as long as the process, and a deployment that wants reuse across restarts injects its own three-method
 * implementation without this package knowing where the vectors go.
 */
export {
  CachingEmbedding,
  MemoryEmbeddingCacheStore,
  defaultEmbeddingCacheKey,
  type CachingEmbeddingOptions,
  type EmbeddingCacheStats,
  type EmbeddingCacheStore,
} from './embedding/cache.js';
export {
  OpenAICompatibleReranker,
  CrossEncoderReranker,
  buildRerankBody,
  parseRerankResponse,
  type OpenAICompatibleRerankerOptions,
  type CrossEncoderRerankerOptions,
  type CrossEncoderPipeline,
} from './rerank/rerank.js';
export {
  LLMReranker,
  buildListwiseRerankPrompt,
  parseListwiseScores,
  type LLMRerankerOptions,
} from './rerank/llm-reranker.js';
export {
  retryableFetch,
  retryableFetchWithStats,
  isRetryableStatus,
  parseRetryAfterMs,
  sleep,
  RetryStatsAggregate,
  createRetryStatsAggregate,
  retryStats,
  resetRetryStats,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_TIMEOUT_MS,
  DEFAULT_RETRY_BUDGET_MS,
  type RetryOptions,
  type RetryStats,
  type RetryOutcome,
  type RetryStatsSnapshot,
  type RetryExhaustion,
} from './retry.js';
/**
 * Pacing, exported because the schedule is a property of the DEPLOYMENT rather than of this
 * package: a service embedding these adapters may have to share one gate between its reader, its
 * embedder and its reranker, and it cannot share an object it cannot name. `sharedRequestGate` is
 * also the only way for a second adapter instance to join the schedule the first one created.
 */
export { sharedRequestGate, type RequestPacer } from './pacing.js';
