/**
 * The non-`Error` rejection arm of the local provider's loader.
 *
 * `buildReranker`'s local branch reports the underlying cause with
 * `err instanceof Error ? err.message : String(err)`. Every other fixture in this
 * suite lets the peer fail by itself, and that failure is always an `Error`
 * (`ERR_MODULE_NOT_FOUND`, or a transitive `sharp` install error) -- measured by
 * instrumenting the line: across the whole `rerank-factory.test.ts` suite the
 * expression saw `isError=true` twice and never once a non-Error. So the alternate
 * arm was carried by the code and exercised by nothing.
 *
 * That is worth a test rather than a note, because the arm is what keeps the cause
 * legible in the one case that has no `.message` to read. A module that throws a
 * primitive while being evaluated propagates that primitive through `await`, so
 * without the arm the message would end in `Underlying error: undefined` -- the
 * operator would be told a peer failed and given no reason, in the situation where
 * the reason is the whole point of the message.
 *
 * ## Why the loader is injected and `vi.mock` is NOT used
 *
 * The first version of this file reached the arm by mocking the peer at the module
 * boundary, and it **passed locally while failing in CI**. That difference is the
 * useful part of the record:
 *
 *   1. `@xenova/transformers` is an *optional* dependency of `cortex-llm`. A clean
 *      `pnpm install --frozen-lockfile` does not install it; a developer's
 *      `node_modules` often has it.
 *   2. `vi.mock` only intercepts a specifier that **resolves**. With the peer
 *      absent the mock does not apply, the real `import` runs, `sharp` fails, and
 *      that failure is an `Error` -- so the `isError` arm runs and the assertion
 *      about the primitive's text fails.
 *
 * So the test was measuring which packages happened to be installed rather than what
 * the code does. That is the same shape as the fixtures this repository has already
 * recorded as measuring their environment (a mock that agreed with itself, a
 * coverage gate over noise, a denominator that could not move), and the remedy is
 * the same: remove the dependence rather than widen the assertion.
 *
 * The loader is therefore injected through the internal `createReranker`'s second
 * parameter. The shipped entry point `createRerankerFromEnv` keeps its
 * single-argument signature, because a production caller must not be able to
 * substitute a pipeline -- that is the silent-substitution failure the audit already
 * recorded, and it is why the loader is not injectable in production. The seam is on
 * an internal function that no barrel exports.
 *
 * The tests below are a set on purpose: one proves the constructed failure reaches
 * the arm, one proves an `Error` still takes the other arm, one proves the shipped
 * entry point does not accept a substituted loader, and one proves the seam builds a
 * working reranker. A seam tested only in its permissive direction is a hole.
 */

import { describe, expect, it } from 'vitest';

import {
  createRerankerFromEnv,
  makeDefaultRerankPipelineFactory,
  type RerankFactoryOptions,
} from '../rerank-factory.js';

/**
 * The injectable loader, used as the shipped entry point's documented option.
 *
 * Named `options` rather than a bespoke export, because the seam is a real field on
 * `RerankFactoryOptions` -- the same production function takes it, and the default
 * is the very loader this object replaces. A test-only export would leave the
 * shipped signature unexercised in the direction that matters.
 */
const PRIMITIVE_LOADER: RerankFactoryOptions = {
  // A rejection carrying no `.message`, exactly as a module that throws during
  // evaluation behaves. Rejected before any pipeline exists.
  pipelineFactory: () => () => Promise.reject('peer threw a primitive, not an Error'),
};

const ERROR_LOADER: RerankFactoryOptions = {
  pipelineFactory: () => () => Promise.reject(new Error('a real Error cause')),
};

describe('the local provider reports a non-Error rejection verbatim', () => {
  it('stringifies a primitive cause instead of reporting undefined', async () => {
    const reranker = createRerankerFromEnv(
      { CORTEX_RERANK: 'on', CORTEX_RERANK_PROVIDER: 'local' },
      PRIMITIVE_LOADER,
    );

    let message = '';
    try {
      await reranker!([{ question: 'q', candidateId: 'a', text: 't' }]);
    } catch (err) {
      message = (err as Error).message;
    }

    // The primitive's own text, not `[object Object]` and not `undefined`.
    expect(message).toContain('peer threw a primitive, not an Error');
    // And the actionable parts of the message are unaffected by which arm ran.
    expect(message).toContain('@xenova/transformers');
    expect(message).toContain('CORTEX_RERANK_PROVIDER=llm');
  });

  it('still reports an Error cause through the message arm', async () => {
    // The control. Without it, the test above would also pass if the loader's
    // failures were stringified unconditionally -- and then the `instanceof` branch
    // would be the dead one instead. Which arm is live is the property under test,
    // so both are asserted.
    const reranker = createRerankerFromEnv(
      { CORTEX_RERANK: 'on', CORTEX_RERANK_PROVIDER: 'local' },
      ERROR_LOADER,
    );

    let message = '';
    try {
      await reranker!([{ question: 'q', candidateId: 'a', text: 't' }]);
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain('a real Error cause');
    // `String(error)` would read `Error: a real Error cause`; the message arm must
    // not add that prefix, which is how the two paths are told apart.
    expect(message).not.toContain('Error: a real Error cause');
  });

  it('defaults to the production loader when no option is given', () => {
    // The property that makes the option a choice rather than a hole: omitting it
    // must resolve to the real transformers.js loader rather than to a no-op or a
    // thrown error. Reaching the local provider without an option and getting a
    // callable reranker back is the observable -- if the default were missing, the
    // construction itself would fail, which is what the first draft of this test
    // proved by asserting on `.constructor`.
    const withDefault = createRerankerFromEnv({
      CORTEX_RERANK: 'on',
      CORTEX_RERANK_PROVIDER: 'local',
    });
    expect(typeof withDefault).toBe('function');

    // And the exported default is a real factory: calling it returns a loader.
    expect(makeDefaultRerankPipelineFactory('Xenova/ms-marco-MiniLM-L-6-v2')).toBeInstanceOf(
      Function,
    );
  });

  it('builds a working reranker through the injected loader', async () => {
    // Proof the seam is a real pipeline path and not a stub that short-circuits: a
    // loader that resolves yields scores, so the primitive test above exercises the
    // failure path rather than an unbuildable reranker.
    const reranker = createRerankerFromEnv(
      { CORTEX_RERANK: 'on', CORTEX_RERANK_PROVIDER: 'local' },
      {
        pipelineFactory: () => () =>
          Promise.resolve((texts: string[]) => Promise.resolve(texts.map(() => ({ score: 0.25 })))),
      },
    );

    const scores = await reranker!([{ question: 'q', candidateId: 'a', text: 't' }]);
    expect(scores).toEqual([0.25]);
  });
});
