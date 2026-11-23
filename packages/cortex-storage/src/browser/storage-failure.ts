/**
 * Which engine failures are storage failures, and the name the browser tier gives them.
 *
 * ## The problem this solves, and the one it deliberately does not
 *
 * A statement on the OPFS tier can fail because the storage layer failed. SQLite reports that as
 * `SQLITE_IOERR: sqlite3 result code 10: disk I/O error`, which travels to the caller inside an
 * `RpcError` whose code says `engine-error` -- the same code a malformed statement produces. So a
 * caller cannot even tell "your SQL was wrong" from "your disk is gone" without matching on a string
 * this module is the only place to own.
 *
 * The predicate below is deliberately not exported: its only caller is the translator in this module,
 * and an export whose only reader is a test is the orphan `tools/export-census.mjs` exists to report.
 * The tests therefore exercise it through the translator, which is how a caller reaches it anyway.
 *
 * What it does **not** do is decide whether the cause was a failing device or an exhausted origin
 * quota. That was tried, in this file, with a one-byte write into the origin's directory, and it was
 * wrong: measured in a real Chromium with the origin's quota overridden to zero, a raw OPFS write of
 * one byte -- and of eight megabytes -- still succeeds and a fresh IndexedDB write still lands. Only
 * SQLite's own writes through the access-handle pool fail. The third candidate, the storage estimate,
 * turned out to depend on the browser build: it reports the default 10 GiB on Chromium 1208 and 0 on
 * the CI Chromium, which is a reason not to use it rather than a reason to trust it. There is no
 * page-side signal that separates the two causes, so the error says so instead of guessing, and
 * `test/browser/quota-probe.mjs` keeps the facts as a reading.
 *
 * ## Why the name is about the layer, not about space
 *
 * `StorageFullError` was the first name and it claimed more than the evidence supports. A caller who
 * catches `StorageUnavailableError` learns what is true in both cases: the statement did not reach
 * the data, nothing was half-written, and the fix is on the storage side rather than in the query.
 */
import { StorageUnavailableError } from '../storage/errors.js';

/**
 * Whether a message carries the SQLite signature of a storage-level failure.
 *
 * Matched on the symbolic code rather than on the number: the message this repository measured is
 * `SQLITE_IOERR: sqlite3 result code 10: disk I/O error`, and `SQLITE_FULL` (13) is the same class of
 * condition on engines that report it directly. `SQLITE_BUSY` and a malformed statement are not
 * candidates, and a message that merely says "disk I/O error" is not either -- the symbolic code is
 * what makes this a signature rather than a phrase.
 */
function looksLikeStorageFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes('SQLITE_IOERR') || error.message.includes('SQLITE_FULL');
}

/**
 * The translator the OPFS tier hands to `SqlStorage`.
 *
 * One decision: a storage-level failure becomes a named, catchable error that keeps the engine's
 * message as its `cause`. Everything else passes through untouched, so this cannot make any failure
 * worse than it was, and it adds no work to a statement that succeeds.
 */
export function translationFor() {
  return async (error: unknown): Promise<unknown> => {
    if (!looksLikeStorageFailure(error)) return error;
    return new StorageUnavailableError(error);
  };
}
