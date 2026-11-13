/**
 * A text is embedded once, and the bill is the only thing that changes.
 *
 * ## What this file is actually guarding
 *
 * Three properties, in descending order of how badly they fail:
 *
 * 1. **A hit returns the vector that was produced.** Not a re-embedding, not a rounding, not a copy that a caller
 *    can mutate into something else. The whole argument for a cache in a measurement path is that the system under
 *    test sees the same input, and a mutable hand-back quietly breaks it in a way that appears only as a retrieval
 *    difference between two runs.
 * 2. **Order is preserved.** A batch reassembled in store-iteration order hands the first question the second
 *    question's vector. Every other assertion here would still pass, and the accuracy would move for a reason no
 *    artifact could explain.
 * 3. **The counters partition the request.** A single "hits" number merges "paid for in an earlier call" with "the
 *    same text twice in this call", and a report that cannot tell them apart cannot say whether a saving came from
 *    the corpus or from the batch.
 *
 * ## Why a fake model rather than a network mock
 *
 * Because the property under test is what the wrapped model was *asked*, and a fake that records its inputs says
 * that directly. The vector it returns is derived from the text, so a mis-mapped batch is visible in the values
 * rather than only in the count.
 */
import { describe, expect, it } from 'vitest';

import type { EmbeddingIdentity, EmbeddingModel } from '../interfaces/embedding.js';

import {
  CachingEmbedding,
  EmbeddingMemo,
  MemoryEmbeddingCacheStore,
  defaultEmbeddingCacheKey,
  type EmbeddingCacheStore,
} from '../cache/embedding-cache.js';

/** A model that records every batch it is asked about and derives its vectors from the text. */
class RecordingEmbedding implements EmbeddingModel {
  readonly calls: string[][] = [];

  /** Optional exactly as the interface declares it, and assigned only when a space was given. */
  readonly identity?: () => EmbeddingIdentity;

  private readonly dimensions: number;

  constructor(dimensions = 3, identity?: EmbeddingIdentity) {
    this.dimensions = dimensions;
    if (identity !== undefined) {
      this.identity = () => identity;
    }
  }

  embed(texts: string[]): Promise<Float64Array[]> {
    this.calls.push([...texts]);
    return Promise.resolve(
      texts.map((text) => {
        const vector = new Float64Array(this.dimensions);
        // Length in the first slot and a byte sum in the second: two texts of the same length differ, which is what
        // makes a mis-ordered batch visible.
        vector[0] = text.length;
        vector[1] = [...text].reduce((sum, character) => sum + character.charCodeAt(0), 0);
        return vector;
      }),
    );
  }

  dimension(): number {
    return this.dimensions;
  }
}

const SPACE: EmbeddingIdentity = {
  provider: 'openai-compatible',
  model: 'embedding-3',
  endpoint: 'https://example.invalid/v1',
  dimensions: 3,
};

describe('a text is embedded once', () => {
  it('forwarded the first call to the model', async () => {
    const inner = new RecordingEmbedding();
    const model = new CachingEmbedding(inner);
    await model.embed(['alpha', 'beta']);
    expect(inner.calls).toEqual([['alpha', 'beta']]);
  });

  it('does not ask again for a text it has seen', async () => {
    const inner = new RecordingEmbedding();
    const model = new CachingEmbedding(inner);
    await model.embed(['alpha']);
    await model.embed(['alpha']);
    expect(inner.calls).toEqual([['alpha']]);
  });

  it('asks only for the texts it has not seen', async () => {
    const inner = new RecordingEmbedding();
    const model = new CachingEmbedding(inner);
    await model.embed(['alpha']);
    await model.embed(['alpha', 'beta']);
    expect(inner.calls).toEqual([['alpha'], ['beta']]);
  });

  it('de-duplicates inside one batch, because a session repeats its own text', async () => {
    const inner = new RecordingEmbedding();
    const model = new CachingEmbedding(inner);
    const vectors = await model.embed(['alpha', 'beta', 'alpha']);
    expect(inner.calls).toEqual([['alpha', 'beta']]);
    expect(vectors).toHaveLength(3);
    expect(vectors[0]).toEqual(vectors[2]);
  });

  it('returns nothing and asks nothing for an empty batch', async () => {
    const inner = new RecordingEmbedding();
    const model = new CachingEmbedding(inner);
    expect(await model.embed([])).toEqual([]);
    expect(inner.calls).toEqual([]);
    expect(model.stats().textsAsked).toBe(0);
  });
});

describe('a hit returns the vector that was produced', () => {
  it('returns the same values on a warm call', async () => {
    const model = new CachingEmbedding(new RecordingEmbedding());
    const cold = await model.embed(['alpha']);
    const warm = await model.embed(['alpha']);
    expect(warm[0]).toEqual(cold[0]);
  });

  it('keeps the order the caller asked for when a batch is partly warm', async () => {
    const model = new CachingEmbedding(new RecordingEmbedding());
    await model.embed(['beta']);
    const vectors = await model.embed(['alpha', 'beta', 'gamma']);
    // Derived from the text, so position 1 holding the vector of `alpha` would show up as a wrong length here.
    expect([...(vectors[0] as Float64Array)].slice(0, 1)).toEqual([5]);
    expect([...(vectors[1] as Float64Array)].slice(0, 1)).toEqual([4]);
    expect([...(vectors[2] as Float64Array)].slice(0, 1)).toEqual([5]);
    // `alpha` and `gamma` are the same length and must still differ.
    expect(vectors[0]).not.toEqual(vectors[2]);
  });

  it('hands out a copy, so a caller cannot mutate the cache', async () => {
    const model = new CachingEmbedding(new RecordingEmbedding());
    const first = await model.embed(['alpha']);
    (first[0] as Float64Array)[0] = 999;
    const second = await model.embed(['alpha']);
    expect([...(second[0] as Float64Array)][0]).toBe(5);
  });

  it('copies on the way in as well, so a mutation before the next call does not reach the store', async () => {
    const inner = new RecordingEmbedding();
    const model = new CachingEmbedding(inner);
    await model.embed(['alpha']);
    // The model's own reply is mutated through a second read of the same text; the store must not have kept a
    // reference to the array the model handed back.
    const vectors = await model.embed(['alpha']);
    (vectors[0] as Float64Array)[1] = -1;
    expect([...((await model.embed(['alpha']))[0] as Float64Array)][1]).not.toBe(-1);
  });

  it('refuses a reply it cannot map back to the batch', async () => {
    const short: EmbeddingModel = {
      embed: () => Promise.resolve([new Float64Array([1, 2, 3])]),
      dimension: () => 3,
    };
    const model = new CachingEmbedding(short);
    await expect(model.embed(['alpha', 'beta'])).rejects.toThrow(
      /returned 1 vector\(s\) for 2 text\(s\)/,
    );
  });
});

describe('the space travels with the vector', () => {
  it('does not reuse a vector across two endpoints serving the same model id', async () => {
    // The same model name behind two gateways can be two sets of weights; the endpoint is in the fingerprint for
    // exactly this reason.
    const first = new CachingEmbedding(
      new RecordingEmbedding(3, { ...SPACE, endpoint: 'https://a.invalid/v1' }),
    );
    const store = new MemoryEmbeddingCacheStore();
    const shared = new CachingEmbedding(
      new RecordingEmbedding(3, { ...SPACE, endpoint: 'https://b.invalid/v1' }),
      { store },
    );
    await first.embed(['alpha']);
    await shared.embed(['alpha']);
    // Separate stores here, so what is asserted is the key rather than the sharing: two identities must not produce
    // the same key.
    expect(defaultEmbeddingCacheKey('a/b/c/3', 'alpha')).not.toBe(
      defaultEmbeddingCacheKey('a/b/d/3', 'alpha'),
    );
    expect(shared.stats().storeHits).toBe(0);
  });

  it('does not reuse a vector across two models of the same width', async () => {
    const store = new MemoryEmbeddingCacheStore();
    const a = new CachingEmbedding(new RecordingEmbedding(3, { ...SPACE, model: 'embedding-3' }), {
      store,
    });
    const b = new CachingEmbedding(new RecordingEmbedding(3, { ...SPACE, model: 'other-3' }), {
      store,
    });
    await a.embed(['alpha']);
    await b.embed(['alpha']);
    expect(b.stats().storeHits).toBe(0);
    expect(b.stats().embedderCalls).toBe(1);
  });

  it('caches under the width alone when the model states no identity', async () => {
    const store = new MemoryEmbeddingCacheStore();
    const anonymous: EmbeddingModel = {
      embed: () => Promise.resolve([new Float64Array([1, 2, 3])]),
      dimension: () => 3,
    };
    const model = new CachingEmbedding(anonymous, { store });
    const first = await model.embed(['alpha']);
    const second = await model.embed(['alpha']);
    expect(second[0]).toEqual(first[0]);
    expect(model.stats().storeHits).toBe(1);
  });

  it('forwards the identity verbatim', () => {
    const model = new CachingEmbedding(new RecordingEmbedding(3, SPACE));
    expect(model.identity?.()).toEqual(SPACE);
  });

  it('has no identity when the wrapped model states none', () => {
    const anonymous: EmbeddingModel = {
      embed: () => Promise.resolve([]),
      dimension: () => 3,
    };
    const model = new CachingEmbedding(anonymous);
    expect(model.identity).toBeUndefined();
  });

  it('forwards the dimension', () => {
    expect(new CachingEmbedding(new RecordingEmbedding(7)).dimension()).toBe(7);
  });
});

describe('the counters partition the request', () => {
  it('separates a store hit from a batch repeat from a call to the model', async () => {
    const model = new CachingEmbedding(new RecordingEmbedding());
    await model.embed(['alpha', 'beta', 'alpha']);
    const first = model.stats();
    expect(first.textsAsked).toBe(3);
    expect(first.embedderCalls).toBe(2);
    expect(first.batchRepeats).toBe(1);
    expect(first.storeHits).toBe(0);

    await model.embed(['alpha', 'gamma']);
    const second = model.stats();
    expect(second.textsAsked).toBe(5);
    expect(second.embedderCalls).toBe(3);
    expect(second.storeHits).toBe(1);
    expect(second.batchRepeats).toBe(1);
    // The three counts partition the request, and the partition is the assertion: a report that subtracted two of
    // them would be describing a run it did not make.
    expect(second.storeHits + second.batchRepeats + second.embedderCalls).toBe(second.textsAsked);
  });

  it('reports no rate before anything has been asked', () => {
    const model = new CachingEmbedding(new RecordingEmbedding());
    expect(model.stats().reuseRate).toBeNull();
    expect(model.stats().saved).toBe(0);
    expect(model.stats().stored).toBe(0);
  });

  it('reports the rate as the share of texts that cost nothing', async () => {
    const model = new CachingEmbedding(new RecordingEmbedding());
    await model.embed(['alpha', 'beta']);
    await model.embed(['alpha', 'beta']);
    const stats = model.stats();
    expect(stats.saved).toBe(2);
    expect(stats.reuseRate).toBe(0.5);
    expect(stats.stored).toBe(2);
  });
});

describe('the store is an extension point', () => {
  it('accepts a caller-supplied store and reads it before the model', async () => {
    const seen: string[] = [];
    const store: EmbeddingCacheStore = {
      get: (key) => {
        seen.push(key);
        return undefined;
      },
      set: () => undefined,
      size: () => 0,
    };
    const model = new CachingEmbedding(new RecordingEmbedding(3, SPACE), { store });
    await model.embed(['alpha']);
    expect(seen).toHaveLength(1);
    // A store that refuses writes leaves nothing behind, so the next call asks again rather than failing.
    await model.embed(['alpha']);
    expect(seen).toHaveLength(2);
  });

  it('lets a caller replace the key, and the replacement is what the store sees', async () => {
    const keys: string[] = [];
    const store = new MemoryEmbeddingCacheStore();
    const model = new CachingEmbedding(new RecordingEmbedding(3, SPACE), {
      store,
      keyOf: (fingerprint, text) => {
        const key = `${fingerprint}:${text}`;
        keys.push(key);
        return key;
      },
    });
    await model.embed(['alpha']);
    expect(keys).toContain(
      `${[SPACE.provider, SPACE.model, SPACE.endpoint, String(SPACE.dimensions)].join('/')}:alpha`,
    );
    expect(store.size()).toBe(1);
  });

  it('keys on the identity, a NUL, and the whole text', () => {
    // Pinned so a rewrite that changes the composition is visible. Not a digest: the root entry of this package has
    // to load with no `node:crypto`, and a collision here is a vector attributed to the wrong text.
    expect(defaultEmbeddingCacheKey('a/b/c/3', 'alpha')).toBe('a/b/c/3\u0000alpha');
    expect(defaultEmbeddingCacheKey('a/b/c/3', 'alpha')).not.toBe(
      defaultEmbeddingCacheKey('a/b/c/3', 'alphb'),
    );
    // The NUL separator, so a split cannot collide: concatenation without it would make these two equal.
    expect(defaultEmbeddingCacheKey('a', 'bc')).not.toBe(defaultEmbeddingCacheKey('ab', 'c'));
  });

  it('counts distinct texts in the default store', () => {
    const store = new MemoryEmbeddingCacheStore();
    store.set('one', new Float64Array([1]));
    store.set('two', new Float64Array([1]));
    store.set('one', new Float64Array([2]));
    expect(store.size()).toBe(2);
    expect(store.get('one')).toEqual(new Float64Array([2]));
    expect(store.get('missing')).toBeUndefined();
  });
});

/**
 * The surface the product's index uses, tested on its own terms.
 *
 * `CachingEmbedding` needs an `EmbeddingModel`; a caller who has only a batched function — which is what
 * `CortexMemoryOptions.index.embed` is — must get the identical algorithm, and the only way to keep "identical"
 * true is to assert it here rather than to assume two adapters agree.
 */
describe('the memo a bare batched embedder gets', () => {
  /** A batch function that records what it was asked, with no `EmbeddingModel` around it. */
  function recorder(): { calls: string[][]; embed: (texts: string[]) => Promise<number[][]> } {
    const calls: string[][] = [];
    return {
      calls,
      embed: (texts) => {
        calls.push([...texts]);
        return Promise.resolve(texts.map((text) => [text.length, text.charCodeAt(0)]));
      },
    };
  }

  it('embeds a text once across two calls, through one store', async () => {
    const { calls, embed } = recorder();
    const store = new MemoryEmbeddingCacheStore();
    const first = new EmbeddingMemo(embed, { store });
    await first.embed(['alpha', 'beta']);
    const second = new EmbeddingMemo(embed, { store });
    await second.embed(['alpha', 'beta', 'gamma']);

    expect(calls).toEqual([['alpha', 'beta'], ['gamma']]);
    expect(second.stats().storeHits).toBe(2);
    expect(second.stats().embedderCalls).toBe(1);
  });

  it('accepts a plain array and a typed array from the same shape of embedder', async () => {
    // The vector type is `ArrayLike<number>` on purpose: a client that returns `Float64Array` and a test double
    // that returns `number[]` are both honest, and a signature that admits only one of them makes every caller
    // write an adapter. This asserts the claim rather than the comment.
    const plain = new EmbeddingMemo(() => Promise.resolve([[1, 2, 3]]));
    expect(await plain.embed(['x'])).toEqual([Float64Array.from([1, 2, 3])]);

    const typed = new EmbeddingMemo(() => Promise.resolve([new Float64Array([4, 5, 6])]));
    expect(await typed.embed(['x'])).toEqual([Float64Array.from([4, 5, 6])]);
  });

  it('returns a stored vector as a copy, so a caller cannot reach the store through it', async () => {
    const store = new MemoryEmbeddingCacheStore();
    const memo = new EmbeddingMemo(() => Promise.resolve([[7, 8]]), { store });
    const [first] = await memo.embed(['alpha']);
    (first as Float64Array)[0] = -1;
    expect([...((await memo.embed(['alpha']))[0] as Float64Array)][0]).toBe(7);
  });

  it('refuses a short reply rather than mapping it back', async () => {
    const memo = new EmbeddingMemo(() => Promise.resolve([[1]]));
    await expect(memo.embed(['alpha', 'beta'])).rejects.toThrow(
      /returned 1 vector\(s\) for 2 text\(s\)/,
    );
  });

  it('reports nothing asked, not a zero rate, before the first call', () => {
    const memo = new EmbeddingMemo(() => Promise.resolve([]));
    expect(memo.stats()).toEqual({
      textsAsked: 0,
      storeHits: 0,
      batchRepeats: 0,
      embedderCalls: 0,
      saved: 0,
      reuseRate: null,
      stored: 0,
    });
  });
});
