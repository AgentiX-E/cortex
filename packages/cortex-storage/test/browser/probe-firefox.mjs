/**
 * Run the browser suite against a real Firefox, twice, across a browser restart.
 *
 * ## Why this file exists at all
 *
 * `§10.2` gate 2 says the browser tier's persistence reproduces on **at least two engines**. The
 * thing that can fail is `FileSystemSyncAccessHandle`, and a second Chromium profile cannot exercise
 * a different implementation of it: same VFS, same SQLite build, same bug surface. Firefox 159 is
 * the second implementation and the second protocol.
 *
 * ## What is engine-specific here, and what deliberately is not
 *
 * Only `open(origin)` is. The matrix, the deterministic write, the restart, the read, the digest
 * comparison and the 24th check all come from `restart-suite.mjs`, so the two runs are comparable by
 * construction rather than by discipline. Read that module first if the reading looks wrong: the
 * suite is where a phase could be missing, and this file is where a browser could be missing.
 *
 * ## The trap
 *
 * Firefox prints `WebDriver BiDi listening on ws://127.0.0.1:PORT` and answers `200 OK` with an
 * `httpd.js` page to a handshake at that URL. The upgrade path is `/session`, one segment down. See
 * `bidi.mjs`, which documents it where the URL is built.
 *
 * ## Usage
 *
 *   pnpm --filter @cortex/storage exec node test/browser/probe-firefox.mjs
 *   CORTEX_ROWS=10000 node test/browser/probe-firefox.mjs
 *   CORTEX_FIREFOX=/path/to/firefox node test/browser/probe-firefox.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFirefox, launchFirefox, waitForReady } from './bidi.mjs';
import { printRestartSuite, runRestartSuite } from './restart-suite.mjs';
import { serveDist } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(HERE, '..', '..');
const ROWS = Number(process.env.CORTEX_ROWS ?? 2_000);
const RESULTS = join(PACKAGE, 'test', 'browser', 'last-run-firefox.json');

const NOTE =
  'One run. The throughput numbers are engine surface, not a criterion: they are cited as a range ' +
  'across runs and never compared with Chromium. The tier, the check count, the check names and ' +
  'the digest are what this file is for.';

async function main() {
  const firefox = findFirefox();
  if (firefox === undefined) {
    // Same honesty as the Chromium probe: without the engine there is no reading, and the exit
    // status is the only part a caller can act on. 2 means "not measured", not "failed".
    console.error('no Firefox found: set CORTEX_FIREFOX to one, or install /opt/firefox');
    process.exitCode = 2;
    return;
  }

  const { server, origin } = await serveDist();
  const profile = mkdtempSync(join(tmpdir(), 'cortex-firefox-'));
  const debugPort = 9900 + Math.floor(Math.random() * 400);

  /** The only engine-specific part: launch on the shared profile, navigate, wait for the modules. */
  const open = async (suiteOrigin) => {
    const launched = await launchFirefox({ firefox, profile, port: debugPort });
    try {
      await launched.connection.navigate(`${suiteOrigin}/`);
      await waitForReady(launched.connection);
    } catch (error) {
      await launched.close();
      throw error;
    }
    return {
      evaluate: (expression) => launched.connection.evaluate(expression),
      close: () => launched.close(),
    };
  };

  let report;
  try {
    report = await runRestartSuite({ engine: 'firefox', rows: ROWS, origin, open, note: NOTE });
  } finally {
    server.close();
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      console.error(
        `note: could not remove the temporary profile ${profile}: ${error.code ?? error}`,
      );
    }
  }

  const record = { firefox, ...report };
  mkdirSync(dirname(RESULTS), { recursive: true });
  writeFileSync(RESULTS, `${JSON.stringify(record, null, 2)}\n`);

  printRestartSuite(record, RESULTS);
  if (record.failures.length > 0) process.exitCode = 1;
}

await main();
