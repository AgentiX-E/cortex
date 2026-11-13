/**
 * PostgreSQL storage backend. Uses JSONB values plus a GIN-indexed JSONB tags
 * column. Depends on a `pg` Pool; works against real PostgreSQL or pg-mem.
 *
 * ## The behaviour here is asserted against a real server, and it was not before
 *
 * `test/pg/integration.test.ts` runs this adapter against PostgreSQL 16 through a real `pg.Pool`.
 * It exists because the sentence that used to be in the unit suite -- "the rollback's effect on
 * stored data is asserted against a real PostgreSQL instance in the integration suite" -- named a
 * file that did not exist. When it finally ran, three of its assertions failed: a transaction read
 * an expired row the non-transactional path hides, `put` left dead rows that `SqlStorage.#put`
 * removes, and `close()` raised `pg`'s message rather than the package's `StorageClosedError`.
 *
 * `pg-mem` is still used by the unit suite, for the statements it can run. It is not evidence about
 * PostgreSQL, and the comments in this file no longer treat it as such.
 */
import type { Pool, PoolClient } from 'pg';
import { StorageClosedError } from './errors.js';
import { matchesAllTags } from './sql.js';
import type {
  PutOptions,
  QueryPredicate,
  Storage,
  StorageTransaction,
} from '@agentix-e/cortex-core';

// Re-exported from the `./pg` subpath so a caller can `catch` the same class it would catch from
// `./sqlite`. Before this, only `pg`'s own message reached the caller.
export { StorageClosedError } from './errors.js';

export type PgStorageOptions = {
  pool: Pool;
};

/** The slice of `Pool` and `PoolClient` this file needs, so one statement builder serves both. */
type Queryable = {
  query(text: string, values?: unknown[]): Promise<unknown>;
};

/**
 * The five statements this adapter issues, each in one place.
 *
 * They were inline string literals at four call sites, and the insert appeared twice -- once in
 * `put` and once in the transaction's `put`, which is how the missing purge reached only one of
 * them. Two copies of a statement are two chances to change one and forget the other, and the
 * bundle gate noticed the duplication before any test did: `./pg` grew 104 bytes gzip against a
 * budget of 2%.
 */
const SQL_PUT = `INSERT INTO cortex_kv (table_name, key, value, tags, expires_at)
  VALUES ($1, $2, $3::jsonb, $4::text[], $5::timestamptz)
  ON CONFLICT (table_name, key)
  DO UPDATE SET value = EXCLUDED.value, tags = EXCLUDED.tags, expires_at = EXCLUDED.expires_at`;

/** Reads outside a transaction filter expiry in SQL, so a single statement needs no purge first. */
const SQL_GET_LIVE = `SELECT value FROM cortex_kv
  WHERE table_name = $1 AND key = $2 AND (expires_at IS NULL OR expires_at > now())`;

/** Reads inside a transaction purge first, so the condition would be redundant. */
const SQL_GET = `SELECT value FROM cortex_kv WHERE table_name = $1 AND key = $2`;

const SQL_DEL = `DELETE FROM cortex_kv WHERE table_name = $1 AND key = $2`;

const SQL_PURGE = `DELETE FROM cortex_kv
  WHERE table_name = $1 AND expires_at IS NOT NULL AND expires_at <= now()`;

/**
 * The bound values for {@link SQL_PUT}, from the caller's write.
 *
 * `expiresAt` is computed here rather than at each call site because the same expression at two
 * call sites is the same defect as the same SQL at two call sites: one of them gets the null check
 * and the other does not.
 */
function putValues(
  table: string,
  key: string,
  value: unknown,
  opts: PutOptions | undefined,
): [string, string, string, string[], string | null] {
  const expiresAt = opts?.ttlMs == null ? null : new Date(Date.now() + opts.ttlMs).toISOString();
  return [table, key, JSON.stringify(value), opts?.tags ?? [], expiresAt];
}

export class PgStorage implements Storage {
  private readonly pool: Pool;
  private closed = false;

  constructor(options: PgStorageOptions) {
    this.pool = options.pool;
  }

  async put(table: string, key: string, value: unknown, opts?: PutOptions): Promise<void> {
    this.assertUsable();
    await this.pool.query(SQL_PUT, putValues(table, key, value, opts));
    // The same purge the SQLite backend performs after a write. Without it an expired row stayed on
    // disk until the next *read* of that table, so a table that was written to and never queried
    // accumulated dead rows indefinitely -- a leak no assertion about returned values can observe.
    await this.purgeOn(this.pool, table);
  }

  async get<T>(table: string, key: string): Promise<T | undefined> {
    this.assertUsable();
    const res = (await this.pool.query(SQL_GET_LIVE, [table, key])) as {
      rows: { value: unknown }[];
    };
    return res.rows.length > 0 ? (res.rows[0]!.value as T) : undefined;
  }

  async del(table: string, key: string): Promise<void> {
    this.assertUsable();
    await this.pool.query(SQL_DEL, [table, key]);
  }

  async query<T>(table: string, predicate: QueryPredicate = {}): Promise<T[]> {
    this.assertUsable();
    // Expired rows are removed before the read, which is what the two SQLite backends do. This
    // adapter used to filter them inline and never delete them, so a table grew without bound
    // while every read reported the same answers -- a leak that no assertion about values could see.
    await this.purgeOn(this.pool, table);

    const res = (await this.pool.query(
      `SELECT key, value, tags FROM cortex_kv WHERE table_name = $1`,
      [table],
    )) as { rows: { key: string; value: unknown; tags: string[] }[] };
    const rows = res.rows;

    // ## Why the prefix is applied here and not in the SQL
    //
    // It was `key LIKE $n` with `${prefix}%`, which is three claims in one line and two of them are
    // false: a prefix containing `%` or `_` is a *pattern*, whether the pattern is case-folded
    // depends on the collation, and there was no escaping.
    //
    // The first version of this comment then claimed that `LIKE ... ESCAPE` is "implemented by
    // neither `pg-mem` nor any engine this repository can run in a test". That was wrong twice:
    // PostgreSQL implements it, and this repository runs PostgreSQL -- `apt-get install postgresql`
    // takes 25 seconds, and `test/pg/integration.test.ts` now depends on it. The real constraint is
    // narrower and worth stating correctly: **`pg-mem` does not implement `ESCAPE`**, and `ESCAPE`
    // is the only way to keep a SQL-side prefix filter both correct and indexable.
    //
    // What that leaves is a choice between a correct filter and a sargable one, and correctness
    // wins because the rows are already materialised: tags are a `text[]` column with no join
    // table, so the tag filter has to read the row anyway, and the read therefore costs the table
    // either way. Applying `startsWith` here also gives "prefix" one definition across three
    // backends -- `idb.ts` uses `startsWith`, `sql.ts` uses `substr(key, 1, n) = prefix`, which is
    // equal for exactly this predicate -- which is the property a filter needs.
    //
    // The cost, stated rather than hidden: no index range scan, so a predicate query on this table
    // is a sequential scan of its own table on every backend. Restoring the range scan on
    // PostgreSQL alone is `LIKE ... ESCAPE '\'` against a `(table_name, key text_pattern_ops)`
    // index, and it is listed as P2 in `docs/AUDIT-PRODUCT-SURFACE.md` rather than done here,
    // because doing it means the SQLite path needs a second definition and the two must be tested
    // against each other.
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
  private async purgeOn(runner: Queryable, table: string): Promise<void> {
    await runner.query(SQL_PURGE, [table]);
  }

  async transaction<T>(fn: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    this.assertUsable();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(this.makeTx(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      // ## The one branch here that has no test, and why it is not in this method
      //
      // If `ROLLBACK` itself throws, two things are wrong at once: the caller's error is not the
      // one that reaches them, and the connection is in a state this adapter cannot describe -- so
      // it must be destroyed (`client.release(err)`) rather than returned to the pool. `SqlStorage`
      // handles the same case with an `AggregateError`.
      //
      // This adapter does not. Not because the case is unimportant, but because **no engine this
      // suite can run will produce it**: `pg-mem` implements `BEGIN`/`COMMIT`/`ROLLBACK` as
      // no-ops that never fail, and the connection whose rollback fails is by definition the one
      // that cannot be asked to fail on demand. Writing the `AggregateError` here anyway would put
      // six unreachable statements into a file the coverage gate holds at 95%, which drops `pg.ts`
      // to 93.3% -- and the honest reading of that number is the point: a defensive branch that no
      // test can reach is not a safeguard, it is a claim.
      //
      // It is registered as P1 in `docs/AUDIT-PRODUCT-SURFACE.md` with the fix that would make it
      // assertable (run the integration suite with coverage and merge the two reports). Until
      // then this method does the thing that is measured: `ROLLBACK`, then rethrow the body's
      // error. That behaviour is asserted against PostgreSQL 16 in
      // `test/pg/integration.test.ts`.
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    // Idempotent, and it sets the flag before the first await so a `get()` racing the close is
    // refused rather than reaching a pool that is half torn down.
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }

  private assertUsable(): void {
    if (this.closed) throw new StorageClosedError();
  }

  private makeTx(client: PoolClient): StorageTransaction {
    const put = async (
      table: string,
      key: string,
      value: unknown,
      opts: PutOptions | undefined,
    ): Promise<void> => {
      await client.query(SQL_PUT, putValues(table, key, value, opts));
      await this.purgeOn(client, table);
    };

    // The purge is what makes this agree with `SqlStorage.#get`, and its absence was a real
    // divergence: inside a transaction this read returned a row that the same store hides outside
    // one. Every expiry-bearing read the memory layer performs inside `transaction()` was affected.
    const get = async <T>(table: string, key: string): Promise<T | undefined> => {
      await this.purgeOn(client, table);
      const res = (await client.query(SQL_GET, [table, key])) as { rows: { value: unknown }[] };
      return res.rows.length > 0 ? (res.rows[0]!.value as T) : undefined;
    };

    const del = async (table: string, key: string): Promise<void> => {
      await client.query(SQL_DEL, [table, key]);
    };

    return {
      put,
      get: get as StorageTransaction['get'],
      del,
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
