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
import {
  DEFAULT_POOL_NAME,
  openClaimedStorage,
  type BrowserTier,
  type OpfsTierOptions,
  type Refusal,
  type TierOpeners,
  type WriterState,
} from './open-policy.js';
import { EngineRpcSession, RpcError, type MessageEndpoint } from './rpc.js';
import type { WriterLockManager, WriterMechanism } from './writer-claim.js';

// The tier, the refusal and the pool name are owned by the policy module -- they are what a caller reads
// when the opener refuses -- and re-exported here because this is the subpath a consumer imports.
export { DEFAULT_POOL_NAME, type BrowserTier, type Refusal, type WriterState };

export type BrowserStorage = {
  storage: Storage;
  /** The tier that was actually opened. */
  tier: BrowserTier;
  /** What is running underneath, for a diagnostic line rather than for a decision. */
  engine: string;
  /** Tiers that were tried and refused before this one, in order. */
  refused: Refusal[];
};

/** A storage opened through {@link openBrowserStorage}, which also holds the origin-wide claim. */
export type ClaimedBrowserStorage = BrowserStorage & { readonly writer: WriterState };

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

/**
 * Raised when another tab of this origin holds the database and the caller asked to be refused.
 *
 * ## Why this is an error class rather than a `refused` entry
 *
 * A plain tier refusal means *this platform cannot*, and the answer to it is the next tier. This means
 * *somebody else is*, and the answer to it is the user -- close the other tab, or accept a second
 * database. A caller cannot branch on a sentence, and the sentence is all a `Refusal` carries.
 *
 * ## The message is the whole user-facing artefact
 *
 * There is no `onSecondTab: 'wait'` to offer as a remedy in it: a Web Lock can be waited on, but a page
 * that blocks its first render on another tab's lifetime is a page that appears frozen. So the message
 * names the three things a reader can act on -- which pool, which mechanism said so, and which option
 * changes the behaviour.
 */
export class BrowserStorageBusy extends Error {
  constructor(
    readonly pool: string,
    readonly mechanism: WriterMechanism,
  ) {
    super(
      `another tab of this origin holds the cortex database "${pool}" ` +
        `(single-writer claim via ${mechanism}). Close it, or pass \`onSecondTab: 'allow'\` to open a ` +
        'second database alongside it — the two will not share rows.',
    );
    this.name = 'BrowserStorageBusy';
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
  /**
   * What to do when another tab of this origin already holds the database.
   *
   * `refuse` (the default) throws {@link BrowserStorageBusy} before any tier is opened. `allow` proceeds,
   * which means the second tab gets its own database -- OPFS is unavailable to it, so it lands on the
   * fallback tier -- and reports `writer.acquired: false` so a caller can say so.
   *
   * The default is `refuse` because the alternative is silent: two tabs, one origin, two sets of rows,
   * and nothing in the return value that a caller has a rule for reading.
   */
  onSecondTab?: 'refuse' | 'allow';
  /**
   * The lock manager the claim is taken with, for tests.
   *
   * Absent -- and `undefined` -- both mean "ask the platform", which reads `navigator.locks`. A runtime
   * that has no such manager reports `mechanism: 'none'`; that is the platform's answer, not a default.
   */
  locks?: WriterLockManager | undefined;
  /**
   * The tier openers, for tests.
   *
   * Not a configuration surface: a production caller never passes this and both fields default to the real
   * implementations. It exists because the decisions this module makes are about **ordering** -- claim
   * before any tier, release before the throw, release on `close()` -- and Node has neither `Worker` nor
   * `indexedDB`, so without a seam those decisions could only be observed through failures. The real
   * openers are exercised in a real browser by `test/browser/`, which is not part of the coverage run.
   */
  openers?: {
    readonly opfs?: (options: OpfsTierOptions) => Promise<{ storage: Storage; engine: string }>;
    readonly idb?: (databaseName: string | undefined) => Promise<Storage>;
  };
};

/**
 * Open the best available tier, and say which one it was.
 *
 * ## The claim comes first, and that ordering is the whole point
 *
 * A second tab's SAH-pool install fails with a message that belongs to sqlite-wasm, and `refused[0].reason`
 * is where that message used to end up -- next to a fallback that had already created a second database.
 * Asking the platform *before* any tier is tried means the product never has to classify an error, never
 * spends the pool's retry budget in a tab that cannot win it, and can answer the only question that
 * matters with two named outcomes instead of a string.
 */
export async function openBrowserStorage(
  options: OpenBrowserOptions = {},
): Promise<ClaimedBrowserStorage> {
  const tiers = options.tiers ?? (['opfs', 'idb'] as const);

  // Configuration first, before the claim: a missing `sqliteModuleUrl` is the caller's own bug and must be
  // reported as one, whether or not another tab happens to be open.
  const sqliteModuleUrl = options.sqliteModuleUrl;
  if (tiers.includes('opfs') && sqliteModuleUrl === undefined) {
    throw new TypeError(
      'openBrowserStorage: sqliteModuleUrl is required when the opfs tier is requested',
    );
  }

  const outcome = await openClaimedStorage({
    tiers,
    pool: options.poolName ?? DEFAULT_POOL_NAME,
    onSecondTab: options.onSecondTab ?? 'refuse',
    ...(options.locks === undefined ? {} : { locks: options.locks }),
    ...(options.idbDatabaseName === undefined ? {} : { idbDatabaseName: options.idbDatabaseName }),
    opfs: {
      sqliteModuleUrl: sqliteModuleUrl ?? '',
      ...(options.workerUrl === undefined ? {} : { workerUrl: options.workerUrl }),
      ...(options.databasePath === undefined ? {} : { databasePath: options.databasePath }),
      ...(options.startupTimeoutMs === undefined
        ? {}
        : { startupTimeoutMs: options.startupTimeoutMs }),
    },
    openers: openersFor(options.openers),
  });

  if (outcome.kind === 'busy') throw new BrowserStorageBusy(outcome.pool, outcome.mechanism);
  if (outcome.kind === 'unavailable') throw new BrowserStorageUnavailable([...outcome.refused]);

  return {
    storage: outcome.storage,
    tier: outcome.tier,
    engine: outcome.engine,
    refused: [...outcome.refused],
    writer: outcome.writer,
  };
}

/**
 * The real tier openers, or the injected ones where a test supplied them.
 *
 * `openOpfsStorage` returns more than the policy needs -- the tier it obviously is, and the refusals it
 * accumulated, which are always empty for a single-tier open -- so the projection is named here rather than
 * twice at the call site.
 */
function openersFor(injected: OpenBrowserOptions['openers']): TierOpeners {
  return {
    opfs:
      injected?.opfs ??
      (async (tierOptions: OpfsTierOptions) => {
        // Built field by field rather than spread: `OpfsOptions` is an `exactOptionalPropertyTypes` type, so
        // an explicitly `undefined` field is a different thing from an absent one.
        const opened = await openOpfsStorage({
          sqliteModuleUrl: tierOptions.sqliteModuleUrl,
          ...(tierOptions.workerUrl === undefined ? {} : { workerUrl: tierOptions.workerUrl }),
          ...(tierOptions.databasePath === undefined
            ? {}
            : { databasePath: tierOptions.databasePath }),
          ...(tierOptions.poolName === undefined ? {} : { poolName: tierOptions.poolName }),
          ...(tierOptions.startupTimeoutMs === undefined
            ? {}
            : { startupTimeoutMs: tierOptions.startupTimeoutMs }),
        });
        return { storage: opened.storage, engine: opened.engine };
      }),
    idb:
      injected?.idb ??
      ((databaseName: string | undefined) =>
        openIdbStorage(databaseName === undefined ? {} : { databaseName })),
  };
}
