/**
 * The worker entry point: open SQLite-WASM on OPFS, then answer RPC requests.
 *
 * ## Why this file is small on purpose
 *
 * Everything that decides behaviour -- the schema, the statements, the transaction discipline, the
 * protocol's error handling -- lives in modules that are tested in Node against a real engine. What
 * is left here is the part that cannot be: creating the VFS, and getting the first message to a
 * handler that may not exist yet. Keeping that residue to a page of code is what makes "the
 * untested part is small and named" a true statement rather than a hope.
 *
 * ## The one failure this file exists to prevent
 *
 * A worker whose initialisation fails while messages are already arriving. The default shape --
 * `await` the setup, then assign `onmessage` -- leaves every message sent during setup unanswered,
 * and the caller sees a promise that never settles: a tab that hangs on first read with nothing in
 * the console. So `onmessage` is assigned **before** any awaiting starts, requests are queued, and a
 * failure is answered for every queued request with a code the caller can branch on.
 *
 * ## Configuration arrives through the worker's own URL
 *
 * A module worker cannot be handed options before it evaluates. The alternatives are a message-based
 * handshake (which reintroduces the "unanswered message" problem this file is about) or query
 * parameters on the worker URL. The URL is chosen because it is available synchronously at the first
 * line, which is exactly what the queueing above needs.
 */
import type { EngineInfo, RpcReply, SqlEngine } from './rpc.js';
import { createEngineRpcHandler } from './rpc.js';
import type { SqlRow, SqlValue } from '../storage/sql.js';

/** The parts of a dedicated-worker global scope this file uses. */
type WorkerScope = {
  location: { href: string };
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
};

/** The parts of a sqlite-wasm database object this file uses. */
type WasmDatabase = {
  exec(sql: string): void;
  exec(config: { sql: string; bind?: SqlValue[]; rowMode?: string; returnValue?: string }): unknown;
  close(): void;
};

type WasmPool = { OpfsSAHPoolDb: new (path: string) => WasmDatabase };

type WasmModule = {
  version: { libVersion: string };
  installOpfsSAHPoolVfs(options: { name: string; initialCapacity: number }): Promise<WasmPool>;
};

const scope = globalThis as unknown as WorkerScope;
const params = new URL(scope.location.href).searchParams;

// Resolved to an absolute URL here, once: the value arrives as whatever the caller wrote, and a
// relative path used as a `URL` base throws "Invalid base URL" on the first `locateFile` call -- a
// failure that reads like a missing build step rather than like an unresolved relative path.
const sqliteParam = params.get('sqlite');
const sqliteUrl = sqliteParam === null ? null : new URL(sqliteParam, scope.location.href).href;
const databasePath = params.get('db') ?? '/cortex.sqlite3';
const poolName = params.get('pool') ?? 'cortex';

/** How many times to try installing the pool. See `openEngine` for why this exists at all. */
const OPEN_ATTEMPTS = 4;
const OPEN_RETRY_MS = 120;

const queue: unknown[] = [];
let dispatch: ((request: unknown) => void) | null = null;
let failure: { error: string; code: 'opfs-unavailable' } | null = null;

function idOf(request: unknown): number {
  if (typeof request === 'object' && request !== null && 'id' in request) {
    const id = (request as { id?: unknown }).id;
    if (typeof id === 'number') return id;
  }
  return -1;
}

/** Answer everybody, however the engine turned out. */
function refuseAll(reason: { error: string; code: 'opfs-unavailable' }): void {
  for (const request of queue.splice(0)) {
    scope.postMessage({ id: idOf(request), ok: false, ...reason });
  }
}

scope.onmessage = (event: { data: unknown }): void => {
  if (failure !== null) {
    scope.postMessage({ id: idOf(event.data), ok: false, ...failure });
    return;
  }
  if (dispatch === null) {
    queue.push(event.data);
    return;
  }
  dispatch(event.data);
};

void start();

async function start(): Promise<void> {
  try {
    const engine = await openEngine();
    const handler = createEngineRpcHandler(engine, (reply: RpcReply) => scope.postMessage(reply));
    dispatch = handler;
    for (const request of queue.splice(0)) handler(request);
  } catch (error) {
    failure = {
      error: `OPFS storage is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      code: 'opfs-unavailable',
    };
    refuseAll(failure);
  }
}

async function openEngine(): Promise<SqlEngine> {
  if (sqliteUrl === null) {
    throw new Error('the worker needs ?sqlite=<url of the sqlite-wasm index.mjs>');
  }

  // The module URL is a runtime value, so the import cannot be statically analysed. That is the
  // point: the same worker serves any copy of sqlite-wasm the host decides to ship.
  const module = (await import(/* @vite-ignore */ sqliteUrl)) as { default: InitModule };
  const sqlite3 = await module.default({ locateFile: (file) => new URL(file, sqliteUrl).href });

  if (typeof sqlite3.installOpfsSAHPoolVfs !== 'function') {
    throw new Error('this sqlite-wasm build has no installOpfsSAHPoolVfs');
  }

  // The SAH pool, not the `opfs` VFS: in the bundler build `sqlite3_vfs_find('opfs')` returns 0, so
  // `new oo1.OpfsDb(...)` throws "not a constructor". The pool is the shape that works, and it is
  // also the shape whose handle limit was the open Safari question -- measured on 26.6 in docs/04.
  //
  // ## Why installing the pool is retried
  //
  // A worker that closed its database is terminated, but its OPFS access handles are released
  // **asynchronously**, after the worker context is torn down. Reopening inside the same document
  // therefore loses a race with its own predecessor and fails with
  // "Access Handles cannot be created if there is another open Access Handle ... associated with the
  // same file" -- measured, not hypothesised: it is what made the second open of a page fall back to
  // IndexedDB while the first one worked.
  //
  // There is no event that reports handle release, so the only available mechanism is to try again.
  // The retry is bounded, it does not inspect the message text, and a failed install creates nothing
  // to clean up; a genuinely absent OPFS therefore costs a few hundred milliseconds and then reports
  // its own error unchanged.
  let lastError: unknown;
  for (let attempt = 1; attempt <= OPEN_ATTEMPTS; attempt += 1) {
    try {
      const pool = await sqlite3.installOpfsSAHPoolVfs({ name: poolName, initialCapacity: 8 });
      const db = new pool.OpfsSAHPoolDb(databasePath);
      return engineOver(db, sqlite3.version.libVersion);
    } catch (error) {
      lastError = error;
      if (attempt < OPEN_ATTEMPTS) await sleep(OPEN_RETRY_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

type InitModule = (config: { locateFile: (file: string) => string }) => Promise<WasmModule>;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** `journal_mode`, read once: it cannot change under a pool VFS, and a read per describe is noise. */
function journalModeOf(db: WasmDatabase): string {
  try {
    const rows = db.exec({
      sql: 'PRAGMA journal_mode',
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as SqlRow[];
    const value = rows[0]?.journal_mode;
    return typeof value === 'string' ? value : 'unknown';
  } catch {
    return 'unknown';
  }
}

function engineOver(db: WasmDatabase, version: string): SqlEngine {
  const journal = journalModeOf(db);
  const info: EngineInfo = { engine: 'sqlite-wasm', version, vfs: 'opfs-sahpool', journal };
  let closed = false;

  return {
    exec: (sql: string) => db.exec(sql),
    run: (sql: string, values: readonly SqlValue[]) => {
      db.exec({ sql, bind: [...values] });
    },
    all: (sql: string, values: readonly SqlValue[]) =>
      db.exec({
        sql,
        bind: [...values],
        rowMode: 'object',
        returnValue: 'resultRows',
      }) as SqlRow[],
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
    },
    describe: () => info,
  };
}
