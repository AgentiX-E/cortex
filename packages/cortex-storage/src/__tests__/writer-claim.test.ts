/**
 * One origin, one writer: the claim two tabs contend for.
 *
 * ## What can be tested here, and what cannot
 *
 * The claim asks the platform one question -- "is anybody else holding this name" -- and everything that
 * makes the answer expensive to get wrong is in how the product uses it. The platform side is a lock
 * manager, so the fake below implements the single behaviour the code depends on: a lock handed to one
 * callback is not handed to another until that callback's promise settles. That is the whole of
 * `ifAvailable`, and a fake that instead returned "busy" or "free" as a flag would test a different
 * program.
 *
 * Whether a real browser answers the way this fake does is `two-tab-probe.mjs`'s question, and it is a
 * different question: this file would pass on a fake whose semantics no browser implements.
 */
import { describe, expect, it } from 'vitest';
import type { Storage, StorageTransaction } from '@agentix-e/cortex-core';
import { claimWithGrace, releaseOnClose, type WriterLockManager } from '../browser/writer-claim.js';

/**
 * A lock manager with the one guarantee the code relies on.
 *
 * `held` maps a name to the callback's promise; a request while a promise is pending resolves its own
 * callback with `null`, which is exactly what the platform does under `ifAvailable: true`.
 */
function fakeLocks(): {
  locks: WriterLockManager;
  held: Map<string, Promise<unknown>>;
  requests: string[];
} {
  const held = new Map<string, Promise<unknown>>();
  const requests: string[] = [];
  const locks: WriterLockManager = {
    request(name, _options, callback) {
      requests.push(name);
      const taken = held.get(name);
      if (taken !== undefined) {
        // The platform calls back with `null` and the request settles as soon as the callback returns.
        return Promise.resolve(callback(null)).then(() => undefined);
      }
      const outcome = Promise.resolve(callback({ name }));
      held.set(name, outcome);
      // A settled callback frees the name, whichever way it settled.
      void outcome.then(
        () => held.delete(name),
        () => held.delete(name),
      );
      return outcome.then(() => undefined);
    },
  };
  return { locks, held, requests };
}

/**
 * One attempt, no retry: the raw question. Every assertion below is about a single answer, so the wrapper
 * is asked not to retry rather than the module exporting a second entry point for each of them.
 */
const claimWriter = (args: { pool: string; locks?: WriterLockManager | undefined }) =>
  claimWithGrace(args, { attempts: 1, delayMs: 0 });

describe('claimWriter', () => {
  it('acquires the pool name and says which mechanism answered', async () => {
    const { locks, requests } = fakeLocks();
    const claim = await claimWriter({ pool: 'cortex', locks });

    expect(claim.acquired).toBe(true);
    expect(claim.mechanism).toBe('web-locks');
    expect(claim.pool).toBe('cortex');
    // The name is namespaced: a page that happens to hold a lock called "cortex" for its own reasons
    // must not be able to make this product refuse to open.
    expect(requests).toEqual(['cortex:writer:cortex']);
  });

  it('refuses the second claim while the first is held, and grants it after a release', async () => {
    const { locks } = fakeLocks();
    const first = await claimWriter({ pool: 'cortex', locks });
    const second = await claimWriter({ pool: 'cortex', locks });

    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
    // A refusal is not an error: it is the answer to the question, and the caller decides what to do
    // with it. Throwing here would put the policy in this module.
    expect(second.mechanism).toBe('web-locks');

    // A refused claim's `release` is called anyway by a caller whose `close()` path does not branch on
    // ownership, so it has to be a no-op rather than an error.
    expect(() => second.release()).not.toThrow();

    first.release();
    // `release` resolves the held promise; the platform frees the name when that promise settles, which
    // is a microtask later rather than synchronously.
    await Promise.resolve();
    await Promise.resolve();

    const third = await claimWriter({ pool: 'cortex', locks });
    expect(third.acquired).toBe(true);
  });

  it('grants a second claim immediately when the first was released before it asked', async () => {
    const { locks } = fakeLocks();
    const first = await claimWriter({ pool: 'cortex', locks });
    first.release();
    await Promise.resolve();
    await Promise.resolve();

    const second = await claimWriter({ pool: 'cortex', locks });
    expect(second.acquired).toBe(true);
  });

  it('is idempotent on release, because two closes are ordinary', async () => {
    const { locks, held } = fakeLocks();
    const claim = await claimWriter({ pool: 'cortex', locks });

    claim.release();
    claim.release();
    claim.release();
    await Promise.resolve();
    await Promise.resolve();

    expect(held.size).toBe(0);
    expect(await claimWriter({ pool: 'cortex', locks })).toMatchObject({ acquired: true });
  });

  it('separates two pools, so a second database on one origin is still one writer each', async () => {
    const { locks } = fakeLocks();
    const one = await claimWriter({ pool: 'cortex', locks });
    const two = await claimWriter({ pool: 'notes', locks });

    expect(one.acquired).toBe(true);
    expect(two.acquired).toBe(true);
  });

  it('reports `none` rather than claiming when the platform has no lock manager', async () => {
    // A browser without Web Locks is a browser where this question cannot be asked. Reporting `none`
    // lets the caller print a line that says so; assuming `acquired: true` silently would make the
    // diagnostic identical to a browser that answered.
    const claim = await claimWriter({ pool: 'cortex', locks: undefined });

    expect(claim).toMatchObject({ acquired: true, mechanism: 'none', pool: 'cortex' });
    // Releasing a claim that was never taken is still a no-op, because the caller's `close()` path does
    // not branch on the mechanism.
    expect(() => claim.release()).not.toThrow();
  });

  it('reads the global lock manager when no manager is passed', async () => {
    // `globalThis.navigator` is an accessor without a setter on this runtime, so the descriptor is what
    // gets replaced. Restoring the descriptor rather than `delete`ing the property keeps the runtime's
    // own `navigator` exactly as it was found.
    const { locks } = fakeLocks();
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      value: { locks },
      configurable: true,
      writable: true,
    });
    try {
      const claim = await claimWriter({ pool: 'global' });
      expect(claim.mechanism).toBe('web-locks');
      expect(claim.acquired).toBe(true);
    } finally {
      if (original === undefined) delete (globalThis as { navigator?: unknown }).navigator;
      else Object.defineProperty(globalThis, 'navigator', original);
    }
  });

  it('treats a manager whose request throws as unavailable rather than as a dead process', async () => {
    // An opaque-origin frame, or a browser that exposes `locks` but refuses the call. The storage tier
    // below is still worth trying: losing the claim loses the *diagnosis*, not the database.
    const locks: WriterLockManager = {
      request() {
        return Promise.reject(new Error('SecurityError: the operation is insecure'));
      },
    };
    const claim = await claimWriter({ pool: 'cortex', locks });

    expect(claim).toMatchObject({ acquired: true, mechanism: 'none' });
    // The refused-answer claim's release is a no-op too, for the same reason as the busy one above.
    expect(() => claim.release()).not.toThrow();
  });
});

describe('releaseOnClose', () => {
  /** A storage that records what it was asked, and closes however the test says. */
  function fakeStorage(options: { readonly failClose?: boolean } = {}): {
    storage: Storage;
    calls: string[];
  } {
    const calls: string[] = [];
    const storage: Storage = {
      put: async (table, key) => {
        calls.push(`put:${table}:${key}`);
      },
      get: async <T>(table: string, key: string) => {
        calls.push(`get:${table}:${key}`);
        return undefined as T | undefined;
      },
      del: async (table, key) => {
        calls.push(`del:${table}:${key}`);
      },
      query: async <T>() => {
        calls.push('query');
        return [] as T[];
      },
      transaction: async <T>(fn: (tx: StorageTransaction) => Promise<T>) => {
        calls.push('transaction');
        return fn({
          put: async () => undefined,
          get: async <V>() => undefined as V | undefined,
          del: async () => undefined,
        });
      },
      close: async () => {
        calls.push('close');
        if (options.failClose === true) throw new Error('close failed');
      },
    };
    return { storage, calls };
  }

  it('forwards every method, so a claimed storage is the storage the caller asked for', async () => {
    const { storage, calls } = fakeStorage();
    const owning = releaseOnClose(storage, () => calls.push('release'));

    await owning.put('t', 'k', 1);
    await owning.get('t', 'k');
    await owning.del('t', 'k');
    await owning.query('t');
    await owning.transaction(async (tx) => tx.put('t', 'k', 1));

    expect(calls).toEqual(['put:t:k', 'get:t:k', 'del:t:k', 'query', 'transaction']);
  });

  it('gives the origin up after the inner close, not before it', async () => {
    // Order matters: releasing first would let a second tab open the database while this one is still
    // writing to it, which is the defect with the sign flipped.
    const { storage, calls } = fakeStorage();
    const owning = releaseOnClose(storage, () => calls.push('release'));

    await owning.close();
    expect(calls).toEqual(['close', 'release']);
  });

  it('gives the origin up even when close throws, and rethrows the failure', async () => {
    // A close that failed has still ended this caller's use. Keeping the origin claimed would make the
    // next tab refuse to open for a reason nobody can see -- a tab that is gone holding a lock.
    const { storage, calls } = fakeStorage({ failClose: true });
    const owning = releaseOnClose(storage, () => calls.push('release'));

    await expect(owning.close()).rejects.toThrow('close failed');
    expect(calls).toEqual(['close', 'release']);
  });

  it('releases once however many times it is closed', async () => {
    const { storage, calls } = fakeStorage();
    let releases = 0;
    const owning = releaseOnClose(storage, () => {
      releases += 1;
      calls.push('release');
    });

    await owning.close();
    await owning.close();
    await owning.close();

    expect(releases).toBe(1);
  });

  it('releases once when two closes race, which is what a teardown plus a timeout does', async () => {
    const { storage } = fakeStorage();
    let releases = 0;
    const owning = releaseOnClose(storage, () => {
      releases += 1;
    });

    await Promise.all([owning.close(), owning.close()]);
    expect(releases).toBe(1);
  });
});

describe('claimWithGrace', () => {
  it('takes the first answer when it is yes, and asks once', async () => {
    const { locks, requests } = fakeLocks();
    const claim = await claimWithGrace({ pool: 'cortex', locks }, { attempts: 4, delayMs: 0 });

    expect(claim.acquired).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it('re-grants a claim that this page released a moment ago', async () => {
    // The race the two-tab suite found in CI. The predecessor's `release()` has resolved, but the platform
    // frees the name a beat later, so the very next request is answered `null` -- and the product used to
    // believe that answer and refuse a page its own database.
    const { locks } = fakeLocks();
    const first = await claimWriter({ pool: 'cortex', locks });
    first.release();
    // Deliberately no `await` between the release and the re-open: that is the sequence the suite performs.
    const second = await claimWithGrace({ pool: 'cortex', locks }, { attempts: 6, delayMs: 1 });

    expect(second.acquired).toBe(true);
  });

  it('still refuses, after the bounded attempts, when another context really holds the pool', async () => {
    const { locks, requests } = fakeLocks();
    // A claim nobody releases is another tab: it holds for its whole lifetime.
    const other = await claimWriter({ pool: 'cortex', locks });
    const claim = await claimWithGrace({ pool: 'cortex', locks }, { attempts: 3, delayMs: 1 });

    expect(other.acquired).toBe(true);
    expect(claim.acquired).toBe(false);
    // The bound is the claim's honesty: retried, and then believed rather than waited on forever.
    expect(requests).toHaveLength(1 + 3);
  });

  it('treats a non-positive attempt count as one attempt rather than as zero', async () => {
    // `Math.max(1, ...)` exists because zero attempts would return the initial claim without ever asking,
    // which reports `acquired: false` on a page that is alone.
    const { locks, requests } = fakeLocks();
    const claim = await claimWithGrace({ pool: 'cortex', locks }, { attempts: 0, delayMs: 0 });

    expect(claim.acquired).toBe(true);
    expect(requests).toHaveLength(1);
  });
});
