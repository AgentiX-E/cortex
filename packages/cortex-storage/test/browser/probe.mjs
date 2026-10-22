/**
 * Run the browser suite against a real Chromium, twice, across a browser restart.
 *
 * ## Why not Playwright
 *
 * The dependency would be the only reason this package needs a browser automation library, and the
 * protocol it speaks is small: create a target, evaluate an expression, wait. Chrome DevTools
 * Protocol over the WebSocket that Node already has does that in a page of code, with no version
 * coupling to whichever Chromium the host happens to have installed.
 *
 * ## What only this run can answer
 *
 * The Node suites cover the SQL, the protocol and the tiering logic against a real engine. They
 * cannot cover the worker, the SAH pool, IndexedDB, or the thing a user actually cares about: that
 * the rows are still there after the browser closes. So this probe does two launches on **one**
 * user-data-dir, writes a deterministic payload in the first, and compares a digest in the second.
 *
 * The origin must be identical across launches or OPFS is a different origin's storage, so the
 * server is started once and left running; picking a new port for the second launch would silently
 * test an empty database and pass.
 *
 * ## Usage
 *
 *   node test/browser/probe.mjs               # 2,000 rows
 *   CORTEX_ROWS=10000 node test/browser/probe.mjs
 *   CORTEX_CHROME=/path/to/chrome node test/browser/probe.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveDist } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(HERE, '..', '..');
const ROWS = Number(process.env.CORTEX_ROWS ?? 2_000);
const RESULTS = join(PACKAGE, 'test', 'browser', 'last-run.json');

/** Find a Chromium. The playwright cache is checked first because CI images usually have one. */
function findChrome() {
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
class Connection {
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

async function sleep(ms) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** Launch Chrome on a profile, wait for its debugger, and connect to a fresh tab. */
async function launch({ chrome, profile, port }) {
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

async function main() {
  const chrome = findChrome();
  if (chrome === undefined) {
    // Not a silent skip: without a browser this suite has measured nothing, and saying so is the
    // only honest outcome. The exit status is what a CI job reads.
    console.error('no Chromium found: set CORTEX_CHROME to one, or install playwright browsers');
    process.exitCode = 2;
    return;
  }

  const { server, origin } = await serveDist();
  const profile = mkdtempSync(join(tmpdir(), 'cortex-opfs-'));
  const debugPort = 9500 + Math.floor(Math.random() * 400);
  const report = { chrome, origin, rows: ROWS, phases: {} };

  try {
    // ---- launch 1: the matrix, then a deterministic write ----
    const first = await launch({ chrome, profile, port: debugPort });
    try {
      await first.connection.send('Page.navigate', { url: `${origin}/` });
      await waitReady(first.connection);

      const matrix = await first.connection.evaluate('__run({ mode: "matrix" })');
      report.phases.matrix = matrix;

      const write = await first.connection.evaluate(`__run({ mode: "write", rows: ${ROWS} })`);
      report.phases.write = write;
    } finally {
      await first.close();
    }

    // ---- launch 2: same profile, same origin, read it back ----
    const second = await launch({ chrome, profile, port: debugPort });
    try {
      await second.connection.send('Page.navigate', { url: `${origin}/` });
      await waitReady(second.connection);

      const expected = report.phases.write.digest.hash;
      const read = await second.connection.evaluate(
        `__run({ mode: "read", rows: ${ROWS}, expected: ${expected} })`,
      );
      report.phases.read = read;
    } finally {
      await second.close();
    }
  } finally {
    server.close();
    // Best effort, and explicitly so: a temporary directory that outlives the run is harmless, while
    // a cleanup error raised here would replace the suite's actual result with a filesystem error
    // from `/tmp`. The path is printed instead, so a leak is visible rather than silent.
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      console.error(
        `note: could not remove the temporary profile ${profile}: ${error.code ?? error}`,
      );
    }
  }

  const checks = [...(report.phases.matrix?.checks ?? [])];
  const digestMatches = report.phases.read?.matches === true;
  checks.push({
    name: 'rows survive a browser restart with an identical digest',
    ok: digestMatches,
    detail: `wrote ${report.phases.write?.digest.hash}, read ${report.phases.read?.digest.hash} (${report.phases.read?.digest.count} rows)`,
  });

  const failures = checks.filter((check) => !check.ok);
  report.note =
    'One run. The throughput numbers move by ~15% between runs on the same host, so the documents ' +
    "cite a range across runs rather than this file's single sample; the digest and the check " +
    'count are stable.';
  report.summary = {
    checks: checks.length,
    passed: checks.length - failures.length,
    failed: failures.length,
    digestMatches,
  };

  mkdirSync(dirname(RESULTS), { recursive: true });
  writeFileSync(RESULTS, `${JSON.stringify(report, null, 2)}\n`);

  for (const check of checks) {
    console.log(
      `${check.ok ? 'ok  ' : 'FAIL'} ${check.name}${check.detail ? ` -- ${check.detail}` : ''}`,
    );
  }
  const write = report.phases.write;
  const read = report.phases.read;
  console.log(
    `\n${write.rows} rows on ${write.tier} (${write.engine}): ` +
      `one commit per row ${write.writeMs.toFixed(0)} ms (${Math.round(write.rowsPerSecond)} rows/s), ` +
      `one transaction ${write.transactionWriteMs.toFixed(0)} ms ` +
      `(${Math.round(write.transactionRowsPerSecond)} rows/s), ` +
      `read ${read.readMs.toFixed(1)} ms, digest ${write.digest.hash} == ${read.digest.hash}`,
  );
  console.log(`${report.summary.passed}/${report.summary.checks} checks passed -> ${RESULTS}`);

  if (failures.length > 0) process.exitCode = 1;
}

/** Wait for the page's modules to finish evaluating; a failed import leaves this false forever. */
async function waitReady(connection) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ready = await connection.evaluate('window.__ready === true').catch(() => false);
    if (ready === true) return;
    await sleep(100);
  }
  const log = await connection.evaluate('document.body.innerText').catch(() => '');
  throw new Error(`the page never became ready: ${JSON.stringify(log).slice(0, 400)}`);
}

await main();
