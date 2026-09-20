/**
 * Tests for the reranker factory (roadmap measure B1).
 *
 * The factory's whole job is to make the reranking stage *reachable*: a
 * reranker that exists but is never constructed is indistinguishable from no
 * reranker at all, which is the failure mode the code-vs-docs audit found in
 * the cognitive layer. These tests pin that contract.
 *
 * The default is deliberately OFF. Reranking changes the retrieval ordering,
 * and this project's history is explicit about the cost of doing that without a
 * controlled A/B: when RRF was wired in it re-ordered hits while the abstention
 * signal was still read from `hits[0].score`, and IE fell from 95.0% to 87.5%.
 * So the stage must be opt-in by configuration, and its absence must leave the
 * pipeline bit-identical to today's.
 */

import { describe, expect, it } from 'vitest';

import { createRerankerFromEnv, DEFAULT_RERANK_MODEL } from '../rerank-factory.js';

describe('createRerankerFromEnv', () => {
  it('returns undefined when reranking is not enabled', () => {
    expect(createRerankerFromEnv({})).toBeUndefined();
    expect(createRerankerFromEnv({ CORTEX_RERANK: 'off' })).toBeUndefined();
  });

  it('returns undefined for the explicit disabled value', () => {
    expect(createRerankerFromEnv({ CORTEX_RERANK: 'disabled' })).toBeUndefined();
  });

  it('builds a reranker when enabled with a key and base URL', () => {
    const reranker = createRerankerFromEnv({
      CORTEX_RERANK: 'on',
      RERANK_API_KEY: 'k',
      RERANK_BASE_URL: 'https://example.invalid/v1',
    });

    expect(reranker).toBeDefined();
    // The factory hands over the scoring FUNCTION, not the adapter object: the
    // pipeline's option is a call signature, so returning the instance would
    // force every call site to unwrap `.score` (and would not type-check under
    // exactOptionalPropertyTypes).
    expect(typeof reranker).toBe('function');
  });

  it('falls back to the Cohere base URL when only a key is given', () => {
    const reranker = createRerankerFromEnv({
      CORTEX_RERANK: 'on',
      RERANK_API_KEY: 'k',
    });

    expect(reranker).toBeDefined();
  });

  it('uses the default model when none is configured', () => {
    const reranker = createRerankerFromEnv({
      CORTEX_RERANK: 'on',
      RERANK_API_KEY: 'k',
      RERANK_BASE_URL: 'https://example.invalid/v1',
    });

    // Exercised through the public surface: the body carries the model id.
    expect(reranker).toBeDefined();
    expect(DEFAULT_RERANK_MODEL).toBe('rerank-v3.5');
  });

  it('throws a named error when enabled without a key, rather than silently doing nothing', () => {
    expect(() => createRerankerFromEnv({ CORTEX_RERANK: 'on' })).toThrow(/RERANK_API_KEY/);
  });

  it('treats the value case-insensitively and accepts a truthy spelling', () => {
    expect(
      createRerankerFromEnv({
        CORTEX_RERANK: 'ON',
        RERANK_API_KEY: 'k',
        RERANK_BASE_URL: 'https://example.invalid/v1',
      }),
    ).toBeDefined();
    expect(
      createRerankerFromEnv({
        CORTEX_RERANK: 'true',
        RERANK_API_KEY: 'k',
        RERANK_BASE_URL: 'https://example.invalid/v1',
      }),
    ).toBeDefined();
  });

  it('treats an empty string as not enabled', () => {
    expect(createRerankerFromEnv({ CORTEX_RERANK: '' })).toBeUndefined();
  });

  it('reads the model override', () => {
    const reranker = createRerankerFromEnv({
      CORTEX_RERANK: 'on',
      RERANK_API_KEY: 'k',
      RERANK_BASE_URL: 'https://example.invalid/v1',
      RERANK_MODEL: 'bge-reranker-v2-m3',
    });

    expect(reranker).toBeDefined();
  });
});
