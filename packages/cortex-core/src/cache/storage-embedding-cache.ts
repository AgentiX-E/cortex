/**
 * The same vector cache, kept on the `Storage` a deployment already has.
 *
 * ## Why durability is a pair of edges rather than a store
 *
 * {@link EmbeddingCacheStore} is synchronous on purpose: `EmbeddingMemo.embed` asks `get(key)` inside the loop
 * that decides hit or miss, and an `await` per text would give up the batch ordering the memo exists to keep.
 * Every durable backend this repository ships is asynchronous -- a SQLite worker behind a `MessageChannel`,
 * `IndexedDB`, a Postgres socket -- so a *durable* synchronous store is not available at any price. The two
 * honest shapes left are "a synchronous cache that is durable at `flush()`" and "no durable cache", and the
 * second one is what `assembleMemory` had: a page load re-embeds the corpus and the read phase after a restart
 * pays again.
 *
 * So this class is memory for the duration of an assembly and a journal across it:
 *
 * ```ts
 * const cache = await StorageEmbeddingCache.open(storage, { dimension: 16 });
 * const { memory } = assembleMemory({ storage, embed, profile: 'full', shared, embeddingStore: cache });
 * // … ask, remember, forget …
 * await cache.flush();
 * ```
 *
 * ## Why `Storage` and not a backend of its own
 *
 * Because the product already ships four of them (`sqlite`, `pg`, `opfs`, `idb`), and a fifth interface with
 * four more implementations would be a fifth place for an erasure to be forgotten. A row in the transcript's
 * own store is also the only shape in which the erasure requirement can be stated as *one* rule: whatever
 * `forget()` reaches in the tables, it reaches here too, because it is the same `Storage`.
 *
 * ## The three ways this class can be silently wrong, and what stops each
 *
 * 1. **A vector serialised as JSON.** `JSON.stringify(new Float64Array([1, 2]))` is `{"0":1,"1":2}`; a reader
 *    that does `Float64Array.from(row.vector)` on that gets a length of zero, and every cosine is `NaN`.
 *    {@link StoredVector} writes `Array.from(...)`, and `storage-embedding-cache.test.ts` reads the row back
 *    through `Storage` rather than through this class to prove it.
 * 2. **A hit from another embedding space.** The key is `fingerprint \0 sha256(text)`, so hydration alone is
 *    not reuse -- see {@link #hydrated}. The test that matters asserts the *bill*: the second run's embedder is
 *    called with nothing.
 * 3. **A row that survives the erasure of its text.** A hydration that skips a row (wrong width, unreadable)
 *    would otherwise make that row unreachable *and* undeletable, which is exactly the derived copy
 *    AfterDeleteBench measured surviving in 68% of cases. So the keys are remembered even when the vectors are
 *    refused, and `delete` reaches them.
 *
 * ## Why `flush` returns counts instead of `void`
 *
 * Because "the erasure reached the disk" is the claim worth reporting, and a count is the only form of it a
 * report can subtract. A `flush()` that wrote nothing after a `forget()` is a finding rather than a no-op.
 */
import type { Storage } from '../interfaces/storage.js';

import type { EmbeddingCacheStore } from './embedding-cache.js';

/** The table this store writes to when the caller names none. */
export const DEFAULT_EMBEDDING_CACHE_TABLE = 'embedding_cache';

/**
 * One row, as it sits in the store's table.
 *
 * The key appears twice on purpose: once as the row key, which is what `Storage.del` needs, and once as a
 * field, because `Storage.query` returns values without their keys -- a hydrating reader that trusted the row
 * key would have nothing to read. The duplication costs a digest per row and removes a whole class of
 * "hydrated under the wrong name" defect.
 */
type StoredVector = {
  /** The composed cache key: `fingerprint \0 sha256(text)`. No plaintext, by construction. */
  readonly key: string;
  /** The components, as an array. See point 1 in the class comment. */
  readonly vector: readonly number[];
};

export type StorageEmbeddingCacheOptions = {
  /** Defaults to {@link DEFAULT_EMBEDDING_CACHE_TABLE}. */
  readonly table?: string | undefined;
  /**
   * The width every vector in this space has, when the caller knows it.
   *
   * A stated width turns a stored vector of another width into a miss rather than into a hit, which is the
   * cheapest available answer to "the embedder changed and the cache did not". Optional because a bare batch
   * function has no `dimension()` to ask, and refusing to hydrate without one would make the option unusable
   * for exactly the callers `EmbedFn` was introduced for.
   */
  readonly dimension?: number | undefined;
};

/** What hydration found. Reported, never used to decide anything. */
export type StorageEmbeddingCacheReport = {
  /** Rows whose vector was read and is usable. */
  readonly hydrated: number;
  /** Rows that were present and refused: unreadable, or of a width the caller ruled out. */
  readonly skipped: number;
};

export class StorageEmbeddingCache implements EmbeddingCacheStore {
  readonly #storage: Storage;
  readonly #table: string;
  readonly #vectors = new Map<string, Float64Array>();
  /** Keys known to sit on the disk, including the ones whose vectors were refused. See point 3. */
  readonly #known = new Set<string>();
  /** Keys whose disk state no longer matches memory: `undefined` marks a removal. */
  readonly #pending = new Map<string, Float64Array | undefined>();
  /**
   * What `open` found.
   *
   * Mutable for exactly one statement -- the one at the end of {@link StorageEmbeddingCache.open} -- because
   * the counts are known only after the loop that fills the store. A second instance built with the finished
   * counts would have been the obvious alternative and would have been empty: the vectors live on the
   * instance that read them.
   */
  #report: StorageEmbeddingCacheReport = { hydrated: 0, skipped: 0 };

  private constructor(storage: Storage, table: string) {
    this.#storage = storage;
    this.#table = table;
  }

  /**
   * Read every row the table holds, then answer `get` from memory.
   *
   * One query rather than lazy reads per key, because the alternative is a synchronous `get` that cannot ask
   * an asynchronous store -- and because the whole saving is decided before the first question is asked.
   */
  static async open(
    storage: Storage,
    options: StorageEmbeddingCacheOptions = {},
  ): Promise<StorageEmbeddingCache> {
    const table = options.table ?? DEFAULT_EMBEDDING_CACHE_TABLE;
    const rows = await storage.query<StoredVector>(table);
    const cache = new StorageEmbeddingCache(storage, table);

    let hydrated = 0;
    let skipped = 0;
    for (const row of rows) {
      const key = keyOf(row);
      if (key === undefined) {
        skipped += 1;
        continue;
      }
      cache.#known.add(key);
      const vector = vectorOf(row, options.dimension);
      if (vector === undefined) {
        skipped += 1;
        continue;
      }
      cache.#vectors.set(key, vector);
      hydrated += 1;
    }

    cache.#report = { hydrated, skipped };
    return cache;
  }

  /**
   * What hydration did.
   *
   * A copy, so a caller reading it twice cannot see it change: the counts are a property of `open` rather than
   * a running tally, and a report that drifted would be a report that describes when it was read.
   */
  get report(): StorageEmbeddingCacheReport {
    return this.#report;
  }

  /** The table this store reads and writes. Echoed so an artifact can name it. */
  get table(): string {
    return this.#table;
  }

  get(key: string): Float64Array | undefined {
    const vector = this.#vectors.get(key);
    return vector === undefined ? undefined : Float64Array.from(vector);
  }

  set(key: string, vector: Float64Array): void {
    const copy = Float64Array.from(vector);
    this.#vectors.set(key, copy);
    this.#known.add(key);
    this.#pending.set(key, copy);
  }

  delete(key: string): boolean {
    const held = this.#vectors.delete(key);
    // A key that only ever existed on the disk still counts as removed, and still has to be removed: it is a
    // copy of the text, which is the whole reason this method is on the interface. `held` alone would report
    // the erasure as complete over a row it never touched.
    const known = this.#known.delete(key);
    if (held || known) this.#pending.set(key, undefined);
    return held || known;
  }

  size(): number {
    return this.#vectors.size;
  }

  /**
   * Write what changed, and say how much.
   *
   * Per key rather than a rewrite of the table: a rewrite would be one transaction and fewer round trips, and
   * it would also delete every row of another space that shares the file -- the fingerprint scoping that makes
   * this store safe across embedders would fail exactly when two of them use one transcript.
   */
  async flush(): Promise<{ written: number; removed: number }> {
    let written = 0;
    let removed = 0;
    // `[...this.#pending]` rather than iterating the map: `await` inside a `for…of` over a `Map` is safe here
    // because nothing else mutates it, but the snapshot makes that a property of the code rather than of the
    // callers.
    for (const [key, vector] of [...this.#pending]) {
      if (vector === undefined) {
        await this.#storage.del(this.#table, key);
        removed += 1;
      } else {
        const row: StoredVector = { key, vector: Array.from(vector) };
        await this.#storage.put(this.#table, key, row);
        written += 1;
      }
    }
    this.#pending.clear();
    return { written, removed };
  }
}

/** The row's key, or `undefined` when the row is not shaped like an entry at all. */
function keyOf(row: StoredVector | null | undefined): string | undefined {
  // `null | undefined` are part of the parameter type rather than a defensive check: these rows come out of a
  // `Storage` that has held whatever the deployment put there, and a value of `null` is one `JSON.parse` away
  // from an empty object. A key that is absent, not a string, or empty is a row this store cannot address.
  if (row === null || row === undefined) return undefined;
  const key = row.key;
  return typeof key === 'string' && key.length > 0 ? key : undefined;
}

/**
 * The row's vector as a `Float64Array`, or `undefined` when it cannot be read.
 *
 * Every component is checked rather than trusted: a `null` in the array becomes `0` in `Float64Array.from`,
 * and a zero where a coordinate was missing is a vector that looks valid and retrieves nothing.
 */
function vectorOf(row: StoredVector, dimension: number | undefined): Float64Array | undefined {
  const vector = row.vector;
  if (!Array.isArray(vector) || vector.length === 0) return undefined;
  if (dimension !== undefined && vector.length !== dimension) return undefined;
  for (const component of vector) {
    if (typeof component !== 'number' || !Number.isFinite(component)) return undefined;
  }
  return Float64Array.from(vector);
}
