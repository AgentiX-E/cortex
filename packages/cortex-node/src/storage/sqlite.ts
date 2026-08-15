/**
 * SQLite storage backend backed by better-sqlite3. Implements the Cortex Storage
 * contract with a simple schema: `kv(table, key, value, tags, expires_at)`.
 */
import Database from 'better-sqlite3';
import type {
  PutOptions,
  QueryPredicate,
  Storage,
  StorageTransaction,
} from '@agentix-e/cortex-core';

export type SqliteStorageOptions = {
  /** Path to the SQLite file, or ':memory:' for an ephemeral in-memory store. */
  filename?: string;
};

export class SqliteStorage implements Storage {
  private readonly db: Database.Database;

  constructor(options: SqliteStorageOptions = {}) {
    this.db = new Database(options.filename ?? ':memory:');
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        table_name TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        expires_at INTEGER,
        PRIMARY KEY (table_name, key)
      );
      CREATE INDEX IF NOT EXISTS kv_tags ON kv(table_name, tags);
    `);
  }

  async put(table: string, key: string, value: unknown, opts?: PutOptions): Promise<void> {
    const tags = JSON.stringify(opts?.tags ?? []);
    const expiresAt = opts?.ttlMs != null ? Date.now() + opts.ttlMs : null;
    this.db
      .prepare(
        `INSERT INTO kv (table_name, key, value, tags, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(table_name, key)
         DO UPDATE SET value = excluded.value, tags = excluded.tags, expires_at = excluded.expires_at`,
      )
      .run(table, key, JSON.stringify(value), tags, expiresAt);
    this.purgeExpired(table);
  }

  async get<T>(table: string, key: string): Promise<T | undefined> {
    this.purgeExpired(table);
    const row = this.db
      .prepare(`SELECT value FROM kv WHERE table_name = ? AND key = ?`)
      .get(table, key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  async del(table: string, key: string): Promise<void> {
    this.db.prepare(`DELETE FROM kv WHERE table_name = ? AND key = ?`).run(table, key);
  }

  async query<T>(table: string, predicate: QueryPredicate = {}): Promise<T[]> {
    this.purgeExpired(table);
    const conditions: string[] = ['table_name = ?'];
    const params: unknown[] = [table];
    if (predicate.keyPrefix) {
      conditions.push('key LIKE ?');
      params.push(`${predicate.keyPrefix}%`);
    }
    // Fetch all matching rows, then apply tag filtering and pagination in JS so
    // that limit/offset semantics remain correct when combined with tags.
    const sql = `SELECT value, tags FROM kv WHERE ${conditions.join(' AND ')}`;
    const rows = this.db.prepare(sql).all(...params) as { value: string; tags: string }[];
    const filtered = rows
      .filter((r) => matchesAllTags(JSON.parse(r.tags) as string[], predicate.tags))
      .map((r) => JSON.parse(r.value) as T);
    const offset = predicate.offset ?? 0;
    const limit = predicate.limit ?? filtered.length;
    return filtered.slice(offset, offset + limit);
  }

  async transaction<T>(fn: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    const tx: StorageTransaction = {
      put: (t, k, v, o) => this.put(t, k, v, o),
      get: (t, k) => this.get(t, k),
      del: (t, k) => this.del(t, k),
    };
    // better-sqlite3 is synchronous; provide a thin async wrapper.
    return fn(tx);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private purgeExpired(table: string): void {
    this.db
      .prepare(`DELETE FROM kv WHERE table_name = ? AND expires_at IS NOT NULL AND expires_at <= ?`)
      .run(table, Date.now());
  }
}

/** True when `tags` contains every requested tag (AND semantics). */
function matchesAllTags(tags: string[], requested?: string[]): boolean {
  if (!requested || requested.length === 0) {
    return true;
  }
  return requested.every((t) => tags.includes(t));
}
