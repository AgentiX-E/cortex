/**
 * Two answers to "who made this vector", checked against each other.
 *
 * `cortex-eval` has reported an embedding's provenance since the 429 audit (`EmbeddingProvenance`:
 * provider, model, baseUrl, dimensions), and the benchmark's cache refuses a file whose block does
 * not match the run. `cortex-core` — the surface a deployment is built on — had no such notion until
 * `EmbeddingIdentity`, so the guard existed where the measurement happens and not where the product
 * is assembled.
 *
 * There are now two records of one fact, which is the shape this repository has been burned by
 * before: a second copy passes its own tests while the first one drifts. So the parity is asserted
 * here, in the only package that can see both, on four environments — remote, remote through the
 * alternate variable names, credential-less, and a credential that arrived as an empty string, which
 * is how an unset CI secret is delivered. The second test is the deployment the guard exists for:
 * a key that disappears, a silent fallback, and an index that was written in the other space.
 */
import { describe, expect, it } from 'vitest';
import { BruteForceVectorIndex, EmbeddingSpace, EmbeddingSpaceError } from '@agentix-e/cortex-core';
import {
  createEmbeddingWithProvenanceFromEnv,
  resolveEmbeddingProvenance,
  type EmbeddingEnv,
} from '../embedding-factory.js';

const ENVIRONMENTS: ReadonlyArray<readonly [string, EmbeddingEnv]> = [
  [
    'a Zhipu key',
    {
      ZHIPU_API_KEY: 'k',
      ZHIPU_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
      ZHIPU_EMBEDDING_MODEL: 'embedding-3',
      EMBEDDING_DIMENSIONS: '1024',
    },
  ],
  [
    'the alternate variable names',
    {
      EMBEDDING_API_KEY: 'k',
      EMBEDDING_BASE_URL: 'https://api.example.com/v1',
      EMBEDDING_MODEL: 'text-embedding-3-small',
      EMBEDDING_DIMENSIONS: '1536',
    },
  ],
  ['no credential at all', {}],
  ['a credential that arrived empty', { ZHIPU_API_KEY: '' }],
];

describe('the model and the provenance agree about the same vectors', () => {
  it.each(ENVIRONMENTS)('names one space for %s', (_label, env) => {
    const { embedding, provenance } = createEmbeddingWithProvenanceFromEnv(env);
    const identity = embedding.identity?.();
    expect(identity).toEqual({
      provider: provenance.provider,
      model: provenance.model,
      // The only field whose name differs, and the difference is deliberate: the cache's block has
      // carried `baseUrl` since version 2, and renaming it would make every archived cache file
      // report a differing field and re-embed 115,000 turns.
      endpoint: provenance.baseUrl,
      dimensions: provenance.dimensions,
    });
    // The identity is also the width the model actually embeds at: one number, read twice.
    expect(identity?.dimensions).toBe(embedding.dimension());
  });

  it('keeps the hash fallback nameless rather than naming a vendor it never contacted', () => {
    const { embedding, provenance } = createEmbeddingWithProvenanceFromEnv({});
    expect(embedding.identity?.()).toEqual({
      provider: 'hash',
      model: null,
      endpoint: null,
      dimensions: provenance.dimensions,
    });
    expect(resolveEmbeddingProvenance({}).provider).toBe('hash');
  });
});

describe('the deployment the guard exists for', () => {
  it('refuses to query a Zhipu store with the fallback the run silently got', async () => {
    const remote = createEmbeddingWithProvenanceFromEnv({
      ZHIPU_API_KEY: 'k',
      EMBEDDING_DIMENSIONS: '8',
    });
    const index = new BruteForceVectorIndex();
    const space = await EmbeddingSpace.open({ model: remote.embedding, index });
    // A real embedding here would be a network call; the space's own width check is what is under
    // test, so the vector is written through the index in the space the model declared.
    await index.add('turn-1', new Float64Array(8).fill(0.5));
    expect(space.identity?.provider).toBe('openai-compatible');

    // The key is gone. The factory does not throw -- that silence is what makes the benchmark
    // runnable without secrets -- so the run continues with 256-dimension hash vectors.
    const fallback = createEmbeddingWithProvenanceFromEnv({});
    const error = await EmbeddingSpace.open({
      model: fallback.embedding,
      index,
      stored: space.identity!,
    })
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmbeddingSpaceError);
    expect((error as EmbeddingSpaceError).reason).toBe('mismatch');
    expect((error as EmbeddingSpaceError).message).toContain('openai-compatible/embedding-3');
    expect((error as EmbeddingSpaceError).message).toContain('hash/(none)');
  });

  it('opens the same store again when the run kept its provider', async () => {
    const env = { ZHIPU_API_KEY: 'k', EMBEDDING_DIMENSIONS: '8' };
    const first = createEmbeddingWithProvenanceFromEnv(env);
    const index = new BruteForceVectorIndex();
    const space = await EmbeddingSpace.open({ model: first.embedding, index });
    await index.add('turn-1', new Float64Array(8).fill(0.5));

    const second = createEmbeddingWithProvenanceFromEnv(env);
    const reopened = await EmbeddingSpace.open({
      model: second.embedding,
      index,
      stored: space.identity!,
    });
    expect(reopened.identity).toEqual(space.identity);
  });
});
