import { describe, it, expect, afterEach } from 'vitest';
import { SqliteStorage } from '../storage/sqlite.js';
import { PgStorage, ensurePgSchema } from '../storage/pg.js';
import * as cortexNode from '../index.js';
import { newDb } from 'pg-mem';

describe('SqliteStorage', () => {
  const stores: SqliteStorage[] = [];
  afterEach(async () => {
    for (const s of stores.splice(0)) {
      await s.close();
    }
  });

  it('stores and retrieves a value', async () => {
    const s = new SqliteStorage({ filename: ':memory:' });
    stores.push(s);
    await s.put('mem', 'k1', { content: 'hello' });
    expect(await s.get<{ content: string }>('mem', 'k1')).toEqual({ content: 'hello' });
  });

  it('deletes a value', async () => {
    const s = new SqliteStorage({ filename: ':memory:' });
    stores.push(s);
    await s.put('mem', 'k1', { x: 1 });
    await s.del('mem', 'k1');
    expect(await s.get('mem', 'k1')).toBeUndefined();
  });

  it('defaults to an in-memory database when no filename is given', async () => {
    const s = new SqliteStorage();
    stores.push(s);
    await s.put('mem', 'k', { v: 1 });
    expect(await s.get('mem', 'k')).toEqual({ v: 1 });
  });

  it('queries by tags', async () => {
    const s = new SqliteStorage({ filename: ':memory:' });
    stores.push(s);
    await s.put('mem', 'a', { v: 'a' }, { tags: ['x'] });
    await s.put('mem', 'b', { v: 'b' }, { tags: ['y'] });
    const rows = await s.query<{ v: string }>('mem', { tags: ['x'] });
    expect(rows).toEqual([{ v: 'a' }]);
  });

  it('expires a value after its TTL', async () => {
    const s = new SqliteStorage({ filename: ':memory:' });
    stores.push(s);
    await s.put('mem', 'k', { v: 1 }, { ttlMs: -1 });
    expect(await s.get('mem', 'k')).toBeUndefined();
  });

  it('queries with key prefix', async () => {
    const s = new SqliteStorage({ filename: ':memory:' });
    stores.push(s);
    await s.put('mem', 'aa', { v: 1 });
    await s.put('mem', 'ab', { v: 2 });
    await s.put('mem', 'bb', { v: 3 });
    const rows = await s.query<{ v: number }>('mem', { keyPrefix: 'a' });
    expect(rows.map((r) => r.v).sort()).toEqual([1, 2]);
  });

  it('paginates query results with limit and offset', async () => {
    const s = new SqliteStorage({ filename: ':memory:' });
    stores.push(s);
    await s.put('mem', 'a', { v: 1 });
    await s.put('mem', 'b', { v: 2 });
    await s.put('mem', 'c', { v: 3 });
    const rows = await s.query<{ v: number }>('mem', { offset: 1, limit: 1 });
    expect(rows).toHaveLength(1);
  });

  it('runs a transaction with read and write', async () => {
    const s = new SqliteStorage({ filename: ':memory:' });
    stores.push(s);
    const result = await s.transaction(async (tx) => {
      await tx.put('mem', 'k', { v: 7 });
      const got = await tx.get<{ v: number }>('mem', 'k');
      await tx.del('mem', 'gone');
      return got;
    });
    expect(result).toEqual({ v: 7 });
  });
});

describe('PgStorage (pg-mem)', () => {
  it('stores, retrieves, and queries', async () => {
    const db = newDb();
    const pool = new (db.adapters.createPg().Pool)() as never;
    await ensurePgSchema(pool as never);
    const s = new PgStorage({ pool: pool as never });
    await s.put('mem', 'k1', { content: 'hi' }, { tags: ['a'] });
    expect(await s.get('mem', 'k1')).toEqual({ content: 'hi' });
    const rows = await s.query<{ content: string }>('mem', { tags: ['a'] });
    expect(rows).toEqual([{ content: 'hi' }]);
    await s.del('mem', 'k1');
    expect(await s.get('mem', 'k1')).toBeUndefined();
    await s.close();
  });

  it('runs transactions atomically', async () => {
    const db = newDb();
    const pool = new (db.adapters.createPg().Pool)() as never;
    await ensurePgSchema(pool as never);
    const s = new PgStorage({ pool: pool as never });
    await s.transaction(async (tx) => {
      await tx.put('mem', 't1', { v: 1 });
      await tx.put('mem', 't2', { v: 2 });
    });
    expect(await s.get('mem', 't1')).toEqual({ v: 1 });
    expect(await s.get('mem', 't2')).toEqual({ v: 2 });
    await s.close();
  });

  it('reads and deletes within a transaction', async () => {
    const db = newDb();
    const pool = new (db.adapters.createPg().Pool)() as never;
    await ensurePgSchema(pool as never);
    const s = new PgStorage({ pool: pool as never });
    await s.transaction(async (tx) => {
      await tx.put('mem', 'k', { v: 5 });
      const got = await tx.get<{ v: number }>('mem', 'k');
      expect(got).toEqual({ v: 5 });
      await tx.del('mem', 'k');
      expect(await tx.get('mem', 'k')).toBeUndefined();
    });
    expect(await s.get('mem', 'k')).toBeUndefined();
    await s.close();
  });

  it('expires a value after its TTL', async () => {
    const db = newDb();
    const pool = new (db.adapters.createPg().Pool)() as never;
    await ensurePgSchema(pool as never);
    const s = new PgStorage({ pool: pool as never });
    await s.put('mem', 'k', { v: 1 }, { ttlMs: -1 });
    expect(await s.get('mem', 'k')).toBeUndefined();
    await s.close();
  });

  it('writes with TTL inside a transaction', async () => {
    const db = newDb();
    const pool = new (db.adapters.createPg().Pool)() as never;
    await ensurePgSchema(pool as never);
    const s = new PgStorage({ pool: pool as never });
    await s.transaction(async (tx) => {
      await tx.put('mem', 'k', { v: 1 }, { ttlMs: -1 });
    });
    expect(await s.get('mem', 'k')).toBeUndefined();
    await s.close();
  });

  it('propagates errors from a failed transaction', async () => {
    const db = newDb();
    const pool = new (db.adapters.createPg().Pool)() as never;
    await ensurePgSchema(pool as never);
    const s = new PgStorage({ pool: pool as never });
    await expect(
      s.transaction(async (tx) => {
        await tx.put('mem', 'k', { v: 1 });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // NOTE: pg-mem does not implement ACID ROLLBACK semantics (verified: the
    // row persists after ROLLBACK), so the rollback's effect on stored data is
    // asserted against a real PostgreSQL instance in the integration suite.
    await s.close();
  });

  it('queries with key prefix and without tags', async () => {
    const db = newDb();
    const pool = new (db.adapters.createPg().Pool)() as never;
    await ensurePgSchema(pool as never);
    const s = new PgStorage({ pool: pool as never });
    await s.put('mem', 'aa', { v: 1 });
    await s.put('mem', 'bb', { v: 2 });
    const rows = await s.query<{ v: number }>('mem', { keyPrefix: 'a' });
    expect(rows).toEqual([{ v: 1 }]);
    const all = await s.query<{ v: number }>('mem');
    expect(all).toHaveLength(2);
    await s.close();
  });
});

describe('package exports', () => {
  it('exports storage backends', () => {
    expect(typeof cortexNode.SqliteStorage).toBe('function');
    expect(typeof cortexNode.PgStorage).toBe('function');
    expect(typeof cortexNode.ensurePgSchema).toBe('function');
  });
});
