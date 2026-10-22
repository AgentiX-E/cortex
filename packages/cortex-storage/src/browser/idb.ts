/**
 * The fallback tier: `Storage` over IndexedDB, for a browser where OPFS is not usable.
 *
 * ## What it is for, and what it costs
 *
 * OPFS fails in places a product cannot ignore: a private-browsing tab, a browser too old to have
 * the access-handle pool, a profile where the quota is gone. The choice there is between losing the
 * user's memory entirely and keeping it somewhere less good. This is "somewhere less good".
 *
 * The costs are stated rather than hidden, because a fallback that pretends to be the primary tier
 * is how a durability guarantee quietly disappears:
 *
 *   * **`transaction()` refuses.** IndexedDB transactions auto-commit when control returns to the
 *     event loop, so an `await` inside the body ends the transaction. There is no way to hold one
 *     open across the body of an async function, and a version that merely *claims* atomicity is
 *     worse than one that says it cannot -- that is the exact defect this repository already fixed
 *     once in the SQL backend.
 *   * **No SQL.** Rows are objects in one store, so the tag filter and the pagination happen in
 *     JavaScript, over the table's index. Fine at the scale this tier is meant for; not a database.
 *
 * ## Why it still shares the query helpers
 *
 * `selectPage` is the same function the SQL backends call, so "filter tags, then page" cannot mean
 * two different things depending on which tier a user landed on. Mapping records to the same
 * `{ value, tags }` shape is the whole adaptation.
 */
import type {
  PutOptions,
  QueryPredicate,
  Storage,
  StorageTransaction,
} from '@agentix-e/cortex-core';
import { selectPage, type KvRow } from '../storage/sql.js';

const STORE = 'kv';
const BY_TABLE = 'by_table';
const BY_EXPIRY = 'by_expiry';

/** One row as IndexedDB holds it. Strings for the JSON payloads, so the helpers can be shared. */
type IdbRecord = {
  table: string;
  key: string;
  value: string;
  tags: string;
  expiresAt: number | null;
};

/** Raised when a caller asks the fallback tier for a real transaction. */
export class TransactionUnsupportedError extends Error {
  constructor() {
    super(
      'IndexedDB transactions cannot span an await: the transaction auto-commits as soon as control ' +
        'returns to the event loop, so an async body would run outside it. This tier does not ' +
        'provide atomicity rather than claiming it. Use the OPFS tier, or write compensating logic.',
    );
    this.name = 'TransactionUnsupportedError';
  }
}

export class IdbStorage implements Storage {
  #closed = false;

  constructor(private readonly db: IDBDatabase) {}

  async put(table: string, key: string, value: unknown, opts?: PutOptions): Promise<void> {
    this.#assertUsable();
    const expiresAt = opts?.ttlMs !== undefined ? Date.now() + opts.ttlMs : null;
    const record: IdbRecord = {
      table,
      key,
      value: JSON.stringify(value),
      tags: JSON.stringify(opts?.tags ?? []),
      expiresAt,
    };

    const tx = this.db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    await complete(tx);
    await this.#purge(table);
  }

  async get<T>(table: string, key: string): Promise<T | undefined> {
    this.#assertUsable();
    await this.#purge(table);

    const tx = this.db.transaction(STORE, 'readonly');
    const record = await request<IdbRecord | undefined>(tx.objectStore(STORE).get([table, key]));
    await complete(tx);
    return record === undefined ? undefined : (JSON.parse(record.value) as T);
  }

  async del(table: string, key: string): Promise<void> {
    this.#assertUsable();
    const tx = this.db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete([table, key]);
    await complete(tx);
  }

  async query<T>(table: string, predicate: QueryPredicate = {}): Promise<T[]> {
    this.#assertUsable();
    await this.#purge(table);

    const tx = this.db.transaction(STORE, 'readonly');
    const records = await request<IdbRecord[]>(
      tx.objectStore(STORE).index(BY_TABLE).getAll(IDBKeyRange.only(table)),
    );
    await complete(tx);

    // The prefix test is `startsWith`, which is literal and case-sensitive -- the same semantics as
    // the SQL tier's `substr`, chosen so that a key containing `_` or `%` behaves the same on both.
    const prefix = predicate.keyPrefix;
    const matching =
      prefix === undefined || prefix === ''
        ? records
        : records.filter((record) => record.key.startsWith(prefix));

    const rows: KvRow[] = matching.map((record) => ({ value: record.value, tags: record.tags }));
    return selectPage<T>(rows, predicate);
  }

  async transaction<T>(_fn: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    this.#assertUsable();
    throw new TransactionUnsupportedError();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.db.close();
  }

  /**
   * Remove this table's expired rows.
   *
   * Uses the `by_expiry` index rather than scanning the table, and it is a separate transaction from
   * the write that triggered it: joining them would put an index walk inside the caller's write
   * transaction and extend the lock for work that does not have to be atomic with it. The cost of
   * that choice is that a crash between the two leaves an expired row behind until the next touch
   * of the table -- which is exactly the visibility the lazy purge already allows.
   */
  async #purge(table: string): Promise<void> {
    const tx = this.db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    // Records with `expiresAt: null` are not in the index at all, so this range is exactly the
    // expired set rather than everything with a deadline.
    const keys = await request<IDBValidKey[]>(
      store.index(BY_EXPIRY).getAllKeys(IDBKeyRange.upperBound(Date.now())),
    );
    for (const key of keys) {
      if (Array.isArray(key) && key[0] === table) store.delete(key);
    }
    await complete(tx);
  }

  #assertUsable(): void {
    if (this.#closed)
      throw new Error('storage is closed: reopen a database rather than reusing this instance');
  }
}

export type IdbStorageOptions = {
  /** Database name. Two Cortex instances in one origin must pass different names to stay apart. */
  databaseName?: string;
};

/** Open (or create) the fallback tier. */
export async function openIdbStorage(options: IdbStorageOptions = {}): Promise<IdbStorage> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('indexedDB is not available in this environment');
  }

  const factory = indexedDB.open(options.databaseName ?? 'cortex', 1);
  factory.onupgradeneeded = (): void => {
    const db = factory.result;
    if (!db.objectStoreNames.contains(STORE)) {
      const store = db.createObjectStore(STORE, { keyPath: ['table', 'key'] });
      store.createIndex(BY_TABLE, 'table');
      store.createIndex(BY_EXPIRY, 'expiresAt');
    }
  };

  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    factory.onsuccess = (): void => resolve(factory.result);
    factory.onerror = (): void => reject(factory.error ?? new Error('could not open IndexedDB'));
    factory.onblocked = (): void =>
      reject(new Error('could not open IndexedDB: an older connection is blocking the upgrade'));
  });

  return new IdbStorage(db);
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function complete(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = (): void => resolve();
    tx.onerror = (): void => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = (): void => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}
