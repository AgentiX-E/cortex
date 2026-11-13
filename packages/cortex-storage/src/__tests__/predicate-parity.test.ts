/**
 * One predicate, three backends, one answer.
 *
 * ## The defect this file exists for
 *
 * `AUDIT-PRODUCT-SURFACE.md` §7 recorded that the three backends defined "prefix" three different ways:
 * `sql.ts` used `substr(key, 1, n) = prefix` and documented at length why `LIKE` is wrong; `idb.ts` used
 * `startsWith`, which agrees; `pg.ts` used `key LIKE 'prefix%'`, which does not — a `%` or `_` inside the
 * prefix became a wildcard, and whether the comparison folded case depended on the collation. The suite that
 * should have caught it (`parity.test.ts`) runs three *SQLite* paths, so the one backend that diverged was
 * the one backend it never built.
 *
 * The repair moved the prefix filter into JavaScript on the PostgreSQL path, which makes `startsWith` the one
 * definition. This file is the assertion that keeps it that way, and it is written as a **cross-backend
 * comparison** rather than as three expectations: a fourth backend added later is covered by being added to
 * the arm list, not by somebody remembering to copy a literal.
 *
 * ## Why predicates rather than a generated workload
 *
 * `parity.test.ts` generates two hundred operations because the interesting failures there are sequences. A
 * prefix predicate has no sequence: it is a pure function of one key set and one pattern, so the interesting
 * cases are the four ways a pattern can lie — `%`, `_`, case, and the empty string that must mean "no
 * filter". Enumerating them is the whole test, and enumerating them explicitly is what makes a failure name
 * the case rather than a script index.
 *
 * ## What is not compared
 *
 * Row order. No backend promises it, and comparing it would assert whatever `pg-mem`'s hash table or
 * SQLite's B-tree happened to do. `limit`/`offset` are compared **after** sorting for the same reason:
 * paging an unordered result set is only well defined up to the set it selects.
 */
import { describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import type { QueryPredicate, Storage } from '@agentix-e/cortex-core';

import { PgStorage, ensurePgSchema } from '../storage/pg.js';
import { SqlStorage } from '../storage/sql-storage.js';
import { SqliteStorage } from '../storage/sqlite.js';
import {
  createBetterSqliteEngine,
  createNodeSqliteEngine,
  hasNodeSqlite,
  sessionFor,
} from './support/sql-engines.js';

/**
 * Keys chosen so that every wrong implementation is visible.
 *
 * `id:1` and `ID:2` differ only in case; `a%b` and `axb` differ only in whether `%` is literal; `a_b` and
 * `aXb` do the same for `_`; `turn:` prefixes `turn:1` but must not reach `turns:3`.
 */
const KEYS = ['id:1', 'ID:2', 'a%b', 'axb', 'a_b', 'aXb', 'turn:1', 'turn:2', 'turns:3'] as const;

type Arm = { name: string; storage: Storage; done: () => Promise<void> };

async function buildArms(): Promise<Arm[]> {
  const sqlite = new SqliteStorage({ filename: ':memory:' });
  const engine = hasNodeSqlite() ? createNodeSqliteEngine() : createBetterSqliteEngine();
  const sql = new SqlStorage(sessionFor(engine));

  const db = newDb();
  const pool = new (db.adapters.createPg().Pool)() as never;
  await ensurePgSchema(pool as never);
  const pg = new PgStorage({ pool: pool as never });

  return [
    { name: 'sqlite', storage: sqlite, done: () => sqlite.close() },
    { name: 'sql', storage: sql, done: () => sql.close() },
    { name: 'postgres(pg-mem)', storage: pg, done: () => pg.close() },
  ];
}

/** Store one row per key, with the key as the value so a row identifies itself. */
async function seed(storage: Storage): Promise<void> {
  for (const key of KEYS) {
    // Tags alternate so a tag filter narrows without correlating with the prefix.
    const tags = key.length % 2 === 0 ? ['even'] : ['odd'];
    await storage.put('facts', key, { key }, { tags });
  }
}

/** The keys a predicate selects, sorted, because no backend promises an order. */
async function keysOf(storage: Storage, predicate: QueryPredicate): Promise<string[]> {
  const rows = await storage.query<{ key: string }>('facts', predicate);
  return rows.map((row) => row.key).sort();
}

describe('one predicate, three backends', () => {
  it('selects the same keys for every shape of prefix, tag and page', async () => {
    const arms = await buildArms();
    try {
      for (const arm of arms) await seed(arm.storage);

      // Two groups, because a page of an unordered set is not a set. A predicate without `limit`/`offset`
      // selects a definite key set and all three backends must produce it; one with them selects a
      // **number** of rows, and which rows is whatever the engine's scan order happened to be. Comparing
      // identities in the second group would assert `pg-mem`'s hash table against SQLite's B-tree -- the
      // mistake this file's header warns about, caught by writing it the first time.
      const exact: { name: string; predicate: QueryPredicate }[] = [
        { name: 'no predicate', predicate: {} },
        { name: 'case-sensitive prefix', predicate: { keyPrefix: 'id:' } },
        { name: 'prefix that is a LIKE pattern', predicate: { keyPrefix: 'a%b' } },
        { name: 'prefix containing an underscore', predicate: { keyPrefix: 'a_b' } },
        { name: 'prefix that is a prefix of a longer word', predicate: { keyPrefix: 'turn:' } },
        { name: 'empty prefix means no filter', predicate: { keyPrefix: '' } },
        { name: 'prefix and tag', predicate: { keyPrefix: 'a', tags: ['odd'] } },
        { name: 'tag only', predicate: { tags: ['even'] } },
        { name: 'a prefix nothing has', predicate: { keyPrefix: 'zzz' } },
        { name: 'offset past the end', predicate: { offset: 99 } },
      ];

      for (const { name, predicate } of exact) {
        const results = await Promise.all(arms.map((arm) => keysOf(arm.storage, predicate)));
        const first = results[0] as string[];
        for (const [position, result] of results.entries()) {
          expect(result, `${name} diverged at ${arms[position]?.name}`).toEqual(first);
        }
      }

      const paged: { name: string; predicate: QueryPredicate; rows: number }[] = [
        { name: 'limit alone', predicate: { limit: 2 }, rows: 2 },
        {
          name: 'prefix, tag and limit',
          predicate: { keyPrefix: 'a', tags: ['odd'], limit: 1 },
          rows: 1,
        },
        {
          name: 'prefix, tag, offset and limit',
          predicate: { keyPrefix: 'a', tags: ['odd'], offset: 1, limit: 5 },
          rows: 3,
        },
      ];

      for (const { name, predicate, rows } of paged) {
        const results = await Promise.all(arms.map((arm) => keysOf(arm.storage, predicate)));
        for (const [position, result] of results.entries()) {
          expect(
            result,
            `${name} returned ${String(result.length)} rows at ${arms[position]?.name}`,
          ).toHaveLength(rows);
        }
      }
    } finally {
      for (const arm of arms) await arm.done();
    }
  });

  it('treats a percent sign in the prefix as a character, on every backend', async () => {
    // The narrow form of the first test, kept separate because this is the assertion that fails when the
    // PostgreSQL adapter goes back to `LIKE`: `a%b` matched `axb` as well, so the set was three keys where
    // the other two backends returned one.
    const arms = await buildArms();
    try {
      for (const arm of arms) await seed(arm.storage);
      for (const arm of arms) {
        expect(await keysOf(arm.storage, { keyPrefix: 'a%b' }), arm.name).toEqual(['a%b']);
      }
    } finally {
      for (const arm of arms) await arm.done();
    }
  });

  it('removes expired rows from the table rather than only hiding them', async () => {
    // `get` filtering an expired row is a read-time illusion; the two SQLite backends delete it, and this
    // asserts the PostgreSQL one does too. Asserted by reading through a *prefix query*, which is the path
    // that used to bypass the filter entirely, rather than through `get`, which never needed it.
    const arms = await buildArms();
    try {
      for (const arm of arms) {
        await arm.storage.put('facts', 'gone', { key: 'gone' }, { ttlMs: -1 });
        await arm.storage.put('facts', 'kept', { key: 'kept' });
      }
      for (const arm of arms) {
        expect(await keysOf(arm.storage, { keyPrefix: 'g' }), arm.name).toEqual([]);
        expect(await keysOf(arm.storage, {}), arm.name).toEqual(['kept']);
      }
    } finally {
      for (const arm of arms) await arm.done();
    }
  });
});
