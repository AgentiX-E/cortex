/**
 * SQLite storage backend for Node, backed by `better-sqlite3`.
 *
 * The class is deliberately thin: it owns the file handle and the pragmas, and delegates every
 * `Storage` method to {@link SqlStorage}, which is engine-agnostic. The browser backend runs the
 * same statements through a worker; keeping the SQL in one place is what makes that a port rather
 * than a reimplementation.
 *
 * ## Why the session is a separate object
 *
 * `better-sqlite3` is synchronous, and `SqlStorage` awaits everything so that it can also drive an
 * engine that lives in another thread. If the sync/async difference leaked into `SqlStorage`, the
 * browser path would need its own copy of the storage logic, and the two copies would drift in the
 * ways that are hardest to notice -- error timing, and whether a failed statement aborts a
 * transaction.
 */
import Database from 'better-sqlite3';
import type { SqlRow, SqlSession, SqlValue } from './sql.js';
import { SqlStorage } from './sql-storage.js';

export type SqliteStorageOptions = {
  /** Path to the SQLite file, or ':memory:' for an ephemeral in-memory store. */
  filename?: string;
};

/** The `SqlSession` that runs statements on a `better-sqlite3` handle in this process. */
class BetterSqliteSession implements SqlSession {
  constructor(private readonly db: Database.Database) {
    // WAL is set before the schema because it is a property of the file, and setting it later
    // rewrites the journal mode of a database that already holds rows.
    this.db.pragma('journal_mode = WAL');
    // ## Why `secure_delete`
    //
    // Because erasure is a promise about bytes, and SQLite's default is a promise about rows only:
    // a deleted row leaves its page content in the file until something overwrites it, so `DELETE`
    // plus a passing `query` is not evidence that a sentence is gone from the disk. Measured, not
    // assumed: with this pragma off, a 1.6 kB sentence erased through the product was still findable
    // verbatim in the file (`disclosure-erasure.test.ts`). `secure_delete = ON` zeroes the freed
    // content on the delete path, which makes the difference between "the store forgot it" and "the
    // file no longer holds it".
    //
    // It is per-connection and not persisted in the file, which is why it is set here rather than in
    // a migration: a reader that opens the database later is not the one that has to delete safely.
    this.db.pragma('secure_delete = ON');
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async run(sql: string, params: readonly SqlValue[]): Promise<void> {
    this.db.prepare(sql).run(...params);
  }

  async all(sql: string, params: readonly SqlValue[]): Promise<SqlRow[]> {
    return this.db.prepare(sql).all(...params) as SqlRow[];
  }

  async close(): Promise<void> {
    // No `db.open` guard. `SqlStorage.close` already returns early on its own `#closed` flag, which
    // it sets synchronously before the first await, so this method cannot be reached twice for one
    // handle -- and better-sqlite3 throws on a second `close()`. A guard here would therefore never
    // report anything; worse, it would silently swallow the double-close it looks like it handles,
    // which is the one way a leaked handle becomes invisible.
    this.db.close();
  }
}

export class SqliteStorage extends SqlStorage {
  constructor(options: SqliteStorageOptions = {}) {
    super(new BetterSqliteSession(new Database(options.filename ?? ':memory:')));
  }
}
