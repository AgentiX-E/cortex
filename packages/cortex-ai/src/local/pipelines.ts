/**
 * The `@huggingface/transformers` loading layer: one place where the library is imported, configured
 * and pinned to the options this package depends on.
 *
 * ## Why options are pinned instead of defaulted
 *
 * Upgrading from `@xenova/transformers` 2.17 to `@huggingface/transformers` 4.x does not keep the
 * defaults, and the two defaults that changed both alter the vector:
 *
 * | option | v2 default | v4 default | effect on the vector |
 * |---|---|---|---|
 * | `dtype` | `q8` (quantized weights) | `fp32` | measured **min cosine 0.988** over 15 texts |
 * | `pooling` | none (token-level output) | none | shape changes from `[n, dim]` to `[n, seq, dim]` |
 *
 * The first row is the migration hazard: a caller who upgrades without pinning gets vectors that
 * look normal, have the right dimension, and are **incomparable to every vector already stored**.
 * Measured, not assumed -- `test/parity/run.mjs` compares both libraries on the same weights and the
 * same texts, with and without the pin. So `dtype` defaults to `fp32` here and the value is passed
 * explicitly on every call; the existing vectors were produced by v2's *quantized* default, which is
 * why docs/04 records them as needing a re-embed rather than as compatible.
 *
 * ## Why the module loader is injectable
 *
 * The peer is optional. Injecting the loader is what lets this file be covered without model
 * weights: the tests supply a module whose `pipeline` records its arguments and returns a stub
 * extractor, which asserts the pinning above directly. `resolveTransformersModule()` is separately
 * tested against the **real** installed package, so "the dynamic import works" is also a fact rather
 * than an assumption -- and neither of those is the same claim as "a real model produces the same
 * numbers", which only the parity harness can make.
 */
import type { CrossEncoderPipeline } from '../rerank/rerank.js';

/**
 * Weight precision.
 *
 * `fp32` is the default because it is the only value that is stable across library versions. The
 * rest are available because a browser deployment may not be able to afford 90 MB of weights, and
 * that trade belongs to the caller -- but it has to be a trade they made on purpose.
 */
export type LocalDtype = 'fp32' | 'fp16' | 'q8' | 'int8' | 'uint8' | 'q4' | 'bnb4' | 'q4f16';

export const DEFAULT_DTYPE: LocalDtype = 'fp32';

/** Where the model comes from. Mirrors the fields of the library's `env` this package supports. */
export type LocalEnv = {
  /** Base URL for model downloads. `https://hf-mirror.com` when the public Hub is unreachable. */
  remoteHost?: string | undefined;
  /** Directory to cache weights in. Defaults to the library's (`.cache` under the cwd). */
  cacheDir?: string | undefined;
  /** Set false to forbid downloads entirely and only use `localModelPath`. */
  allowRemoteModels?: boolean | undefined;
  /** Directory holding a pre-downloaded model tree. */
  localModelPath?: string | undefined;
};

/** A `feature-extraction` pipeline: texts in, a matrix-like object out. */
export type FeatureExtractor = (
  texts: string[],
  opts?: { pooling: string; normalize: boolean },
) => Promise<{ tolist: () => number[][] }>;

/** The parts of the library this package touches. Structural, so a test can supply its own. */
export type TransformersModule = {
  env: LocalEnv;
  pipeline(
    task: string,
    model: string,
    options?: { dtype?: string; device?: string },
  ): Promise<unknown>;
  /**
   * Used by the rerank path, which needs the tokenizer and the model separately.
   *
   * Optional in the type so that a caller testing the embedding path does not have to supply them --
   * but required by `createRerankClassifier`, which refuses with a sentence rather than a
   * `TypeError` when a build of the library does not export them.
   */
  AutoTokenizer?: {
    from_pretrained(model: string, options?: { dtype?: string; device?: string }): Promise<unknown>;
  };
  AutoModelForSequenceClassification?: {
    from_pretrained(model: string, options?: { dtype?: string; device?: string }): Promise<unknown>;
  };
};

export type LocalPipelineOptions = {
  /** Model id on the Hub, or a path under `localModelPath`. */
  model: string;
  /**
   * Weight precision. Defaults to {@link DEFAULT_DTYPE}; see the module comment for why.
   *
   * The optional fields below admit `undefined` for the same reason `LocalEnv` does: they are
   * usually forwarded from a configuration object, and `exactOptionalPropertyTypes` would otherwise
   * make `{ dtype: config.dtype }` a type error at every call site.
   */
  dtype?: LocalDtype | undefined;
  /** Execution device. `webgpu` is browser-only and needs the library's wasm/webgpu build. */
  device?: 'cpu' | 'webgpu' | undefined;
  /** Applied to the library's process-wide `env` before the first pipeline is created. */
  env?: LocalEnv | undefined;
  /** Injectable module loader; defaults to importing `@huggingface/transformers`. */
  loadModule?: (() => Promise<TransformersModule>) | undefined;
};

/**
 * Pooling and normalisation, pinned at the call site.
 *
 * `pooling: 'mean'` turns token embeddings into one vector per text; `normalize: true` makes the
 * result unit-length so cosine similarity is a dot product. Neither is a library default, and a
 * missing `pooling` returns `[n, seq, dim]` -- which the mean-pooling code downstream would then
 * read as n rows of the wrong width.
 */
export const EMBEDDING_CALL_OPTIONS = { pooling: 'mean', normalize: true } as const;

/**
 * The default loader, with the peer named in the failure.
 *
 * `import('@huggingface/transformers')` fails with whatever module the resolver gave up on first,
 * and that is not always the peer: measured on the previous library, a machine without it produced a
 * 706-character `sharp` installation manual, because `sharp` is a *transitive* dependency and its own
 * native build was what broke. An operator reading that message installs the wrong package.
 *
 * So the failure is wrapped: the peer this package requires is named first, the remedy is stated,
 * and the original message is kept at the end so a genuinely different cause is still visible.
 *
 * The import is a parameter only so that this wrapping can be tested; the default is the real one,
 * and `test/parity/run.mjs` exercises that path with real weights.
 */
export async function resolveTransformersModule(
  load: () => Promise<TransformersModule> = () => import('@huggingface/transformers'),
): Promise<TransformersModule> {
  try {
    return await load();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      'the local model runtime is unavailable: @huggingface/transformers could not be loaded. ' +
        'Install it (`pnpm add @huggingface/transformers`), or use a remote provider, which needs ' +
        `no peer at all. Underlying error: ${detail}`,
      { cause: error },
    );
  }
}

/**
 * Apply `env` overrides.
 *
 * The library keeps this configuration in module scope, so this is deliberately a write to shared
 * state and is documented as such: two embeddings in one process that ask for different mirrors will
 * get whichever was applied last. Making it per-instance would mean reimplementing the library's
 * cache key, and pretending the setting is local when it is not would be worse than saying so.
 */
export function applyLocalEnv(module: TransformersModule, env: LocalEnv | undefined): void {
  if (env === undefined) return;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    (module.env as Record<string, unknown>)[key] = value;
  }
}

/** Load the module, apply `env`, and return it with the pipeline arguments this package pins. */
async function prepare(options: LocalPipelineOptions): Promise<{
  module: TransformersModule;
  args: { dtype: string; device?: string };
}> {
  const module = await (options.loadModule ?? resolveTransformersModule)();
  applyLocalEnv(module, options.env);
  const args: { dtype: string; device?: string } = { dtype: options.dtype ?? DEFAULT_DTYPE };
  if (options.device !== undefined) args.device = options.device;
  return { module, args };
}

/** Create the embedding pipeline. */
export async function createFeatureExtractor(
  options: LocalPipelineOptions,
): Promise<FeatureExtractor> {
  const { module, args } = await prepare(options);
  const extractor = (await module.pipeline('feature-extraction', options.model, args)) as (
    texts: string[],
    opts?: { pooling: string; normalize: boolean },
  ) => Promise<{ tolist: () => number[][] }>;

  return (texts, opts) => extractor(texts, opts ?? EMBEDDING_CALL_OPTIONS);
}

/**
 * Create the cross-encoder used by `CrossEncoderReranker`: raw logits, one per input.
 *
 * ## Why this does not go through `pipeline('text-classification')`
 *
 * The pipeline post-processes the model's logits with a softmax over its labels. A reranking
 * cross-encoder has one label, so that softmax is over a single element and returns **1.0 for every
 * input** -- every candidate ties, and a reranker that ties is a reranker that does nothing while
 * reporting success. Measured on `Xenova/ms-marco-MiniLM-L-6-v2`: the three logits for
 * (query, Paris) / (query, weather) / (query, Berlin) are `1.95 / -5.63 / -4.03`, and the pipeline
 * returned `1 / 1 / 1` for all three.
 *
 * The previous version of this file went through the pipeline and asked for `topk: null`. Under v2
 * that happened to fail loudly -- the old pipeline nested its results per input, so the adapter's
 * length check passed while `entry.score` was `undefined`, and `CrossEncoderReranker` refused the
 * batch and fell back. Under v4 the shape matches and the failure became silent: a correct-looking
 * array of equal scores. `docs/04` records both halves, because "it used to break" is the reason
 * this test exists rather than an anecdote.
 *
 * Building the tokenizer and the model directly is also the more stable interface: it does not
 * depend on how a given version post-processes logits.
 */
export async function createRerankClassifier(
  options: LocalPipelineOptions,
): Promise<CrossEncoderPipeline> {
  const { module, args } = await prepare(options);
  const tokenizerClass = module.AutoTokenizer;
  const modelClass = module.AutoModelForSequenceClassification;
  if (tokenizerClass === undefined || modelClass === undefined) {
    throw new Error(
      'this build of @huggingface/transformers does not export AutoTokenizer and ' +
        'AutoModelForSequenceClassification, which the local reranker needs',
    );
  }

  const tokenizer = (await tokenizerClass.from_pretrained(options.model, args)) as (
    texts: string[],
    options?: { padding?: boolean; truncation?: boolean },
  ) => Promise<Record<string, unknown>>;
  const model = (await modelClass.from_pretrained(options.model, args)) as (
    inputs: Record<string, unknown>,
  ) => Promise<{ logits: { data: ArrayLike<number>; dims: readonly number[] } }>;

  return async (texts) => {
    if (texts.length === 0) return [];
    const encoded = await tokenizer(texts, { padding: true, truncation: true });
    const output = await model(encoded);
    const [rows, columns] = output.logits.dims;
    if (rows !== texts.length || columns === undefined) {
      throw new Error(
        `cross-encoder returned ${String(rows)}x${String(columns)} logits for ${texts.length} inputs`,
      );
    }

    // One score per input, taken from the first (and, for a reranker, only) logit column. The
    // sigmoid that turns a logit into a probability is applied by `CrossEncoderReranker` when it is
    // asked for, so the number here stays the model's own output.
    return Array.from({ length: rows }, (_unused, row) => ({
      score: output.logits.data[row * (columns as number)] as number,
    }));
  };
}

/**
 * Bind a factory for `TransformersEmbedding.pipelineFactory`.
 *
 * A bare model id is accepted as well as the options object, because "which model" is the only
 * thing most callers need to say and forcing them to write `{ model: ... }` for it would make the
 * ordinary case the verbose one. Everything else keeps its pinned default.
 */
export function makeFeatureExtractorFactory(
  options: LocalPipelineOptions | string,
): () => Promise<FeatureExtractor> {
  const resolved = typeof options === 'string' ? { model: options } : options;
  return () => createFeatureExtractor(resolved);
}

/** Bind a factory for `CrossEncoderReranker.pipeline`. Accepts a model id or full options. */
export function makeRerankPipelineFactory(
  options: LocalPipelineOptions | string,
): () => Promise<CrossEncoderPipeline> {
  const resolved = typeof options === 'string' ? { model: options } : options;
  return () => createRerankClassifier(resolved);
}
