/**
 * PostgreSQL storage backend. Uses JSONB values plus a GIN-indexed JSONB tags
 * column. Depends on a `pg` Pool; works against real PostgreSQL or pg-mem.
 */
import type { Pool } from 'pg';
import { type PoolClient } from 'pg';
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
    const conditions: string[] = ['table_name = $1', '(expires_at IS NULL OR expires_at > now())'];
    const params: unknown[] = [table];
    let i = 2;
    if (predicate.keyPrefix) {
      conditions.push(`key LIKE $${i}`);
      params.push(`${predicate.keyPrefix}%`);
      i++;
    }
    // Fetch all matching rows, then apply tag filtering and pagination in JS so
    // that limit/offset semantics remain correct when combined with tags.
    const sql = `SELECT value, tags FROM cortex_kv WHERE ${conditions.join(' AND ')}`;
    const res = await this.pool.query(sql, params);
    const filtered = (res.rows as { value: unknown; tags: string[] }[])
      .filter((r) => matchesAllTags(r.tags, predicate.tags))
      .map((r) => r.value as T);
    const offset = predicate.offset ?? 0;
    const limit = predicate.limit ?? filtered.length;
    return filtered.slice(offset, offset + limit);
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

/** True when `tags` contains every requested tag (AND semantics). */
function matchesAllTags(tags: string[], requested?: string[]): boolean {
  if (!requested || requested.length === 0) {
    return true;
  }
  return requested.every((t) => tags.includes(t));
}
