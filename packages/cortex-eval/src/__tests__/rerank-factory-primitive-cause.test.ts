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
 * The peer is replaced at the module boundary rather than the loader being
 * injected, because the loader is deliberately not injectable: making it a
 * parameter would let a caller substitute a pipeline in production, which is the
 * silent-substitution failure this project has already paid for. `vi.mock` here is
 * a test-only seam and leaves the shipped signature untouched.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@xenova/transformers', () => ({
  pipeline: () => {
    throw 'peer threw a primitive, not an Error';
  },
}));

describe('the local provider reports a non-Error rejection verbatim', () => {
  it('stringifies a primitive cause instead of reporting undefined', async () => {
    const { createRerankerFromEnv } = await import('../rerank-factory.js');
    const reranker = createRerankerFromEnv({
      CORTEX_RERANK: 'on',
      CORTEX_RERANK_PROVIDER: 'local',
    });

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
});
