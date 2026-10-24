/**
 * Does the review page behave like an instrument a person can actually finish?
 *
 * ## Why a browser, when the unit tests already assert the page's shape
 *
 * The unit tests check the markup: that the rubric is present, that the reset control sits outside
 * the section it resets, that the stylesheet does not hide the finish screen. Those are proxies. The
 * defect that reached a person was a *cascade*: `el.done.hidden = false` against `.done{display:none}`
 * -- neither line is wrong on its own, and a structural test can only see them one at a time.
 *
 * The other reason is that the export is scriptable while invisible. The end-to-end test in step 16
 * clicked forty times and read `#a3-json`, which a hidden page still fills. It passed, and the person
 * who actually used the page got a blank screen. **Reading a value is not clicking a button**, and
 * this probe measures what the person sees: `offsetHeight`, not text.
 *
 * ## What is driven
 *
 *   1. reset and undo are visible before the first judgement (they used to exist only at the end)
 *   2. three accepts, then undo: the count goes back and the previous card is shown again
 *   3. undo all the way to zero: the control that says it undoes everything does
 *   4. start over: the export is emptied, not just the screen
 *   5. skip: counted in the progress, absent from the export, and undone by the same button
 *   6. through to the end: the finish screen is **visible**, and the export parses as JSONL
 *
 * `window.confirm` is replaced with `() => true` before the reset click, because a headless dialog
 * would otherwise block the page. That is the only part of the page this script modifies, and it is
 * stated here because a probe that quietly rewrites its subject is measuring something else.
 *
 * Usage, from `packages/cortex-eval` after `pnpm build`:
 *
 *     node test/review-page/probe.mjs
 *     CORTEX_CHROME=/path/to/chrome node test/review-page/probe.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderA3ReviewPage } from '../../dist/review-page.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(HERE, '..', '..');
const RESULT = join(HERE, 'last-run.json');

/** Three cards, so six showings: small enough to read the transcript, big enough to alternate. */
const CARDS = [
  {
    cardId: 'p1',
    source: 'I moved to Berlin in March and I work at Acme on payments.',
    atoms: ['I moved to Berlin in March', 'I work at Acme on payments'],
  },
  {
    cardId: 'p2',
    source: 'The bookshop on the corner reopens next month.',
    atoms: ['The bookshop on the corner reopens next month.'],
  },
  {
    cardId: 'p3',
    source: 'I keep notes on paper and I read on the train.',
    atoms: ['I read on the train.'],
  },
];

function findChrome() {
  if (process.env.CORTEX_CHROME !== undefined) return process.env.CORTEX_CHROME;
  const cache = join(process.env.HOME ?? '/root', '.cache', 'ms-playwright');
  if (existsSync(cache)) {
    for (const entry of readdirSync(cache)) {
      if (!entry.startsWith('chromium-')) continue;
      for (const sub of ['chrome-linux64', 'chrome-linux']) {
        const candidate = join(cache, entry, sub, 'chrome');
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  for (const candidate of ['/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser']) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

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
    });
    if (outcome.exceptionDetails) {
      throw new Error(
        outcome.exceptionDetails.exception?.description ??
          outcome.exceptionDetails.text ??
          'evaluation failed',
      );
    }
    return outcome.result.value;
  }

  close() {
    this.#socket.close();
  }
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

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
        { method: 'PUT' },
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

  return {
    connection,
    async close() {
      connection.close();
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    },
  };
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

async function main() {
  const chrome = findChrome();
  if (chrome === undefined) {
    console.error('no Chromium found: set CORTEX_CHROME to one, or install playwright browsers');
    process.exitCode = 2;
    return;
  }

  const html = renderA3ReviewPage({
    cards: CARDS,
    promptVersion: 'triage-proposer/v2',
    profile: 'probe',
  });

  // Served over loopback rather than opened as file://, because localStorage on a file origin is
  // shared with every other local page and the resume key would collide with an unrelated review.
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port: httpPort } = server.address();
  const origin = `http://127.0.0.1:${httpPort}/`;

  const profile = mkdtempSync(join(tmpdir(), 'cortex-a3-'));
  const browser = await launch({ chrome, profile, port: 9500 + Math.floor(Math.random() * 400) });

  const visible = (selector) =>
    browser.connection.evaluate(
      `(function(){var n=document.querySelector(${JSON.stringify(selector)});` +
        'return n === null ? -1 : n.offsetHeight;})()',
    );
  const progress = () => browser.connection.evaluate('document.getElementById("a3-progress").textContent');
  const tag = () => browser.connection.evaluate('(document.querySelector(".tag")||{}).textContent||""');
  const click = (act) =>
    browser.connection.evaluate(
      `document.querySelector('[data-act=${JSON.stringify(act)}]').click()`,
    );
  const press = (id) => browser.connection.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const exported = () => browser.connection.evaluate('document.getElementById("a3-json").value');

  try {
    await browser.connection.send('Page.navigate', { url: origin });
    await sleep(600);

    check('the run starts on card 1', (await tag()).includes('card 1 of 3'), await tag());
    check(
      'reset and undo are reachable before the first judgement',
      (await visible('#a3-reset')) > 0 && (await visible('#a3-undo')) > 0,
      `reset ${await visible('#a3-reset')}px, undo ${await visible('#a3-undo')}px`,
    );
    check('the finish screen is hidden at the start', (await visible('#a3-done')) === 0);

    await click('accept');
    await click('accept');
    await click('accept');
    check('three accepts are counted', (await progress()).startsWith('3 / 6'), await progress());

    await press('a3-undo');
    check('undo takes one back', (await progress()).startsWith('2 / 6'), await progress());
    check('undo shows that card again', (await tag()).includes('card 2 of 3'), await tag());
    check(
      'undo removes it from the export, not only from the screen',
      (await exported()).split('\n').filter(Boolean).length === 2,
    );

    // A skip is a decision about the instrument: counted, not exported, and undoable.
    await click('skip');
    check('a skip advances the count', (await progress()).startsWith('3 / 6'), await progress());
    check(
      'a skip is not a judgement, so it never reaches the export',
      (await exported()).split('\n').filter(Boolean).length === 2,
    );
    await press('a3-undo');
    check('undo also takes back a skip', (await progress()).startsWith('2 / 6'), await progress());

    // Reset, with the confirm dialog answered the way a person would answer it.
    await browser.connection.evaluate('window.confirm = function () { return true; };');
    await press('a3-reset');
    check('start over returns to card 1', (await tag()).includes('card 1 of 3'), await tag());
    check('start over empties the count', (await progress()).startsWith('0 / 6'), await progress());
    check('start over empties the export too', (await exported()) === '');

    // Through to the end.
    for (let index = 0; index < 6; index += 1) await click('accept');
    check('the finish screen is visible, not merely unhidden', (await visible('#a3-done')) > 0, `${await visible('#a3-done')}px`);
    const lines = (await exported()).split('\n').filter(Boolean);
    check('the export holds one line per judgement', lines.length === 6, `${lines.length} lines`);
    const parsed = lines.map((line) => JSON.parse(line));
    check(
      'every exported line names a card, an arm and a decision',
      parsed.every((row) => row.cardId && (row.arm === 'source' || row.arm === 'atoms') && row.decision),
    );
    const summary = await browser.connection.evaluate(
      'document.getElementById("a3-summary").textContent',
    );
    check('the summary shows both presentations', summary.includes('the sentence') && summary.includes('the atoms'));
  } finally {
    await browser.close();
    server.close();
    rmSync(profile, { recursive: true, force: true });
  }

  const failures = checks.filter((entry) => !entry.ok);
  writeFileSync(RESULT, `${JSON.stringify({ chrome, checks, ok: failures.length === 0 }, null, 2)}\n`);
  console.log(`\n${checks.length - failures.length} / ${checks.length} checks passed`);
  if (failures.length > 0) process.exitCode = 1;
}

await main();
