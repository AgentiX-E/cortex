/**
 * A `Storage` over two stores, split by table prefix, with the split made explicit.
 *
 * ## Why this is a pure composition and not a backend
 *
 * Two independent stores already implement `Storage`. Routing between them needs no I/O of its
 * own: no sockets, no files, no clock. So it belongs in `cortex-core` next to
 * `BruteForceVectorIndex`, which is the same kind of object -- a combinator over a contract that
 * can be tested exhaustively with two real implementations and no mocks. Putting it in a backend
 * package would have tied it to one engine and made "does the boundary hold" a question about
 * SQLite rather than about the router.
 *
 * ## Why the scope lives in the table name
 *
 * `Storage` is `put(table, key, value, {tags, ttlMs})` -- six methods, no scope field. Adding one
 * would change a contract every backend implements, and it would put a policy word inside a
 * storage primitive. A namespace prefix (`private/facts`, `shared/facts`) carries the same
 * information in the place an engine already treats as a namespace, which is also how Mem0
 * (`user_id`/`agent_id`/`run_id`) and Redis Agent Memory (namespaced keys) do it.
 *
 * The prefix is a *routing marker*, not part of the name inside a store: `private/facts` and
 * `shared/facts` are both `facts` once routed, otherwise the same logical table would have two
 * names depending on where it lives and a cross-store read would have to know both. The first
 * draft of POC-3 made exactly that mistake and `queryAcross` returned nothing.
 *
 * ## What this refuses to fake
 *
 * A write that would touch both stores in one unit is **not** implemented. Two independent stores
 * have no shared commit point -- two SQLite files certainly do not -- and a router that pretended
 * otherwise would lose half a write on the failure path. `transaction` therefore throws, and the
 * message names the alternative: write one scope, then the other, and reconcile on read.
 */

import type { QueryPredicate, Storage, StorageTransaction } from '../interfaces/storage.js';

/** The two sides of the boundary. There is no third value, and `both` is not a store. */
export type MemoryScope = 'private' | 'shared';

/** A row together with the store it came from. */
export type ScopedRow<T = unknown> = {
  /** Which store returned this row. */
  origin: MemoryScope;
  /**
   * The row's identity, when it has one.
   *
   * `Storage.query` returns values, not entries, so the router cannot always know a key. Values
   * carrying a string `id` are the common case here and that is what is reported. Anything else
   * is `undefined`, and the read-side assembler then keeps both rows: a duplicate that cannot be
   * detected must not be silently collapsed.
   */
  key?: string;
  /** The stored value. */
  value: T;
};

/** Raised when a federation operation cannot be honoured as asked. */
export class FederationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FederationError';
  }
}

/**
 * The scope a table belongs to, from its prefix.
 *
 * Unprefixed tables are **private**: the default has to be the safe one, or a caller who forgets
 * the prefix publishes.
 */
export function scopeOf(table: string): MemoryScope {
  return table.startsWith('shared/') ? 'shared' : 'private';
}

/** Split a table name into the store it routes to and the name it has inside that store. */
function route(table: string): { scope: MemoryScope; name: string } {
  if (table.startsWith('shared/')) return { scope: 'shared', name: table.slice('shared/'.length) };
  if (table.startsWith('private/'))
    return { scope: 'private', name: table.slice('private/'.length) };
  return { scope: 'private', name: table };
}

export class FederatedStorage implements Storage {
  private readonly stores: Record<MemoryScope, Storage>;

  constructor(stores: Record<MemoryScope, Storage>) {
    this.stores = stores;
  }

  /** The store a table routes to, for tests and for callers that must report the layer used. */
  storeFor(table: string): Storage {
    return this.stores[route(table).scope];
  }

  async put(
    table: string,
    key: string,
    value: unknown,
    opts?: { ttlMs?: number; tags?: string[] },
  ): Promise<void> {
    const { scope, name } = route(table);
    await this.stores[scope].put(name, key, value, opts);
  }

  async get<T>(table: string, key: string): Promise<T | undefined> {
    const { scope, name } = route(table);
    return this.stores[scope].get<T>(name, key);
  }

  async del(table: string, key: string): Promise<void> {
    const { scope, name } = route(table);
    await this.stores[scope].del(name, key);
  }

  async query<T>(table: string, predicate?: QueryPredicate): Promise<T[]> {
    const { scope, name } = route(table);
    return this.stores[scope].query<T>(name, predicate);
  }

  /**
   * Query both stores and label every row with where it came from.
   *
   * The label is the point: a window assembled from two origins must be able to say which is
   * which, because the read-side policy is "a shareable answer sees shared rows only" and that
   * decision needs the origin visible at the assembly site rather than inferred from a table name
   * by whoever remembers to check.
   */
  async queryAcross<T>(table: string, predicate?: QueryPredicate): Promise<ScopedRow<T>[]> {
    const { name } = route(table);
    const [local, shared] = await Promise.all([
      this.stores.private.query<T>(name, predicate),
      this.stores.shared.query<T>(name, predicate),
    ]);
    return [
      ...local.map((value) => withOrigin('private', value)),
      ...shared.map((value) => withOrigin('shared', value)),
    ];
  }

  async transaction<T>(_fn: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    // The callback decides the scope, so the scope cannot be known before it runs -- that is the
    // whole reason a two-store commit cannot be offered: the router would have to guess.
    throw new FederationError(
      'a federated transaction cannot be atomic across two stores: pass a single scope with ' +
        '`transactionIn(scope, fn)` and reconcile cross-scope writes on read. Two stores have no ' +
        'shared commit point, and a router that pretended otherwise would lose half a write on ' +
        'the failure path.',
    );
  }

  /**
   * Explicitly scoped transaction, which is what the product should call.
   *
   * The callback receives a **routing** transaction, so table names carry the prefix exactly as
   * they do everywhere else in this class. That uniformity is deliberate: an API where the router
   * takes `private/facts` but its transaction takes `facts` is the kind of inconsistency that
   * produces a write to the wrong store and a very long afternoon.
   *
   * Because the scope is already decided, a table that routes elsewhere is **refused** rather than
   * silently accepted into this transaction: writing to the shared store from inside a private
   * transaction means the caller believes something about the boundary that is not true, and the
   * place to say so is here.
   */
  async transactionIn<T>(
    scope: MemoryScope,
    fn: (tx: StorageTransaction) => Promise<T>,
  ): Promise<T> {
    if (scope !== 'private' && scope !== 'shared') {
      throw new FederationError(
        `unknown scope ${JSON.stringify(scope)}: expected private or shared`,
      );
    }

    const scoped: StorageTransaction = {
      put: async (table, key, value, opts) => {
        this.assertRoutedTo(scope, table);
        await this.stores[scope].put(route(table).name, key, value, opts);
      },
      get: async <V>(table: string, key: string): Promise<V | undefined> => {
        this.assertRoutedTo(scope, table);
        return this.stores[scope].get<V>(route(table).name, key);
      },
      del: async (table, key) => {
        this.assertRoutedTo(scope, table);
        await this.stores[scope].del(route(table).name, key);
      },
    };

    return this.stores[scope].transaction(() => fn(scoped));
  }

  /** Refuse a table name that belongs to the other side of the boundary. */
  private assertRoutedTo(scope: MemoryScope, table: string): void {
    const actual = route(table).scope;
    if (actual !== scope) {
      throw new FederationError(
        `table ${JSON.stringify(table)} routes to the ${actual} store, but this transaction is ` +
          `scoped to ${scope}. A cross-scope write inside one transaction cannot be atomic here; ` +
          `write the other scope in its own transaction and reconcile on read.`,
      );
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.stores.private.close(), this.stores.shared.close()]);
  }
}

/**
 * Tag a row with its origin, and with its identity when the value carries one.
 *
 * Positional fallbacks (`#0`, `#1`) were the obvious shortcut and are wrong: the same position in
 * two stores is two different rows, so a merge keyed on position would collapse unrelated facts
 * and would do it silently.
 */
function withOrigin<T>(origin: MemoryScope, value: T): ScopedRow<T> {
  if (typeof value === 'object' && value !== null && 'id' in value) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string') return { origin, key: id, value };
  }
  return { origin, value };
}
