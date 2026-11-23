/**
 * The pool name exists twice, and this is the file that keeps the two copies equal.
 *
 * ## Why not import it
 *
 * `opfs-worker.ts` is a second entry point with its own budget: importing `opfs.ts` into it would pull
 * `SqlStorage`, the IndexedDB tier and this package's error classes into a worker whose only job is to
 * create a VFS. So the default is a literal in both files.
 *
 * ## What the two copies are for, and what breaks if they drift
 *
 * `opfs.ts` takes the origin-wide writer claim under `cortex:writer:<pool>`; `opfs-worker.ts` installs the
 * SAH pool under `?pool=<pool>`, defaulting to the same name. If they drift, the product claims one name
 * and opens another -- so two tabs would both be granted the claim *and* both contend for one pool, which
 * is the defect this round exists to remove, restored silently and with a green build.
 *
 * ## Why a source test rather than a shared constant
 *
 * A shared constant is the better design and it is blocked by the module graph, not by taste. Reading the
 * two files is the check that survives someone adding the import later: if the literal stops being the
 * default, the pattern below stops matching and this fails, which is the reminder to re-derive the seam
 * rather than to delete the test.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POOL_NAME } from '../browser/opfs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BROWSER = join(HERE, '..', 'browser');

describe('the pool name', () => {
  it('is the same in the claim and in the worker that installs the pool', () => {
    const source = readFileSync(join(BROWSER, 'opfs-worker.ts'), 'utf8');
    const match = /const poolName = params\.get\('pool'\) \?\? '([^']+)';/.exec(source);

    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(DEFAULT_POOL_NAME);
  });

  it('is the name the product documents, so a bug report can be matched to a lock', () => {
    // The name reaches a user through `BrowserStorageBusy`'s message, so it is not an internal detail.
    expect(DEFAULT_POOL_NAME).toBe('cortex');
  });
});
