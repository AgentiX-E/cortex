/**
 * What a caller sees when the connection behind `SqlStorage` cannot reach the data.
 *
 * ## The defect these tests exist for
 *
 * A real Chromium with the origin's quota at zero answers a `put` with
 * `SQLITE_IOERR: sqlite3 result code 10: disk I/O error` inside an `RpcError` whose code is
 * `engine-error` -- the same code a typo in the SQL produces. A caller cannot tell a failing disk
 * from a malformed statement without matching on a string.
 *
 * What is asserted here is the part no browser is needed for: that the translation happens once per
 * public call, that it happens for the read path too (reads purge expired rows, so a read can be the
 * statement that fails), and that it does not paper over a connection left in an unknown state.
 */
import { describe, expect, it } from 'vitest';
import { StorageUnavailableError } from '../storage/errors.js';
import { KV_DEL, KV_PUT, KV_PURGE, type SqlSession } from '../storage/sql.js';
import { SqlStorage } from '../storage/sql-storage.js';
import { translationFor } from '../browser/storage-failure.js';
import { createBetterSqliteEngine, sessionFor } from './support/sql-engines.js';

/** Exactly what the product received from SQLite under a zero quota, in a real Chromium. */
const MEASURED = 'SQLITE_IOERR: sqlite3 result code 10: disk I/O error';

/**
 * A session whose writing statements fail the way SQLite reports a storage-level failure.
 *
 * A wrapper over a real engine rather than a stub: `exec` still reaches sqlite, so `BEGIN`/`ROLLBACK`
 * behave, and only the statements that write are made to fail. `attempts` counts them, which is how
 * "translated once, not once per statement" becomes an assertion instead of a claim.
 */
function refusesWrites(session: SqlSession): { session: SqlSession; attempts: () => number } {
  let attempts = 0;
  const failing = new Set([KV_PUT, KV_DEL, KV_PURGE]);
  return {
    attempts: () => attempts,
    session: {
      exec: (sql) => session.exec(sql),
      all: (sql, params) => session.all(sql, params),
      close: () => session.close(),
      run: async (sql, params) => {
        if (failing.has(sql)) {
          attempts += 1;
          throw new Error(MEASURED);
        }
        await session.run(sql, params);
      },
    },
  };
}

function storageOver(session: SqlSession): SqlStorage {
  return new SqlStorage(session, { translateFailure: translationFor() });
}

describe('a storage failure, seen by the caller', () => {
  it('reports a put as StorageUnavailableError, keeping the SQLite message as the cause', async () => {
    const { session } = refusesWrites(sessionFor(createBetterSqliteEngine()));
    const storage = storageOver(session);
    const failure = await storage.put('table', 'key', { v: 1 }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(StorageUnavailableError);
    expect((failure as StorageUnavailableError).cause).toMatchObject({ message: MEASURED });
    await storage.close();
  });

  it('reports a get the same way, because a read purges expired rows', async () => {
    const { session } = refusesWrites(sessionFor(createBetterSqliteEngine()));
    const storage = storageOver(session);
    await expect(storage.get('table', 'key')).rejects.toBeInstanceOf(StorageUnavailableError);
    await storage.close();
  });

  it('reports a delete and a query the same way', async () => {
    const { session } = refusesWrites(sessionFor(createBetterSqliteEngine()));
    const storage = storageOver(session);
    await expect(storage.del('table', 'key')).rejects.toBeInstanceOf(StorageUnavailableError);
    await expect(storage.query('table')).rejects.toBeInstanceOf(StorageUnavailableError);
    await storage.close();
  });

  it('translates a transaction body failure once, at the boundary', async () => {
    const { session, attempts } = refusesWrites(sessionFor(createBetterSqliteEngine()));
    const storage = storageOver(session);
    await expect(
      storage.transaction(async (tx) => {
        await tx.put('table', 'a', { v: 1 });
        await tx.put('table', 'b', { v: 2 });
      }),
    ).rejects.toBeInstanceOf(StorageUnavailableError);
    // Only the first put reached the engine: the body stopped there and the transaction rolled back.
    expect(attempts()).toBe(1);
    await storage.close();
  });

  it('does not hide a connection in an unknown state behind the storage name', async () => {
    // The rollback is the statement that makes the connection clean, and here it fails too. The
    // aggregate is the honest answer: "unavailable" would say the state is known, and it is not.
    const { session } = refusesWrites(sessionFor(createBetterSqliteEngine()));
    const withBrokenRollback: SqlSession = {
      exec: async (sql) => {
        if (sql.trim().toUpperCase() === 'ROLLBACK') throw new Error('disk went away mid-rollback');
        await session.exec(sql);
      },
      run: (sql, params) => session.run(sql, params),
      all: (sql, params) => session.all(sql, params),
      close: () => session.close(),
    };
    const storage = storageOver(withBrokenRollback);
    const failure = await storage
      .transaction(async (tx) => {
        await tx.put('table', 'a', { v: 1 });
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toMatchObject({ message: MEASURED });
    await storage.close();
  });

  it('propagates the raw failure when no translator is installed', async () => {
    // The server and embedded backends have no such translation to make; their errors are already theirs.
    const { session } = refusesWrites(sessionFor(createBetterSqliteEngine()));
    const storage = new SqlStorage(session);
    const failure = await storage.put('table', 'key', { v: 1 }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(StorageUnavailableError);
    expect((failure as Error).message).toBe(MEASURED);
    await storage.close();
  });
});
