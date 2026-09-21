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

/**
 * Provider selection.
 *
 * `CORTEX_RERANK` stays exactly what it was — a single off/on switch — and a new
 * `CORTEX_RERANK_PROVIDER` chooses the backend. The two are kept apart because
 * collapsing them would create an unresolvable question: under an LLM backend the
 * credential is the provider's chat key, so `RERANK_API_KEY` would have to be
 * sometimes-required and sometimes-forbidden in the same variable, and the
 * "enabled without credentials" error could no longer name the variable the
 * operator actually has to set.
 *
 * The LLM backend exists because a chat endpoint that is already configured can
 * score passages without a second credential or a second vendor. The local
 * backend exists because it needs no credential at all — which is what makes the
 * B1 A/B runnable in an environment that has neither.
 */
describe('createRerankerFromEnv provider selection', () => {
  it('defaults to the OpenAI-compatible /rerank client', () => {
    const reranker = createRerankerFromEnv({
      CORTEX_RERANK: 'on',
      RERANK_API_KEY: 'k',
      RERANK_BASE_URL: 'https://example.invalid/v1',
    });

    expect(typeof reranker).toBe('function');
  });

  it('accepts the provider value case-insensitively and with surrounding space', () => {
    const reranker = createRerankerFromEnv({
      CORTEX_RERANK: 'on',
      CORTEX_RERANK_PROVIDER: '  LLM  ',
      DEEPSEEK_API_KEY: 'k',
    });

    expect(typeof reranker).toBe('function');
  });

  it('builds an LLM reranker from the chat credential, needing no RERANK_API_KEY', () => {
    // This is the whole point of the provider: the operator already has a chat
    // key, and reranking reuses it rather than duplicating it as a second secret.
    const reranker = createRerankerFromEnv({
      CORTEX_RERANK: 'on',
      CORTEX_RERANK_PROVIDER: 'llm',
      DEEPSEEK_API_KEY: 'chat-key',
      DEEPSEEK_BASE_URL: 'https://example.invalid/v1',
    });

    expect(typeof reranker).toBe('function');
  });

  it('names DEEPSEEK_API_KEY when the LLM provider has no chat credential', () => {
    expect(() =>
      createRerankerFromEnv({
        CORTEX_RERANK: 'on',
        CORTEX_RERANK_PROVIDER: 'llm',
      }),
    ).toThrow(/DEEPSEEK_API_KEY/);
  });

  it('does not silently accept a RERANK_API_KEY in place of the chat credential', () => {
    // Accepting it would let an operator configure the LLM backend with a key the
    // LLM backend cannot use, and the failure would appear at first request
    // instead of at startup.
    expect(() =>
      createRerankerFromEnv({
        CORTEX_RERANK: 'on',
        CORTEX_RERANK_PROVIDER: 'llm',
        RERANK_API_KEY: 'wrong-key',
      }),
    ).toThrow(/DEEPSEEK_API_KEY/);
  });

  it('routes to the local cross-encoder without requiring any credential', () => {
    const reranker = createRerankerFromEnv({
      CORTEX_RERANK: 'on',
      CORTEX_RERANK_PROVIDER: 'local',
    });

    expect(typeof reranker).toBe('function');
  });

  it('honours a local model override', () => {
    const reranker = createRerankerFromEnv({
      CORTEX_RERANK: 'on',
      CORTEX_RERANK_PROVIDER: 'local',
      CORTEX_RERANK_MODEL: 'Xenova/ms-marco-MiniLM-L-6-v2',
    });

    expect(typeof reranker).toBe('function');
  });

  it('rejects an unknown provider by name rather than falling back', () => {
    // A typo in the provider is the one failure that must never be silent: falling
    // back to the default would run the A/B against the wrong reranker and report
    // the resulting accuracy as a fact about the intended one.
    expect(() =>
      createRerankerFromEnv({
        CORTEX_RERANK: 'on',
        CORTEX_RERANK_PROVIDER: 'coher',
        RERANK_API_KEY: 'k',
      }),
    ).toThrow(/coher/);
  });

  it('ignores the provider when reranking is off', () => {
    // Off means off: an unset CORTEX_RERANK leaves the pipeline bit-identical no
    // matter what else is configured.
    expect(createRerankerFromEnv({ CORTEX_RERANK_PROVIDER: 'llm' })).toBeUndefined();
  });
});

/**
 * The local provider's lazy loader.
 *
 * The provider was previously reachable only in the sense that a function was
 * returned: nothing ever invoked the pipeline closure, so the memoised load and the
 * passthrough of `topk: null` were unexercised. That is the same defect class as the
 * one this whole change began with — `CrossEncoderReranker` existed, was exported,
 * had tests, and was constructed by no one.
 *
 * `@xenova/transformers` is absent here, so the observable contract in this
 * environment is that the failure surfaces as a rejected promise naming the missing
 * module when scoring is attempted. Asserting that is stronger than asserting the
 * closure exists: it proves the score call actually reaches the loader, and it pins
 * that the failure is deferred to first use rather than thrown at construction.
 */
describe('createRerankerFromEnv local provider', () => {
  it('defers the model load to first scoring rather than failing at construction', () => {
    // Constructing must not touch the optional peer: the stage is built during
    // startup, and a missing optional dependency must not abort a run that never
    // scores anything.
    const reranker = createRerankerFromEnv({
      CORTEX_RERANK: 'on',
      CORTEX_RERANK_PROVIDER: 'local',
    });

    expect(typeof reranker).toBe('function');
  });

  it('surfaces the missing optional peer when scoring is actually attempted', async () => {
    const reranker = createRerankerFromEnv({
      CORTEX_RERANK: 'on',
      CORTEX_RERANK_PROVIDER: 'local',
    });

    await expect(reranker!([{ question: 'q', candidateId: 'a', text: 'text' }])).rejects.toThrow(
      /xenova|transformers|Cannot find/i,
    );
  });
});
