/**
 * A content-addressed cache in front of any {@link EmbeddingModel}.
 *
 * ## Why the product needs this and not only the evaluation harness
 *
 * Two costs sit in front of every memory product, and only one of them is the reader's. Ingestion embeds every
 * turn; a session that is re-indexed, a corpus that overlaps a previous one, and a retry after a transient
 * failure all re-embed text this process has already paid for. Run `43170314351` priced it on a competitor:
 * **49m42s** of ingest against **54s** of answering, a ratio of 55×. That number is about the corpus rather
 * than about the competitor — 972 sessions of LongMemEval haystack share most of their text between questions,
 * and nothing in the path noticed.
 *
 * The evaluation harness has had a cache for one arm for some time
 * (`cortexMemoryArmEmbeddingCachePath`). This is the same idea at the only place every caller crosses: the
 * `EmbeddingModel` interface the product documents as its extension point, so an injected model gets it too.
 *
 * ## Why a decorator rather than a parameter
 *
 * The call sites are the problem, the same argument `reader-temperature.ts` makes about the sampling field: a
 * cache threaded through options is a cache some future constructor forgets. Wrapping the model cannot be
 * forgotten by a caller that never knew it existed, and it makes the property testable once — "a text is
 * embedded once" — instead of once per call site.
 *
 * ## What it does not change
 *
 * `identity()` is forwarded verbatim, because a cache does not move the vector space. A wrapper that reported a
 * different identity would make `EmbeddingSpace` refuse an index it had itself written, or worse, accept a query
 * it should refuse. The cache is invisible to everything except the bill, and `stats()` is how a report says so.
 *
 * The vectors are not approximated. Same text and same model is the same vector — a functional fact about a
 * deterministic endpoint — so a hit is not "close enough", it is the value that was returned.
 */
import type { EmbeddingIdentity, EmbeddingModel } from '@agentix-e/cortex-core';

/**
 * Where vectors are kept between calls.
 *
 * Deliberately three methods and no iteration: a store that could be enumerated would invite eviction policies,
 * and a policy is a behavioural difference between two runs of one configuration. Durability is the injector's
 * business — an in-memory map for a single run, a file or a database for a deployment — and
 * `MemoryEmbeddingCacheStore` is the default so the option is never absent.
 */
export interface EmbeddingCacheStore {
  get(key: string): Float64Array | undefined;
  set(key: string, vector: Float64Array): void;
  /** Number of distinct texts held. Reported, never used to decide anything. */
  size(): number;
}

/**
 * The default store: a process-lifetime map.
 *
 * Copies on both sides. A stored `Float64Array` handed back by reference can be mutated by a caller, and the
 * next hit would then return a vector the endpoint never produced — a defect that would appear only as a
 * retrieval difference between two runs, which is the hardest kind to attribute.
 */
export class MemoryEmbeddingCacheStore implements EmbeddingCacheStore {
  readonly #vectors = new Map<string, Float64Array>();

  get(key: string): Float64Array | undefined {
    const vector = this.#vectors.get(key);
    return vector === undefined ? undefined : Float64Array.from(vector);
  }

  set(key: string, vector: Float64Array): void {
    this.#vectors.set(key, Float64Array.from(vector));
  }

  size(): number {
    return this.#vectors.size;
  }
}

/**
 * What the cache did, in the units a report can subtract.
 *
 * The three counts partition `textsAsked`, and they are reported separately because they mean different things:
 * a **store hit** is text paid for in an earlier call, a **batch repeat** is the same text twice in one call,
 * and an **embedder call** is a text that cost money. A single "hits" number would merge the first two and make
 * a run that ingests one session look like a run that reused a corpus.
 *
 * `reuseRate` is `null` rather than `0` before anything has been asked, because "nothing has been asked" and
 * "asked and never helped" are different facts and a zero would read as the second.
 */
export type EmbeddingCacheStats = {
  /** Texts the caller asked about, including repeats within one call. */
  readonly textsAsked: number;
  /** Texts served from the store — paid for in an earlier call. */
  readonly storeHits: number;
  /** Texts that repeated an earlier position of the same call, and so cost nothing at all. */
  readonly batchRepeats: number;
  /** Texts sent upstream. The only count that appears on a bill. */
  readonly embedderCalls: number;
  /** `textsAsked - embedderCalls`, i.e. the texts that cost nothing. */
  readonly saved: number;
  /** `saved / textsAsked`, or `null` when nothing has been asked. */
  readonly reuseRate: number | null;
  /** Distinct texts currently held. */
  readonly stored: number;
};

export type CachingEmbeddingOptions = {
  /** Defaults to a fresh {@link MemoryEmbeddingCacheStore}. */
  store?: EmbeddingCacheStore | undefined;
  /**
   * Overrides the cache key.
   *
   * The default is the fingerprint, a NUL, and the text. The endpoint is inside the fingerprint on purpose: the
   * same model id served by two gateways can be two different sets of weights, and a cache keyed on the model
   * alone would hand one gateway's vectors to the other — silently, and only after somebody changed an
   * environment variable.
   *
   * An override that ignores either half is a cache that can return a wrong vector. It exists because a caller may
   * have a store it wants to share across processes, not because the default is negotiable.
   */
  keyOf?: ((fingerprint: string, text: string) => string) | undefined;
};

/** The part of a model's identity that makes two vectors incomparable. */
function fingerprintOf(model: EmbeddingModel): string {
  const identity: EmbeddingIdentity | undefined = model.identity?.();
  if (identity === undefined) {
    // Dimensions alone: an unstated space is not a claim about weights, and refusing to cache is worse than
    // caching under the only fact the model does state — the width its vectors must be read at.
    return `unknown/${String(model.dimension())}`;
  }
  return [identity.provider, identity.model, identity.endpoint, String(identity.dimensions)].join(
    '/',
  );
}

/**
 * The identity of one vector: which space, over exactly which text.
 *
 * ## Why this is not a hash
 *
 * Because the root entry of this package has to load where there is no `node:crypto`, and an import closure test
 * enforces it: a hash here would move the whole product entry behind a Node built-in, which is the browser axis
 * giving up a feature to save a few bytes of map key. The text is already in memory — a `Map` keyed on it holds a
 * reference rather than a copy — so hashing would buy nothing and cost a platform.
 *
 * It is also the more honest key. A collision in a cache is a vector attributed to the wrong text, and a
 * concatenation has no collisions at all; a `sha256` would make that a 2^-128 argument where the direct key makes
 * it a statement. A store that needs a bounded key — a SQLite table, a file name — hashes on its own side, where
 * the platform is known.
 *
 * The NUL is the separator because no model id and no natural text contains one, so `("a", "bc")` and `("ab",
 * "c")` cannot collide.
 */
export function defaultEmbeddingCacheKey(fingerprint: string, text: string): string {
  return `${fingerprint}\u0000${text}`;
}

/**
 * An {@link EmbeddingModel} that embeds each text once.
 *
 * ## Intra-call de-duplication is not an optimisation
 *
 * A batch is often the whole ingest of a session, and a session repeats text — the same user turn quoted back, a
 * system preamble, a template rendered twice. Sending the batch through unchanged and caching only what the
 * store missed would still pay for the repeat inside that batch. De-duplication therefore happens **before** the
 * call, and the assertion is that the upstream sees each distinct text at most once per `embed()`.
 *
 * ## Order is the contract
 *
 * The result has the same length and the same order as the input. Positions are recorded per text and the array
 * is filled by index, because a batch reassembled in store-iteration order would hand a question another
 * question's vector and every other assertion in the test file would still pass.
 */
export class CachingEmbedding implements EmbeddingModel {
  readonly #inner: EmbeddingModel;
  readonly #store: EmbeddingCacheStore;
  readonly #keyOf: (fingerprint: string, text: string) => string;
  readonly #fingerprint: string;

  #textsAsked = 0;
  #storeHits = 0;
  #batchRepeats = 0;
  #embedderCalls = 0;

  constructor(inner: EmbeddingModel, options: CachingEmbeddingOptions = {}) {
    this.#inner = inner;
    this.#store = options.store ?? new MemoryEmbeddingCacheStore();
    this.#keyOf = options.keyOf ?? defaultEmbeddingCacheKey;
    this.#fingerprint = fingerprintOf(inner);
    const stated = inner.identity;
    // Assigned only when the wrapped model states one: under `exactOptionalPropertyTypes` an absent optional
    // property and a property whose value is `undefined` are different types, and the interface's is the first.
    if (stated !== undefined) {
      this.identity = () => stated.call(inner);
    }
  }

  dimension(): number {
    return this.#inner.dimension();
  }

  /**
   * Forwarded, not decorated — and absent when the wrapped model states none.
   *
   * A cache is not a space. Reporting a different identity here would make a store refuse an index it wrote
   * itself, because `EmbeddingSpace` compares identities and treats a difference as a reason to refuse a query;
   * a wrapper that changed this string would break retrieval while passing an accuracy test on a cold cache.
   *
   * It is an optional property rather than a method because the interface declares it optional: a class method
   * cannot be conditionally present, and answering `undefined` from a method that the interface says returns an
   * identity would be a lie the type checker rejects. Bound once, at construction, so a wrapped model that gains
   * an identity later cannot make two calls to this wrapper describe two different spaces.
   */
  readonly identity?: () => EmbeddingIdentity;

  async embed(texts: string[]): Promise<Float64Array[]> {
    if (texts.length === 0) {
      return [];
    }
    this.#textsAsked += texts.length;

    // One pass to decide, one call for the distinct misses, one assembly pass by index.
    const positions = new Map<string, number[]>();
    const resolved = new Map<string, Float64Array>();
    const pending: string[] = [];
    for (const [index, text] of texts.entries()) {
      const at = positions.get(text);
      if (at !== undefined) {
        at.push(index);
        this.#batchRepeats += 1;
        continue;
      }
      positions.set(text, [index]);
      const stored = this.#store.get(this.#keyOf(this.#fingerprint, text));
      if (stored === undefined) {
        pending.push(text);
      } else {
        resolved.set(text, stored);
        this.#storeHits += 1;
      }
    }

    if (pending.length > 0) {
      const fetched = await this.#inner.embed(pending);
      if (fetched.length !== pending.length) {
        throw new Error(
          `CachingEmbedding: the wrapped model returned ${String(fetched.length)} vector(s) for ` +
            `${String(pending.length)} text(s). A short reply cannot be mapped back to the batch, and guessing ` +
            "which text lost its vector would attribute one text's embedding to another.",
        );
      }
      this.#embedderCalls += pending.length;
      for (const [offset, text] of pending.entries()) {
        const vector = fetched[offset] as Float64Array;
        resolved.set(text, vector);
        this.#store.set(this.#keyOf(this.#fingerprint, text), vector);
      }
    }

    const out: Float64Array[] = new Array<Float64Array>(texts.length);
    for (const [text, indexes] of positions) {
      // Every distinct text is in `resolved` by construction — either a store hit, assigned where the hit was
      // found, or a fetch, assigned from `fetched` — so there is no branch to take here. The assertion is
      // `noUncheckedIndexedAccess`'s price for a map lookup, paid once rather than as a dead `if` that no test
      // could ever cover.
      const vector = resolved.get(text) as Float64Array;
      for (const index of indexes) {
        out[index] = Float64Array.from(vector);
      }
    }
    return out;
  }

  /** What the cache did. Read, never reset — a report asks once, at the end. */
  stats(): EmbeddingCacheStats {
    const saved = this.#textsAsked - this.#embedderCalls;
    return {
      textsAsked: this.#textsAsked,
      storeHits: this.#storeHits,
      batchRepeats: this.#batchRepeats,
      embedderCalls: this.#embedderCalls,
      saved,
      reuseRate: this.#textsAsked === 0 ? null : saved / this.#textsAsked,
      stored: this.#store.size(),
    };
  }
}
