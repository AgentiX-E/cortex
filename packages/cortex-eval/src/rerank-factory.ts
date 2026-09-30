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
 

 *
 * ## Module-private exports
 *
 * Some declarations below are deliberately not exported. They are used only inside
 * this file, appear in no package barrel, and are referenced by no test or tool —
 * so `export` would advertise a consumer that does not exist. The `export-census`
 * tool reports them as `referenced-locally`, and
 * `packages/cortex-eval/src/__tests__/export-surface.test.ts` pins the set from both
 * sides. Restoring an `export` is a deliberate act: add it when a real caller
 * appears, not in advance of one.
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
const DEFAULT_LOCAL_RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';

/** Chat-model defaults for the LLM backend, matching the benchmark's answerer. */
const DEFAULT_LLM_RERANK_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_LLM_RERANK_MODEL = 'deepseek-chat';

/** Values of `CORTEX_RERANK` that turn the stage on. */
const ENABLED_VALUES = new Set(['on', 'true', '1', 'yes', 'enabled']);

/** Values of `CORTEX_RERANK` that turn the stage off, explicitly. */
const DISABLED_VALUES = new Set(['', 'off', '0', 'false', 'no', 'disabled']);

/** Backends `CORTEX_RERANK_PROVIDER` can select. */
const RERANK_PROVIDERS = ['openai', 'llm', 'local'] as const;
type RerankProvider = (typeof RERANK_PROVIDERS)[number];

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
 * ## Two configurations are errors, and neither is downgraded to "off"
 *
 * 1. **Enabled without a key.** A silently disabled experiment produces a number
 *    that looks like a negative result and is not one.
 * 2. **A provider name where the enable flag belongs.** This is the mistake the
 *    two adjacent variables invite: `CORTEX_RERANK` decides *whether* the stage
 *    exists, `CORTEX_RERANK_PROVIDER` decides *which backend* it uses, and
 *    `local` is a documented spelling of the second. Reading it as "off" was the
 *    old behaviour, and the cost was an offline run that looked like a completed
 *    one: the reranking ablation is guarded on this function returning a
 *    reranker, so the arm was skipped and the job still reported success. The
 *    only artifact that carried `featureConfig` was written inside that arm, so
 *    the run also lost the record of its own configuration.
 *
 * An unrecognised value is an error rather than an off, for the same reason
 * `resolveProvider` throws on an unknown provider: a typo must not become a
 * measurement of something other than what the operator named. `off` is spelled
 * out in `DISABLED_VALUES` precisely so that "this value was a deliberate
 * refusal" and "this value was not understood" stop being the same outcome.
 */
export function createRerankerFromEnv(env: RerankEnv): RerankScoreFn | undefined {
  const raw = env['CORTEX_RERANK'];
  const flag = (raw ?? '').trim().toLowerCase();

  if (DISABLED_VALUES.has(flag)) {
    return undefined;
  }

  const providerInFlag = RERANK_PROVIDERS.find((provider) => provider === flag);
  if (providerInFlag !== undefined) {
    throw new Error(
      `CORTEX_RERANK="${raw}" is a backend name, not an enable flag. ` +
        `Set CORTEX_RERANK=on to enable the stage and ` +
        `CORTEX_RERANK_PROVIDER=${providerInFlag} to select that backend; ` +
        `leave CORTEX_RERANK unset (or "off") to run without reranking.`,
    );
  }

  if (!ENABLED_VALUES.has(flag)) {
    throw new Error(
      `Unknown CORTEX_RERANK value "${raw}"; expected one of ` +
        `${[...ENABLED_VALUES].join(', ')} to enable, or ` +
        `${[...DISABLED_VALUES].filter(Boolean).join(', ')} to disable.`,
    );
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

/**
 * A `RerankScoreFn` that also carries live fallback counters.
 *
 * The counters are defined as getters that read through to `adapter` on every
 * access rather than being copied once. A copy would pass a construction-time
 * assertion and then keep reporting `0/0` after any number of failures — the same
 * silent-unknown outcome the counters exist to prevent, just harder to notice.
 */
function withFallbackCounters(
  score: RerankScoreFn,
  adapter: { readonly fallbackCount: number; readonly bucketCount: number },
): RerankScoreFn {
  return Object.defineProperties(score, {
    fallbackCount: { get: () => adapter.fallbackCount, enumerable: true },
    bucketCount: { get: () => adapter.bucketCount, enumerable: true },
  });
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
    const reranker = new LLMReranker({ llm });
    return withFallbackCounters(reranker.score, reranker);
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
