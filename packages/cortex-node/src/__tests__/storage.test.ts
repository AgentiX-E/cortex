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

  it('queries by tags', async () => {
    const s = new SqliteStorage({ filename: ':memory:' });
    stores.push(s);
    await s.put('mem', 'a', { v: 'a' }, { tags: ['x'] });
    await s.put('mem', 'b', { v: 'b' }, { tags: ['y'] });
    const rows = await s.query<{ v: string }>('mem', { tags: ['x'] });
    expect(rows).toEqual([{ v: 'a' }]);
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
});

describe('package exports', () => {
  it('exports storage backends', () => {
    expect(typeof cortexNode.SqliteStorage).toBe('function');
    expect(typeof cortexNode.PgStorage).toBe('function');
    expect(typeof cortexNode.ensurePgSchema).toBe('function');
  });
});
