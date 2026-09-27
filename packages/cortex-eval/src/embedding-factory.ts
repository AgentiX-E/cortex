/**
 * Embedding factory: resolves a remote OpenAI-compatible embedding (Zhipu
 * embedding-3 by default) when the API credentials are present, otherwise falls
 * back to the deterministic hash embedding for local development. This keeps the
 * benchmark reproducible without secrets while supporting a real embedding on CI
 * runners.
 *
 * The factory also reports WHICH backend it built. The fallback is silent — that
 * is what makes the benchmark runnable without secrets — and a silent
 * substitution between two deterministic-but-incompatible embeddings is
 * invisible in every downstream number: both produce stable vectors, so a
 * determinism probe reads `0` either way, and a retrieval score computed against
 * 256-dimension hash vectors looks exactly like one computed against Zhipu's
 * 1024. The provenance is what makes two runs comparable without assuming.
 */
import type { EmbeddingModel } from '@agentix-e/cortex-core';
import { OpenAIEmbedding } from '@agentix-e/cortex-llm';
import { HashEmbedding } from './embedding.js';

export type EmbeddingEnv = Record<string, string | undefined>;

export const DEFAULT_HASH_DIMENSION = 256;
export const DEFAULT_ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
export const DEFAULT_ZHIPU_EMBEDDING_MODEL = 'embedding-3';
export const DEFAULT_ZHIPU_EMBEDDING_DIMENSIONS = 1024;

/**
 * The backend an embedding actually came from.
 *
 * `provider: 'hash'` carries `model: null` and `baseUrl: null` rather than the
 * Zhipu defaults it would have used had a key been present. Naming a provider
 * the process never contacted is worse than naming none: it would make a
 * credential-less run read as a Zhipu run in the artifact, which is the
 * substitution this type exists to expose.
 *
 * `dimensions` is the resolved value, so a reader can tell a 256-dimension hash
 * run from a 1024-dimension Zhipu run without knowing which model was asked for.
 */
export type EmbeddingProvenance = {
  /** `'openai-compatible'` for any HTTP embedding, `'hash'` for the offline fallback. */
  provider: 'openai-compatible' | 'hash';
  /** Resolved model id, or `null` when the hash fallback was used. */
  model: string | null;
  /** Resolved endpoint, or `null` when the hash fallback was used. */
  baseUrl: string | null;
  /** Vector length the model produces. */
  dimensions: number;
};

/** An embedding plus the backend that produced it. */
export type EmbeddingWithProvenance = {
  embedding: EmbeddingModel;
  provenance: EmbeddingProvenance;
};

/**
 * Resolve the embedding and report which backend was reached.
 *
 * An API key that is present but empty is treated as absent. The env helpers in
 * this codebase read `KEY ?? default`, and `??` only skips null and undefined, so
 * an unset CI secret (which arrives as `""`) would otherwise select the remote
 * path and fail the run with a 401 against a URL nobody configured — losing the
 * whole benchmark to what is defined here as a missing credential.
 */
export function createEmbeddingWithProvenanceFromEnv(env: EmbeddingEnv): EmbeddingWithProvenance {
  const apiKey = firstNonEmpty(env['ZHIPU_API_KEY'], env['EMBEDDING_API_KEY']);
  const baseUrl =
    firstNonEmpty(env['ZHIPU_BASE_URL'], env['EMBEDDING_BASE_URL']) ?? DEFAULT_ZHIPU_BASE_URL;
  const model =
    firstNonEmpty(env['ZHIPU_EMBEDDING_MODEL'], env['EMBEDDING_MODEL']) ??
    DEFAULT_ZHIPU_EMBEDDING_MODEL;
  const dimensions = Number(env['EMBEDDING_DIMENSIONS'] ?? DEFAULT_ZHIPU_EMBEDDING_DIMENSIONS);
  if (apiKey !== undefined && Number.isInteger(dimensions) && dimensions > 0) {
    return {
      embedding: new OpenAIEmbedding({ baseUrl, apiKey, model, dimensions }),
      // `dimensions` is the value just validated and handed to the client, and
      // the client's own `dimension()` returns that same field, so the two cannot
      // disagree. Reported explicitly rather than read back so this stays a plain
      // object a caller can log before the client exists.
      provenance: { provider: 'openai-compatible', model, baseUrl, dimensions },
    };
  }
  return {
    embedding: new HashEmbedding(DEFAULT_HASH_DIMENSION),
    provenance: {
      provider: 'hash',
      model: null,
      baseUrl: null,
      dimensions: DEFAULT_HASH_DIMENSION,
    },
  };
}

/** First value that is neither undefined nor an empty/blank string. */
function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== '') {
      return value;
    }
  }
  return undefined;
}

export function createEmbeddingFromEnv(env: EmbeddingEnv): EmbeddingModel {
  return createEmbeddingWithProvenanceFromEnv(env).embedding;
}
