/**
 * Opening browser storage, and choosing which tier was actually obtained.
 *
 * ## Why the tier is returned rather than assumed
 *
 * A product that asks for OPFS and silently gets IndexedDB has lost two things without being told:
 * atomic transactions, and the durability of a real file. So `openBrowserStorage` returns the tier
 * it got **and the reasons each preferred tier was refused**, and the caller is expected to show
 * that to the user -- "your browser stored this in a fallback location" is a sentence a user can act
 * on; a silent downgrade is not.
 *
 * ## Misconfiguration is not unavailability
 *
 * If the caller forgot `sqliteModuleUrl`, that is a programming error and it throws immediately. It
 * does **not** fall through to the fallback tier: a fallback exists to absorb a platform's limits,
 * and using it to hide a missing argument would make every development environment quietly run the
 * path that production does not.
 *
 * ## Startup cannot be allowed to hang
 *
 * A worker that never answers -- because its module failed to load, or because the VFS blocked --
 * produces a promise that never settles, and the symptom is a tab that does nothing. Two mechanisms
 * prevent that: the worker's `error` event aborts the session, and `describe()` is raced against a
 * startup deadline. The deadline applies to **opening only**; a query is never cut short.
 */
import type { Storage } from '@agentix-e/cortex-core';
import { SqlStorage } from '../storage/sql-storage.js';
import { openIdbStorage } from './idb.js';
import { EngineRpcSession, RpcError, type MessageEndpoint } from './rpc.js';

export type BrowserTier = 'opfs' | 'idb';

export type Refusal = { tier: BrowserTier; reason: string };

export type BrowserStorage = {
  storage: Storage;
  /** The tier that was actually opened. */
  tier: BrowserTier;
  /** What is running underneath, for a diagnostic line rather than for a decision. */
  engine: string;
  /** Tiers that were tried and refused before this one, in order. */
  refused: Refusal[];
};

/** Raised when no requested tier could be opened. Carries every reason, not just the last. */
export class BrowserStorageUnavailable extends Error {
  constructor(readonly refused: Refusal[]) {
    super(
      refused.length === 0
        ? 'no storage tier was requested'
        : `no storage tier could be opened: ${refused.map((r) => `${r.tier}: ${r.reason}`).join('; ')}`,
    );
    this.name = 'BrowserStorageUnavailable';
  }
}

export type OpfsOptions = {
  /**
   * URL of the sqlite-wasm ESM entry (`.../dist/index.mjs`). Required: the package does not ship a
   * copy, because a second copy of a 1 MB wasm build inside this one would be invisible to the
   * consumer's bundler and to their dependency scanner.
   */
  sqliteModuleUrl: string;
  /** Override the worker location. Defaults to the worker next to this module. */
  workerUrl?: string | URL;
  /** Database file inside the OPFS pool. */
  databasePath?: string;
  /** Pool name; two pools with one name share their handle budget. */
  poolName?: string;
  /** Startup deadline. Opening only -- queries are never cut short. */
  startupTimeoutMs?: number;
};

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;

/**
 * Open the OPFS tier.
 *
 * ## The worker URL, and the claim this docstring used to get wrong
 *
 * The default is the file next to this module. That is correct for the deployment it is written
 * for -- native ESM, module served as published -- and it is the only default that needs no
 * configuration there. It was documented as also working under a bundler, on the grounds that
 * `import.meta.url` "is rewritten by Vite, webpack 5 and esbuild". **Two of those three are true.**
 * esbuild has no worker support, so `new URL('./opfs-worker.js', import.meta.url)` survives into the
 * consumer's output verbatim; the emitted bundle then asks for a file the bundler never wrote, the
 * worker 404s, and this function throws `the storage worker failed to start`. Vite and webpack 5 do
 * emit the asset, because both have first-class worker handling.
 *
 * So there are two supported deployments, and the second one is a build step the consumer writes:
 *
 *   - **Unbundled** (the default): serve the package as published. `dist/browser/opfs-worker.js` sits
 *     next to `opfs.js` and resolves relative to it.
 *   - **Bundled**: add `@agentix-e/cortex-storage/opfs/worker` as a *second entry point* of the same
 *     build, so the worker becomes its own emitted file, and pass its URL as `workerUrl`. Copying
 *     `opfs-worker.js` on its own is not enough and never was -- it imports `./rpc.js`.
 *
 * `tools/bundle-guard.mjs` reports `worker: ./opfs-worker.js NOT emitted` for the second case instead
 * of leaving it to a runtime 404, and `test/browser/bundle-probe.mjs` runs both deployments in a real
 * Chromium so the recipe above is measured rather than asserted.
 */
export async function openOpfsStorage(options: OpfsOptions): Promise<BrowserStorage> {
  if (typeof Worker === 'undefined') {
    throw new Error('Worker is not available: the OPFS tier needs a browser');
  }

  // A relative override has to be resolved against something, and the document is what a caller
  // passing `'my-worker.js'` means. The default needs no base: `import.meta.url` is absolute.
  const base = typeof document === 'undefined' ? undefined : document.baseURI;
  const url =
    options.workerUrl === undefined
      ? new URL('./opfs-worker.js', import.meta.url)
      : new URL(options.workerUrl, base);
  url.searchParams.set('sqlite', options.sqliteModuleUrl);
  if (options.databasePath !== undefined) url.searchParams.set('db', options.databasePath);
  if (options.poolName !== undefined) url.searchParams.set('pool', options.poolName);

  const worker = new Worker(url, { type: 'module', name: 'cortex-storage' });
  // The worker is terminated when the session closes. Without this the pool stays installed in a
  // live worker, and the next `openOpfsStorage` in the same page fails to install a second pool with
  // the same name -- a failure that looks like "OPFS is unavailable" on the second open of a document.
  const session = new EngineRpcSession(worker as unknown as MessageEndpoint, {
    onClose: () => worker.terminate(),
  });

  // A worker whose module fails to load never speaks, so the only signal is its `error` event.
  //
  // That event is not an `ErrorEvent` in practice. Chrome dispatches a plain `Event` for a module
  // script whose fetch 404s, so `event.message` is `undefined` rather than `''` -- and the first
  // version of this handler tested `=== ''`, which let `undefined` through into `new Error(undefined)`
  // and handed the caller an `RpcError` whose `message` was empty. The empty message was found by
  // `test/browser/bundle-probe.mjs`, on the one path the surrounding docstring warns about, which is
  // the worst place for a failure to be silent: the reader is looking at exactly this error.
  //
  // The URL is in the message because that is the fact a reader can act on. Three-quarters of the
  // reasons for this event are "the file is not at the path the URL names", and the path is the
  // difference between "my bundler did not emit the worker" and "I passed the wrong workerUrl".
  const workerDescription = `${url.origin}${url.pathname}`;
  const onError = (event: Event): void => {
    const reported = (event as Partial<ErrorEvent>).message;
    const detail =
      typeof reported === 'string' && reported !== ''
        ? reported
        : 'the module did not load (a bundler that does not emit worker assets needs `workerUrl`, ' +
          'see the `@agentix-e/cortex-storage/opfs/worker` subpath)';
    session.abort(`the storage worker failed to start: ${workerDescription} -- ${detail}`);
  };
  worker.addEventListener('error', onError);

  const timeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const info = await Promise.race([
      session.describe(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // Named rather than silent: the two plausible causes lead to different fixes, and a
          // generic "timed out" would make the reader guess which one they have.
          session.abort(
            `the storage worker did not answer within ${timeoutMs} ms (${workerDescription}): either ` +
              `its module failed to load or the OPFS pool is blocked`,
          );
          // The thrown error carries the same facts as the aborted request, because which of the
          // two settles the race is an implementation detail and a caller should not have to know.
          reject(
            new RpcError(
              `storage worker startup timed out after ${timeoutMs} ms: did not answer (${workerDescription}); ` +
                'either its module failed to load or the OPFS pool is blocked',
              'channel-error',
            ),
          );
        }, timeoutMs);
      }),
    ]);

    return {
      storage: new SqlStorage(session),
      tier: 'opfs',
      engine: `${info.engine} ${info.version} on ${info.vfs} (journal: ${info.journal ?? 'unknown'})`,
      refused: [],
    };
  } catch (error) {
    worker.terminate();
    await session.close().catch(() => undefined);
    throw error;
  } finally {
    worker.removeEventListener('error', onError);
    if (timer !== undefined) clearTimeout(timer);
  }
}

export type OpenBrowserOptions = Omit<OpfsOptions, 'sqliteModuleUrl' | 'startupTimeoutMs'> & {
  sqliteModuleUrl?: string;
  startupTimeoutMs?: number;
  /** Tiers to try, in order. Default `['opfs', 'idb']`. */
  tiers?: readonly BrowserTier[];
  /** Name of the IndexedDB database, when the fallback is used. */
  idbDatabaseName?: string;
};

/** Open the best available tier, and say which one it was. */
export async function openBrowserStorage(
  options: OpenBrowserOptions = {},
): Promise<BrowserStorage> {
  const tiers = options.tiers ?? (['opfs', 'idb'] as const);
  const refused: Refusal[] = [];

  for (const tier of tiers) {
    if (tier === 'opfs') {
      const sqliteModuleUrl = options.sqliteModuleUrl;
      if (sqliteModuleUrl === undefined) {
        // Configuration, not capability. See the module comment: falling back here would make every
        // unlucky environment run the tier that production does not.
        throw new TypeError(
          'openBrowserStorage: sqliteModuleUrl is required when the opfs tier is requested',
        );
      }
      try {
        const opened = await openOpfsStorage({
          sqliteModuleUrl,
          ...(options.workerUrl === undefined ? {} : { workerUrl: options.workerUrl }),
          ...(options.databasePath === undefined ? {} : { databasePath: options.databasePath }),
          ...(options.poolName === undefined ? {} : { poolName: options.poolName }),
          ...(options.startupTimeoutMs === undefined
            ? {}
            : { startupTimeoutMs: options.startupTimeoutMs }),
        });
        return { ...opened, refused };
      } catch (error) {
        refused.push({ tier, reason: error instanceof Error ? error.message : String(error) });
      }
    } else {
      try {
        const storage = await openIdbStorage(
          options.idbDatabaseName === undefined ? {} : { databaseName: options.idbDatabaseName },
        );
        return { storage, tier: 'idb', engine: 'indexeddb', refused };
      } catch (error) {
        refused.push({ tier, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  throw new BrowserStorageUnavailable(refused);
}
