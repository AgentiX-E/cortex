/**
 * The errors every backend in this package raises, defined once.
 *
 * ## Why this is its own module
 *
 * These two classes were defined inside `sql-storage.ts`, which made them a property of the SQLite
 * path rather than of the `Storage` contract. `PgStorage` therefore raised nothing: after
 * `close()` it re-threw whatever `pg` said -- `Cannot use a pool after calling end on the pool` --
 * so a caller that caught the documented error type worked against the embedded backend and
 * crashed against the server one. Same interface, two error vocabularies, and the difference was
 * invisible because no test compared the two backends' failures.
 *
 * The integration suite (`test/pg/integration.test.ts`) caught it the first time it ran. The fix
 * is not to translate a message: it is for both adapters to raise the same class, which means the
 * class cannot live in either one.
 *
 * ## Why these are classes and not string codes
 *
 * `instanceof` survives a bundler, a re-export and a `catch (e: unknown)`. A `code` property does
 * too, but only if every throw site remembers to set it, and the failure mode of forgetting is a
 * caller's `switch` falling through to a generic branch that swallows the error. A class cannot be
 * forgotten at a throw site that is typed to raise it.
 */

/** Raised when a storage is used after `close()`. */
export class StorageClosedError extends Error {
  constructor() {
    super('storage is closed: reopen a session rather than reusing this instance');
    this.name = 'StorageClosedError';
  }
}

/**
 * Raised when a write arrives from outside while a transaction is open on this connection.
 *
 * Only the SQLite-shaped backends raise this: `PgStorage` takes a client from the pool per
 * transaction, so a write from outside the body cannot land in somebody else's unit of work. The
 * class lives here anyway, because it is part of the contract a caller may have to catch and
 * because a class that exists only on one backend has to be re-found by every reader who wonders
 * whether the other one raises it.
 */
export class TransactionOpenError extends Error {
  constructor(operation: string) {
    super(
      `${operation}() was called while a transaction is open on this storage. The connection is ` +
        `inside BEGIN, so this write would belong to somebody else's unit of work. Use the handle ` +
        `passed to the transaction body, or await the transaction first.`,
    );
    this.name = 'TransactionOpenError';
  }
}

/**
 * Raised when a statement could not reach the data because the storage layer failed.
 *
 * ## Why this is not called "full"
 *
 * It was, for one round. The browser tier measured what a full origin actually produces -- and the
 * answer is that the page cannot tell. With the origin's quota overridden to zero, SQLite reports
 * `SQLITE_IOERR` (result code 10), the same code it reports for a failing device; meanwhile a raw
 * OPFS write of eight megabytes still succeeds and `navigator.storage.estimate()` still reports the
 * default 10 GiB (`test/browser/quota-probe.mjs`, reading committed beside it). A class named
 * `StorageFullError` would therefore have been wrong in one of the two cases, and wrong in the
 * direction that costs a user: told to free space when the disk is failing, or told to replace a
 * device when all they need is a deleted row.
 *
 * ## What a caller can act on
 *
 * The statement did not run: no partial write, no half-committed transaction. The engine's own
 * message is preserved as `cause`. The two causes worth checking, in the order that costs least to
 * check: free space on the device, and the origin's quota. Retrying the same statement unchanged is
 * the one response that helps in neither case.
 *
 * ## Why reads can raise it
 *
 * Reads purge expired rows for the table they touch, so a read can be the statement that finds the
 * storage unavailable. A message that said "your write failed" would be wrong about half the time it
 * appeared.
 */
export class StorageUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      'the storage layer could not carry out this statement, so nothing was written and nothing was ' +
        'half-written. Two causes reach this error and this library cannot tell them apart: the device ' +
        'is failing, or the origin is out of quota. Check free space, then the quota. Reads purge ' +
        'expired rows, so a read can fail this way too. Retrying the same statement will not help.',
      { cause },
    );
    this.name = 'StorageUnavailableError';
  }
}
