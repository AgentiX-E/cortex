/**
 * Storage abstraction: a table-oriented key/value primitive that can be backed by
 * embedded SQLite, a remote PostgreSQL database, or an in-memory/browser store.
 * All Cortex packages depend on this contract only, never on a concrete engine.
 */
export type PutOptions = {
  /** Optional time-to-live in milliseconds. */
  ttlMs?: number;
  /** Optional semantic tags used by query predicates. */
  tags?: string[];
};

export type QueryPredicate = {
  /** Exact tag match (AND semantics). */
  tags?: string[];
  /** Optional lexical prefix filter on the key. */
  keyPrefix?: string;
  /** Optional upper bound on returned rows. */
  limit?: number;
  /** Optional offset for pagination. */
  offset?: number;
};

export interface StorageTransaction {
  put(table: string, key: string, value: unknown, opts?: PutOptions): Promise<void>;
  get<T>(table: string, key: string): Promise<T | undefined>;
  del(table: string, key: string): Promise<void>;
}

export interface Storage {
  put(table: string, key: string, value: unknown, opts?: PutOptions): Promise<void>;
  get<T>(table: string, key: string): Promise<T | undefined>;
  del(table: string, key: string): Promise<void>;
  query<T>(table: string, predicate?: QueryPredicate): Promise<T[]>;
  transaction<T>(fn: (tx: StorageTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
