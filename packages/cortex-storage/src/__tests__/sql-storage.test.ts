/**
 * `SqlStorage`'s behaviour, asserted against two real engines.
 *
 * ## Why the suite is parameterised over engines rather than written once
 *
 * The class is the only `Storage` implementation the SQL backends share, so a behaviour that holds
 * on one engine and not the other is a behaviour nobody can rely on. Running the same assertions
 * against `better-sqlite3` and `node:sqlite` costs one loop and catches exactly that.
 *
 * ## Why the engine is kept alongside the storage
 *
 * Some claims are about the *files*, not the API: "an expired row is deleted, not merely hidden"
 * cannot be asserted through `get`, which is the thing doing the hiding. Holding the engine lets
 * those tests read `kv` directly -- white box, against the real table, with no fake in sight.
 *
 * ## The transactions
 *
 * Three of these tests exist because the previous implementation passed them for the wrong reason:
 * `transaction()` never issued `BEGIN`, so a body that threw left its earlier writes behind. The
 * rollback test is the one that would have caught it, and it is written to fail loudly if the
 * rollback ever stops happening.
 */
import { describe, expect, it, afterEach } from 'vitest';
import type { SqlEngine } from '../browser/rpc.js';
import { KV_PURGE, type SqlSession, type SqlRow } from '../storage/sql.js';
import { SqlStorage, StorageClosedError, TransactionOpenError } from '../storage/sql-storage.js';
import { SqliteStorage } from '../storage/sqlite.js';
import {
  createBetterSqliteEngine,
  createNodeSqliteEngine,
  hasNodeSqlite,
  sessionFor,
} from './support/sql-engines.js';

type Arm = { name: string; open: () => { session: SqlSession; engine: SqlEngine } };

const ARMS: Arm[] = [{ name: 'better-sqlite3', open: () => withSession(createBetterSqliteEngine) }];

if (hasNodeSqlite()) {
  ARMS.push({ name: 'node:sqlite', open: () => withSession(createNodeSqliteEngine) });
}

function withSession(make: () => SqlEngine): { session: SqlSession; engine: SqlEngine } {
  const engine = make();
  return { session: sessionFor(engine), engine };
}

/** A session that fails on one chosen statement. Fault injection over a real engine, not a stub. */
function failingRollback(session: SqlSession): SqlSession {
  return {
    exec: async (sql: string) => {
      if (sql.trim().toUpperCase() === 'ROLLBACK') throw new Error('disk went away mid-rollback');
      await session.exec(sql);
    },
    run: (sql, params) => session.run(sql, params),
    all: (sql, params) => session.all(sql, params),
    close: () => session.close(),
  };
}

describe.each(ARMS)('SqlStorage over $name', ({ open }) => {
  const opened: SqlStorage[] = [];

  function make(factory: () => { session: SqlSession; engine: SqlEngine } = open): {
    storage: SqlStorage;
    engine: SqlEngine;
  } {
    const { session, engine } = factory();
    const storage = new SqlStorage(session);
    opened.push(storage);
    return { storage, engine };
  }

  afterEach(async () => {
    for (const storage of opened.splice(0)) await storage.close();
  });

  it('stores and reads a value back', async () => {
    const { storage } = make();
    await storage.put('facts', 'k1', { content: 'hello' });
    expect(await storage.get<{ content: string }>('facts', 'k1')).toEqual({ content: 'hello' });
  });

  it('rewrites the same key instead of failing on the second write', async () => {
    // The upsert's conflict target. Without `ON CONFLICT(table_name, key)` this test fails with a
    // constraint error on line two -- which is why a happy-path suite that writes every key once
    // never notices.
    const { storage } = make();
    await storage.put('facts', 'k1', { v: 1 });
    await storage.put('facts', 'k1', { v: 2 });
    expect(await storage.get('facts', 'k1')).toEqual({ v: 2 });
  });

  it('deletes a value and reports a missing key as undefined', async () => {
    const { storage } = make();
    await storage.put('facts', 'k1', { v: 1 });
    await storage.del('facts', 'k1');
    expect(await storage.get('facts', 'k1')).toBeUndefined();
    expect(await storage.get('facts', 'never-written')).toBeUndefined();
  });

  it('keeps tables apart', async () => {
    const { storage } = make();
    await storage.put('a', 'k', { v: 'in-a' });
    await storage.put('b', 'k', { v: 'in-b' });
    expect(await storage.get('a', 'k')).toEqual({ v: 'in-a' });
    expect(await storage.get('b', 'k')).toEqual({ v: 'in-b' });
  });

  it('queries by all requested tags', async () => {
    const { storage } = make();
    await storage.put('facts', 'a', { v: 'a' }, { tags: ['x'] });
    await storage.put('facts', 'b', { v: 'b' }, { tags: ['x', 'y'] });
    await storage.put('facts', 'c', { v: 'c' }, { tags: ['y'] });
    expect(await storage.query('facts', { tags: ['x'] })).toHaveLength(2);
    expect(await storage.query('facts', { tags: ['x', 'y'] })).toEqual([{ v: 'b' }]);
  });

  it('treats a prefix as a literal prefix, not as a pattern', async () => {
    // `_` and `%` are LIKE wildcards. A prefix filter built on `LIKE` matches `axb` for `a_b` and
    // everything for `a%b`; both are silent wrong answers, and neither shows up unless a key
    // happens to contain the character.
    const { storage } = make();
    await storage.put('facts', 'a_b', { v: 'literal' });
    await storage.put('facts', 'axb', { v: 'wildcard-match' });
    await storage.put('facts', 'a%b', { v: 'percent' });
    expect(await storage.query('facts', { keyPrefix: 'a_b' })).toEqual([{ v: 'literal' }]);
    expect(await storage.query('facts', { keyPrefix: 'a%b' })).toEqual([{ v: 'percent' }]);
  });

  it('compares a prefix case-sensitively', async () => {
    // SQLite's LIKE folds ASCII case, so a LIKE-based prefix answered `ID:` with `id:...` rows.
    const { storage } = make();
    await storage.put('facts', 'ID:1', { v: 'upper' });
    await storage.put('facts', 'id:1', { v: 'lower' });
    expect(await storage.query('facts', { keyPrefix: 'ID:' })).toEqual([{ v: 'upper' }]);
  });

  it('pages after filtering on tags', async () => {
    const { storage } = make();
    await storage.put('facts', 'k1', { n: 1 }, { tags: ['a'] });
    await storage.put('facts', 'k2', { n: 2 }, { tags: ['b'] });
    await storage.put('facts', 'k3', { n: 3 }, { tags: ['a'] });
    const page = await storage.query<{ n: number }>('facts', { tags: ['a'], limit: 1, offset: 1 });
    expect(page).toEqual([{ n: 3 }]);
  });

  it('hides an expired value from get and from query', async () => {
    const { storage } = make();
    await storage.put('facts', 'gone', { v: 1 }, { ttlMs: -1 });
    await storage.put('facts', 'here', { v: 2 });
    expect(await storage.get('facts', 'gone')).toBeUndefined();
    expect(await storage.query('facts')).toEqual([{ v: 2 }]);
  });

  it('deletes an expired row rather than only hiding it', async () => {
    // Visibility and storage are different claims. This one reads the table: if expiry were a
    // filter, the table would grow without bound and every query would scan the dead rows.
    const { storage, engine } = make();
    await storage.put('facts', 'gone', { v: 1 }, { ttlMs: -1 });
    expect(await storage.get('facts', 'gone')).toBeUndefined();
    expect(
      await engine.all('SELECT count(*) AS c FROM kv WHERE table_name = ?', ['facts']),
    ).toEqual([{ c: 0 }]);
  });

  it('finds expired rows through an index rather than scanning the table', async () => {
    // The purge runs on every read and write, so a scan here is quadratic in bulk loads: with 2,000
    // rows on OPFS that was the difference between 161 rows/s and a few hundred milliseconds. The
    // plan is asserted rather than the time, because the claim is about the schema.
    const { engine } = make();
    const plan: SqlRow[] = await engine.all(`EXPLAIN QUERY PLAN ${KV_PURGE}`, [
      'facts',
      Date.now(),
    ]);
    const detail = plan.map((row) => String(row.detail)).join(' | ');
    expect(detail).toContain('kv_expiry');
  });

  it('commits a transaction', async () => {
    const { storage } = make();
    await storage.transaction(async (tx) => {
      await tx.put('facts', 't1', { v: 1 });
      await tx.put('facts', 't2', { v: 2 });
      expect(await tx.get('facts', 't1')).toEqual({ v: 1 });
    });
    expect(await storage.get('facts', 't2')).toEqual({ v: 2 });
  });

  it('rolls back everything a failing body wrote', async () => {
    // The assertion that the old implementation would fail: it never issued BEGIN, so `inside`
    // survived the throw while the caller was told the transaction had failed.
    const { storage } = make();
    await storage.put('facts', 'before', { v: 0 });

    await expect(
      storage.transaction(async (tx) => {
        await tx.put('facts', 'inside', { v: 1 });
        throw new Error('body failed');
      }),
    ).rejects.toThrow('body failed');

    expect(await storage.get('facts', 'inside')).toBeUndefined();
    expect(await storage.get('facts', 'before')).toEqual({ v: 0 });
  });

  it('rolls back a delete as well as a write', async () => {
    const { storage } = make();
    await storage.put('facts', 'keep', { v: 1 });
    await expect(
      storage.transaction(async (tx) => {
        await tx.del('facts', 'keep');
        throw new Error('changed my mind');
      }),
    ).rejects.toThrow('changed my mind');
    expect(await storage.get('facts', 'keep')).toEqual({ v: 1 });
  });

  it('refuses a nested transaction', async () => {
    const { storage } = make();
    await expect(
      storage.transaction(async () => {
        await storage.transaction(async () => undefined);
      }),
    ).rejects.toBeInstanceOf(TransactionOpenError);
  });

  it('refuses a write from outside while a transaction is open', async () => {
    // The connection is inside BEGIN, so this row would be committed -- or rolled back -- with
    // somebody else's unit of work. Refusing is the only answer that does not misattribute it.
    const { storage } = make();
    let refusal: unknown;
    await storage.transaction(async () => {
      try {
        await storage.put('facts', 'stray', { v: 1 });
      } catch (error) {
        refusal = error;
      }
    });
    expect(refusal).toBeInstanceOf(TransactionOpenError);
    expect(await storage.get('facts', 'stray')).toBeUndefined();
  });

  it('still allows a read from outside while a transaction is open', async () => {
    const { storage } = make();
    await storage.put('facts', 'seed', { v: 1 });
    const seen = await storage.transaction(async (tx) => {
      await tx.put('facts', 'in', { v: 2 });
      return storage.get('facts', 'seed');
    });
    expect(seen).toEqual({ v: 1 });
  });

  it('serialises two transactions instead of interleaving their BEGINs', async () => {
    // If the second transaction started while the first was open, either the second BEGIN would
    // fail, or its write would be rolled back with the first body's throw. `second` surviving is
    // the evidence that the queue works.
    const { storage } = make();
    const first = storage.transaction(async (tx) => {
      await tx.put('facts', 'first', { v: 1 });
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error('first failed');
    });
    const second = storage.transaction(async (tx) => {
      await tx.put('facts', 'second', { v: 2 });
    });

    await expect(first).rejects.toThrow('first failed');
    await expect(second).resolves.toBeUndefined();
    expect(await storage.get('facts', 'first')).toBeUndefined();
    expect(await storage.get('facts', 'second')).toEqual({ v: 2 });
  });

  it('reports both failures when the rollback itself fails', async () => {
    // A connection whose rollback failed is in an unknown state; reporting only the body's error
    // would hide the one fact the caller most needs.
    const { engine } = open();
    const storage = new SqlStorage(failingRollback(sessionFor(engine)));
    opened.push(storage);

    await expect(
      storage.transaction(async (tx) => {
        await tx.put('facts', 'k', { v: 1 });
        throw new Error('body failed');
      }),
    ).rejects.toBeInstanceOf(AggregateError);
  });

  it('refuses use after close, and tolerates closing twice', async () => {
    const { storage } = make();
    await storage.close();
    await expect(storage.get('facts', 'k')).rejects.toBeInstanceOf(StorageClosedError);
    await expect(storage.put('facts', 'k', { v: 1 })).rejects.toBeInstanceOf(StorageClosedError);
    await expect(storage.close()).resolves.toBeUndefined();
  });

  it('reports a corrupted tag column instead of skipping the row', async () => {
    // A row whose tags are not a string array is invisible to every tag query but visible to `get`.
    // Silently treating it as untagged would hide a corrupted row from the only mechanism that
    // would have found it.
    const { storage, engine } = make();
    await engine.run(
      'INSERT INTO kv (table_name, key, value, tags, expires_at) VALUES (?, ?, ?, ?, NULL)',
      ['facts', 'broken', '{"v":1}', '{"not":"an array"}'],
    );
    await expect(storage.query('facts')).rejects.toBeInstanceOf(TypeError);
  });
});

describe('SqliteStorage', () => {
  it('is the same behaviour over the shipped engine', async () => {
    const storage = new SqliteStorage({ filename: ':memory:' });
    await storage.put('facts', 'k', { v: 1 });
    expect(await storage.get('facts', 'k')).toEqual({ v: 1 });
    await storage.close();
  });

  it('defaults to an in-memory database', async () => {
    const storage = new SqliteStorage();
    await storage.put('facts', 'k', { v: 1 });
    expect(await storage.get('facts', 'k')).toEqual({ v: 1 });
    await storage.close();
  });
});
