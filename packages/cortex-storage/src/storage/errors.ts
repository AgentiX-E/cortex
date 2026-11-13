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
