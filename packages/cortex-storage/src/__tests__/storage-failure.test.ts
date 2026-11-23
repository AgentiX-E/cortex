/**
 * Which engine failures are storage failures -- and, just as important, which are not.
 *
 * ## The one decision this file is about
 *
 * A message carrying SQLite's symbolic I/O code is a storage failure; everything else is the
 * caller's own error and must come back untouched. The signature is the symbolic code rather than
 * the number, and rather than the phrase "disk I/O error", because a phrase is something any future
 * engine could produce for a different reason.
 *
 * ## What is deliberately not here
 *
 * Whether the cause was a device or a quota. That question was measured in a real Chromium and the
 * answer is that the page cannot tell (`test/browser/quota-probe.mjs`): at a zero quota a raw OPFS
 * write of eight megabytes still succeeds and `navigator.storage.estimate()` still reports 10 GiB,
 * while SQLite's own write fails. A test cannot assert a distinction the platform does not provide,
 * so the error's message states the ambiguity and this file asserts that it is stated.
 */
import { describe, expect, it } from 'vitest';
import { StorageUnavailableError } from '../storage/errors.js';
import { translationFor } from '../browser/storage-failure.js';

/** Exactly what the product received from SQLite under a zero quota, in a real Chromium. */
const MEASURED = 'SQLITE_IOERR: sqlite3 result code 10: disk I/O error';

describe('translationFor', () => {
  it('replaces a storage failure with a named error that keeps the cause', async () => {
    const translate = translationFor();
    const original = new Error(MEASURED);
    const translated = await translate(original);
    expect(translated).toBeInstanceOf(StorageUnavailableError);
    expect((translated as StorageUnavailableError).cause).toBe(original);
  });

  it('recognises SQLITE_FULL, the same condition on engines that report it directly', async () => {
    const translate = translationFor();
    expect(await translate(new Error('SQLITE_FULL: database or disk is full'))).toBeInstanceOf(
      StorageUnavailableError,
    );
  });

  it('passes an unrelated failure through as the same object', async () => {
    // Four shapes that are not the signature: a statement error, a busy database, the words without
    // the symbolic code, and something that is not an error at all.
    const translate = translationFor();
    for (const error of [
      new Error('SQLITE_ERROR: near "SELEC": syntax error'),
      new Error('SQLITE_BUSY: database is locked'),
      new Error('disk I/O error'),
      'SQLITE_IOERR',
    ]) {
      expect(await translate(error)).toBe(error);
    }
  });

  it('says in the message that the two causes cannot be told apart', () => {
    // The assertion a user-facing decision rests on: this error must not claim more than measured.
    const error = new StorageUnavailableError(new Error(MEASURED));
    expect(error.name).toBe('StorageUnavailableError');
    expect(error.message).toContain('quota');
    expect(error.message).toContain('device');
    expect(error.message).toContain('cannot tell them apart');
  });
});
