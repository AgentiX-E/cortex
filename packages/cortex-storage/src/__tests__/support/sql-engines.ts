/**
 * Two real SQL engines, exposed through the synchronous {@link SqlEngine} interface.
 *
 * ## Why the test support is engines and not session stubs
 *
 * Everything below `SqlStorage` is either SQLite or glue. A stub session would assert the glue
 * against the stub's idea of SQLite -- which is to say, against itself. These two adapters are real:
 * one is the engine the server ships, the other is a second, independent SQLite build reached
 * through a different API (`node:sqlite`'s `DatabaseSync`). That independence is what makes the
 * parity test worth running: two separate C libraries agreeing on every observable result is
 * evidence, and one library agreeing with itself is not.
 *
 * `node:sqlite` is available from Node 22.5 without a flag, but it is still experimental, so the
 * helpers report which engine they produced and the tests say so in their output rather than
 * assuming.
 */
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import type { EngineInfo, SqlEngine } from '../../browser/rpc.js';
import type { SqlRow, SqlSession, SqlValue } from '../../storage/sql.js';

const require = createRequire(import.meta.url);

/** Whether this runtime exposes `node:sqlite`, which is the independent engine. */
export function hasNodeSqlite(): boolean {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

type Statement = {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
};

type Handle = {
  exec(sql: string): unknown;
  prepare(sql: string): Statement;
  close(): void;
};

function engineOver(handle: Handle, engine: string, vfs: string): SqlEngine {
  // Closing twice is a state that happens as soon as two storages share one engine, which is what a
  // fault-injection test does. A real session has to tolerate it, so the adapter does too.
  let closed = false;
  const version = (): string => {
    try {
      const row = handle.prepare('SELECT sqlite_version() AS v').all()[0] as
        { v?: unknown } | undefined;
      return typeof row?.v === 'string' ? row.v : 'unknown';
    } catch {
      return 'unknown';
    }
  };
  const journalMode = (): string => {
    try {
      const row = handle.prepare('PRAGMA journal_mode').all()[0] as
        { journal_mode?: unknown } | undefined;
      return typeof row?.journal_mode === 'string' ? row.journal_mode : 'unknown';
    } catch {
      return 'unknown';
    }
  };
  const info: EngineInfo = { engine, version: version(), vfs, journal: journalMode() };

  return {
    exec: (sql) => void handle.exec(sql),
    run: (sql, params) => void handle.prepare(sql).run(...params),
    all: (sql, params) => handle.prepare(sql).all(...params) as SqlRow[],
    close: () => {
      if (closed) return;
      closed = true;
      handle.close();
    },
    describe: () => info,
  };
}

/** The engine the server ships. */
export function createBetterSqliteEngine(path = ':memory:'): SqlEngine {
  return engineOver(new Database(path) as unknown as Handle, 'better-sqlite3', 'memory');
}

/** A second, independent SQLite build. Throws when the runtime has no `node:sqlite`. */
export function createNodeSqliteEngine(path = ':memory:'): SqlEngine {
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => Handle;
  };
  return engineOver(new DatabaseSync(path), 'node:sqlite', 'memory');
}

/**
 * A `SqlSession` over a synchronous engine.
 *
 * This is the adapter the parity test uses to separate two possible causes of a mismatch: if the
 * direct arm and the RPC arm disagree, the protocol is at fault; if the direct arm and the
 * better-sqlite3 arm disagree, the engine is.
 */
export function sessionFor(engine: SqlEngine): SqlSession {
  const closed = { value: false };
  return {
    exec: async (sql: string) => engine.exec(sql),
    run: async (sql: string, params: readonly SqlValue[]) => engine.run(sql, params),
    all: async (sql: string, params: readonly SqlValue[]) => engine.all(sql, params),
    close: async () => {
      if (closed.value) return;
      closed.value = true;
      engine.close();
    },
  };
}
