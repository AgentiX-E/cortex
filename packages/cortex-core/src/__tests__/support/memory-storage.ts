/**
 * An in-memory `Storage` used as both halves of the federation tests.
 *
 * ## Why this is not a mock
 *
 * A mock would record calls and return canned values, which would let the router look correct
 * while doing nothing. This implements the contract for real -- tags, ttl, prefix queries,
 * pagination, transactional rollback -- so an assertion about "the private row is invisible to a
 * shared query" is a statement about behaviour rather than about call order.
 *
 * ## Why not two SQLite files
 *
 * Because the subject here is the *router*, not the engine. Mixing the two would make a failure
 * ambiguous: a missing row could be routing logic or a schema mistake. `cortex-storage` covers
 * the engines; `POC-1` covers the browser engine.
 */

import type {
  PutOptions,
  QueryPredicate,
  Storage,
  StorageTransaction,
} from '../../interfaces/storage.js';

type Row = {
  value: unknown;
  tags: string[];
  expiresAt?: number;
};

export class MemoryStorage implements Storage {
  private readonly rows = new Map<string, Map<string, Row>>();
  private closed = false;

  private bucket(table: string): Map<string, Row> {
    let bucket = this.rows.get(table);
    if (bucket === undefined) {
      bucket = new Map();
      this.rows.set(table, bucket);
    }
    return bucket;
  }

  async put(table: string, key: string, value: unknown, opts?: PutOptions): Promise<void> {
    const row: Row = { value, tags: [...(opts?.tags ?? [])] };
    if (opts?.ttlMs !== undefined) row.expiresAt = Date.now() + opts.ttlMs;
    this.bucket(table).set(key, row);
  }

  async get<T>(table: string, key: string): Promise<T | undefined> {
    const bucket = this.bucket(table);
    const row = bucket.get(key);
    if (row === undefined) return undefined;
    if (row.expiresAt !== undefined && row.expiresAt <= Date.now()) {
      bucket.delete(key);
      return undefined;
    }
    return row.value as T;
  }

  async del(table: string, key: string): Promise<void> {
    this.bucket(table).delete(key);
  }

  async query<T>(table: string, predicate?: QueryPredicate): Promise<T[]> {
    const now = Date.now();
    const entries = [...this.bucket(table).entries()]
      .filter(([, row]) => row.expiresAt === undefined || row.expiresAt > now)
      .filter(([key]) => predicate?.keyPrefix === undefined || key.startsWith(predicate.keyPrefix))
      .filter(([, row]) => (predicate?.tags ?? []).every((tag) => row.tags.includes(tag)))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    const start = predicate?.offset ?? 0;
    const end = predicate?.limit === undefined ? entries.length : start + predicate.limit;
    return entries.slice(start, end).map(([, row]) => row.value as T);
  }

  async transaction<T>(fn: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    const snapshot = new Map<string, Map<string, Row>>();
    for (const [table, rows] of this.rows) {
      snapshot.set(
        table,
        new Map([...rows].map(([key, row]) => [key, { ...row, tags: [...row.tags] }])),
      );
    }

    const tx: StorageTransaction = {
      put: (table, key, value, opts) => this.put(table, key, value, opts),
      get: (table, key) => this.get(table, key),
      del: (table, key) => this.del(table, key),
    };

    try {
      return await fn(tx);
    } catch (error) {
      this.rows.clear();
      for (const [table, rows] of snapshot) this.rows.set(table, rows);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rows.clear();
  }

  /** Whether `close()` was called, so a caller can assert the router closed both halves. */
  get isClosed(): boolean {
    return this.closed;
  }
}
