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
    if (this.db.open) this.db.close();
  }
}

export class SqliteStorage extends SqlStorage {
  constructor(options: SqliteStorageOptions = {}) {
    super(new BetterSqliteSession(new Database(options.filename ?? ':memory:')));
  }
}
