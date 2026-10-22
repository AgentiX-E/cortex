/**
 * The SQL vocabulary every SQLite-shaped backend shares: bound values, the kv schema, the four
 * statements over it, and the two helpers whose semantics are easy to get subtly wrong.
 *
 * ## Why this is a module and not a few string constants inside each backend
 *
 * Three execution engines run this schema: `better-sqlite3` on the server, SQLite-WASM inside a
 * browser worker, and `node:sqlite` in the tests that exercise the browser code without a browser.
 * Each would otherwise carry its own copy.
 *
 * A copy that drifts is not cosmetic. Missing `expires_at` turns a TTL into a permanently visible
 * row; a missing `ON CONFLICT(table_name, key)` turns an overwrite into a constraint error that
 * only fires on the *second* write of a key -- which is precisely the write a happy-path test
 * never performs. And `query`'s tag/pagination ordering is subtle enough that two hand-written
 * copies will disagree, so here there is one function and both backends call it.
 *
 * ## The two helpers are here because they encode decisions, not convenience
 *
 * `kvQuery` builds the WHERE clause with `substr(key, 1, ?) = ?` rather than `key LIKE ?`, and
 * `selectPage` filters on tags *before* paginating. Both look like style until they are not:
 * see the comments on each.
 */
import type { PutOptions, QueryPredicate } from '@agentix-e/cortex-core';

/** Everything SQLite can bind as a parameter. Deliberately narrow: no `boolean`, no `Date`. */
export type SqlValue = string | number | null;

/** A row as an engine returns it: column name to bound value. */
export type SqlRow = Record<string, SqlValue>;

/**
 * What a backend must be able to do for `SqlStorage` to sit on top of it.
 *
 * Every method is asynchronous even where the engine is synchronous, because one of the engines is
 * *not in this process*: the browser one lives in a worker and answers over `postMessage`. Making
 * the server session synchronous would have forced two versions of `SqlStorage` -- one that awaits
 * and one that does not -- and the two would disagree on error timing the first time one of them
 * was changed. Awaiting a resolved promise costs a microtask; two implementations cost a class of
 * bug.
 */
export interface SqlSession {
  /** Run one or more statements with no parameters: DDL, `BEGIN`, `COMMIT`, `ROLLBACK`. */
  exec(sql: string): Promise<void>;
  /** Run one parameterised statement for effect. */
  run(sql: string, params: readonly SqlValue[]): Promise<void>;
  /** Run one parameterised statement and return its rows. */
  all(sql: string, params: readonly SqlValue[]): Promise<SqlRow[]>;
  /** Release the underlying engine. Idempotent. */
  close(): Promise<void>;
}

/**
 * The schema.
 *
 * One string with two statements in it rather than two strings, because all three engines accept a
 * multi-statement script and applying it in one call is what makes "the schema exists" a single
 * fact rather than a sequence that can be interrupted halfway.
 */
export const KV_SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  table_name TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  expires_at INTEGER,
  PRIMARY KEY (table_name, key)
);
CREATE INDEX IF NOT EXISTS kv_tags ON kv(table_name, tags);
CREATE INDEX IF NOT EXISTS kv_expiry ON kv(table_name, expires_at);
`;

/** Upsert. The conflict target must name both columns, or a rewrite of the same key throws. */
export const KV_PUT = `INSERT INTO kv (table_name, key, value, tags, expires_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(table_name, key) DO UPDATE SET
  value = excluded.value,
  tags = excluded.tags,
  expires_at = excluded.expires_at`;

export const KV_GET = `SELECT value FROM kv WHERE table_name = ? AND key = ?`;

export const KV_DEL = `DELETE FROM kv WHERE table_name = ? AND key = ?`;

/**
 * Lazy expiry: rows are removed when their own table is next touched, not by a background job.
 *
 * ## Why `kv_expiry` exists
 *
 * This statement runs on **every** read and write of its table. Without an index on
 * `(table_name, expires_at)` it scans all of that table's rows to find the few expired ones, which
 * makes a bulk load quadratic in the number of rows: measured at 161 rows/s on OPFS for 2,000 rows,
 * against 12.4 s total for what should be a few hundred milliseconds. The index turns it into a
 * range scan that usually finds nothing.
 *
 * `tests/sql-storage.test.ts` asserts the query *plan*, not the timing, because a timing assertion
 * would be a machine-dependent test of a database-independent claim.
 */
export const KV_PURGE = `DELETE FROM kv WHERE table_name = ? AND expires_at IS NOT NULL AND expires_at <= ?`;

/** A stored row's payload and tags, as `kv` holds them. */
export type KvRow = { value: string; tags: string };

/**
 * Parameter list for {@link KV_PUT}.
 *
 * `now` is a parameter rather than `Date.now()` inside the function so that TTL behaviour can be
 * asserted against a fixed clock instead of against a `sleep`. A test that waits for a timer to
 * fire is a test that fails on a loaded machine.
 */
export function kvPutParams(
  table: string,
  key: string,
  value: unknown,
  opts: PutOptions | undefined,
  now: number,
): SqlValue[] {
  const tags = JSON.stringify(opts?.tags ?? []);
  const expiresAt = opts?.ttlMs !== undefined ? now + opts.ttlMs : null;
  return [table, key, JSON.stringify(value), tags, expiresAt];
}

/**
 * The SELECT for one table, optionally narrowed by key prefix.
 *
 * ## Why `substr(key, 1, ?) = ?` and not `key LIKE ?`
 *
 * Two defects, both silent, both of the kind that only shows up on a key nobody wrote a test for:
 *
 *   1. **Wildcards in the prefix.** `key LIKE 'a_b%'` treats `_` as "any single character", so a
 *      prefix containing `_` or `%` matched keys that do not start with it. Keys in this codebase
 *      carry separators (`turn:`, `private/facts`), so this was not hypothetical for `%`-bearing
 *      callers -- it was only hypothetical for callers who had not used one yet.
 *   2. **Case folding.** SQLite's `LIKE` is case-insensitive for ASCII, so prefix `ID:` matched
 *      `id:...`. A prefix filter that ignores case is not a prefix filter; it is a suggestion.
 *
 * The cost is honest and worth stating: `substr(...)` cannot use the `(table_name, key)` index for
 * a range scan, so a prefix query reads the table's rows and filters them. Prefix queries are the
 * minority path here (the read side selects a table, then filters in memory anyway), and an
 * over-matching prefix is a wrong answer rather than a slow one.
 */
export function kvQuery(
  table: string,
  predicate: QueryPredicate,
): { sql: string; params: SqlValue[] } {
  const conditions = ['table_name = ?'];
  // The table goes into the parameter list first because it is the first condition. Returning the
  // SQL and leaving the caller to prepend the table would put the same fact in two places, and the
  // first caller to forget would read another table's rows rather than fail.
  const params: SqlValue[] = [table];

  const prefix = predicate.keyPrefix;
  if (prefix !== undefined && prefix !== '') {
    conditions.push('substr(key, 1, ?) = ?');
    params.push(prefix.length, prefix);
  }
  return { sql: `SELECT value, tags FROM kv WHERE ${conditions.join(' AND ')}`, params };
}

/** True when `tags` contains every requested tag (AND semantics). */
export function matchesAllTags(
  tags: readonly string[],
  requested: readonly string[] | undefined,
): boolean {
  if (requested === undefined || requested.length === 0) return true;
  return requested.every((tag) => tags.includes(tag));
}

/**
 * Turn rows into values, applying the predicate's tag filter and then its pagination.
 *
 * ## Why the order is not negotiable
 *
 * Tags are matched in JavaScript because they are stored as a JSON array in one column, so SQL
 * cannot filter them without a join table that would have to be kept in sync. The consequence is
 * that `LIMIT`/`OFFSET` must be applied *after* that filter, in JS. Applying them in SQL first
 * would page over rows the predicate then discards, so `limit: 10, offset: 10` would return fewer
 * than ten rows -- or none -- depending on how many matched. That is the sort of bug that survives
 * review because the happy path (`offset: 0`) agrees.
 */
export function selectPage<T>(rows: readonly KvRow[], predicate: QueryPredicate): T[] {
  const values = rows
    .filter((row) => matchesAllTags(parseTags(row.tags), predicate.tags))
    .map((row) => JSON.parse(row.value) as T);

  const offset = predicate.offset ?? 0;
  const limit = predicate.limit ?? values.length;
  return values.slice(offset, offset + limit);
}

/**
 * Parse the stored tag array.
 *
 * A malformed value throws, on purpose. The alternative -- treating unreadable tags as `[]` -- would
 * make a corrupted row invisible to every tag query while remaining visible to `get`, which is a
 * worse failure than an exception: the row exists, is readable, and is silently skipped by the
 * mechanism that is supposed to find it.
 */
export function parseTags(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((tag) => typeof tag !== 'string')) {
    throw new TypeError(`stored tags are not a string array: ${raw}`);
  }
  return parsed as string[];
}
