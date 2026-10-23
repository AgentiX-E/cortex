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
  buildChatBody,
  parseJson,
  sanitizePrompt,
  type OpenAICompatibleLLMOptions,
  type ThinkingMode,
} from './llm/openai-compatible.js';
export { OpenAIEmbedding, type OpenAIEmbeddingOptions } from './embedding/openai.js';
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
