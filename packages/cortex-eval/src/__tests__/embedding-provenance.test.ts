/**
 * Embedding provenance: which backend produced the vectors a run was graded on.
 *
 * The 429 root-cause audit found the diagnostics artifact carried
 * `embeddingMaxAbsDiff` with no provider, model, or dimension beside it. A
 * determinism score of `0` is read as "the embedding is deterministic" and says
 * nothing about WHICH embedding — the hash fallback and Zhipu embedding-3 are
 * both deterministic and differ by ~150x in dimension. Two runs whose artifacts
 * both read `embeddingMaxAbsDiff: 0` are therefore not comparable, and nothing
 * in the artifact said so.
 *
 * These tests pin the substitution down at the boundary where it happens
 * (`createEmbeddingWithProvenanceFromEnv`), rather than trusting that the
 * absence of an error means the intended backend was reached.
 */
import { describe, expect, it } from 'vitest';
import { OpenAIEmbedding } from '@agentix-e/cortex-llm';
import { HashEmbedding } from '../embedding.js';
import {
  createEmbeddingFromEnv,
  createEmbeddingWithProvenanceFromEnv,
  DEFAULT_HASH_DIMENSION,
  DEFAULT_ZHIPU_BASE_URL,
  DEFAULT_ZHIPU_EMBEDDING_DIMENSIONS,
  DEFAULT_ZHIPU_EMBEDDING_MODEL,
} from '../embedding-factory.js';

describe('createEmbeddingWithProvenanceFromEnv', () => {
  it('names the remote backend it actually built', () => {
    const { embedding, provenance } = createEmbeddingWithProvenanceFromEnv({
      EMBEDDING_API_KEY: 'k',
      EMBEDDING_BASE_URL: 'https://api.example.com/v1',
      EMBEDDING_MODEL: 'text-embedding-3-small',
      EMBEDDING_DIMENSIONS: '1536',
    });
    expect(embedding).toBeInstanceOf(OpenAIEmbedding);
    expect(provenance).toEqual({
      provider: 'openai-compatible',
      model: 'text-embedding-3-small',
      baseUrl: 'https://api.example.com/v1',
      dimensions: 1536,
    });
  });

  it('reports the Zhipu defaults that an unconfigured run actually uses', () => {
    const { provenance } = createEmbeddingWithProvenanceFromEnv({ ZHIPU_API_KEY: 'zhipu-key' });
    expect(provenance).toEqual({
      provider: 'openai-compatible',
      model: DEFAULT_ZHIPU_EMBEDDING_MODEL,
      baseUrl: DEFAULT_ZHIPU_BASE_URL,
      dimensions: DEFAULT_ZHIPU_EMBEDDING_DIMENSIONS,
    });
  });

  it('reports the hash fallback as a fallback, not as a provider', () => {
    const { embedding, provenance } = createEmbeddingWithProvenanceFromEnv({});
    expect(embedding).toBeInstanceOf(HashEmbedding);
    // `null` for model and baseUrl, not the Zhipu defaults: a fallback run must
    // not name a provider it never contacted. Falling back is silent by design
    // (it is what keeps the benchmark runnable without secrets), so the
    // provenance entry is the only place the substitution becomes visible.
    expect(provenance).toEqual({
      provider: 'hash',
      model: null,
      baseUrl: null,
      dimensions: DEFAULT_HASH_DIMENSION,
    });
  });

  it('reports the hash fallback when the dimension is invalid', () => {
    const { embedding, provenance } = createEmbeddingWithProvenanceFromEnv({
      ZHIPU_API_KEY: 'k',
      EMBEDDING_DIMENSIONS: 'not-a-number',
    });
    expect(embedding).toBeInstanceOf(HashEmbedding);
    expect(provenance.provider).toBe('hash');
  });

  it('reports the hash fallback for a zero or negative dimension', () => {
    // `Number.isInteger(0)` and `Number.isInteger(-5)` are both true, so a guard
    // written as `isInteger` alone admits both. A zero-length vector is not an
    // embedding and `Float64Array(-5)` throws, so each of these would fail the
    // run in a place that does not name the misconfigured variable.
    for (const dimensions of ['0', '-5', '-1']) {
      const { embedding, provenance } = createEmbeddingWithProvenanceFromEnv({
        ZHIPU_API_KEY: 'k',
        EMBEDDING_DIMENSIONS: dimensions,
      });
      expect(embedding, `EMBEDDING_DIMENSIONS=${dimensions}`).toBeInstanceOf(HashEmbedding);
      expect(provenance.provider).toBe('hash');
    }
  });

  it('reports the hash fallback when only a dimension is configured', () => {
    // A key is required for the remote path. Without one the run embeds through
    // the hash, even though every other variable is present and valid.
    const { provenance } = createEmbeddingWithProvenanceFromEnv({ EMBEDDING_DIMENSIONS: '1536' });
    expect(provenance).toEqual({
      provider: 'hash',
      model: null,
      baseUrl: null,
      dimensions: DEFAULT_HASH_DIMENSION,
    });
  });

  it('agrees with the embedding it returns: dimensions are the model’s own', () => {
    // The provenance dimension is copied rather than recomputed, so it cannot
    // drift from the vector length a reader would measure. Asserting the two
    // against each other is what keeps that copy honest.
    for (const env of [
      { EMBEDDING_API_KEY: 'k', EMBEDDING_DIMENSIONS: '1536' },
      { ZHIPU_API_KEY: 'z' },
      {},
    ]) {
      const { embedding, provenance } = createEmbeddingWithProvenanceFromEnv(env);
      expect(provenance.dimensions).toBe(embedding.dimension());
    }
  });

  it('treats an empty API key as absent', () => {
    // `??` only skips null and undefined, so an empty string from an unset CI
    // secret reaches the remote path unless it is filtered. The remote client
    // would then 401 against the Zhipu base URL, which is a run-ending error
    // where the fallback was available.
    const { embedding, provenance } = createEmbeddingWithProvenanceFromEnv({
      ZHIPU_API_KEY: '',
      EMBEDDING_DIMENSIONS: '1536',
    });
    expect(embedding).toBeInstanceOf(HashEmbedding);
    expect(provenance.provider).toBe('hash');
  });
});

describe('createEmbeddingFromEnv', () => {
  it('stays the same function the provenance variant builds', () => {
    const env = { EMBEDDING_API_KEY: 'k', EMBEDDING_DIMENSIONS: '768' };
    const direct = createEmbeddingFromEnv(env);
    const { embedding } = createEmbeddingWithProvenanceFromEnv(env);
    expect(direct.dimension()).toBe(embedding.dimension());
    expect(direct.constructor).toBe(embedding.constructor);
  });
});
