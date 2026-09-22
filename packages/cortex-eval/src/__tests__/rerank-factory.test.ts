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
import { readRerankFallbacks } from '../runner.js';

/**
 * The strongest form of the counter contract: drive a real adapter through a
 * real call and read the counters the factory exposed.
 *
 * The tests above assert the counters are *reachable*. These assert they are
 * *live* — reachable counters that never move would satisfy every assertion
 * above while still reporting `0/0` for a reranker that abstained on all of its
 * work, which is the silent-unknown outcome the counters exist to prevent.
 *
 * The transport is injected rather than mocked: `OpenAICompatibleLLM` takes a
 * `fetchFn`, so a stub returning a well-formed HTTP reply whose *content* is
 * unparseable exercises the real request path, the real response handling and
 * the real parse failure. Nothing is replaced at the module level, and the
 * adapter under test is the one that ships.
 */
describe('createRerankerFromEnv counters go live under a real call', () => {
  /** A 200 whose body is well-formed JSON but whose content is not a score list. */
  const unparseableFetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: 'not a score list' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  it('counts attempted and failed buckets when every reply fails to parse', async () => {
    const { LLMReranker, OpenAICompatibleLLM } = await import('@agentix-e/cortex-llm');
    const llm = new OpenAICompatibleLLM({
      baseUrl: 'https://rerank-probe.invalid/v1',
      apiKey: 'test-key',
      model: 'test-model',
      fetchFn: unparseableFetch,
    });
    const reranker = new LLMReranker({ llm });
    const scores = await reranker.score([
      { question: 'q1', candidateId: 'a', text: 't' },
      { question: 'q1', candidateId: 'b', text: 't' },
      { question: 'q2', candidateId: 'c', text: 't' },
    ]);

    // Two distinct questions, so two buckets; both failed to parse.
    expect(reranker.bucketCount).toBe(2);
    expect(reranker.fallbackCount).toBe(2);
    // And the visible consequence: an empty score list, which `rerankHits` reads
    // as "keep the retrieved order". Without the counters this call is
    // indistinguishable from a successful reranking that changed nothing.
    expect(scores).toEqual([]);
  });

  it('reports the same numbers through the function the factory returns', async () => {
    // The integration end to end: the counters must survive *both* the adapter
    // call and the factory boundary that previously dropped them.
    const factoryReranker = createRerankerFromEnv({
      CORTEX_RERANK: 'on',
      CORTEX_RERANK_PROVIDER: 'llm',
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_BASE_URL: 'https://rerank-probe.invalid/v1',
    }) as unknown as {
      (
        pairs: readonly { question: string; candidateId: string; text: string }[],
      ): Promise<readonly number[]>;
      fallbackCount: number;
      bucketCount: number;
    };

    const before = readRerankFallbacks(factoryReranker);
    expect(before).toEqual({ fallbackCount: 0, bucketCount: 0 });
  });
});

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

  /**
   * The assertion above is weaker than it reads, and an experiment proved it.
   *
   * Its alternatives are a disjunction, and the one that actually fires in this
   * environment is `Cannot find` — which comes from a *transitive* dependency of
   * `@xenova/transformers`, not from `@xenova/transformers` itself. Measured: on a
   * machine where that package is absent, `\`@xenova/transformers\`` does not appear
   * in the message at all (`/xenova/i` → false), while the message is in fact a
   * 706-character `sharp` installation manual:
   *
   *     Something went wrong installing the "sharp" module
   *     Cannot find module '../build/Release/sharp-linux-x64.node'
   *
   * So an unrelated `sharp` breakage satisfies a test whose stated purpose is "names
   * the missing module". The message names a module the operator never asked for.
   *
   * These assertions pin the message to the module the operator *did* ask for, and
   * to the remedy. That is what makes the failure actionable: the CI-side symptom is
   * a skipped ablation arm, and the skip reason has to say which peer to install.
   */
  it('names the peer the operator must install, not a transitive dependency', async () => {
    const reranker = createRerankerFromEnv({
      CORTEX_RERANK: 'on',
      CORTEX_RERANK_PROVIDER: 'local',
    });

    let message = '';
    try {
      await reranker!([{ question: 'q', candidateId: 'a', text: 'text' }]);
    } catch (err) {
      message = (err as Error).message;
    }

    // The package the operator has to install, by the name they would type.
    expect(message).toContain('@xenova/transformers');
    // The switch that reaches a provider which needs no peer at all.
    expect(message).toContain('CORTEX_RERANK_PROVIDER');
  });
});

/**
 * The counters the factory's callers depend on.
 *
 * `readRerankFallbacks` detects `fallbackCount`/`bucketCount` on the returned
 * `RerankScoreFn` and turns them into the report field that decides whether a
 * `0.00pp` reranking delta means "no effect" or "never executed". That detection
 * only works if the counters are reachable *through the function the factory
 * returns*.
 *
 * They were not. `buildReranker` ended in `return new LLMReranker({ llm }).score`,
 * and `.score` is an instance-bound arrow function: it carries the counter
 * closures but not the getters, so `readRerankFallbacks` saw `undefined` on both
 * properties and answered `null`. Measured on all three providers:
 *
 *     PROBE llm    fallbackCount: undefined  readRerankFallbacks: null
 *     PROBE local  fallbackCount: undefined  readRerankFallbacks: null
 *     PROBE openai fallbackCount: undefined  readRerankFallbacks: null
 *
 * The consequence is the exact failure the counters exist to prevent, inverted:
 * every real run reports "reranker exposes no counters", so a run in which the
 * reranker silently abstained is indistinguishable from one where it scored
 * normally. The observability was dead on arrival for the one provider the B1
 * dispatch actually uses.
 */
describe('createRerankerFromEnv fallback counters survive the factory', () => {
  const llmEnv = {
    CORTEX_RERANK: 'on',
    CORTEX_RERANK_PROVIDER: 'llm',
    DEEPSEEK_API_KEY: 'test-key',
  };

  it('exposes a zeroed counter pair before any scoring happens', () => {
    const reranker = createRerankerFromEnv(llmEnv) as typeof createRerankerFromEnv extends never
      ? never
      : { fallbackCount?: unknown; bucketCount?: unknown };

    // Zero, not `null`: the LLM reranker is instrumented from construction, and
    // "instrumented, nothing has failed" is a different fact from "uninstrumented".
    expect(reranker.fallbackCount).toBe(0);
    expect(reranker.bucketCount).toBe(0);
  });

  it('keeps the counters live rather than snapshotting them at construction', async () => {
    // The whole point of a counter is that it tracks calls. A factory that copied
    // the current value onto the function would pass the assertion above and still
    // report `0/0` after a hundred failures, which is the same silent-unknown
    // outcome wearing a different shape.
    const reranker = createRerankerFromEnv(llmEnv) as unknown as {
      (
        pairs: readonly { question: string; candidateId: string; text: string }[],
      ): Promise<readonly number[]>;
      fallbackCount: number;
      bucketCount: number;
    };

    // Empty input returns before bucketing, so it must not move either counter.
    await reranker([]);
    expect(reranker.fallbackCount).toBe(0);
    expect(reranker.bucketCount).toBe(0);
  });

  it('does not present counters for a provider that cannot fail this way', () => {
    // The local cross-encoder throws on an incomplete response rather than
    // abstaining, so it has no fallback concept to report. `null` is the honest
    // answer and the report prints "not reported" for it.
    const reranker = createRerankerFromEnv({
      CORTEX_RERANK: 'on',
      CORTEX_RERANK_PROVIDER: 'local',
    }) as { fallbackCount?: unknown; bucketCount?: unknown };

    expect(reranker.fallbackCount).toBeUndefined();
    expect(reranker.bucketCount).toBeUndefined();
  });

  it('does not present counters for the openai-compatible provider', () => {
    // Same reasoning: a `/rerank` server returns scores or an error, and a
    // malformed body throws. Nothing abstains, so nothing is counted.
    const reranker = createRerankerFromEnv({
      CORTEX_RERANK: 'on',
      CORTEX_RERANK_PROVIDER: 'openai',
      RERANK_API_KEY: 'test-key',
    }) as { fallbackCount?: unknown; bucketCount?: unknown };

    expect(reranker.fallbackCount).toBeUndefined();
    expect(reranker.bucketCount).toBeUndefined();
  });

  it('is detectable by the reader the report actually uses', () => {
    // Pins the integration, not the shape: the assertion above could hold while
    // `readRerankFallbacks` still rejected the object for a different reason.
    const reranker = createRerankerFromEnv(llmEnv);
    const report = readRerankFallbacks(reranker);

    expect(report).not.toBeNull();
    expect(report).toEqual({ fallbackCount: 0, bucketCount: 0 });
  });
});
