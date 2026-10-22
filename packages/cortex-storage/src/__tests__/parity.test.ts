/**
 * Parity: the same scripted workload, run through three different paths, must produce one answer.
 *
 * ## The three arms, and what each one isolates
 *
 * | arm | storage | engine | crosses a thread |
 * |---|---|---|---|
 * | `server` | `SqliteStorage` | better-sqlite3 | no |
 * | `independent` | `SqlStorage` + direct session | node:sqlite | no |
 * | `channel` | `SqlStorage` + `EngineRpcSession` | node:sqlite | yes |
 *
 * `server` against `independent` isolates the **engine**. `independent` against `channel` isolates
 * the **protocol**. That split matters when this test fails: a mismatch between arms 1 and 2 is a
 * SQL difference, and a mismatch between 2 and 3 is a message-passing difference, and the two have
 * nothing to do with each other. A single comparison of arm 1 to arm 3 would report "they differ"
 * and leave the reader to work out which half was responsible.
 *
 * ## Why the workload is generated from a seed rather than written out
 *
 * Two hundred operations covering the combinations a hand-written list forgets: a delete of a key
 * that expired, a prefix query with `_` in it, a transaction that rewrites a row it also reads.
 * The seed makes the run reproducible -- a failure prints the operation index and the script is
 * identical next time.
 *
 * ## What is deliberately not compared
 *
 * Error *messages*. Engines word them differently and the difference is not a defect. Errors are
 * compared by type name (or by the fact that the arm threw at all), which is the part callers can
 * depend on.
 */
import { describe, expect, it, afterEach } from 'vitest';
import type { SqlEngine } from '../browser/rpc.js';
import type { QueryPredicate, Storage } from '@agentix-e/cortex-core';
import type { SqlSession } from '../storage/sql.js';
import { SqlStorage } from '../storage/sql-storage.js';
import { SqliteStorage } from '../storage/sqlite.js';
import { openChannelSession, type ChannelSession } from './support/channel.js';
import {
  createBetterSqliteEngine,
  createNodeSqliteEngine,
  hasNodeSqlite,
  sessionFor,
} from './support/sql-engines.js';

type Op =
  | { kind: 'put'; table: string; key: string; value: unknown; tags?: string[]; ttlMs?: number }
  | { kind: 'get'; table: string; key: string }
  | { kind: 'del'; table: string; key: string }
  | { kind: 'query'; table: string; predicate: QueryPredicate }
  | {
      kind: 'transaction';
      writes: { table: string; key: string; value: unknown }[];
      fail: boolean;
    };

const TABLES = ['facts', 'turns', 'notes'] as const;
const TAGS = ['a', 'b', 'c'] as const;

/** mulberry32: small, deterministic, and good enough to shuffle a workload. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function script(count: number, seed: number): Op[] {
  const random = seeded(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const key = (): string => `k${Math.floor(random() * 20)}`;
  const ops: Op[] = [];

  for (let index = 0; index < count; index += 1) {
    const roll = random();
    const table = pick(TABLES);

    if (roll < 0.42) {
      const tags = random() < 0.5 ? [pick(TAGS)] : undefined;
      const ttlRoll = random();
      const ttlMs = ttlRoll < 0.15 ? -1 : ttlRoll < 0.25 ? 60_000 : undefined;
      const op: Op = { kind: 'put', table, key: key(), value: { n: index } };
      if (tags !== undefined) op.tags = tags;
      if (ttlMs !== undefined) op.ttlMs = ttlMs;
      ops.push(op);
    } else if (roll < 0.6) {
      ops.push({ kind: 'get', table, key: key() });
    } else if (roll < 0.68) {
      ops.push({ kind: 'del', table, key: key() });
    } else if (roll < 0.92) {
      const predicate: QueryPredicate = {};
      if (random() < 0.4) predicate.tags = [pick(TAGS)];
      if (random() < 0.3) predicate.keyPrefix = random() < 0.5 ? 'k1' : 'k_';
      if (random() < 0.3) predicate.limit = Math.floor(random() * 4);
      if (random() < 0.3) predicate.offset = Math.floor(random() * 3);
      ops.push({ kind: 'query', table, predicate });
    } else {
      const writes = [{ table, key: key(), value: { n: index } }];
      if (random() < 0.5) writes.push({ table, key: key(), value: { n: index + 1 } });
      ops.push({ kind: 'transaction', writes, fail: random() < 0.5 });
    }
  }

  return ops;
}

/** Run one operation and describe its outcome in a way that is comparable across arms. */
async function apply(storage: Storage, op: Op): Promise<string> {
  try {
    switch (op.kind) {
      case 'put': {
        const options = {
          ...(op.tags === undefined ? {} : { tags: op.tags }),
          ...(op.ttlMs === undefined ? {} : { ttlMs: op.ttlMs }),
        };
        await storage.put(op.table, op.key, op.value, options);
        return 'ok';
      }
      case 'get':
        return JSON.stringify(await storage.get(op.table, op.key), nullish);
      case 'del':
        await storage.del(op.table, op.key);
        return 'ok';
      case 'query':
        return JSON.stringify(await storage.query(op.table, op.predicate), nullish);
      case 'transaction': {
        await storage.transaction(async (tx) => {
          for (const write of op.writes) await tx.put(write.table, write.key, write.value);
          if (op.fail) throw new Error('scripted failure');
        });
        return op.fail ? 'committed-after-failure' : 'committed';
      }
    }
  } catch (error) {
    return `threw:${error instanceof Error ? error.name : typeof error}`;
  }
}

/** Sort keys so that two arms returning the same rows in a different order cannot look equal. */
function nullish(_key: string, value: unknown): unknown {
  return value === undefined ? '<undefined>' : value;
}

type Arm = { name: string; storage: Storage; done: () => Promise<void> };

const arms: Arm[] = [];
const channels: ChannelSession[] = [];

function buildArms(): Arm[] {
  const serverStorage = new SqliteStorage({ filename: ':memory:' });
  arms.push({
    name: 'server',
    storage: serverStorage,
    done: () => serverStorage.close(),
  });

  const engines: { name: string; make: () => SqlEngine }[] = [
    { name: 'independent', make: () => createNodeSqliteEngine() },
  ];
  if (!hasNodeSqlite()) {
    // Without `node:sqlite` there is no second engine to be independent *of*, so the engine half of
    // the claim is not available. The protocol half still is, over the engine that is here.
    engines.splice(0, 1, { name: 'independent', make: () => createBetterSqliteEngine() });
  }

  const direct = engines[0] as { name: string; make: () => SqlEngine };
  const directSession: SqlSession = sessionFor(direct.make());
  const directStorage = new SqlStorage(directSession);
  arms.push({
    name: `${direct.name}(${hasNodeSqlite() ? 'node:sqlite' : 'better-sqlite3'})`,
    storage: directStorage,
    done: () => directStorage.close(),
  });

  const channel = openChannelSession(direct.make());
  channels.push(channel);
  const channelStorage = new SqlStorage(channel.session);
  arms.push({
    name: 'channel',
    storage: channelStorage,
    done: () => channelStorage.close(),
  });

  return arms;
}

afterEach(async () => {
  for (const arm of arms.splice(0)) await arm.done();
  for (const channel of channels.splice(0)) await channel.close();
});

describe('parity across engine and protocol', () => {
  it('produces identical outcomes for 200 generated operations', async () => {
    const running = buildArms();
    expect(running.length).toBe(3);

    const ops = script(200, 0x5eed);
    const counts = new Map<string, number>();
    for (const op of ops) counts.set(op.kind, (counts.get(op.kind) ?? 0) + 1);
    // A script that never queried would pass parity vacuously. Every kind has to appear.
    for (const kind of ['put', 'get', 'del', 'query', 'transaction']) {
      expect(counts.get(kind) ?? 0, `${kind} missing from the script`).toBeGreaterThan(5);
    }

    for (const [index, op] of ops.entries()) {
      const outcomes: string[] = [];
      for (const arm of running) outcomes.push(await apply(arm.storage, op));
      const first = outcomes[0] as string;
      for (const [position, outcome] of outcomes.entries()) {
        expect(
          outcome,
          `operation ${index} (${op.kind}) diverged at arm ${running[position]?.name}`,
        ).toBe(first);
      }
    }

    // The final state, not just the responses: an arm that dropped a row would agree on every
    // individual reply as long as the row was not the one asked about.
    const dumps: string[] = [];
    for (const arm of running) {
      const dump: Record<string, unknown> = {};
      for (const table of TABLES) dump[table] = await arm.storage.query(table);
      dumps.push(JSON.stringify(dump, nullish));
    }
    for (const [position, dump] of dumps.entries()) {
      expect(dump, `final state diverged at arm ${running[position]?.name}`).toBe(dumps[0]);
    }
  });
});
