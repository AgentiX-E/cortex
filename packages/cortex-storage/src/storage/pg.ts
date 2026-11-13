/**
 * PostgreSQL storage backend. Uses JSONB values plus a GIN-indexed JSONB tags
 * column. Depends on a `pg` Pool; works against real PostgreSQL or pg-mem.
 */
import type { Pool } from 'pg';
import { type PoolClient } from 'pg';
import { matchesAllTags } from './sql.js';
import type {
  PutOptions,
  QueryPredicate,
  Storage,
  StorageTransaction,
} from '@agentix-e/cortex-core';

export type PgStorageOptions = {
  pool: Pool;
};

export class PgStorage implements Storage {
  private readonly pool: Pool;

  constructor(options: PgStorageOptions) {
    this.pool = options.pool;
  }

  async put(table: string, key: string, value: unknown, opts?: PutOptions): Promise<void> {
    const tags = opts?.tags ?? [];
    const expiresAt = opts?.ttlMs != null ? new Date(Date.now() + opts.ttlMs).toISOString() : null;
    await this.pool.query(
      `INSERT INTO cortex_kv (table_name, key, value, tags, expires_at)
       VALUES ($1, $2, $3::jsonb, $4::text[], $5::timestamptz)
       ON CONFLICT (table_name, key)
       DO UPDATE SET value = EXCLUDED.value, tags = EXCLUDED.tags, expires_at = EXCLUDED.expires_at`,
      [table, key, JSON.stringify(value), tags, expiresAt],
    );
  }

  async get<T>(table: string, key: string): Promise<T | undefined> {
    const res = await this.pool.query(
      `SELECT value FROM cortex_kv
       WHERE table_name = $1 AND key = $2 AND (expires_at IS NULL OR expires_at > now())`,
      [table, key],
    );
    return res.rows.length > 0 ? (res.rows[0]!.value as T) : undefined;
  }

  async del(table: string, key: string): Promise<void> {
    await this.pool.query(`DELETE FROM cortex_kv WHERE table_name = $1 AND key = $2`, [table, key]);
  }

  async query<T>(table: string, predicate: QueryPredicate = {}): Promise<T[]> {
    // Expired rows are removed before the read, which is what the two SQLite backends do. This adapter
    // used to filter them inline and never delete them, so a table grew without bound while every read
    // reported the same answers -- a leak that no assertion about values could see.
    await this.#purge(table);

    const res = await this.pool.query(
      `SELECT key, value, tags FROM cortex_kv WHERE table_name = $1`,
      [table],
    );
    const rows = res.rows as { key: string; value: unknown; tags: string[] }[];

    // ## Why the prefix is applied here and not in the SQL
    //
    // It was `key LIKE $n` with `${prefix}%`, which is three claims in one line and two of them are false.
    // A prefix containing `%` or `_` is a *pattern*, so `turn:%` matched `turn:1` and `turn:2` and also
    // `turns:x`; whether the pattern is case-folded depends on the collation, and SQLite's default folds
    // ASCII while PostgreSQL's does not; and the escaping that would fix both (`LIKE ... ESCAPE`) is
    // implemented by neither `pg-mem` nor any engine this repository can run in a test.
    //
    // The rows are already materialised for the tag filter -- tags are a `text[]` column with no join table,
    // so they cannot be filtered without reading the row -- and the read therefore costs the table either
    // way. Applying `startsWith` here makes one definition of "prefix" instead of three: `idb.ts` uses
    // `startsWith`, `sql.ts` uses `substr(key, 1, n) = prefix` (equal for exactly this predicate), and this
    // file now uses the same word. A filter that cannot be got wrong on one backend and right on another.
    //
    // The cost, stated: no index range scan. `substr` cannot use one either, and neither can the tag filter,
    // so a predicate query on this table is a table scan in the current schema on every backend.
    const prefix = predicate.keyPrefix;
    const filtered = rows
      .filter((row) => prefix === undefined || prefix === '' || row.key.startsWith(prefix))
      .filter((row) => matchesAllTags(row.tags, predicate.tags))
      .map((row) => row.value as T);
    const offset = predicate.offset ?? 0;
    const limit = predicate.limit ?? filtered.length;
    return filtered.slice(offset, offset + limit);
  }

  /** Remove this table's expired rows. Same statement the SQLite backends issue on every read. */
  async #purge(table: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM cortex_kv WHERE table_name = $1 AND expires_at IS NOT NULL AND expires_at <= now()`,
      [table],
    );
  }

  async transaction<T>(fn: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx = this.makeTx(client);
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private makeTx(client: PoolClient): StorageTransaction {
    const run = async (
      op: 'put' | 'get' | 'del',
      table: string,
      key: string,
      value?: unknown,
      opts?: PutOptions,
    ) => {
      if (op === 'put') {
        const tags = opts?.tags ?? [];
        const expiresAt =
          opts?.ttlMs != null ? new Date(Date.now() + opts.ttlMs).toISOString() : null;
        await client.query(
          `INSERT INTO cortex_kv (table_name, key, value, tags, expires_at)
           VALUES ($1, $2, $3::jsonb, $4::text[], $5::timestamptz)
           ON CONFLICT (table_name, key)
           DO UPDATE SET value = EXCLUDED.value, tags = EXCLUDED.tags, expires_at = EXCLUDED.expires_at`,
          [table, key, JSON.stringify(value), tags, expiresAt],
        );
      } else if (op === 'get') {
        const res = await client.query(
          `SELECT value FROM cortex_kv WHERE table_name = $1 AND key = $2`,
          [table, key],
        );
        return res.rows.length > 0 ? (res.rows[0]!.value as unknown) : undefined;
      } else {
        await client.query(`DELETE FROM cortex_kv WHERE table_name = $1 AND key = $2`, [
          table,
          key,
        ]);
      }
    };
    return {
      put: async (t, k, v, o) => {
        await run('put', t, k, v, o);
      },
      get: async (t, k) => (await run('get', t, k)) as never,
      del: async (t, k) => {
        await run('del', t, k);
      },
    };
  }
}

/** Create the `cortex_kv` table (idempotent). */
export async function ensurePgSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cortex_kv (
      table_name TEXT NOT NULL,
      key TEXT NOT NULL,
      value JSONB NOT NULL,
      tags TEXT[] NOT NULL DEFAULT '{}'::text[],
      expires_at TIMESTAMPTZ,
      PRIMARY KEY (table_name, key)
    );
    CREATE INDEX IF NOT EXISTS cortex_kv_tags ON cortex_kv USING GIN (tags);
  `);
}
