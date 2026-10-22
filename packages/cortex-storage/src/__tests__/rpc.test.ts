/**
 * The worker protocol.
 *
 * Two kinds of test, on purpose:
 *
 *   * the handler alone, driven with messages, for the branches a well-behaved caller never
 *     produces -- a malformed envelope, an unknown method, a request after close;
 *   * the handler and the session across a **real `MessageChannel`**, with a real SQLite engine
 *     behind it, for the property that actually matters: what goes in one end comes out the other
 *     unchanged, and a failure arrives as a rejection rather than as a promise that never settles.
 *
 * The second kind is why there is no stub anywhere in this file. A stub would have agreed with
 * whatever the protocol did.
 */
import { MessageChannel } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EngineRpcSession,
  RpcError,
  createEngineRpcHandler,
  type MessageEndpoint,
  type RpcReply,
} from '../browser/rpc.js';
import { openChannelSession, type ChannelSession } from './support/channel.js';
import { createBetterSqliteEngine } from './support/sql-engines.js';

const open: ChannelSession[] = [];

/** Wire a session to a handler over a real channel, the way the worker does it. */
function wire(): ChannelSession {
  const wiring = openChannelSession(createBetterSqliteEngine());
  open.push(wiring);
  return wiring;
}

afterEach(async () => {
  for (const wiring of open.splice(0)) await wiring.close();
});

describe('peers that misbehave', () => {
  /** An endpoint the test drives by hand: the only way to produce a badly-formed reply. */
  function scripted() {
    const listeners: ((event: { data: unknown }) => void)[] = [];
    return {
      endpoint: {
        postMessage: () => undefined,
        addEventListener: (_type: 'message', listener: (event: { data: unknown }) => void) => {
          listeners.push(listener);
        },
        removeEventListener: () => undefined,
      } satisfies MessageEndpoint,
      /** Send a raw message to the session, as a malformed peer would. */
      emit: (data: unknown) => {
        for (const listener of listeners) listener({ data });
      },
      get listenerCount() {
        return listeners.length;
      },
    };
  }

  it('ignores a reply that is not an object, and one whose id nobody is waiting for', async () => {
    // A stray message must not throw inside the reader's handler: that would surface as an unhandled
    // error in the worker's port, which is where the least debuggable failures live.
    const { endpoint, emit } = scripted();
    const session = new EngineRpcSession(endpoint);
    emit(null);
    emit('not a reply');
    emit({ id: 999, ok: true });

    const pending = session.all('SELECT 1', []);
    emit({ id: 1, ok: true, rows: [{ a: 1 }] });
    await expect(pending).resolves.toEqual([{ a: 1 }]);
  });

  it('reads a success reply with no rows as an empty result', async () => {
    const { endpoint, emit } = scripted();
    const session = new EngineRpcSession(endpoint);
    const pending = session.all('SELECT 1', []);
    emit({ id: 1, ok: true });
    await expect(pending).resolves.toEqual([]);
  });

  it('runs the close hook once, however many times the session fails', () => {
    // The hook terminates a worker. Running it twice would be harmless; running it zero times leaks
    // a thread, and running it on a session that never closed would take the worker away from a
    // caller that still holds it.
    const { endpoint } = scripted();
    let closes = 0;
    const session = new EngineRpcSession(endpoint, { onClose: () => (closes += 1) });
    session.abort('first');
    session.abort('second');
    expect(closes).toBe(1);
  });

  it('rejects with an Error when the channel throws something that is not one', async () => {
    const endpoint: MessageEndpoint = {
      postMessage: () => {
        throw 'the port exploded';
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const session = new EngineRpcSession(endpoint);
    await expect(session.all('SELECT 1', [])).rejects.toBeInstanceOf(Error);
  });
});

describe('handler, driven directly', () => {
  function collect(): { replies: RpcReply[]; handler: (request: unknown) => void } {
    const replies: RpcReply[] = [];
    return {
      replies,
      handler: createEngineRpcHandler(createBetterSqliteEngine(), (r) => replies.push(r)),
    };
  }

  it('answers a malformed envelope with id -1 so the failure is visible somewhere', () => {
    const { replies, handler } = collect();
    handler({ method: 'all', sql: 'SELECT 1' });
    expect(replies).toEqual([
      {
        id: -1,
        ok: false,
        error: 'malformed request: expected { id, method }',
        code: 'malformed-request',
      },
    ]);
  });

  it('answers null, which is not an envelope either', () => {
    const { replies, handler } = collect();
    handler(null);
    expect(replies[0]).toMatchObject({ id: -1, ok: false, code: 'malformed-request' });
  });

  it('reports a non-Error thrown by the engine', () => {
    // A wasm shim can throw a string. Losing the message because it is not an Error would turn a
    // diagnosable failure into "engine-error".
    const replies: RpcReply[] = [];
    const engine = {
      exec: () => undefined,
      run: () => undefined,
      all: () => {
        throw 'sqlite said no';
      },
      close: () => undefined,
      describe: () => ({ engine: 'fake', version: '0', vfs: 'none' }),
    };
    const handler = createEngineRpcHandler(engine, (reply) => replies.push(reply));
    handler({ id: 9, method: 'all', sql: 'SELECT 1' });
    expect(replies[0]).toMatchObject({
      id: 9,
      ok: false,
      error: 'sqlite said no',
      code: 'engine-error',
    });
  });

  it('answers an unknown method with the id it was given', () => {
    const { replies, handler } = collect();
    handler({ id: 7, method: 'drop' });
    expect(replies[0]).toMatchObject({ id: 7, ok: false, code: 'unsupported-method' });
  });

  it('refuses a statement with no sql', () => {
    const { replies, handler } = collect();
    handler({ id: 1, method: 'all', sql: '   ' });
    expect(replies[0]).toMatchObject({ id: 1, ok: false, code: 'malformed-request' });
  });

  it('reports an engine failure as an error reply rather than throwing out of the handler', () => {
    // A throw here would escape into the worker's `onmessage` and be reported by the browser, where
    // the waiting caller cannot see it. The reply is what the caller can act on.
    const { replies, handler } = collect();
    handler({ id: 2, method: 'all', sql: 'SELECT * FROM does_not_exist' });
    expect(replies[0]).toMatchObject({ id: 2, ok: false, code: 'engine-error' });
    expect((replies[0] as { error: string }).error).toContain('does_not_exist');
  });

  it('refuses further work after close', () => {
    const { replies, handler } = collect();
    handler({ id: 3, method: 'close' });
    handler({ id: 4, method: 'all', sql: 'SELECT 1' });
    expect(replies[0]).toEqual({ id: 3, ok: true });
    expect(replies[1]).toMatchObject({ id: 4, ok: false, code: 'closed' });
  });
});

describe('session across a real channel', () => {
  it('round-trips exec, run and all', async () => {
    const { session } = wire();

    await session.exec('CREATE TABLE t (a TEXT, b INTEGER)');
    await session.run('INSERT INTO t (a, b) VALUES (?, ?)', ['x', 1]);
    expect(await session.all('SELECT a, b FROM t', [])).toEqual([{ a: 'x', b: 1 }]);
  });

  it('reports the engine that is actually behind the channel', async () => {
    const { session } = wire();
    const info = await session.describe();
    expect(info.engine).toBe('better-sqlite3');
    expect(info.version).not.toBe('unknown');
  });

  it('rejects with the far side’s code when a statement fails', async () => {
    const { session } = wire();
    await expect(session.all('SELECT * FROM nope', [])).rejects.toBeInstanceOf(RpcError);
    await expect(session.all('SELECT * FROM nope', [])).rejects.toMatchObject({
      code: 'engine-error',
    });
  });

  it('keeps replies paired with requests when several are in flight', async () => {
    const { session } = wire();
    await session.exec('CREATE TABLE t (n INTEGER)');
    await session.run('INSERT INTO t (n) VALUES (?)', [1]);
    await session.run('INSERT INTO t (n) VALUES (?)', [2]);

    const [first, second, third] = await Promise.all([
      session.all('SELECT n FROM t ORDER BY n', []),
      session.all('SELECT count(*) AS c FROM t', []),
      session.all('SELECT n FROM t ORDER BY n DESC', []),
    ]);
    expect(first).toEqual([{ n: 1 }, { n: 2 }]);
    expect(second).toEqual([{ c: 2 }]);
    expect(third).toEqual([{ n: 2 }, { n: 1 }]);
  });

  it('rejects outstanding work when the session closes', async () => {
    // No handler is attached to the far port, so this request is never answered: the session has to
    // settle it on close rather than leave the caller waiting for a worker that is gone.
    const { port1, port2 } = new MessageChannel();
    const session = new EngineRpcSession(port2 as unknown as MessageEndpoint);
    const pending = session.all('SELECT 1', []);
    await session.close();
    await expect(pending).rejects.toMatchObject({ code: 'closed' });
    port1.close();
    port2.close();
  });

  it('refuses to send after close', async () => {
    const { session } = wire();
    await session.close();
    await expect(session.all('SELECT 1', [])).rejects.toMatchObject({ code: 'closed' });
  });

  it('aborts in-flight work when the worker reports an error', async () => {
    // The only signal from a worker whose module never loaded. Without this the caller waits for a
    // reply that will never come, which is the one failure mode a browser makes invisible.
    const endpoint: MessageEndpoint = {
      postMessage: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const session = new EngineRpcSession(endpoint);
    const pending = session.all('SELECT 1', []);
    session.abort('the worker died');
    await expect(pending).rejects.toMatchObject({ code: 'channel-error' });
    await expect(pending).rejects.toThrow('the worker died');
    await expect(session.all('SELECT 1', [])).rejects.toMatchObject({ code: 'closed' });
  });

  it('closes even when the channel refuses the goodbye', async () => {
    // A dead channel is exactly when close is called. Throwing here would take down the shutdown
    // path of whatever called it, which is the opposite of what a close is for.
    const endpoint: MessageEndpoint = {
      postMessage: () => {
        throw new Error('port is gone');
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const session = new EngineRpcSession(endpoint);
    await expect(session.close()).resolves.toBeUndefined();
  });

  it('refuses a describe reply that carries no engine', async () => {
    // A peer that answers success without the payload: an older build, or a proxy. Reading it as
    // `undefined` would surface much later as a tier line saying "undefined undefined on undefined".
    const replies: RpcReply[] = [];
    const endpoint: MessageEndpoint = {
      postMessage: (value) => {
        const request = value as { id: number };
        replies.push({ id: request.id, ok: true });
      },
      addEventListener: (type, listener) => {
        if (type !== 'message') return;
        // Answer synchronously on the next turn, as a worker would.
        queueMicrotask(() => {
          for (const reply of replies.splice(0)) listener({ data: reply });
        });
      },
      removeEventListener: () => undefined,
    };
    const session = new EngineRpcSession(endpoint);
    await expect(session.describe()).rejects.toThrow('no engine information');
  });

  it('surfaces a channel that cannot be written to as a rejection', async () => {
    const endpoint: MessageEndpoint = {
      postMessage: () => {
        throw new Error('port is gone');
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const session = new EngineRpcSession(endpoint);
    await expect(session.all('SELECT 1', [])).rejects.toThrow('port is gone');
  });
});
