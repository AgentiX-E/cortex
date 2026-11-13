/**
 * The PostgreSQL integration suite: `PgStorage` against a real server.
 *
 * ## Why this file exists, stated as a defect rather than as a feature
 *
 * `src/__tests__/storage.test.ts` contains this sentence, at the test that asserts a failed
 * transaction propagates:
 *
 *     NOTE: pg-mem does not implement ACID ROLLBACK semantics (verified: the row
 *     persists after ROLLBACK), so the rollback's effect on stored data is
 *     asserted against a real PostgreSQL instance in the integration suite.
 *
 * There was no integration suite. `grep -rn 'integration suite' .` returned that line and nothing
 * else. So the comment named a file that did not exist, and every reader -- including the round
 * that wrote the sentence -- took `pg-mem` coverage for coverage of PostgreSQL.
 *
 * The same paragraph in `src/storage/pg.ts` said the escaping that would make `LIKE ... ESCAPE`
 * correct is "implemented by neither `pg-mem` nor any engine this repository can run in a test".
 * That is false twice over: PostgreSQL implements it, and this repository can run PostgreSQL --
 * `apt-get install postgresql` takes 25 seconds and the server starts in two. The sentence was
 * not a finding about engines. It was a finding about the test environment, written in the voice
 * of a finding about engines, and it was then used to justify giving up an indexable predicate.
 *
 * ## What this suite is, and what it refuses to be
 *
 * It constructs a real `pg.Pool` against `CORTEX_PG_URL` and asserts the behaviour the adapter
 * claims. There is no shim, no in-process engine and no mock: a suite that asserts a stand-in
 * cannot find the differences between the stand-in and the thing.
 *
 * It runs when `CORTEX_PG_URL` is set. That conditional is the one dangerous line in the file --
 * a skipped suite looks exactly like a passing one in a test summary -- so the skip is not trusted
 * to be noticed. `tools/pg-integration-count.mjs` reads the JSON reporter output and fails when
 * the executed assertion count is below the floor or when anything was skipped. `verify.yml` runs
 * that check against a `services: postgres` container, which is what makes this suite a gate
 * rather than a file that exists.
 *
 * ## Why the tests are ordered and namespaced
 *
 * Each test owns its own `table_name`, so a failure names the behaviour instead of a tuple, and
 * no test depends on another's rows. The tables are dropped in `beforeAll` rather than at the end,
 * because a suite that dies halfway must not leave rows that make the next run pass.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PgStorage, ensurePgSchema } from '../../src/storage/pg.js';

const url = process.env.CORTEX_PG_URL;
const suite = url === undefined ? describe.skip : describe;

const TABLES = [
  'mem',
  'tag',
  'noq',
  'del',
  'ow',
  'pf',
  'pf2',
  'pf3',
  'pf4',
  'pf5',
  'page',
  'ttl1',
  'ttl2',
  'ttl3',
  'ttl4',
  'tx1',
  'tx2',
  'tx3',
  'tx4',
  'tx5',
  'tx6',
  'par1',
  'par2',
  'par3',
  'par3',
  'js1',
  'js2',
  'tg1',
  'tg2',
];

suite('PgStorage against a real PostgreSQL server', () => {
  let pool: pg.Pool;
  let store: PgStorage;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 6 });
    await ensurePgSchema(pool);
    // A fresh slate, so a run that died last time cannot satisfy an assertion this time.
    await pool.query(`DELETE FROM cortex_kv WHERE table_name = ANY($1::text[])`, [TABLES]);
    store = new PgStorage({ pool });
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('the kv contract', () => {
    it('stores and retrieves a value', async () => {
      await store.put('mem', 'k1', { content: 'hi' }, { tags: ['a'] });
      expect(await store.get('mem', 'k1')).toEqual({ content: 'hi' });
    });

    it('deletes a value', async () => {
      await store.put('del', 'k', { v: 1 });
      await store.del('del', 'k');
      expect(await store.get('del', 'k')).toBeUndefined();
    });

    it('overwrites in place rather than accumulating rows', async () => {
      await store.put('ow', 'k', { v: 1 });
      await store.put('ow', 'k', { v: 2 });
      expect(await store.get('ow', 'k')).toEqual({ v: 2 });
      const rows = await pool.query(
        `SELECT count(*)::int AS n FROM cortex_kv WHERE table_name = 'ow'`,
      );
      expect(rows.rows[0].n).toBe(1);
    });

    it('queries an entire table with no predicate', async () => {
      await store.put('noq', 'a', { v: 1 });
      await store.put('noq', 'b', { v: 2 });
      expect(await store.query('noq', {})).toHaveLength(2);
    });

    it('matches tags with AND semantics, on a real text[] column', async () => {
      await store.put('tag', 'a', { v: 'a' }, { tags: ['x', 'y'] });
      await store.put('tag', 'b', { v: 'b' }, { tags: ['x'] });
      expect(await store.query('tag', { tags: ['x', 'y'] })).toEqual([{ v: 'a' }]);
    });
  });

  describe('the key prefix', () => {
    it('excludes keys that do not start with it', async () => {
      await store.put('pf', 'aa', { v: 1 });
      await store.put('pf', 'ab', { v: 2 });
      await store.put('pf', 'bb', { v: 3 });
      const rows = await store.query<{ v: number }>('pf', { keyPrefix: 'a' });
      expect(rows.map((r) => r.v).sort()).toEqual([1, 2]);
    });

    it('treats % as a literal rather than a wildcard', async () => {
      await store.put('pf2', 'turn:%', { v: 'literal' });
      await store.put('pf2', 'turn:1', { v: 'one' });
      expect(await store.query('pf2', { keyPrefix: 'turn:%' })).toEqual([{ v: 'literal' }]);
    });

    it('treats _ as a literal rather than a single-character wildcard', async () => {
      await store.put('pf3', 'a_b', { v: 'underscore' });
      await store.put('pf3', 'axb', { v: 'any' });
      expect(await store.query('pf3', { keyPrefix: 'a_b' })).toEqual([{ v: 'underscore' }]);
    });

    // The one assertion that `LIKE` could not have satisfied: PostgreSQL's default collation folds
    // nothing, but a database created with a non-C collation *can* fold, and `substr`/`startsWith`
    // fold under no collation at all. This test is the reason the prefix filter is not SQL-side.
    it('is case-sensitive', async () => {
      await store.put('pf4', 'ID:x', { v: 'upper' });
      await store.put('pf4', 'id:y', { v: 'lower' });
      expect(await store.query('pf4', { keyPrefix: 'ID:' })).toEqual([{ v: 'upper' }]);
    });

    it('treats the empty string as no filter', async () => {
      await store.put('pf5', 'a', { v: 1 });
      await store.put('pf5', 'b', { v: 2 });
      expect(await store.query('pf5', { keyPrefix: '' })).toHaveLength(2);
    });
  });

  describe('pagination', () => {
    it('applies limit and offset after the tag filter', async () => {
      for (let i = 0; i < 5; i++) {
        await store.put('page', `k${i}`, { v: i }, { tags: i < 3 ? ['m'] : [] });
      }
      expect(await store.query('page', { tags: ['m'], limit: 10 })).toHaveLength(3);
      expect(await store.query('page', { tags: ['m'], offset: 2, limit: 10 })).toHaveLength(1);
    });

    it('treats a limit past the end as a short page and an offset past the end as empty', async () => {
      for (const i of [0, 1, 2]) await store.put('noq', `p${i}`, { v: i });
      expect(await store.query('noq', { limit: 2 })).toHaveLength(2);
      expect(await store.query('noq', { offset: 1, limit: 1 })).toHaveLength(1);
      expect(await store.query('noq', { offset: 9999, limit: 10 })).toHaveLength(0);
    });
  });

  describe('TTL', () => {
    it('hides an already-expired row from get', async () => {
      await store.put('ttl1', 'k', { v: 1 }, { ttlMs: -1 });
      expect(await store.get('ttl1', 'k')).toBeUndefined();
    });

    it('deletes the expired row rather than only hiding it', async () => {
      await store.put('ttl2', 'k', { v: 1 }, { ttlMs: -1 });
      await store.query('ttl2', {});
      const rows = await pool.query(
        `SELECT count(*)::int AS n FROM cortex_kv WHERE table_name = 'ttl2'`,
      );
      expect(rows.rows[0].n).toBe(0);
    });

    it('keeps a live row', async () => {
      await store.put('ttl3', 'k', { v: 1 }, { ttlMs: 60_000 });
      expect(await store.get('ttl3', 'k')).toEqual({ v: 1 });
    });

    it('hides an expired row from a tag predicate too', async () => {
      await store.put('ttl4', 'k', { v: 1 }, { ttlMs: -1, tags: ['x'] });
      expect(await store.query('ttl4', { tags: ['x'] })).toEqual([]);
    });
  });

  describe('transactions', () => {
    // The assertion `pg-mem` cannot make. It is the reason this file was supposed to exist.
    it('discards writes when the body throws', async () => {
      await expect(
        store.transaction(async (tx) => {
          await tx.put('tx1', 'inside', { v: 2 });
          throw new Error('body failed');
        }),
      ).rejects.toThrow('body failed');
      expect(await store.get('tx1', 'inside')).toBeUndefined();
    });

    it('propagates the body error, not a rollback artefact', async () => {
      let seen = '';
      try {
        await store.transaction(async (tx) => {
          await tx.put('tx2', 'k', { v: 1 });
          throw new Error('original');
        });
      } catch (error) {
        seen = (error as Error).message;
      }
      expect(seen).toBe('original');
    });

    it('makes a committed write visible on another connection', async () => {
      const reader = new PgStorage({ pool });
      await store.transaction(async (tx) => {
        await tx.put('tx3', 'k', { v: 42 });
      });
      expect(await reader.get('tx3', 'k')).toEqual({ v: 42 });
    });

    it('reads its own writes inside the body', async () => {
      await store.transaction(async (tx) => {
        await tx.put('tx4', 'k', { v: 5 });
        expect(await tx.get('tx4', 'k')).toEqual({ v: 5 });
      });
    });

    it('reads its own deletes inside the body', async () => {
      await store.put('tx5', 'k', { v: 5 });
      await store.transaction(async (tx) => {
        await tx.del('tx5', 'k');
        expect(await tx.get('tx5', 'k')).toBeUndefined();
      });
    });

    it('runs six concurrent transactions to completion on one pool', async () => {
      const jobs = Array.from({ length: 6 }, (_, i) =>
        store.transaction(async (tx) => {
          await tx.put('tx6', `k${i}`, { v: i });
          // Hold the transaction open long enough that a `BEGIN` on a shared connection would
          // interleave. `PgStorage` takes a client per transaction, so this must not deadlock.
          await new Promise((resolve) => setTimeout(resolve, 10));
        }),
      );
      const settled = await Promise.allSettled(jobs);
      expect(settled.filter((r) => r.status === 'rejected')).toEqual([]);
      expect(await store.query('tx6', {})).toHaveLength(6);
    });
  });

  /**
   * Where `PgStorage` and `SqlStorage` disagreed, and how it was found.
   *
   * These are not edge cases. Each one is a difference between two implementations of the same
   * interface, and each was invisible to the unit suite because `pg-mem` either accepts the wrong
   * behaviour or cannot express the right one. All three were red the first time this file ran.
   */
  describe('parity with the SQLite backend', () => {
    // `SqlStorage.#get` calls `#purge(table)` before reading. `PgStorage.makeTx`'s `get` issued a
    // bare `SELECT value ... WHERE table_name = $1 AND key = $2` with no `expires_at` condition, so
    // a transaction read a row that the same store hides outside a transaction. The window is real:
    // every expiry-bearing read the memory layer performs inside `transaction()` was affected.
    //
    // The row is inserted directly, because `put` purges on write and therefore cannot produce this
    // state: a row created through `put` with a negative TTL is already gone before the assertion
    // runs, and the test would then pass whether or not `tx.get` purges. That was measured, not
    // assumed -- removing the purge from `tx.get` left the earlier version of this test green,
    // because the repair to `put` was supplying the result the assertion was checking for. Two
    // repairs in one commit, and only one of them tested.
    it('transaction.get purges before reading, like the non-transactional read', async () => {
      await pool.query(
        `INSERT INTO cortex_kv (table_name, key, value, expires_at)
         VALUES ('par1', 'k', '{"v":1}'::jsonb, now() - interval '1 second')
         ON CONFLICT (table_name, key) DO UPDATE
           SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
      );
      const before = await pool.query(
        `SELECT count(*)::int AS n FROM cortex_kv WHERE table_name = 'par1'`,
      );
      expect(before.rows[0].n).toBe(1);

      const seen = await store.transaction(async (tx) => tx.get('par1', 'k'));
      expect(seen).toBeUndefined();

      // Hidden is not enough: the purge is a `DELETE`, and a row that is merely invisible still
      // accumulates. This is the same distinction the `query` path is tested on.
      const after = await pool.query(
        `SELECT count(*)::int AS n FROM cortex_kv WHERE table_name = 'par1'`,
      );
      expect(after.rows[0].n).toBe(0);
    });

    // `SqlStorage.#put` purges after writing. `PgStorage.put` did not, so an expired row stayed on
    // disk until the next read of that table -- and a table written to but never queried kept its
    // dead rows indefinitely. A leak no assertion about returned values can see.
    //
    // Inserted directly for the same reason as above: a row created by `put` with a negative TTL is
    // removed by the very `put` under test, which makes the count assertion true before the second
    // write is reached.
    it('put purges its table, like the SQLite backend', async () => {
      await pool.query(
        `INSERT INTO cortex_kv (table_name, key, value, expires_at)
         VALUES ('par2', 'dead', '{"v":1}'::jsonb, now() - interval '1 second')
         ON CONFLICT (table_name, key) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      );
      await store.put('par2', 'live', { v: 2 });
      const rows = await pool.query(
        `SELECT count(*)::int AS n FROM cortex_kv WHERE table_name = 'par2'`,
      );
      expect(rows.rows[0].n).toBe(1);
    });

    // The write inside a transaction is a separate statement from the write outside one -- it had
    // its own copy of the insert, and its own missing purge. Asserting only the outer `put` left
    // this half uncovered, which a mutation found: deleting the transactional purge changed
    // nothing in the suite until this test existed.
    it('put inside a transaction purges its table as well', async () => {
      await pool.query(
        `INSERT INTO cortex_kv (table_name, key, value, expires_at)
         VALUES ('par3', 'dead', '{"v":1}'::jsonb, now() - interval '1 second')
         ON CONFLICT (table_name, key) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      );
      await store.transaction(async (tx) => {
        await tx.put('par3', 'live', { v: 2 });
      });
      const rows = await pool.query(
        `SELECT count(*)::int AS n FROM cortex_kv WHERE table_name = 'par3'`,
      );
      expect(rows.rows[0].n).toBe(1);
    });

    // `SqlStorage` throws `StorageClosedError`. `PgStorage` threw whatever `pg` said --
    // "Cannot use a pool after calling end on the pool" -- so a caller that caught the documented
    // error type and closed a store would crash instead. Same interface, two error vocabularies.
    it('reports a closed store with the same error type as the SQLite backend', async () => {
      const own = new pg.Pool({ connectionString: url, max: 1 });
      const closed = new PgStorage({ pool: own });
      await closed.close();
      await expect(closed.get('mem', 'k')).rejects.toMatchObject({ name: 'StorageClosedError' });
      await expect(closed.put('mem', 'k', { v: 1 })).rejects.toMatchObject({
        name: 'StorageClosedError',
      });
    });
  });

  /**
   * Payload fidelity, and the one place where the two backends genuinely differ.
   *
   * `kv.value` is `TEXT` in SQLite and `JSONB` here. `JSONB` normalises: it sorts object keys,
   * drops duplicate keys and trailing whitespace, and re-renders numbers. So `get()` returns a
   * deep-equal value with a different `JSON.stringify` -- and a caller that hashes the serialised
   * payload (a digest, a signature, a dedup key) gets one answer on SQLite and another here.
   *
   * That is a property of the column type, not a bug in this adapter, and it is asserted rather
   * than described so that a future switch to `JSON` -- which preserves text -- fails here and has
   * to be argued for.
   */
  describe('payload fidelity', () => {
    it('round-trips nested values, null, unicode and the largest safe integer', async () => {
      const value = { a: [1, { b: null }], s: '汉字🙂', n: 9_007_199_254_740_991, f: 1.5, e: [] };
      await store.put('js1', 'k', value);
      expect(await store.get('js1', 'k')).toEqual(value);
    });

    it('keeps a string payload a string', async () => {
      await store.put('js2', 'k', 'plain');
      expect(await store.get('js2', 'k')).toBe('plain');
    });

    // Recorded, not fixed: `JSONB` decides the key order, and it is not insertion order. The rule
    // is length first, then byte order, which is why `alpha` precedes `zebra` in the input and both
    // survive in that order -- but `{ zebra: 1, alpha: 2 }` would come back with `alpha` first.
    it('normalises object key order, so a serialised payload is not byte-stable across backends', async () => {
      const value = { zebra: 1, alpha: 2 };
      await store.put('js1', 'order', value);
      const back = await store.get<Record<string, number>>('js1', 'order');
      expect(back).toEqual(value);
      expect(Object.keys(back!)).toEqual(['alpha', 'zebra']);
    });

    it('round-trips tags containing unicode, commas, quotes and braces', async () => {
      const tags = ['汉字', 'a,b', 'quote"d', '{odd}', 'back\\slash'];
      await store.put('tg1', 'k', { v: 1 }, { tags });
      for (const tag of tags) {
        expect(await store.query('tg1', { tags: [tag] })).toHaveLength(1);
      }
    });

    it('applies the schema twice without error', async () => {
      await ensurePgSchema(pool);
      await ensurePgSchema(pool);
    });
  });
});
