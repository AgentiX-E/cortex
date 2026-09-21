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
import {
  CrossEncoderReranker,
  LLMReranker,
  OpenAICompatibleLLM,
  OpenAICompatibleReranker,
  makeDefaultRerankPipelineFactory,
  type CrossEncoderPipeline,
} from '@agentix-e/cortex-llm';
import type { RerankScoreFn } from '@agentix-e/cortex-core';

export type RerankEnv = Record<string, string | undefined>;

/** Cohere's OpenAI-compatible rerank endpoint; the same shape Jina and Voyage expose. */
export const DEFAULT_RERANK_BASE_URL = 'https://api.cohere.com/v2';
export const DEFAULT_RERANK_MODEL = 'rerank-v3.5';

/**
 * Default local cross-encoder. An ms-marco MiniLM cross-encoder is the smallest
 * model that is actually a cross-encoder rather than a re-scored bi-encoder, so it
 * is the cheapest honest offline baseline. Override with `CORTEX_RERANK_MODEL`.
 */
export const DEFAULT_LOCAL_RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';

/** Chat-model defaults for the LLM backend, matching the benchmark's answerer. */
export const DEFAULT_LLM_RERANK_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_LLM_RERANK_MODEL = 'deepseek-chat';

/** Values of `CORTEX_RERANK` that turn the stage on. Anything else is off. */
const ENABLED_VALUES = new Set(['on', 'true', '1', 'yes', 'enabled']);

/** Backends `CORTEX_RERANK_PROVIDER` can select. */
export const RERANK_PROVIDERS = ['openai', 'llm', 'local'] as const;
export type RerankProvider = (typeof RERANK_PROVIDERS)[number];

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
  return buildReranker(env, resolveProvider(env));
}

/**
 * Resolve the backend. Defaults to the OpenAI-compatible client so that an
 * existing configuration (which only ever set `CORTEX_RERANK`) keeps its meaning.
 *
 * An unrecognised value throws rather than falling back. A typo here would run the
 * experiment against a different reranker than the one the operator named and then
 * report the resulting accuracy as a fact about the named one — the exact class of
 * silent substitution this project has already paid for once.
 */
function resolveProvider(env: RerankEnv): RerankProvider {
  const raw = (env['CORTEX_RERANK_PROVIDER'] ?? 'openai').trim().toLowerCase();
  const found = RERANK_PROVIDERS.find((provider) => provider === raw);
  if (found === undefined) {
    throw new Error(
      `Unknown CORTEX_RERANK_PROVIDER "${raw}"; expected one of ${RERANK_PROVIDERS.join(', ')}`,
    );
  }
  return found;
}

function buildReranker(env: RerankEnv, provider: RerankProvider): RerankScoreFn {
  if (provider === 'local') {
    // No credential of any kind is consulted. This is the offline path, and it is
    // the reason the B1 A/B can run where no rerank provider is configured.
    //
    // The pipeline factory resolves lazily and is memoised, so the model is
    // downloaded once on first use rather than per call, and constructing the
    // reranker stays synchronous — a factory that awaited here would turn this
    // function async and force every call site to handle startup failure.
    const model = env['CORTEX_RERANK_MODEL'] ?? DEFAULT_LOCAL_RERANK_MODEL;
    const loadPipeline = makeDefaultRerankPipelineFactory(model);
    let cached: Promise<CrossEncoderPipeline> | undefined;
    const pipeline: CrossEncoderPipeline = (texts, options) => {
      cached ??= loadPipeline().catch((err: unknown) => {
        // Name the peer and the alternative. The underlying failure is a bad error
        // for this purpose: measured on a machine without the package, the message
        // is a `sharp` installation manual, because `sharp` is a transitive
        // dependency of `@xenova/transformers` and its own install is what broke.
        // The string `@xenova/transformers` does not appear in it at all. An
        // operator reading that message would install the wrong thing, and the CI
        // symptom is only a skipped ablation arm whose skip reason they are trying
        // to interpret.
        //
        // Rethrowing rather than swallowing: the stage must keep failing loudly,
        // because the alternative is an arm that silently records the baseline's
        // ordering as the feature's.
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `CORTEX_RERANK_PROVIDER=local requires the optional peer @xenova/transformers, ` +
            `which could not be loaded (model "${model}"). Install it, or set ` +
            `CORTEX_RERANK_PROVIDER=llm to reuse the chat credential. Underlying error: ${detail}`,
          { cause: err },
        );
      });
      return cached.then((resolve) => resolve(texts, options));
    };
    return new CrossEncoderReranker({ pipeline }).score;
  }

  if (provider === 'llm') {
    // Reuses the chat credential the pipeline already has, so reranking does not
    // require a second secret. `RERANK_API_KEY` is deliberately NOT consulted: it
    // would be a key the chat endpoint cannot use, and accepting it would move the
    // failure from startup to the first request.
    const apiKey = env['DEEPSEEK_API_KEY'];
    if (!apiKey) {
      throw new Error(
        'DEEPSEEK_API_KEY is required when CORTEX_RERANK_PROVIDER=llm; the LLM reranker reuses the chat credential, so set it (or switch to CORTEX_RERANK_PROVIDER=local, which needs no credential)',
      );
    }
    const llm = new OpenAICompatibleLLM({
      baseUrl: env['DEEPSEEK_BASE_URL'] ?? DEFAULT_LLM_RERANK_BASE_URL,
      apiKey,
      model: env['DEEPSEEK_MODEL'] ?? DEFAULT_LLM_RERANK_MODEL,
    });
    return new LLMReranker({ llm }).score;
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
