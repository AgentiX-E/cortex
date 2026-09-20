/**
 * Reranker factory: resolves the cross-encoder reranking stage (roadmap measure
 * B1) from environment variables, or returns undefined to leave the pipeline
 * untouched.
 *
 * Why a factory rather than a bool plumbed through every option object: the
 * reranking stage must be switchable for the controlled A/B that decides
 * whether it ships. Every retrieval-side change in this project that was not
 * A/B'd against a frozen baseline has had to be reverted (`p3b-graph-verdict`,
 * the RRF v1 integration), so the switch is the deliverable, not a convenience.
 *
 * Default-off is deliberate. With `CORTEX_RERANK` unset, `createRerankerFromEnv`
 * returns undefined and `NaturalLanguageMemory` behaves exactly as before this
 * module existed, which is what makes the ablation arms comparable.
 *
 * Provider-agnostic by construction: the adapter is the OpenAI-compatible
 * `/rerank` client from cortex-llm, whose base URL and model are both
 * configurable, so the same switch serves Cohere, Jina, Voyage, or a
 * self-hosted bge-reranker behind a proxy. No provider is baked in.
 */
import { OpenAICompatibleReranker } from '@agentix-e/cortex-llm';
import type { RerankScoreFn } from '@agentix-e/cortex-core';

export type RerankEnv = Record<string, string | undefined>;

/** Cohere's OpenAI-compatible rerank endpoint; the same shape Jina and Voyage expose. */
export const DEFAULT_RERANK_BASE_URL = 'https://api.cohere.com/v2';
export const DEFAULT_RERANK_MODEL = 'rerank-v3.5';

/** Values of `CORTEX_RERANK` that turn the stage on. Anything else is off. */
const ENABLED_VALUES = new Set(['on', 'true', '1', 'yes', 'enabled']);

/**
 * Build the reranking stage, or return undefined when it is not enabled.
 *
 * Returns the `RerankScoreFn` rather than the adapter instance: the pipeline
 * takes a scoring function, and the adapter's scoring method is bound, so
 * handing over the function is what makes the stage actually injectable
 * (`exactOptionalPropertyTypes` rejects a class instance where a call signature
 * is expected, and pretending otherwise would push the unwrapping onto every
 * call site).
 *
 * Exactly one configuration is an error: enabled without a key. That is thrown
 * rather than downgraded to "reranking off", because a silently disabled
 * experiment produces a number that looks like a negative result and is not one.
 */
export function createRerankerFromEnv(env: RerankEnv): RerankScoreFn | undefined {
  const flag = (env['CORTEX_RERANK'] ?? '').trim().toLowerCase();
  if (!ENABLED_VALUES.has(flag)) {
    return undefined;
  }
  const apiKey = env['RERANK_API_KEY'];
  if (!apiKey) {
    throw new Error(
      'RERANK_API_KEY is required when CORTEX_RERANK is enabled; unset CORTEX_RERANK to run without reranking',
    );
  }
  const baseUrl = env['RERANK_BASE_URL'] ?? DEFAULT_RERANK_BASE_URL;
  const model = env['RERANK_MODEL'] ?? DEFAULT_RERANK_MODEL;
  return new OpenAICompatibleReranker({ baseUrl, apiKey, model }).score;
}
