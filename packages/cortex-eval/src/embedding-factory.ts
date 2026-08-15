/**
 * Embedding factory: resolves a remote OpenAI-compatible embedding (Zhipu
 * embedding-3 by default) when the API credentials are present, otherwise falls
 * back to the deterministic hash embedding for local development. This keeps the
 * benchmark reproducible without secrets while supporting a real embedding on CI
 * runners.
 */
import type { EmbeddingModel } from '@agentix-e/cortex-core';
import { OpenAIEmbedding } from '@agentix-e/cortex-llm';
import { HashEmbedding } from './embedding.js';

export type EmbeddingEnv = Record<string, string | undefined>;

export const DEFAULT_HASH_DIMENSION = 256;
export const DEFAULT_ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
export const DEFAULT_ZHIPU_EMBEDDING_MODEL = 'embedding-3';
export const DEFAULT_ZHIPU_EMBEDDING_DIMENSIONS = 1024;

export function createEmbeddingFromEnv(env: EmbeddingEnv): EmbeddingModel {
  const apiKey = env['ZHIPU_API_KEY'] ?? env['EMBEDDING_API_KEY'];
  const baseUrl = env['ZHIPU_BASE_URL'] ?? env['EMBEDDING_BASE_URL'] ?? DEFAULT_ZHIPU_BASE_URL;
  const model =
    env['ZHIPU_EMBEDDING_MODEL'] ?? env['EMBEDDING_MODEL'] ?? DEFAULT_ZHIPU_EMBEDDING_MODEL;
  const dimensions = Number(env['EMBEDDING_DIMENSIONS'] ?? DEFAULT_ZHIPU_EMBEDDING_DIMENSIONS);
  if (apiKey && Number.isInteger(dimensions) && dimensions > 0) {
    return new OpenAIEmbedding({ baseUrl, apiKey, model, dimensions });
  }
  return new HashEmbedding(DEFAULT_HASH_DIMENSION);
}
