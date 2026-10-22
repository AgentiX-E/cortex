/**
 * One `Storage` implementation over any {@link SqlSession}.
 *
 * ## Why there is exactly one
 *
 * The browser backend and the server backend run the same SQL against the same schema. Writing the
 * `Storage` methods twice would give two chances to disagree about lazy expiry, about whether a
 * failed transaction rolls back, or about the order of tag filtering and pagination -- and the
 * disagreement would be invisible, because each copy is covered by its own tests and both pass.
 *
 * So the only thing that differs between engines is the session: `better-sqlite3` in this process,
 * a worker round-trip in the browser, and `node:sqlite` in the tests that run the browser code
 * without a browser. `tests/parity.test.ts` asserts that swapping the session does not change a
 * single observable result.
 *
 * ## Three behaviours worth reading before changing anything
 *
 * 1. **Expiry is lazy, per table.** A read or write of table `t` deletes `t`'s expired rows. There
 *    is no sweeper. This keeps the design free of background timers (which a browser tab suspends
 *    anyway) at the cost of dead rows surviving until their table is next touched -- a cost stated
 *    here because "expired rows exist on disk" is otherwise a surprising thing to find.
 *
 * 2. **A transaction really is one.** `BEGIN`, then the body, then `COMMIT`; any throw rolls back
 *    and the original error is what propagates. The predecessor of this class wrapped
 *    `better-sqlite3` and never issued `BEGIN` at all, so a body that threw halfway left its
 *    earlier writes in place while the caller was told the transaction failed.
 *
 * 3. **Writes are refused while a transaction is open.** The connection is inside `BEGIN`, so a
 *    write that arrives from outside the body would be committed -- or rolled back -- with somebody
 *    else's transaction. Refusing is the only answer that does not silently attribute a write to
 *    the wrong unit of work. Transactions are serialised through a queue, so two of them cannot
 *    interleave their `BEGIN`/`COMMIT` on one connection.
 */
import type {
  PutOptions,
  QueryPredicate,
  Storage,
  StorageTransaction,
} from '@agentix-e/cortex-core';
import {
  KV_DEL,
  KV_GET,
  KV_PURGE,
  KV_PUT,
  KV_SCHEMA,
  kvPutParams,
  kvQuery,
  selectPage,
  type KvRow,
  type SqlSession,
} from './sql.js';

/** Raised when a storage is used after `close()`. */
export class StorageClosedError extends Error {
  constructor() {
    super('storage is closed: reopen a session rather than reusing this instance');
    this.name = 'StorageClosedError';
  }
}

/** Raised when a write arrives from outside while a transaction is open on this connection. */
export class TransactionOpenError extends Error {
  constructor(operation: string) {
    super(
      `${operation}() was called while a transaction is open on this storage. The connection is ` +
        `inside BEGIN, so this write would belong to somebody else's unit of work. Use the handle ` +
        `passed to the transaction body, or await the transaction first.`,
    );
    this.name = 'TransactionOpenError';
  }
}

export class SqlStorage implements Storage {
  readonly #session: SqlSession;
  readonly #ready: Promise<void>;
  #open = false;
  #closed = false;

  /**
   * Serialises transactions.
   *
   * `BEGIN`/`COMMIT` are connection state, not statement state. Two transactions started in the
   * same tick would otherwise interleave -- the second `BEGIN` would fail, or worse, succeed
   * against an engine that allows nesting and then commit the first body's writes.
   */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(session: SqlSession) {
    this.#session = session;
    // The schema is applied eagerly but asynchronously, and every operation awaits this. A
    // synchronous engine settles it before the first call returns; the worker-backed one resolves
    // after the worker has answered. Either way "the table exists" is a precondition of every
    // statement below rather than a race.
    this.#ready = session.exec(KV_SCHEMA);
  }

  async put(table: string, key: string, value: unknown, opts?: PutOptions): Promise<void> {
    this.#assertWritable('put');
    await this.#put(table, key, value, opts);
  }

  async get<T>(table: string, key: string): Promise<T | undefined> {
    this.#assertUsable();
    return this.#get<T>(table, key);
  }

  async del(table: string, key: string): Promise<void> {
    this.#assertWritable('del');
    await this.#del(table, key);
  }

  async query<T>(table: string, predicate: QueryPredicate = {}): Promise<T[]> {
    this.#assertUsable();
    await this.#ready;
    await this.#purge(table);

    const { sql, params } = kvQuery(table, predicate);
    const rows = await this.#session.all(sql, params);
    return selectPage<T>(rows as KvRow[], predicate);
  }

  async transaction<T>(fn: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    this.#assertUsable();
    if (this.#open) {
      throw new TransactionOpenError('transaction');
    }

    // The queue is advanced even when the body fails, so one failed transaction does not wedge
    // every transaction behind it.
    const run = this.#queue.then(() => this.#runTransaction(fn));
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // A failed schema application must not prevent the engine from being released: the caller
    // asked for the handle to go away, and leaving a database open because a statement failed
    // would leak the file handle that `close` exists to release.
    await this.#ready.catch(() => undefined);
    await this.#session.close();
  }

  async #runTransaction<T>(fn: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    const tx: StorageTransaction = {
      put: (table: string, key: string, value: unknown, opts?: PutOptions) =>
        this.#put(table, key, value, opts),
      get: <U>(table: string, key: string) => this.#get<U>(table, key),
      del: (table: string, key: string) => this.#del(table, key),
    };

    this.#open = true;
    await this.#ready;
    await this.#session.exec('BEGIN');
    try {
      const result = await fn(tx);
      await this.#session.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        await this.#session.exec('ROLLBACK');
      } catch (rollbackError) {
        // Both failures are reported. Throwing only the first would leave the caller believing the
        // connection is clean when the one operation that makes it clean is the one that failed.
        throw new AggregateError(
          [error, rollbackError],
          'transaction body failed and the rollback failed: this connection is in an unknown state',
        );
      }
      throw error;
    } finally {
      this.#open = false;
    }
  }

  async #put(table: string, key: string, value: unknown, opts?: PutOptions): Promise<void> {
    this.#assertUsable();
    await this.#ready;
    await this.#session.run(KV_PUT, kvPutParams(table, key, value, opts, Date.now()));
    await this.#purge(table);
  }

  async #get<T>(table: string, key: string): Promise<T | undefined> {
    await this.#ready;
    await this.#purge(table);
    const rows = await this.#session.all(KV_GET, [table, key]);
    const row = rows[0];
    return row === undefined ? undefined : (JSON.parse(String(row.value)) as T);
  }

  async #del(table: string, key: string): Promise<void> {
    await this.#ready;
    await this.#session.run(KV_DEL, [table, key]);
  }

  async #purge(table: string): Promise<void> {
    await this.#session.run(KV_PURGE, [table, Date.now()]);
  }

  #assertUsable(): void {
    if (this.#closed) throw new StorageClosedError();
  }

  #assertWritable(operation: string): void {
    this.#assertUsable();
    if (this.#open) throw new TransactionOpenError(operation);
  }
}
