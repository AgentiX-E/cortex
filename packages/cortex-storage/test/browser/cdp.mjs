/**
 * The Chrome DevTools Protocol client the browser suites share: find a browser, launch it, talk to it.
 *
 * ## Why this exists as a module and not twice
 *
 * There are two suites: `probe.mjs` runs the shipped `dist/` across a browser restart, and
 * `bundle-probe.mjs` runs an *esbuild output* of the same package to check that a consumer's build
 * keeps working. They differ in what they load and in what they assert; they do not differ in how a
 * headless Chromium is started, how a tab is opened, or how a page is polled until its modules have
 * evaluated. A second copy of the launcher is how two suites end up disagreeing about the one thing
 * they must agree on -- the origin -- and an origin disagreement silently gives OPFS a different
 * storage area, which looks like a persistence bug.
 *
 * ## Why not Playwright
 *
 * The protocol surface used here is small: create a target, evaluate an expression, wait. A browser
 * automation dependency would be the only reason this package needs one, and it would pin the suite
 * to whichever Chromium the host happens to have. `Connection` speaks JSON over the WebSocket that
 * Node already provides.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Find a Chromium. The playwright cache is checked first because CI images usually have one. */
export function findChrome() {
  if (process.env.CORTEX_CHROME !== undefined) return process.env.CORTEX_CHROME;
  const cache = join(process.env.HOME ?? '/root', '.cache', 'ms-playwright');
  if (existsSync(cache)) {
    for (const entry of readdirSync(cache)) {
      if (!entry.startsWith('chromium-')) continue;
      const candidate = join(cache, entry, 'chrome-linux64', 'chrome');
      if (existsSync(candidate)) return candidate;
      const other = join(cache, entry, 'chrome-linux', 'chrome');
      if (existsSync(other)) return other;
    }
  }
  for (const candidate of [
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** A CDP connection to one target. */
export class Connection {
  #socket;
  #nextId = 1;
  #pending = new Map();

  static async open(wsUrl) {
    const connection = new Connection();
    connection.#socket = new WebSocket(wsUrl);
    await new Promise((resolveOpen, rejectOpen) => {
      connection.#socket.addEventListener('open', () => resolveOpen());
      connection.#socket.addEventListener('error', () =>
        rejectOpen(new Error(`cannot connect to ${wsUrl}`)),
      );
    });
    connection.#socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const entry = connection.#pending.get(message.id);
      if (entry === undefined) return;
      connection.#pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
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

  async evaluate(expression) {
    const outcome = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 300_000,
    });
    if (outcome.exceptionDetails) {
      const description =
        outcome.exceptionDetails.exception?.description ??
        outcome.exceptionDetails.text ??
        'evaluation failed';
      throw new Error(description);
    }
    return outcome.result.value;
  }

  close() {
    this.#socket.close();
  }
}

export async function sleep(ms) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** Launch Chrome on a profile, wait for its debugger, and connect to a fresh tab. */
export async function launch({ chrome, profile, port }) {
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      'about:blank',
    ],
    // Detached so the whole process *group* can be signalled. Chrome's renderers and zygote are
    // separate processes that keep the profile directory busy; killing only the parent leaves them
    // writing to it, and the next launch then reads a half-written profile.
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  const deadline = Date.now() + 30_000;
  let target;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`,
        {
          method: 'PUT',
        },
      );
      if (response.ok) {
        target = await response.json();
        break;
      }
    } catch {
      // Not listening yet.
    }
    await sleep(200);
  }

  if (target === undefined) {
    child.kill('SIGKILL');
    throw new Error(`chrome did not expose a debugger on ${port}. stderr: ${stderr.slice(-800)}`);
  }

  const connection = await Connection.open(target.webSocketDebuggerUrl);
  await connection.send('Page.enable');
  await connection.send('Runtime.enable');

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
      connection.close();
      signal('SIGTERM');
      const exited = await new Promise((resolveExit) => {
        if (child.exitCode !== null) return resolveExit(true);
        const timer = setTimeout(() => resolveExit(false), 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolveExit(true);
        });
      });
      // Reported rather than swallowed: a profile left behind is harmless, but a launcher that
      // believes it closed a browser that is still running is how the next launch gets a locked
      // profile and the run fails for a reason that has nothing to do with storage.
      if (!exited) signal('SIGKILL');
    },
  };
}

/** Wait for the page's modules to finish evaluating; a failed import leaves this false forever. */
export async function waitReady(connection) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ready = await connection.evaluate('window.__ready === true').catch(() => false);
    if (ready === true) return;
    await sleep(100);
  }
  const log = await connection.evaluate('document.body.innerText').catch(() => '');
  throw new Error(`the page never became ready: ${JSON.stringify(log).slice(0, 400)}`);
}
