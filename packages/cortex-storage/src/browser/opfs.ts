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
 * The worker URL defaults to the file next to this module, which is the only path that works under
 * a bundler without configuration: `import.meta.url` is rewritten by Vite, webpack 5 and esbuild, so
 * the emitted worker is found where the emitted module lives.
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
  const onError = (event: ErrorEvent): void => {
    session.abort(event.message === '' ? 'the storage worker failed to start' : event.message);
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
            `the storage worker did not answer within ${timeoutMs} ms: either its module failed to ` +
              `load or the OPFS pool is blocked`,
          );
          reject(new RpcError('storage worker startup timed out', 'channel-error'));
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
