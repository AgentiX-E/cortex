/**
 * The Firefox half of the browser suites: WebDriver BiDi, no automation library.
 *
 * ## Why a second protocol rather than a second Chromium
 *
 * `§10.2` gate 2 asks whether OPFS persistence survives a restart on a **second engine**, and a second
 * Chromium profile does not answer it: same VFS, same SQLite build, same bug surface. Two engines must
 * mean two implementations of `createSyncAccessHandle`, and the only cheap way to get one is Firefox.
 *
 * ## Why BiDi and not CDP
 *
 * Firefox's CDP support was removed in 129. What it kept is the W3C standard: `--remote-debugging-port`
 * starts a **WebDriver BiDi** server that speaks JSON over a WebSocket at the port's root path. The
 * protocol surface this file needs is five commands, so the same argument that kept Playwright out of
 * `cdp.mjs` applies here -- a dependency would be the only reason this package needs a browser
 * automation library, and it would pin the suite to whichever Firefox the host happens to have.
 *
 * ## The one thing a reader should know before debugging this
 *
 * **The WebSocket path is `/session`, and the log line does not say so.** Firefox prints
 * `WebDriver BiDi listening on ws://127.0.0.1:PORT` and then answers `200 OK` with an `httpd.js`
 * welcome page to a handshake at `/`, because the root is the HTTP endpoint -- the upgrade lives one
 * segment down. Connecting to the printed URL therefore fails with "non-101 status code", which reads
 * like a handshake bug and is a path bug. `curl` cannot tell you either: it returns `200` to a GET and
 * "the handshake request must use GET method" to a POST.
 *
 * The session is created **inside** the socket by the first `session.new` command, so the connection is
 * the readiness test and there is no HTTP probe that can substitute for it.
 */

import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Find a Firefox. Explicit path first, then the playwright cache, then the usual install locations. */
export function findFirefox() {
  if (process.env.CORTEX_FIREFOX !== undefined) return process.env.CORTEX_FIREFOX;
  const cache = join(process.env.HOME ?? '/root', '.cache', 'ms-playwright');
  if (existsSync(cache)) {
    for (const entry of readdirSync(cache)) {
      if (!entry.startsWith('firefox-')) continue;
      const candidate = join(cache, entry, 'firefox', 'firefox');
      if (existsSync(candidate)) return candidate;
    }
  }
  for (const candidate of [
    '/opt/firefox/firefox',
    '/usr/bin/firefox',
    '/usr/lib/firefox/firefox',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** A BiDi connection to one browser, which is also the session. */
export class BiDiConnection {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #context = null;

  static async open(url) {
    const connection = new BiDiConnection();
    connection.#socket = new WebSocket(url);
    await new Promise((resolveOpen, rejectOpen) => {
      const timer = setTimeout(
        () => rejectOpen(new Error(`no BiDi handshake from ${url} within 20 s`)),
        20_000,
      );
      connection.#socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolveOpen();
      });
      connection.#socket.addEventListener('error', () => {
        clearTimeout(timer);
        rejectOpen(new Error(`cannot connect to ${url}`));
      });
    });
    connection.#socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id === undefined) return; // An event, not a reply: this suite subscribes to none.
      const entry = connection.#pending.get(message.id);
      if (entry === undefined) return;
      connection.#pending.delete(message.id);
      if (message.type === 'error') entry.reject(new Error(`${message.error}: ${message.message}`));
      else entry.resolve(message.result);
    });
    return connection;
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolveSend, rejectSend) => {
      this.#pending.set(id, { resolve: resolveSend, reject: rejectSend });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * The tab every later command targets.
   *
   * Read-only, and public because a command this class does not wrap needs it to build its own
   * `target`. `browsingContext.getTree` would be the obvious way to rediscover it and it does not
   * work: Firefox answers "System access is required. Start Firefox with the
   * MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 environment variable" -- a capability this suite must not need
   * just to look up an id it already holds.
   */
  get context() {
    return this.#context;
  }

  /** Open the session, then a tab, and remember the tab: every later command targets it. */
  async start() {
    await this.send('session.new', { capabilities: {} });
    const created = await this.send('browsingContext.create', { type: 'tab' });
    this.#context = created.context;
    return this.#context;
  }

  async navigate(url, wait = 'complete') {
    return this.send('browsingContext.navigate', { context: this.#context, url, wait });
  }

  /**
   * Evaluate an expression in the tab and return its value.
   *
   * `resultOwnership: 'none'` means the browser does not keep the result alive. The suites only ever
   * want a value -- a boolean, a string, an object literal built by the page -- so a handle would be a
   * leak with no reader.
   *
   * The conversion lives in `valueOf`, not here, because it is the part that can be wrong without a
   * browser: the first version of this method returned `outcome.result.value` and handed the restart
   * suite an array of `[key, value]` pairs where it expected an object (see `deserialize`).
   */
  async evaluate(expression) {
    const outcome = await this.send('script.evaluate', {
      expression,
      target: { context: this.#context },
      awaitPromise: true,
      resultOwnership: 'none',
    });
    return valueOf(outcome);
  }

  close() {
    this.#socket.close();
  }
}

/**
 * Turn a BiDi `RemoteValue` into the JavaScript value the page meant.
 *
 * ## Why this is not `remote.value`
 *
 * WebDriver BiDi does not send objects as objects. A plain object arrives as
 *
 *     { type: 'object', value: [ ['hash', { type: 'number', value: 4000247205 }], … ] }
 *
 * -- an ordered list of `[key, RemoteValue]` pairs -- and an array as
 * `{ type: 'array', value: [RemoteValue, …] }`. Reading `.value` off the object therefore yields an
 * **array of pairs**, which is why the first Firefox run of the restart suite died three lines into
 * the *shared* module with `Cannot read properties of undefined (reading 'hash')` on `phases.write`.
 * Nothing was wrong with OPFS on Firefox; the runner was holding the wire format.
 *
 * Numbers JSON cannot carry arrive as the **strings** `'NaN'`, `'-0'`, `'Infinity'` and `'-Infinity'`,
 * so a naive passthrough turns `NaN` into a string and `-0` into `0`. Undefined arrives as a type with
 * **no `value` field at all**.
 *
 * `bigint` and `date` come back as strings (decimal and ISO 8601). No suite depends on either, and
 * inventing a Date from an ISO string would silently accept a wrong time zone, so they are left as the
 * strings the protocol sends.
 *
 * Every one of these shapes is exercised by `--self-test`, which needs no browser.
 */
export function deserialize(remote) {
  if (remote === undefined || remote === null) return undefined;
  switch (remote.type) {
    case 'undefined':
      return undefined;
    case 'null':
      return null;
    case 'string':
    case 'boolean':
    case 'bigint':
    case 'date':
      return remote.value;
    case 'number': {
      // The four that JSON cannot round-trip, per the specification's NumberValue union.
      if (remote.value === 'NaN') return Number.NaN;
      if (remote.value === '-0') return -0;
      if (remote.value === 'Infinity') return Number.POSITIVE_INFINITY;
      if (remote.value === '-Infinity') return Number.NEGATIVE_INFINITY;
      return remote.value;
    }
    case 'array':
    case 'set':
      return (remote.value ?? []).map(deserialize);
    case 'map':
      return new Map(
        (remote.value ?? []).map(([key, value]) => [deserialize(key), deserialize(value)]),
      );
    case 'object': {
      // A platform object (a `File`, a `Blob`, a `DOMMatrix`) may arrive with no enumerable pairs.
      // `{}` is the honest reading: the suites only ask for plain objects built by the page.
      if (!Array.isArray(remote.value)) return {};
      return Object.fromEntries(remote.value.map(([key, value]) => [key, deserialize(value)]));
    }
    default:
      // function / promise / symbol / node / window / channel: no value a suite can use.
      return undefined;
  }
}

/**
 * The `script.evaluate` result, converted: the value on success, a thrown `Error` on an exception.
 *
 * Separated from `evaluate` so that the branch that reads `exceptionDetails` is testable without a
 * browser, and so the transport stays six lines.
 */
export function valueOf(outcome) {
  if (outcome === undefined || outcome === null) return undefined;
  if (outcome.type === 'exception') {
    const description = outcome.exceptionDetails?.text ?? 'evaluation failed';
    throw new Error(description);
  }
  return deserialize(outcome.result);
}

async function sleep(ms) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/**
 * Launch Firefox on a profile, wait for its BiDi port, and open a session.
 *
 * The readiness loop connects rather than probing HTTP: Firefox answers `404` to `/` until a session
 * exists, and the session is created over the socket, so an HTTP probe can never succeed and a
 * `curl`-based check reports "not ready" forever.
 */
export async function launchFirefox({ firefox, profile, port }) {
  const child = spawn(
    firefox,
    ['--headless', '--no-remote', '--profile', profile, `--remote-debugging-port=${port}`],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  const deadline = Date.now() + 45_000;
  let connection;
  while (Date.now() < deadline && connection === undefined) {
    try {
      connection = await BiDiConnection.open(`ws://127.0.0.1:${port}/session`);
    } catch {
      await sleep(500);
    }
  }
  if (connection === undefined) {
    child.kill('SIGKILL');
    throw new Error(`firefox did not expose BiDi on ${port}. stderr: ${stderr.slice(-800)}`);
  }
  await connection.start();

  const signal = (name) => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, name);
    } catch {
      // Already gone.
    }
  };

  return {
    connection,
    async close() {
      try {
        await connection.send('browser.close', {});
      } catch {
        // The next launch is what matters; a browser that refuses to close is reported below.
      }
      connection.close();
      signal('SIGTERM');
      const exited = await new Promise((resolveExit) => {
        if (child.exitCode !== null) return resolveExit(true);
        const timer = setTimeout(() => resolveExit(false), 10_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolveExit(true);
        });
      });
      // A profile that is still being written when the next launch reads it produces a "your session
      // was restored" page instead of the app, which fails as a storage bug and is not one.
      if (!exited) signal('SIGKILL');
    },
  };
}

/** Wait for the page's modules to finish evaluating; a failed import leaves this false forever. */
export async function waitForReady(connection) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const ready = await connection.evaluate('window.__ready === true').catch(() => false);
    if (ready === true) return;
    await sleep(200);
  }
  const log = await connection.evaluate('document.body.innerText').catch(() => '');
  throw new Error(`the page never became ready: ${JSON.stringify(log).slice(0, 400)}`);
}

/**
 * The conversion, asserted against the shapes Firefox 159 actually sent, with no browser involved.
 *
 * `node test/browser/bidi.mjs --self-test`. The fixtures are transcribed from a live
 * `script.evaluate` round trip, not from the specification's prose: the pair-list encoding of an
 * object is the detail that cost a run, and a test written from the prose would have been written by
 * whoever wrote the bug.
 */
function selfTest() {
  const cases = [
    [
      'a number comes back a number',
      () => {
        deepStrictEqual(valueOf({ type: 'success', result: { type: 'number', value: 2 } }), 2);
      },
    ],
    [
      'an object is a pair list on the wire, and an object here',
      () => {
        const wire = {
          type: 'success',
          result: {
            type: 'object',
            value: [
              ['hash', { type: 'number', value: 4000247205 }],
              ['count', { type: 'number', value: 2000 }],
            ],
          },
        };
        deepStrictEqual(valueOf(wire), { hash: 4000247205, count: 2000 });
      },
    ],
    [
      'an array keeps its order and its null',
      () => {
        const wire = {
          type: 'success',
          result: {
            type: 'array',
            value: [{ type: 'number', value: 1 }, { type: 'string', value: 'a' }, { type: 'null' }],
          },
        };
        deepStrictEqual(valueOf(wire), [1, 'a', null]);
      },
    ],
    [
      'undefined stays undefined, not the string "undefined"',
      () => {
        const wire = {
          type: 'success',
          result: {
            type: 'object',
            value: [['u', { type: 'undefined' }]],
          },
        };
        const value = valueOf(wire);
        deepStrictEqual(value, { u: undefined });
        strictEqual('u' in value, true);
      },
    ],
    [
      'the four numbers JSON cannot carry',
      () => {
        const wire = {
          type: 'success',
          result: {
            type: 'object',
            value: [
              ['nan', { type: 'number', value: 'NaN' }],
              ['neg', { type: 'number', value: '-0' }],
              ['inf', { type: 'number', value: 'Infinity' }],
              ['ninf', { type: 'number', value: '-Infinity' }],
            ],
          },
        };
        const value = valueOf(wire);
        strictEqual(Number.isNaN(value.nan), true);
        strictEqual(Object.is(value.neg, -0), true);
        strictEqual(value.inf, Number.POSITIVE_INFINITY);
        strictEqual(value.ninf, Number.NEGATIVE_INFINITY);
      },
    ],
    [
      'an object with no pairs is an empty object',
      () => {
        deepStrictEqual(valueOf({ type: 'success', result: { type: 'object' } }), {});
      },
    ],
    [
      'a nested pair list inside an array is deserialised too',
      () => {
        const wire = {
          type: 'success',
          result: {
            type: 'object',
            value: [
              [
                'checks',
                {
                  type: 'array',
                  value: [
                    {
                      type: 'object',
                      value: [
                        ['name', { type: 'string', value: 'opfs: delete' }],
                        ['ok', { type: 'boolean', value: true }],
                      ],
                    },
                  ],
                },
              ],
            ],
          },
        };
        deepStrictEqual(valueOf(wire), { checks: [{ name: 'opfs: delete', ok: true }] });
      },
    ],
    [
      'an exception is thrown, not returned as a value',
      () => {
        const wire = {
          type: 'exception',
          realm: 'r',
          exceptionDetails: { text: 'the page threw before it wrote anything' },
        };
        throws(() => valueOf(wire), /threw before it wrote/);
      },
    ],
  ];

  let failed = 0;
  for (const [name, run] of cases) {
    try {
      run();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL  ${name}: ${error.message.split('\n')[0]}`);
    }
  }
  console.log(`\n${cases.length - failed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

// Only when this file is the entry point: `probe-firefox.mjs` importing it must not run the tests,
// and neither must a copy under another name that someone runs directly (a mutation fixture).
const entryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (entryPoint && process.argv.includes('--self-test')) selfTest();
