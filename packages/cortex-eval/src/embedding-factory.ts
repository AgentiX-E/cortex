/**
 * Embedding factory: resolves a remote OpenAI-compatible embedding when the API
 * credentials are present, otherwise falls back to the deterministic hash
 * embedding for local development. This keeps the benchmark reproducible without
 * secrets while supporting a real embedding on CI runners.
 */
import type { EmbeddingModel } from '@agentix-e/cortex-core';
import { OpenAIEmbedding } from '@agentix-e/cortex-llm';
import { HashEmbedding } from './embedding.js';

export type EmbeddingEnv = Record<string, string | undefined>;

export const DEFAULT_HASH_DIMENSION = 256;

export function createEmbeddingFromEnv(env: EmbeddingEnv): EmbeddingModel {
  const apiKey = env['EMBEDDING_API_KEY'];
  const baseUrl = env['EMBEDDING_BASE_URL'];
  const model = env['EMBEDDING_MODEL'];
  const dimensions = Number(env['EMBEDDING_DIMENSIONS'] ?? 0);
  if (apiKey && baseUrl && model && Number.isInteger(dimensions) && dimensions > 0) {
    return new OpenAIEmbedding({ baseUrl, apiKey, model, dimensions });
  }
  return new HashEmbedding(DEFAULT_HASH_DIMENSION);
}
