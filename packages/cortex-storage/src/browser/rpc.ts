/**
 * The protocol between the main thread and the storage worker, and the two halves that speak it.
 *
 * ## Why the boundary exists at all
 *
 * OPFS's synchronously-usable handles are only reachable from a dedicated worker, so a browser
 * storage engine cannot live on the main thread without giving up the synchronous VFS. That makes
 * the worker boundary a constraint rather than an optimisation -- and it makes the protocol a piece
 * of product code, not plumbing: every read and write goes through it.
 *
 * ## The shape, and why there are two interfaces for four operations
 *
 * {@link SqlEngine} is synchronous, because the engine it describes (SQLite-WASM) is. {@link SqlSession}
 * is asynchronous, because it is on the other side of a thread. Collapsing them into one
 * async-by-default interface would have put `await` inside the worker for no reason; collapsing
 * them the other way would have made `SqlStorage` synchronous and unshareable.
 *
 * Both are tested with a real engine: `tests/rpc.test.ts` wires a handler over `node:sqlite` to a
 * session over a real `MessageChannel`, so the protocol is exercised as bytes and replies rather
 * than as a method call on a stub.
 *
 * ## The failure this protocol is built to avoid
 *
 * A worker that fails to initialise -- no OPFS, no quota, a private-browsing tab -- would otherwise
 * accept messages and never answer, and the symptom would be a tab that hangs on first read with
 * nothing in the console. So the worker answers **every** request, including the ones that arrived
 * before it finished starting and the ones that arrive after a failure: a refusal with a code is a
 * result, silence is not.
 */
import type { SqlRow, SqlSession, SqlValue } from '../storage/sql.js';

/** What the engine inside the worker can do. Synchronous: this is the thread that owns SQLite. */
export interface SqlEngine {
  /** Run one or more statements with no parameters. */
  exec(sql: string): void;
  /** Run one parameterised statement for effect. */
  run(sql: string, params: readonly SqlValue[]): void;
  /** Run one parameterised statement and return its rows. */
  all(sql: string, params: readonly SqlValue[]): SqlRow[];
  /** Release the engine. Idempotent. */
  close(): void;
  /** Identify what is actually running, so the caller can report the tier it really got. */
  describe(): EngineInfo;
}

/** Facts about the engine that are worth reporting rather than assuming. */
export type EngineInfo = {
  /** `sqlite-wasm`, `node:sqlite`, ... */
  engine: string;
  /** Engine version string, or `unknown`. */
  version: string;
  /** Which VFS the database is on: `opfs-sahpool`, `memory`, ... */
  vfs: string;
  /**
   * The engine's `journal_mode`, when it can be read.
   *
   * Reported rather than forced, because it explains the one number a caller will otherwise find
   * inexplicable: on the SAH pool the mode stays a rollback journal, so every single `put` pays a
   * commit -- about 4 ms on this machine -- while the same writes inside one transaction run at
   * 10,000 rows/s. Setting `journal_mode=WAL` there changes nothing and would have made the code
   * look tuned while the behaviour stayed the same.
   */
  journal?: string;
};

export type RpcMethod = 'exec' | 'run' | 'all' | 'describe' | 'close';

export type RpcRequest = {
  id: number;
  method: RpcMethod;
  sql?: string;
  params?: SqlValue[];
};

export type RpcErrorCode =
  | 'unsupported-method'
  | 'malformed-request'
  | 'engine-error'
  | 'closed'
  | 'channel-error'
  | 'opfs-unavailable';

export type RpcReply =
  | { id: number; ok: true; rows?: SqlRow[]; info?: EngineInfo }
  | { id: number; ok: false; error: string; code: RpcErrorCode };

/** The success half. `SqlSession`'s methods only ever see this one. */
type OkReply = Extract<RpcReply, { ok: true }>;

/** A failure reported by the far side of the channel. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: RpcErrorCode,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

function isRequest(value: unknown): value is RpcRequest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<RpcRequest>;
  // Only the envelope is validated here. The method name is deliberately *not* checked against
  // `METHODS`: an unknown method with a valid id deserves an answer carrying that id (so the
  // caller's promise settles), not a message that cannot be correlated with anything.
  return typeof candidate.id === 'number' && typeof candidate.method === 'string';
}

/**
 * The worker half.
 *
 * `post` is injected rather than read from the global scope so this function is testable in a
 * thread that has no `self` -- and so the worker's own entry point stays a thin adapter whose only
 * job is to name the engine.
 */
export function createEngineRpcHandler(
  engine: SqlEngine,
  post: (reply: RpcReply) => void,
): (request: unknown) => void {
  let closed = false;

  return (request: unknown): void => {
    if (!isRequest(request)) {
      // A request without a numeric id cannot be answered. Reporting it on the console is all that
      // is left, and doing nothing at all would be worse: a malformed message would otherwise look
      // exactly like a slow one.
      post({
        id: -1,
        ok: false,
        error: 'malformed request: expected { id, method }',
        code: 'malformed-request',
      });
      return;
    }

    if (closed) {
      post({ id: request.id, ok: false, error: 'engine is closed', code: 'closed' });
      return;
    }

    try {
      switch (request.method) {
        case 'describe':
          post({ id: request.id, ok: true, info: engine.describe() });
          return;
        case 'close':
          engine.close();
          closed = true;
          post({ id: request.id, ok: true });
          return;
        case 'exec':
        case 'run':
        case 'all': {
          const sql = request.sql;
          // A blank statement is a malformed request, not an engine failure: an engine would report
          // "incomplete input" at a position that means nothing to the caller, while the actual
          // mistake is upstream where the string was built.
          if (typeof sql !== 'string' || sql.trim().length === 0) {
            post({
              id: request.id,
              ok: false,
              error: `${request.method} needs a non-empty sql string`,
              code: 'malformed-request',
            });
            return;
          }
          const params = request.params ?? [];
          if (request.method === 'exec') {
            // `exec` is the DDL/transaction-control path and takes no parameters on purpose: a
            // statement that needs parameters is a `run`, and allowing both would make the binding
            // rules depend on which method the caller picked.
            engine.exec(sql);
            post({ id: request.id, ok: true });
            return;
          }
          if (request.method === 'run') {
            engine.run(sql, params);
            post({ id: request.id, ok: true });
            return;
          }
          post({ id: request.id, ok: true, rows: engine.all(sql, params) });
          return;
        }
        default:
          post({
            id: request.id,
            ok: false,
            error: `unsupported method ${String(request.method)}`,
            code: 'unsupported-method',
          });
      }
    } catch (error) {
      post({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: 'engine-error',
      });
    }
  };
}

/** The parts of a `Worker` or `MessagePort` this module needs. */
export interface MessageEndpoint {
  postMessage(value: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  start?(): void;
  terminate?(): void;
}

/** The main-thread half: a `SqlSession` whose statements run on the other side of a channel. */
export class EngineRpcSession implements SqlSession {
  #nextId = 1;
  #closed = false;
  #failed = false;
  readonly #pending = new Map<
    number,
    { resolve: (reply: RpcReply) => void; reject: (error: Error) => void }
  >();

  readonly #onClose: (() => void) | undefined;

  constructor(
    private readonly endpoint: MessageEndpoint,
    options: { onClose?: () => void } = {},
  ) {
    this.#onClose = options.onClose;
    endpoint.addEventListener('message', this.#onMessage);
    // Node's `MessagePort` only delivers to `addEventListener` listeners once started; browsers
    // start implicitly. Calling it where it exists is what makes the same class work in both.
    endpoint.start?.();
  }

  async exec(sql: string): Promise<void> {
    await this.#call({ method: 'exec', sql });
  }

  async run(sql: string, params: readonly SqlValue[]): Promise<void> {
    await this.#call({ method: 'run', sql, params: [...params] });
  }

  async all(sql: string, params: readonly SqlValue[]): Promise<SqlRow[]> {
    const reply = await this.#call({ method: 'all', sql, params: [...params] });
    return reply.rows ?? [];
  }

  /** What the far side actually opened. Forces initialisation, so a failure surfaces here. */
  async describe(): Promise<EngineInfo> {
    const reply = await this.#call({ method: 'describe' });
    if (reply.info === undefined) {
      // Reachable only if the far side answers success without the payload. Kept because a peer
      // that does that -- an older build, a proxy, a hand-rolled test double -- would otherwise be
      // read as `undefined` and the failure would surface much later, as a tier line that says
      // "undefined undefined on undefined".
      throw new RpcError('describe returned no engine information', 'malformed-request');
    }
    return reply.info;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    // The far side is told to close its engine, but its reply is deliberately not awaited. If the
    // worker has already died -- the exact situation `close` is often reached from -- there is
    // nobody to answer, and awaiting would hang the caller that is trying to shut down.
    try {
      this.endpoint.postMessage({ id: this.#nextId++, method: 'close' });
    } catch {
      // A channel that cannot be written to is already as closed as this call can make it.
    }
    this.#settle();
  }

  /**
   * Fail every outstanding request because the channel itself broke.
   *
   * The worker's `error` event is the only signal from a worker whose module never loaded, so this is
   * what turns "the tab does nothing" into a rejection with a reason.
   */
  abort(reason: string): void {
    this.#fail(new RpcError(reason, 'channel-error'));
  }

  /** Detach from the endpoint, settling whatever was in flight. */
  #settle(): void {
    this.#fail(new RpcError('channel closed before the request was answered', 'closed'));
  }

  #fail(error: RpcError): void {
    if (this.#closed && this.#failed) return;
    this.#closed = true;
    this.#failed = true;
    this.endpoint.removeEventListener('message', this.#onMessage);
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) entry.reject(error);
    // Releasing the endpoint is the session's job, not the caller's: whoever holds the session holds
    // the only handle that can terminate a worker, and a caller that forgets leaks a thread and a
    // wasm instance per open/close cycle -- in a browser tab, where nobody is watching for it.
    this.#onClose?.();
  }

  #onMessage = (event: { data: unknown }): void => {
    const reply = event.data as RpcReply;
    if (typeof reply !== 'object' || reply === null) return;
    const entry = this.#pending.get(reply.id);
    if (entry === undefined) return;
    this.#pending.delete(reply.id);
    entry.resolve(reply);
  };

  /**
   * Send a request and return its success reply, or throw.
   *
   * The return type is the narrowed success arm, which is what removed a dead branch from every
   * caller: `if (!reply.ok)` here means the callers never have an error arm to handle, and a caller
   * that wrote `reply.ok ? rows : []` was expressing a condition that cannot be false.
   */
  async #call(request: { method: RpcMethod; sql?: string; params?: SqlValue[] }): Promise<OkReply> {
    if (this.#closed) throw new RpcError('session is closed', 'closed');
    const id = this.#nextId++;
    const reply = await new Promise<RpcReply>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.endpoint.postMessage({ id, ...request });
      } catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    if (!reply.ok) throw new RpcError(reply.error, reply.code);
    return reply;
  }
}
