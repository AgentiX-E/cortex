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
 * `/rerank` client from cortex-ai, whose base URL and model are both
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
  type CrossEncoderPipeline,
} from '@agentix-e/cortex-ai';
// The loader comes from the `./local` entry, which is the only one that reaches transformers.js.
// Keeping it out of the root import is what lets a deployment that never reranks locally drop the
// dependency entirely -- and `tools/entry-guard.mjs` fails the build if the root ever pulls it back
// in through a transitive import.
import { makeRerankPipelineFactory as makeDefaultRerankPipelineFactory } from '@agentix-e/cortex-ai/local';
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
/**
 * Default peer loader, re-exported so a caller can pass it explicitly.
 *
 * `cortex-eval`'s rerank arm wires the local provider through here. Having the
 * default reachable by name is what keeps `RerankFactoryOptions.pipelineFactory`
 * a *choice* rather than a test-only back door: the shipped entry point and the
 * injectable one resolve to the same function, so the seam cannot change
 * production behaviour without name-dropping it.
 */
export { makeDefaultRerankPipelineFactory };

/**
 * Options for {@link createRerankerFromEnv}.
 *
 * One field, and it exists for a reason established by a CI failure rather than by
 * taste. The non-`Error` arm of the local provider's loader —
 * `err instanceof Error ? err.message : String(err)` — has no deterministic trigger
 * when the optional peer is absent, which is the state a clean install is in:
 *
 *   - `@huggingface/transformers` is an *optional* dependency of `cortex-ai`. A clean
 *     `pnpm install --frozen-lockfile` does not install it; a developer's
 *     `node_modules` often has it.
 *   - Reaching the arm with `vi.mock('@huggingface/transformers', ...)` therefore makes
 *     the test's outcome depend on which packages the machine happens to have: the
 *     mock only intercepts a specifier that **resolves**, so with the peer absent it
 *     silently does not apply, the real `import` runs, `sharp` fails, and that
 *     failure is an `Error` — the other arm.
 *
 * That is the same shape as the fixtures this repository has already recorded as
 * measuring their environment, and the remedy is the same: remove the dependence
 * rather than widen the assertion. Injecting the loader lets the caller construct
 * the failure, so the same code path runs whether or not the peer is installed.
 */
export type RerankFactoryOptions = {
  /**
   * Builds the peer-backed pipeline for a model name. Defaults to the real
   * transformers.js loader.
   *
   * Overridable for the same reason `fetchFn` is overridable on the
   * OpenAI-compatible reranker: a failure mode that only the network or an
   * optional dependency can produce is otherwise untestable off the machine that
   * has it.
   */
  pipelineFactory?: (model: string) => () => Promise<CrossEncoderPipeline>;
};

/**
 * Which variables a caller's switch reads.
 *
 * ## Why the arm needs its own switch and not a boolean
 *
 * `run-ablation.ts` constructs **both** sides of the A/B in one process: the memory arm (the
 * treatment) and `cortex-eval`'s reference pipeline (the paired control). If the arm read
 * `CORTEX_RERANK` — the variable `bench-arm-options.ts` already wires into the reference pipeline —
 * then one dispatch would turn reranking on for the control as well, and the arm's delta would
 * compare a reranked system with a reranked system while its artifact claimed a single variable.
 * That is the conflation `PREREGISTRATION` §13.110 charged a whole run for on the reader axis.
 *
 * So the *switch* is arm-specific. The provider variable and the credential stay shared, because
 * only one of the two systems can carry the stage at a time: `run-ablation.ts` never hands a
 * reranker to the reference pipeline, and a second credential variable would be a second secret for
 * one endpoint.
 */
type RerankVariableSet = {
  readonly enable: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly model: string;
  /** Credential for the `/rerank` endpoint. */
  readonly apiKey: string;
  /** Credential the `llm` backend reuses, because it calls the chat endpoint. */
  readonly llmApiKey: string;
};

/** The reference pipeline's set, unchanged since the B1 ablation first ran. */
const REFERENCE_VARIABLES: RerankVariableSet = {
  enable: 'CORTEX_RERANK',
  provider: 'CORTEX_RERANK_PROVIDER',
  baseUrl: 'RERANK_BASE_URL',
  model: 'RERANK_MODEL',
  apiKey: 'RERANK_API_KEY',
  llmApiKey: 'DEEPSEEK_API_KEY',
};

/**
 * The memory arm's set. Only the two switches differ; see {@link RerankVariableSet}.
 *
 * `CORTEX_MEMORY_RERANK` follows the arm's own `CORTEX_MEMORY_*` convention, which is what makes a
 * dispatch's input list readable as a description of one system.
 */
const MEMORY_ARM_VARIABLES: RerankVariableSet = {
  ...REFERENCE_VARIABLES,
  enable: 'CORTEX_MEMORY_RERANK',
  provider: 'CORTEX_MEMORY_RERANK_PROVIDER',
  model: 'CORTEX_MEMORY_RERANK_MODEL',
  baseUrl: 'CORTEX_MEMORY_RERANK_BASE_URL',
};

/**
 * What the artifact records about the stage, resolved without touching a credential.
 *
 * ## Why the identity is a separate function from the constructor
 *
 * The reader axis paid for this lesson (§13.110/§13.114): if the identity can only be produced by a
 * process that could also score, then a report rendered from a replayed artifact cannot state what
 * scored it. Identity is not a permission — it is a fact about which environment variables were
 * read — so it resolves with no key, no network and no peer.
 *
 * ## Why `model` and `host` are `null` rather than absent
 *
 * `provider: 'none'` is a run that dispatched the control, and it has no model or host to name.
 * `null` says "there is none", and the type does not permit a `'none'` identity to carry a model.
 */
export type RerankIdentity =
  | { readonly provider: 'none' }
  | {
      readonly provider: 'openai-compatible' | 'llm' | 'local';
      /** The model id the scorer was built with, or the documented default. */
      readonly model: string;
      /** The service host, or `null` for the local cross-encoder, which talks to no service. */
      readonly host: string | null;
    };

/** A resolved choice: either the control, or a backend with every value the client needs. */
type RerankChoice =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly backend: RerankProvider;
      readonly model: string;
      readonly baseUrl: string;
    };

/**
 * Read and validate the switch, in one place, for both public functions.
 *
 * This is the structural guarantee behind the identity: {@link resolveRerankIdentity} and
 * {@link createMemoryArmReranker} cannot disagree about the model, the base URL or the provider,
 * because neither of them reads an environment variable — they both read this.
 */
function readChoice(env: RerankEnv, variables: RerankVariableSet): RerankChoice {
  const raw = env[variables.enable];
  const flag = (raw ?? '').trim().toLowerCase();

  if (DISABLED_VALUES.has(flag)) {
    return { enabled: false };
  }

  const providerInFlag = RERANK_PROVIDERS.find((provider) => provider === flag);
  if (providerInFlag !== undefined) {
    throw new Error(
      `${variables.enable}="${raw}" is a backend name, not an enable flag. ` +
        `Set ${variables.enable}=on to enable the stage and ` +
        `${variables.provider}=${providerInFlag} to select that backend; ` +
        `leave ${variables.enable} unset (or "off") to run without reranking.`,
    );
  }

  if (!ENABLED_VALUES.has(flag)) {
    throw new Error(
      `Unknown ${variables.enable} value "${raw}"; expected one of ` +
        `${[...ENABLED_VALUES].join(', ')} to enable, or ` +
        `${[...DISABLED_VALUES].filter(Boolean).join(', ')} to disable.`,
    );
  }

  const backend = resolveProvider(env, variables);
  // Model and base URL are resolved here rather than inside the constructor, so that the value the
  // artifact names and the value the request carries are one reading of one variable.
  if (backend === 'local') {
    return {
      enabled: true,
      backend,
      model: env[variables.model] ?? DEFAULT_LOCAL_RERANK_MODEL,
      baseUrl: '',
    };
  }
  if (backend === 'llm') {
    return {
      enabled: true,
      backend,
      model: env['DEEPSEEK_MODEL'] ?? DEFAULT_LLM_RERANK_MODEL,
      baseUrl: env['DEEPSEEK_BASE_URL'] ?? DEFAULT_LLM_RERANK_BASE_URL,
    };
  }
  return {
    enabled: true,
    backend,
    model: env[variables.model] ?? DEFAULT_RERANK_MODEL,
    baseUrl: env[variables.baseUrl] ?? DEFAULT_RERANK_BASE_URL,
  };
}

/**
 * The identity of the reranking stage this environment configures.
 *
 * Never touches a credential and never constructs a client. Throws on a value the factory would
 * also refuse, so a dispatch that mistypes the switch fails in the same place whether the caller
 * asked for the stage or only for its name.
 */
export function resolveRerankIdentity(
  env: RerankEnv,
  options: { readonly arm?: boolean } = {},
): RerankIdentity {
  const choice = readChoice(env, options.arm === true ? MEMORY_ARM_VARIABLES : REFERENCE_VARIABLES);
  if (!choice.enabled) {
    return { provider: 'none' };
  }
  if (choice.backend === 'local') {
    return { provider: 'local', model: choice.model, host: null };
  }
  let host: string | null = null;
  try {
    host = new URL(choice.baseUrl).host;
  } catch {
    // A malformed base URL is the constructor's to refuse, with the message the operator needs. An
    // identity is still worth stating — the provider and the model are known — so this records the
    // host as unknown rather than throwing here and destroying the artifact over a description.
    host = null;
  }
  return {
    provider: choice.backend === 'llm' ? 'llm' : 'openai-compatible',
    model: choice.model,
    host,
  };
}

/**
 * The scorer's wire limits, when the deployment declares them.
 *
 * ## Why these are configuration and not constants
 *
 * They are properties of an **endpoint**, not of a cross-encoder: Zhipu's `/rerank` takes 128
 * documents of at most 4,096 characters and refuses the call above either bound, while Cohere takes
 * 1,000. Baking 128 into the library would make one vendor's limit look like the stage's semantics,
 * and the arm would silently clip a Cohere deployment to a fifth of what it accepts.
 *
 * ## Why they are optional, and what `null` means
 *
 * `null` is "this deployment declared no limit", which is the state of every run before this field
 * existed and the correct state for a local cross-encoder that reads whole strings. It is not the
 * same as a limit of zero, and the parser refuses a value that is not a positive integer rather than
 * coercing it — a limit of `0` would clip every passage to the empty string and every score would be
 * a measurement of nothing.
 */
export type RerankBounds = {
  readonly maxDocuments: number | null;
  readonly maxDocumentChars: number | null;
};

/** Read a declared limit, or `null` when the variable is absent or blank. */
function readBound(env: RerankEnv, variable: string): number | null {
  const raw = env[variable];
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `${variable}="${raw}" must be a positive integer when set; a limit of zero would clip every ` +
        'passage to nothing, and a non-integer is not a wire limit.',
    );
  }
  return value;
}

/** The stage's declared wire limits. Reads the arm's variables; see {@link RerankBounds}. */
export function resolveRerankBounds(env: RerankEnv): RerankBounds {
  return {
    maxDocuments: readBound(env, 'CORTEX_MEMORY_RERANK_MAX_DOCUMENTS'),
    maxDocumentChars: readBound(env, 'CORTEX_MEMORY_RERANK_MAX_DOCUMENT_CHARS'),
  };
}

/**
 * Build the configured reranker, or `undefined` when the stage is off.
 *
 * `off` is spelled out in `DISABLED_VALUES` precisely so that "this value was a
 * deliberate refusal" and "this value was not understood" stop being the same
 * outcome.
 */
export function createRerankerFromEnv(
  env: RerankEnv,
  options: RerankFactoryOptions = {},
): RerankScoreFn | undefined {
  return createReranker(env, options.pipelineFactory ?? makeDefaultRerankPipelineFactory);
}

/**
 * The memory arm's reranking stage, or `undefined` when the arm is running the control.
 *
 * Same adapters, same credential rules, same refusal of a misspelled switch; the only difference is
 * which variables the switch and the model read. See {@link RerankVariableSet} for why that matters
 * in a process that also builds the paired control.
 */
export function createMemoryArmReranker(
  env: RerankEnv,
  options: RerankFactoryOptions = {},
): RerankScoreFn | undefined {
  return createReranker(
    env,
    options.pipelineFactory ?? makeDefaultRerankPipelineFactory,
    MEMORY_ARM_VARIABLES,
  );
}

/**
 * The decision itself, with the loader required rather than defaulted.
 *
 * Internal: {@link createRerankerFromEnv} is the entry point, and it supplies the
 * production loader when the caller does not. Keeping the resolution in one place
 * means there is no path on which a missing option silently yields a reranker with
 * no pipeline.
 */
function createReranker(
  env: RerankEnv,
  pipelineFactory: (model: string) => () => Promise<CrossEncoderPipeline>,
  variables: RerankVariableSet = REFERENCE_VARIABLES,
): RerankScoreFn | undefined {
  const choice = readChoice(env, variables);
  if (!choice.enabled) {
    return undefined;
  }
  return buildReranker(env, variables, choice, pipelineFactory);
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
function resolveProvider(env: RerankEnv, variables: RerankVariableSet): RerankProvider {
  const raw = (env[variables.provider] ?? 'openai').trim().toLowerCase();
  const found = RERANK_PROVIDERS.find((provider) => provider === raw);
  if (found === undefined) {
    throw new Error(
      `Unknown ${variables.provider} "${raw}"; expected one of ${RERANK_PROVIDERS.join(', ')}`,
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

function buildReranker(
  env: RerankEnv,
  variables: RerankVariableSet,
  choice: Extract<RerankChoice, { enabled: true }>,
  pipelineFactory: (model: string) => () => Promise<CrossEncoderPipeline>,
): RerankScoreFn {
  if (choice.backend === 'local') {
    // No credential of any kind is consulted. This is the offline path, and it is
    // the reason the B1 A/B can run where no rerank provider is configured.
    //
    // The pipeline factory resolves lazily and is memoised, so the model is
    // downloaded once on first use rather than per call, and constructing the
    // reranker stays synchronous — a factory that awaited here would turn this
    // function async and force every call site to handle startup failure.
    const model = choice.model;
    const loadPipeline = pipelineFactory(model);
    let cached: Promise<CrossEncoderPipeline> | undefined;
    const pipeline: CrossEncoderPipeline = (texts, options) => {
      cached ??= loadPipeline().catch((err: unknown) => {
        // Name the peer and the alternative. The underlying failure is a bad error
        // for this purpose: measured on a machine without the package, the message
        // is a `sharp` installation manual, because `sharp` is a transitive
        // dependency of the peer and its own install is what broke. The string the
        // operator needs does not appear in it at all. An
        // operator reading that message would install the wrong thing, and the CI
        // symptom is only a skipped ablation arm whose skip reason they are trying
        // to interpret.
        //
        // Rethrowing rather than swallowing: the stage must keep failing loudly,
        // because the alternative is an arm that silently records the baseline's
        // ordering as the feature's.
        //
        // Both arms of the `instanceof` below are live, and the second one is not a
        // formality. `loadPipeline()` is `createRerankClassifier`, which
        // awaits `import('@huggingface/transformers')`, and a module that throws a
        // primitive while being evaluated propagates that primitive through `await`
        // -- measured, not assumed: mocking the peer to `throw` a string reaches
        // this line with `err` a string, and the message below then ends in
        // `Underlying error: <that string>`. So `String(err)` is the arm that keeps
        // the real cause visible for the one rejection shape that has no `.message`
        // to read; reading `err.message` unconditionally would report `undefined`
        // and hide it.
        //
        // Why the coverage report showed this arm at zero: every existing fixture
        // lets the peer fail on its own terms, and that failure is always an
        // `Error` (`ERR_MODULE_NOT_FOUND`, or a transitive `sharp` install error).
        // A zero count here therefore described the fixtures, not the code -- which
        // is exactly what the test below this comment now pins.
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `CORTEX_RERANK_PROVIDER=local requires the optional peer @huggingface/transformers, ` +
            `which could not be loaded (model "${model}"). Install it, or set ` +
            `CORTEX_RERANK_PROVIDER=llm to reuse the chat credential. Underlying error: ${detail}`,
          { cause: err },
        );
      });
      return cached.then((resolve) => resolve(texts, options));
    };
    return new CrossEncoderReranker({ pipeline }).score;
  }

  if (choice.backend === 'llm') {
    // Reuses the chat credential the pipeline already has, so reranking does not
    // require a second secret. `RERANK_API_KEY` is deliberately NOT consulted: it
    // would be a key the chat endpoint cannot use, and accepting it would move the
    // failure from startup to the first request.
    const apiKey = env[variables.llmApiKey];
    if (!apiKey) {
      throw new Error(
        'DEEPSEEK_API_KEY is required when CORTEX_RERANK_PROVIDER=llm; the LLM reranker reuses the chat credential, so set it (or switch to CORTEX_RERANK_PROVIDER=local, which needs no credential)',
      );
    }
    const llm = new OpenAICompatibleLLM({
      baseUrl: choice.baseUrl,
      apiKey,
      model: choice.model,
    });
    const reranker = new LLMReranker({ llm });
    return withFallbackCounters(reranker.score, reranker);
  }

  const apiKey = env[variables.apiKey];
  if (!apiKey) {
    throw new Error(
      `${variables.apiKey} is required when ${variables.enable} is enabled; unset ` +
        `${variables.enable} to run without reranking`,
    );
  }
  return new OpenAICompatibleReranker({
    baseUrl: choice.baseUrl,
    apiKey,
    model: choice.model,
  }).score;
}
