/**
 * What a caller is told when the OPFS worker never starts.
 *
 * ## Why this is a test and not a line in the browser probe
 *
 * The probe found the defect: bundling the package with esbuild and opening the default worker URL
 * produced an `RpcError` whose `message` was **empty**. Two facts had to line up for that:
 *
 *   - Chrome dispatches a plain `Event` -- not an `ErrorEvent` -- when a module script's fetch 404s,
 *     so `event.message` is `undefined`;
 *   - the handler tested `event.message === ''`, which `undefined` passes through, so
 *     `new Error(undefined)` reached the caller with nothing in it.
 *
 * A probe can find that once. It cannot keep it found: the probe needs Chromium, a bundler and two
 * minutes, and the package's Node suite should not depend on any of them to notice that its own
 * error message became empty again. So the browser surface is exercised here against a `Worker`
 * stub -- the only thing `openOpfsStorage` needs from the environment -- and the probe stays the
 * one place that proves a real browser agrees.
 *
 * ## What each case is for
 *
 *   - `undefined` and `''` are the two shapes a 404 arrives in across engines, and both must name the
 *     URL and the fix;
 *   - a message the browser did provide is kept verbatim, because it is usually the precise cause
 *     ("Failed to fetch dynamically imported module: ...");
 *   - the timeout says how long it waited and where, because "timed out" alone sends the reader to
 *     the wrong file;
 *   - the worker is terminated on every failure path. A browser tab that leaks one thread and one
 *     wasm instance per failed open is a product defect nobody reports.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openOpfsStorage } from '../browser/opfs.js';

/** The smallest object that satisfies `openOpfsStorage`: it listens, posts, and dies. */
class StubWorker {
  static instances: StubWorker[] = [];

  readonly listeners = new Map<string, ((event: Event) => void)[]>();
  readonly posted: unknown[] = [];
  terminated = false;

  constructor(
    readonly url: URL,
    readonly options: { type?: string; name?: string },
  ) {
    StubWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((candidate) => candidate !== listener),
    );
  }

  postMessage(value: unknown): void {
    this.posted.push(value);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Deliver whatever the engine would deliver. `message` is omitted on purpose for the 404 case. */
  emitError(message?: string): void {
    const event = new Event('error') as Event & { message?: string };
    if (message !== undefined) event.message = message;
    for (const listener of this.listeners.get('error') ?? []) listener(event);
  }
}

function installStub(): void {
  StubWorker.instances = [];
  vi.stubGlobal('Worker', StubWorker as unknown as typeof globalThis.Worker);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const SQLITE = 'https://example.test/vendor/index.mjs';

describe('the OPFS worker never starts', () => {
  it('names the URL and the fix when the browser event carries no message', async () => {
    installStub();
    const opening = openOpfsStorage({ sqliteModuleUrl: SQLITE });
    const worker = StubWorker.instances[0]!;
    worker.emitError();
    const error = await opening.then(
      () => null,
      (reason: Error) => reason,
    );
    expect(error?.message).toContain('the storage worker failed to start');
    expect(error?.message).toContain('opfs-worker.js');
    expect(error?.message).toContain('opfs/worker');
    expect(error?.message.trim()).not.toBe('');
  });

  it('treats an empty message as no message rather than passing it through', async () => {
    installStub();
    const opening = openOpfsStorage({ sqliteModuleUrl: SQLITE });
    StubWorker.instances[0]!.emitError('');
    const error = await opening.then(
      () => null,
      (reason: Error) => reason,
    );
    expect(error?.message).toContain('the module did not load');
  });

  it('keeps the message the browser did provide, and adds where it looked', async () => {
    installStub();
    const opening = openOpfsStorage({ sqliteModuleUrl: SQLITE });
    StubWorker.instances[0]!.emitError('Failed to fetch dynamically imported module');
    const error = await opening.then(
      () => null,
      (reason: Error) => reason,
    );
    expect(error?.message).toContain('Failed to fetch dynamically imported module');
    expect(error?.message).toContain('/opfs-worker.js');
  });

  it('reports how long it waited on a worker that says nothing at all', async () => {
    installStub();
    vi.useFakeTimers();
    const opening = openOpfsStorage({ sqliteModuleUrl: SQLITE, startupTimeoutMs: 250 });
    const settled = opening.then(
      () => null,
      (reason: Error) => reason,
    );
    await vi.advanceTimersByTimeAsync(300);
    const error = await settled;
    expect(error?.message).toContain('timed out after 250 ms');
    expect(error?.message).toContain('/opfs-worker.js');
    expect(error?.message).toContain('the OPFS pool is blocked');
  });

  it('terminates the worker on every failure path, so a failed open leaks no thread', async () => {
    installStub();
    const opening = openOpfsStorage({ sqliteModuleUrl: SQLITE });
    const worker = StubWorker.instances[0]!;
    worker.emitError();
    await opening.catch(() => undefined);
    expect(worker.terminated).toBe(true);
  });

  it('passes the sqlite module and the database through the worker URL', async () => {
    installStub();
    const opening = openOpfsStorage({
      sqliteModuleUrl: SQLITE,
      databasePath: 'notes.sqlite3',
      poolName: 'notes',
    });
    const worker = StubWorker.instances[0]!;
    expect(worker.url.searchParams.get('sqlite')).toBe(SQLITE);
    expect(worker.url.searchParams.get('db')).toBe('notes.sqlite3');
    expect(worker.url.searchParams.get('pool')).toBe('notes');
    expect(worker.options).toEqual({ type: 'module', name: 'cortex-storage' });
    worker.emitError();
    await opening.catch(() => undefined);
  });
});
