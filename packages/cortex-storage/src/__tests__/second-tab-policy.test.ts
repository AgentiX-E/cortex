/**
 * What the documented opener does when another tab already holds the origin.
 *
 * ## The three answers, and why the wrong one is the default in the shipped code
 *
 * Before this file, `openBrowserStorage` had one policy: try OPFS, and on **any** reason fall through to
 * IndexedDB. Two of those reasons want opposite responses. *This platform cannot do OPFS* should fall
 * back. *Another tab is holding the database* must not, because the fallback is precisely how a second,
 * divergent database gets created on one origin -- and the caller is not told, since the only field that
 * differs is a `refused[0].reason` string with no rule attached to it.
 *
 * So the policy is a named input now (`onSecondTab`), the refusal is a named error
 * (`BrowserStorageBusy`), and the claim it rests on is taken **before** any tier is opened. These tests
 * run in Node, where `Worker` does not exist: that is what makes them able to tell the two outcomes
 * apart, because the difference between "refused before opening anything" and "opened and fell back" is
 * `BrowserStorageBusy` against `BrowserStorageUnavailable`.
 *
 * The platform side -- that a real Chromium tab answers a second tab's claim with a refusal -- is
 * `test/browser/two-tab-probe.mjs`'s question. This file would pass on a fake no browser implements.
 */
import { describe, expect, it } from 'vitest';
import {
  BrowserStorageBusy,
  BrowserStorageUnavailable,
  openBrowserStorage,
} from '../browser/opfs.js';
import type { WriterLockManager } from '../browser/writer-claim.js';
import type { Storage } from '@agentix-e/cortex-core';

/** The same fake `writer-claim.test.ts` uses: a taken name is not handed out until its promise settles. */
function fakeLocks(): { locks: WriterLockManager; held: Map<string, Promise<unknown>> } {
  const held = new Map<string, Promise<unknown>>();
  const locks: WriterLockManager = {
    request(name, _options, callback) {
      const taken = held.get(name);
      if (taken !== undefined) return Promise.resolve(callback(null)).then(() => undefined);
      const outcome = Promise.resolve(callback({ name }));
      held.set(name, outcome);
      void outcome.then(
        () => held.delete(name),
        () => held.delete(name),
      );
      return outcome.then(() => undefined);
    },
  };
  return { locks, held };
}

/** Let the platform free a name it was told to release: the resolution is a microtask, not synchronous. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * A tier that opens, in a runtime with no `indexedDB`.
 *
 * The policy is what these tests are about, so the tier is a stand-in that records that it was asked: the
 * assertion "no tier was opened" needs an opener that would have said so.
 */
function fakeTier(): {
  idb: (name: string | undefined) => Promise<Storage>;
  calls: (string | undefined)[];
} {
  const calls: (string | undefined)[] = [];
  return {
    calls,
    idb: async (name) => {
      calls.push(name);
      const storage: Storage = {
        put: async () => undefined,
        get: async <T>() => undefined as T | undefined,
        del: async () => undefined,
        query: async <T>() => [] as T[],
        transaction: async <T>(fn: (tx: never) => Promise<T>) => fn(undefined as never),
        close: async () => undefined,
      };
      return storage;
    },
  };
}

describe('a second tab on one origin', () => {
  it('is refused before any tier is opened, not diverted to a second database', async () => {
    const { locks } = fakeLocks();
    const first = await claimFor(locks);
    expect(first.writer).toEqual({ pool: 'cortex', acquired: true, mechanism: 'web-locks' });

    // Node has no `Worker`, so if this call reached the OPFS tier it would come back as
    // `BrowserStorageUnavailable` with the reason "Worker is not available". Getting `BrowserStorageBusy`
    // instead is the assertion that no tier was tried.
    await expect(
      openBrowserStorage({ sqliteModuleUrl: '/does-not-matter/index.mjs', locks }),
    ).rejects.toBeInstanceOf(BrowserStorageBusy);
  });

  it('opens no tier at all when it refuses, which is what makes the refusal cheap', async () => {
    // The assertion the seam exists for. A second tab that reached the OPFS tier would spend four pool
    // installs and 480 ms of retries before learning what the platform would have said immediately.
    const { locks } = fakeLocks();
    await claimFor(locks);
    const tiers = fakeTier();

    await expect(
      openBrowserStorage({
        tiers: ['opfs', 'idb'],
        sqliteModuleUrl: '/does-not-matter/index.mjs',
        locks,
        openers: { idb: tiers.idb },
      }),
    ).rejects.toBeInstanceOf(BrowserStorageBusy);

    expect(tiers.calls).toEqual([]);
  });

  it('opens the tier when the caller allows a shared origin, and records that it was shared', async () => {
    const { locks } = fakeLocks();
    await claimFor(locks);
    const tiers = fakeTier();

    const opened = await openBrowserStorage({
      tiers: ['idb'],
      locks,
      onSecondTab: 'allow',
      openers: { idb: tiers.idb },
    });

    expect(tiers.calls).toEqual([undefined]);
    expect(opened.writer).toEqual({ pool: 'cortex', acquired: false, mechanism: 'web-locks' });
    await opened.storage.close();
  });

  it('names the pool, the mechanism and the decision, because a message is what a developer reads', async () => {
    const { locks } = fakeLocks();
    await claimFor(locks);

    const error = await refusalFrom<BrowserStorageBusy>({
      sqliteModuleUrl: '/does-not-matter/index.mjs',
      locks,
    });

    expect(error).toBeInstanceOf(BrowserStorageBusy);
    expect(error.name).toBe('BrowserStorageBusy');
    expect(error.pool).toBe('cortex');
    expect(error.mechanism).toBe('web-locks');
    // The message has to say what to do about it. "Busy" alone leaves a reader choosing between
    // retrying forever and giving up.
    expect(error.message).toContain('another tab');
    expect(error.message).toContain('"cortex"');
    expect(error.message).toContain('onSecondTab');
  });

  it('proceeds when the caller says it wants a shared origin, and says which writer it is', async () => {
    const { locks } = fakeLocks();
    await claimFor(locks);

    // With `allow` the tier loop runs, so the failure is about this runtime rather than about the origin.
    const error = await refusalFrom<BrowserStorageUnavailable>({
      sqliteModuleUrl: '/does-not-matter/index.mjs',
      locks,
      onSecondTab: 'allow',
    });

    expect(error).toBeInstanceOf(BrowserStorageUnavailable);
    expect(error.refused[0]?.reason).toContain('Worker');
  });

  it('falls back to IndexedDB with the claim in hand when no other tab holds the origin', async () => {
    const { locks } = fakeLocks();
    const opened = await openBrowserStorage({
      tiers: ['idb'],
      locks,
      openers: { idb: fakeTier().idb },
    });

    expect(opened.tier).toBe('idb');
    expect(opened.writer).toEqual({ pool: 'cortex', acquired: true, mechanism: 'web-locks' });
    await opened.storage.close();
  });

  it('releases the origin when storage is closed, so the next tab is not refused by a closed one', async () => {
    const { locks, held } = fakeLocks();
    const opened = await openBrowserStorage({
      tiers: ['idb'],
      locks,
      openers: { idb: fakeTier().idb },
    });
    expect(held.size).toBe(1);

    await opened.storage.close();
    await settle();

    expect(held.size).toBe(0);
    // The next tab asks the same question and gets the same answer a first tab would.
    const next = await openBrowserStorage({
      tiers: ['idb'],
      locks,
      openers: { idb: fakeTier().idb },
    });
    expect(next.writer.acquired).toBe(true);
    await next.storage.close();
  });

  it('releases the origin when every tier fails, so a failed open does not block the retry', async () => {
    const { locks, held } = fakeLocks();
    await expect(
      openBrowserStorage({ sqliteModuleUrl: '/does-not-matter/index.mjs', locks }),
    ).rejects.toBeInstanceOf(BrowserStorageUnavailable);
    await settle();

    expect(held.size).toBe(0);
  });

  it('records a non-Error refusal as its text, because a tier can throw a string', async () => {
    // `worker.onerror` in some browsers, and every hand-written stub, produce a plain string. Dropping it
    // would leave a `Refusal` list that says a tier failed and not why -- the shape this record exists to
    // prevent, arriving one field down.
    const error = await refusalFrom<BrowserStorageUnavailable>({
      tiers: ['idb'],
      locks: undefined,
      openers: {
        idb: () => Promise.reject('idb said no'),
      },
    });

    expect(error.refused).toEqual([{ tier: 'idb', reason: 'idb said no' }]);
  });

  it('reports `none` when the platform cannot be asked, instead of claiming the origin', async () => {
    const opened = await openBrowserStorage({
      tiers: ['idb'],
      locks: undefined,
      openers: { idb: fakeTier().idb },
    });

    expect(opened.writer).toEqual({ pool: 'cortex', acquired: true, mechanism: 'none' });
    await opened.storage.close();
  });

  it('uses the pool name the caller passed, in the claim and in the refusal', async () => {
    const { locks } = fakeLocks();
    const first = await openBrowserStorage({
      tiers: ['idb'],
      locks,
      poolName: 'notes',
      openers: { idb: fakeTier().idb },
    });
    expect(first.writer.pool).toBe('notes');

    const error = await refusalFrom<BrowserStorageBusy>({
      sqliteModuleUrl: '/does-not-matter/index.mjs',
      locks,
      poolName: 'notes',
    });
    expect(error).toBeInstanceOf(BrowserStorageBusy);
    expect(error.pool).toBe('notes');

    await first.storage.close();
  });
});

/**
 * The error an open produced, typed as the error it has to be.
 *
 * A `.catch(thrown => thrown)` leaves the union `T | Error`, and every assertion after it then needs a cast
 * that the compiler cannot check. Narrowing in one place is what keeps the assertions honest.
 */
async function refusalFrom<T extends Error = Error>(
  options: Parameters<typeof openBrowserStorage>[0],
): Promise<T> {
  try {
    await openBrowserStorage(options);
  } catch (error) {
    if (error instanceof Error) return error as T;
    throw error;
  }
  throw new Error('the open was expected to fail and it succeeded');
}

/** The first tab of a test: a fake tier, because Node has no `indexedDB`. */
async function claimFor(locks: WriterLockManager) {
  return openBrowserStorage({ tiers: ['idb'], locks, openers: { idb: fakeTier().idb } });
}
