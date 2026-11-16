/**
 * A vector cache that outlives the process, over the `Storage` the deployment already has.
 *
 * ## Why this file exists at all
 *
 * `MemoryEmbeddingCacheStore` is process-lifetime, and `assembleMemory` created one unconditionally. A browser
 * page load therefore re-embeds the whole corpus, and the corpus suite's read phase pays for it a second time
 * after the restart -- measured at five texts and two calls per assembly, which is small enough to be ignored
 * and large enough to be the wrong shape for a product.
 *
 * The interface cannot change: `EmbeddingCacheStore` is synchronous because `EmbeddingMemo.embed` asks about a
 * text inside the loop that decides hit or miss, and an `await` per text would undo the batch ordering the memo
 * keeps. So durability is not a store implementation -- it is a **pair of edges**: hydrate before the assembly,
 * flush after it. This file pins both, and pins the two things that make the pair wrong in ways a green suite
 * would not show:
 *
 * 1. **A vector is a `Float64Array`, and JSON does not store one.** `JSON.stringify(new Float64Array([1, 2]))`
 *    is `{"0":1,"1":2}` -- an object. Every assertion in a naive round-trip test still passes on the *keys*, and
 *    the vector that comes back has length zero and every cosine is `NaN`.
 * 2. **A hydrated entry is not a hit.** Keys are `fingerprint \0 sha256(text)`, so a store hydrated for one
 *    embedding space is invisible to a memo in another. That is the property that keeps one gateway's vectors
 *    from reaching another's, and it is also the reason a durable cache that silently changes its fingerprint
 *    between runs looks exactly like a durable cache that works.
 *
 * ## Why `MemoryStorage` and not a fake
 *
 * Because the subject is the round trip through a `Storage`: `put`, `get`, `del`, `query`. A recorder would
 * assert call order and let a store that never wrote a row pass. `MemoryStorage` is the real contract
 * implementation this package already tests its federation router against, and it is the same code path every
 * backend in `cortex-storage` implements.
 */
import { describe, expect, it } from 'vitest';

import { EmbeddingMemo } from '../cache/embedding-cache.js';
import { StorageEmbeddingCache } from '../cache/storage-embedding-cache.js';
import { MemoryStorage } from './support/memory-storage.js';

/** The table a fresh cache uses, restated here so a rename is a red test rather than a silent one. */
const TABLE = 'embedding_cache';

const KEY_A = 'unstated\u0000aaa';
const KEY_B = 'unstated\u0000bbb';

/** A batched embedder that records its calls and derives its vectors from the text. */
function recordingEmbed(): {
  embed: (texts: string[]) => Promise<Float64Array[]>;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    embed: (texts: string[]) => {
      calls.push([...texts]);
      return Promise.resolve(
        texts.map((text) => Float64Array.from([text.length, text.charCodeAt(0), 7])),
      );
    },
  };
}

describe('a store that survives the process', () => {
  it('gives back what a previous instance flushed', async () => {
    const storage = new MemoryStorage();
    const first = await StorageEmbeddingCache.open(storage);
    first.set(KEY_A, Float64Array.from([1, 2, 3]));
    first.set(KEY_B, Float64Array.from([4, 5, 6]));
    const written = await first.flush();
    expect(written).toEqual({ written: 2, removed: 0 });

    const second = await StorageEmbeddingCache.open(storage);
    expect(second.size()).toBe(2);
    expect(Array.from(second.get(KEY_A) ?? [])).toEqual([1, 2, 3]);
    expect(Array.from(second.get(KEY_B) ?? [])).toEqual([4, 5, 6]);
  });

  it('stores a vector as values, not as the keys of an object', async () => {
    // The defect this pins: `JSON.stringify` of a typed array is `{"0":…}`, so a store that serialises the
    // array by hand and reads it back with `Float64Array.from(row.vector)` gets `NaN`s and a length of zero.
    const storage = new MemoryStorage();
    const store = await StorageEmbeddingCache.open(storage);
    store.set(KEY_A, Float64Array.from([1.5, -2, 0]));
    await store.flush();

    const row = await storage.get<{ key: string; vector: number[] }>(TABLE, KEY_A);
    expect(row?.key).toBe(KEY_A);
    expect(row?.vector).toEqual([1.5, -2, 0]);

    const reopened = await StorageEmbeddingCache.open(storage);
    const vector = reopened.get(KEY_A);
    expect(vector).toBeInstanceOf(Float64Array);
    expect(vector?.length).toBe(3);
    expect(Array.from(vector ?? [])).toEqual([1.5, -2, 0]);
  });

  it('reports a second flush as having nothing left to write', async () => {
    const storage = new MemoryStorage();
    const store = await StorageEmbeddingCache.open(storage);
    store.set(KEY_A, Float64Array.from([1]));
    expect(await store.flush()).toEqual({ written: 1, removed: 0 });
    expect(await store.flush()).toEqual({ written: 0, removed: 0 });
  });

  it('removes in memory at once and on disk at the flush', async () => {
    // Both halves matter. A `delete` that only touched the map would report an erasure the Disk never heard
    // about -- the derived copy that AfterDeleteBench found surviving in 68% of cases. A `delete` that awaited
    // the Disk cannot exist: the eraser's contract is synchronous.
    const storage = new MemoryStorage();
    const store = await StorageEmbeddingCache.open(storage);
    store.set(KEY_A, Float64Array.from([1, 2]));
    await store.flush();

    expect(store.delete(KEY_A)).toBe(true);
    expect(store.get(KEY_A)).toBeUndefined();
    expect(store.size()).toBe(0);
    expect(await storage.get(TABLE, KEY_A)).toBeDefined();

    expect(await store.flush()).toEqual({ written: 0, removed: 1 });
    expect(await storage.get(TABLE, KEY_A)).toBeUndefined();
  });

  it('says a key it never held was not removed, and queues no work for it', async () => {
    const storage = new MemoryStorage();
    const store = await StorageEmbeddingCache.open(storage);
    expect(store.delete(KEY_A)).toBe(false);
    expect(await store.flush()).toEqual({ written: 0, removed: 0 });
  });

  it('copies on both sides, so a caller cannot edit the store through a vector it was handed', async () => {
    const store = await StorageEmbeddingCache.open(new MemoryStorage());
    const handed = Float64Array.from([1, 2, 3]);
    store.set(KEY_A, handed);
    handed[0] = 99;
    expect(Array.from(store.get(KEY_A) ?? [])).toEqual([1, 2, 3]);

    const read = store.get(KEY_A) as Float64Array;
    read[1] = 99;
    expect(Array.from(store.get(KEY_A) ?? [])).toEqual([1, 2, 3]);
  });

  it('skips a row it cannot read and says how many it skipped', async () => {
    // A cache is not a source of truth: one malformed row must not stop a page from loading, and one *silently*
    // malformed row must not be indistinguishable from an empty cache either. Hence the count. Five shapes are
    // refused, and each one is a different way for a row to look present and be useless: no key, a null row, a
    // vector that is not an array, a vector with no components, and a component that is not a finite number.
    const storage = new MemoryStorage();
    await storage.put(TABLE, 'good', { key: 'good', vector: [1, 2] });
    await storage.put(TABLE, 'no-key', { vector: [1, 2] });
    await storage.put(TABLE, 'empty-key', { key: '', vector: [1, 2] });
    await storage.put(TABLE, 'null-row', null);
    await storage.put(TABLE, 'no-vector', { key: 'no-vector' });
    await storage.put(TABLE, 'wrong-type', { key: 'wrong-type', vector: 'nonsense' });
    await storage.put(TABLE, 'empty-vector', { key: 'empty-vector', vector: [] });
    await storage.put(TABLE, 'not-a-number', { key: 'not-a-number', vector: [1, 'a', 3] });
    await storage.put(TABLE, 'nan', { key: 'nan', vector: [1, null, 3] });
    await storage.put(TABLE, 'infinite', {
      key: 'infinite',
      vector: [1, Number.POSITIVE_INFINITY],
    });

    const store = await StorageEmbeddingCache.open(storage);
    expect(store.size()).toBe(1);
    expect(store.get('good')).toBeDefined();
    expect(store.report).toEqual({ hydrated: 1, skipped: 9 });
  });

  it('skips a vector of the wrong width when the caller states one', async () => {
    // The cheapest available answer to "did the embedder change": a stored vector of the old width is not a
    // hit, it is a wrong-space vector that would rank silently. Stating the width is optional because a bare
    // batch function may not know it.
    const storage = new MemoryStorage();
    await storage.put(TABLE, KEY_A, { key: KEY_A, vector: [1, 2, 3] });
    await storage.put(TABLE, KEY_B, { key: KEY_B, vector: [1, 2] });

    const store = await StorageEmbeddingCache.open(storage, { dimension: 3 });
    expect(store.size()).toBe(1);
    expect(store.get(KEY_A)).toBeDefined();
    expect(store.get(KEY_B)).toBeUndefined();
    expect(store.report).toEqual({ hydrated: 1, skipped: 1 });
  });

  it('can still erase a row it declined to read', async () => {
    // The width guard above turns a wrong-space vector into a miss, which is right for retrieval and a trap
    // for erasure: a row that hydration skipped is a copy of a sentence still on disk, and `forget()` on that
    // sentence has to reach it. So the store remembers which keys exist even when it refuses their vectors.
    const storage = new MemoryStorage();
    await storage.put(TABLE, KEY_B, { key: KEY_B, vector: [1, 2] });
    const store = await StorageEmbeddingCache.open(storage, { dimension: 3 });
    expect(store.size()).toBe(0);

    expect(store.delete(KEY_B)).toBe(true);
    expect(await store.flush()).toEqual({ written: 0, removed: 1 });
    expect(await storage.get(TABLE, KEY_B)).toBeUndefined();
  });

  it('uses the table the caller names, and the default when it names none', async () => {
    const storage = new MemoryStorage();
    const elsewhere = await StorageEmbeddingCache.open(storage, { table: 'custom_cache' });
    elsewhere.set(KEY_A, Float64Array.from([1]));
    await elsewhere.flush();
    expect(await storage.get('custom_cache', KEY_A)).toBeDefined();
    expect(await storage.get(TABLE, KEY_A)).toBeUndefined();
    // Echoed so an artifact can name the table the rows are in without restating the default.
    expect(elsewhere.table).toBe('custom_cache');
    expect((await StorageEmbeddingCache.open(storage)).table).toBe(TABLE);
  });
});

describe('what hydration buys, stated as a bill', () => {
  it('makes a second process pay for nothing', async () => {
    // The whole point, in the units the artifact can subtract: the first run sends two texts upstream, the
    // second run sends none, and both produce the same vectors.
    const storage = new MemoryStorage();
    const texts = ['a sentence', 'another sentence'];

    const firstEmbed = recordingEmbed();
    const firstStore = await StorageEmbeddingCache.open(storage);
    const first = new EmbeddingMemo(firstEmbed.embed, {
      store: firstStore,
      fingerprint: 'space-1',
    });
    const firstVectors = await first.embed([...texts]);
    await firstStore.flush();
    expect(first.stats().embedderCalls).toBe(2);

    const secondEmbed = recordingEmbed();
    const secondStore = await StorageEmbeddingCache.open(storage);
    const second = new EmbeddingMemo(secondEmbed.embed, {
      store: secondStore,
      fingerprint: 'space-1',
    });
    const secondVectors = await second.embed([...texts]);

    expect(secondEmbed.calls).toEqual([]);
    expect(second.stats().embedderCalls).toBe(0);
    expect(second.stats().storeHits).toBe(2);
    expect(second.stats().reuseRate).toBe(1);
    expect(secondVectors.map((vector) => Array.from(vector))).toEqual(
      firstVectors.map((vector) => Array.from(vector)),
    );
  });

  it('does not hand one embedding space the other space’s vectors', async () => {
    // A hydrated store is not a hit: the fingerprint is part of every key, so a run that names a different
    // space re-embeds. This is the assertion a durable cache most needs, because its failure mode is a *hit*.
    const storage = new MemoryStorage();
    const texts = ['a sentence'];

    const firstStore = await StorageEmbeddingCache.open(storage);
    await new EmbeddingMemo(recordingEmbed().embed, {
      store: firstStore,
      fingerprint: 'space-1',
    }).embed([...texts]);
    await firstStore.flush();

    const embed = recordingEmbed();
    const secondStore = await StorageEmbeddingCache.open(storage);
    const second = new EmbeddingMemo(embed.embed, { store: secondStore, fingerprint: 'space-2' });
    await second.embed([...texts]);

    expect(embed.calls).toEqual([[...texts]]);
    expect(second.stats().storeHits).toBe(0);
  });
});
