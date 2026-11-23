/**
 * One origin, one writer: the claim a tab takes before it opens a database.
 *
 * ## The failure this exists for, stated as the sequence a user performs
 *
 * Open the app. Open it again in a second tab. The first tab holds the OPFS access handle for
 * `/cortex.sqlite3`, so the second tab's SAH-pool install fails with *"Access Handles cannot be created
 * if there is another open Access Handle…"*. `openBrowserStorage` treats every reason alike and falls
 * through to IndexedDB, so the second tab now writes **a different database on the same origin**. Both
 * tabs work. Neither is wrong on its own. The user's memory is split in two, and the return value that
 * would say so is a `refused[0].reason` string that a caller has no rule for reading.
 *
 * That is not a tier decision. A tier fallback is the platform saying *I cannot do this here*; this is
 * the platform saying *somebody else is doing it*. The two want opposite responses -- the first one
 * should fall back, the second one must not, because falling back is how the divergence happens.
 *
 * ## Why the question is asked before any tier is tried
 *
 * So the product never has to interpret an error. Asking first means a second tab does not open OPFS,
 * does not spend the pool's retry budget, and does not have to classify a message whose exact wording
 * belongs to sqlite-wasm and varies by version. `opfs.ts` already refuses to inspect message text for
 * exactly this reason (`opfs-worker.ts`'s retry comment), and a classifier here would be the same
 * mistake one layer up.
 *
 * ## The Web Locks API, used as what it is
 *
 * A lock held while its callback's promise is pending is a lock the platform will not hand to anyone
 * else. `ifAvailable: true` turns "wait for it" into "answer me now": the callback is invoked with
 * `null` when somebody holds the name. That is the entire mechanism, and it is the browser's own --
 * released when the tab closes, which is the lifetime a database writer actually has.
 *
 * ## Three answers, because two would lie
 *
 * `web-locks` with `acquired: true` -- we hold the origin.
 * `web-locks` with `acquired: false` -- somebody else does.
 * `none` with `acquired: true` -- nobody can be asked. A browser without Web Locks (Safari before 15.4,
 * an opaque-origin frame) is not a browser where the answer is "free"; it is a browser where the question
 * does not exist, and saying `none` is what lets a caller print that instead of inventing a policy for it.
 */

import type { QueryPredicate, Storage, StorageTransaction } from '@agentix-e/cortex-core';

/** Which facility answered. `none` means the platform has no lock manager, not that the lock was free. */
export type WriterMechanism = 'web-locks' | 'none';
/**
 * The part of `LockManager` this module uses.
 *
 * Structural rather than the DOM type so the fake in the tests does not have to implement `query`,
 * `policy` or the non-`ifAvailable` overloads, none of which is read here.
 */
export type WriterLockManager = {
  request(
    name: string,
    options: { readonly ifAvailable: true },
    callback: (lock: unknown) => Promise<unknown> | unknown,
  ): Promise<unknown>;
};

export type WriterClaim = {
  readonly pool: string;
  /** Whether **this** context holds the origin. Always `true` when the mechanism is `none`. */
  readonly acquired: boolean;
  readonly mechanism: WriterMechanism;
  /** Give the origin up. Idempotent, and a no-op for a claim that was refused or never taken. */
  release(): void;
};

/** The prefix keeps the name out of the namespace an application's own locks use. */
const LOCK_PREFIX = 'cortex:writer:';

function globalLocks(): WriterLockManager | undefined {
  const navigator = (globalThis as { navigator?: { locks?: WriterLockManager } }).navigator;
  const locks = navigator?.locks;
  return locks !== undefined && typeof locks.request === 'function' ? locks : undefined;
}

/**
 * Ask the platform whether this context may be the origin's writer, once.
 *
 * Not exported: `claimWithGrace` is the entry point a caller uses, because a single answer is exactly what
 * a page re-opening its own database cannot afford to believe (see that function). The tests reach it
 * through the wrapper with `attempts: 1`, which is the same call and keeps this module's surface to what a
 * consumer actually uses.
 *
 * Never throws for a platform reason. A lock manager that is missing, or one whose `request` rejects
 * (a `SecurityError` on an opaque origin), degrades to `mechanism: 'none'` -- because the claim is a
 * diagnosis, and losing it must not lose the database the caller was going to open anyway.
 */
async function claimWriter(args: {
  readonly pool: string;
  /**
   * The manager to ask, or `undefined` to ask the platform.
   *
   * `??` rather than `'locks' in args`, and the difference was measured: `openBrowserStorage` passes the
   * field it was given, so an explicit `undefined` reached the falsy branch of an `in` test and reported
   * `mechanism: 'none'` in a Chromium that has Web Locks. The two-tab probe is what caught it -- the Node
   * suites always hand a manager over, so the wiring between the two modules was the untested seam.
   */
  readonly locks?: WriterLockManager | undefined;
}): Promise<WriterClaim> {
  const locks = args.locks ?? globalLocks();
  if (locks === undefined) {
    return { pool: args.pool, acquired: true, mechanism: 'none', release: () => undefined };
  }

  // Assigned synchronously by the promise executor three lines down -- a `Promise` constructor runs its
  // executor before it returns -- so the definite-assignment assertion states a fact about the language
  // rather than a hope. The `= () => undefined` that used to stand here was a function nothing could ever
  // call, and the per-file function count reported it as exactly that.
  let release!: () => void;
  // Resolved by `release()`. The platform holds the lock while this promise is pending, so it must stay
  // pending for the lifetime of the writer and must not be awaited by this function.
  const held = new Promise<void>((resolveHeld) => {
    release = resolveHeld;
  });

  let acquired = false;
  // Set only when the platform refused to answer at all. The callback below cannot also have run in that
  // case -- a request settles when its callback's promise settles, and a rejection happens before the
  // callback is invoked -- so the two outcomes cannot both be in flight.
  let refused = false;
  const answered = new Promise<void>((resolveAnswered) => {
    locks
      .request(`${LOCK_PREFIX}${args.pool}`, { ifAvailable: true }, (lock) => {
        if (lock === null) {
          // Somebody holds it. The callback returns without touching `held`, so the request settles and
          // nothing is left pending for a lock this context never had.
          acquired = false;
          resolveAnswered();
          return undefined;
        }
        acquired = true;
        resolveAnswered();
        return held;
      })
      // The request promise settles only when `held` settles, or rejects when the platform refuses to
      // ask. Neither outcome is owed to a caller, and an unhandled rejection here would surface as an
      // error in a tab that is working.
      .then(
        () => undefined,
        () => {
          refused = true;
          resolveAnswered();
        },
      );
  });

  await answered;
  if (refused) {
    return { pool: args.pool, acquired: true, mechanism: 'none', release: () => undefined };
  }
  if (!acquired) {
    return { pool: args.pool, acquired: false, mechanism: 'web-locks', release: () => undefined };
  }
  return { pool: args.pool, acquired: true, mechanism: 'web-locks', release };
}

/**
 * The claim, retried for a beat when it comes back refused.
 *
 * ## The race this exists for, measured in CI rather than argued about
 *
 * `release()` resolves the promise the platform is holding the lock with, and the platform frees the name
 * **a beat later** -- there is no event, and `navigator.locks.query()` would be a second source of truth
 * about a thing this module already knows it did. So a page that closes storage and opens it again in the
 * same task can be refused *by its own predecessor*: the two-tab suite does exactly that three times
 * (`matrix`, `write`, `read` in one page), and it failed on both engines in CI while passing locally,
 * because the window is a couple of microseconds wide.
 *
 * A refusal is therefore retried a bounded number of times before it is believed. The bound is what keeps
 * the genuine second-tab case honest: another tab holds the lock for its whole lifetime, so every attempt
 * fails and the caller is refused after `attempts x delayMs` -- 240 ms by default, which is a pause a user
 * will not notice in a failure path and is far cheaper than a flaky suite.
 *
 * ## Why not a context-scoped singleton instead
 *
 * Holding one claim per page and never re-acquiring would remove the race, at the price of a page that
 * closed its storage continuing to refuse every other tab until the page goes away -- a worse failure than
 * a 240 ms pause, because it is invisible and it outlives the reason it existed.
 */
export async function claimWithGrace(
  args: { readonly pool: string; readonly locks?: WriterLockManager | undefined },
  options: { readonly attempts?: number; readonly delayMs?: number } = {},
): Promise<WriterClaim> {
  const attempts = Math.max(1, options.attempts ?? 6);
  const delayMs = options.delayMs ?? 40;
  let claim = await claimWriter(args);
  for (let attempt = 1; attempt < attempts && !claim.acquired; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, delayMs));
    claim = await claimWriter(args);
  }
  return claim;
}

/**
 * The storage a caller gets back, with the claim's lifetime attached to `close()`.
 *
 * ## Why `close()` rather than a `release()` the caller has to remember
 *
 * `Storage` already has a `close()`, and a caller who has closed storage has said the thing that makes
 * releasing correct. A separate `release()` would be a second ending for one lifetime, and the failure
 * mode of a second ending is the one that matters here: forget it and the origin stays claimed by a tab
 * that no longer uses it, so the next tab is refused because of a tab that is doing nothing.
 *
 * ## The two orderings that are load-bearing
 *
 * **After the inner close, not before.** Releasing first would let a second tab take the origin while
 * this one is still writing -- the same defect with the sign flipped.
 *
 * **Whatever happened to the inner close.** A `close()` that threw has still ended this caller's use, so
 * the release happens in a `finally` and the failure is rethrown unchanged. A caller's error is not
 * improved by also losing the origin.
 */
export function releaseOnClose(storage: Storage, release: () => void): Storage {
  let released = false;
  const once = (): void => {
    if (released) return;
    released = true;
    release();
  };
  return {
    put: (table, key, value, options) => storage.put(table, key, value, options),
    get: <T>(table: string, key: string) => storage.get<T>(table, key),
    del: (table, key) => storage.del(table, key),
    query: <T>(table: string, predicate?: QueryPredicate) => storage.query<T>(table, predicate),
    transaction: <T>(fn: (tx: StorageTransaction) => Promise<T>) => storage.transaction(fn),
    close: async () => {
      try {
        await storage.close();
      } finally {
        once();
      }
    },
  };
}
