/**
 * Bundle probe: the package after a consumer's bundler, in a real Chromium.
 *
 * ## What the browser suite's own probe cannot answer
 *
 * `probe.mjs` loads `dist/browser/opfs.js` as a module. That is the package *as published*, and it is
 * not how anyone consumes it: consumers bundle, and a bundle relocates the module. The one thing that
 * relocation breaks is the OPFS worker's default URL -- `new URL('./opfs-worker.js', import.meta.url)`
 * names a file the bundler never emitted -- and the package's docstring used to assert the opposite,
 * naming esbuild as one of the three bundlers that rewrite it. esbuild does not.
 *
 * So this suite builds the package with esbuild twice: once as the consumer's main entry, once as the
 * `./opfs/worker` second entry. Then it runs four checks in the browser:
 *
 *   1. the default worker URL **fails**, with a message that names the worker (this is the claim the
 *      docstring made, measured);
 *   2. an explicit `workerUrl` opens the OPFS tier;
 *   3. `openBrowserStorage` picks OPFS rather than falling back to IndexedDB when it is given one;
 *   4. bytes survive a write and read through the bundled worker.
 *
 * Check 1 is the reason the file exists. It would be easy to write only checks 2-4, and then the
 * documented workaround would be verified while the default silently stayed broken.
 *
 * ## Usage
 *
 *   node test/browser/bundle-probe.mjs
 *   CORTEX_ROWS=1000 node test/browser/bundle-probe.mjs
 *   CORTEX_CHROME=/path/to/chrome node test/browser/bundle-probe.mjs
 */
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findChrome, launch, waitReady } from './cdp.mjs';
import { serveDist } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(HERE, '..', '..');
const ROWS = Number(process.env.CORTEX_ROWS ?? 200);
const RESULTS = join(PACKAGE, 'test', 'browser', 'bundle-run.json');

/**
 * Bundle the two entries a consumer needs.
 *
 * `splitting: false` is deliberate: a shared chunk between the main bundle and the worker would be a
 * third file to serve, and the question here is whether *two* entries suffice. If code splitting ever
 * becomes necessary, this suite fails to open the tier and says so, which is the right way to learn it.
 */
async function buildEntries(outdir) {
  const shared = {
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: false,
    sourcemap: false,
    splitting: false,
    metafile: true,
    logLevel: 'silent',
    outdir,
  };
  const main = await build({
    ...shared,
    entryPoints: [{ in: join(PACKAGE, 'dist', 'browser', 'opfs.js'), out: 'main' }],
  });
  const worker = await build({
    ...shared,
    entryPoints: [{ in: join(PACKAGE, 'dist', 'browser', 'opfs-worker.js'), out: 'worker' }],
  });
  return {
    main: Object.keys(main.metafile.outputs)[0],
    worker: Object.keys(worker.metafile.outputs)[0],
    mainInputs: Object.keys(main.metafile.inputs).length,
    workerInputs: Object.keys(worker.metafile.inputs).length,
  };
}

async function main() {
  const chrome = findChrome();
  if (chrome === undefined) {
    console.error('no Chromium found: set CORTEX_CHROME to one, or install playwright browsers');
    process.exitCode = 2;
    return;
  }

  // The bundle page lives in this directory and the server already serves it; the generated files
  // go into a temporary directory mounted at `/bundle/` so nothing is written into the repository.
  const outdir = mkdtempSync(join(tmpdir(), 'cortex-bundle-'));
  const built = await buildEntries(outdir);
  const { server, origin } = await serveDist(0, [{ prefix: '/bundle/', dir: outdir }]);
  const profile = mkdtempSync(join(tmpdir(), 'cortex-bundle-profile-'));
  const debugPort = 9900 + Math.floor(Math.random() * 400);
  const report = {
    chrome,
    origin,
    rows: ROWS,
    built: {
      main: built.main.split('/').pop(),
      worker: built.worker.split('/').pop(),
      mainInputs: built.mainInputs,
      workerInputs: built.workerInputs,
    },
  };

  try {
    const first = await launch({ chrome, profile, port: debugPort });
    try {
      await first.connection.send('Page.navigate', { url: `${origin}/bundle-page.html` });
      await waitReady(first.connection);
      const run = await first.connection.evaluate(`__run({ rows: ${ROWS} })`);
      report.checks = run.checks;
      report.facts = run.facts;
    } finally {
      await first.close();
    }
  } finally {
    server.close();
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      console.error(
        `note: could not remove the temporary profile ${profile}: ${error.code ?? error}`,
      );
    }
    rmSync(outdir, { recursive: true, force: true });
  }

  const checks = report.checks ?? [];
  const failures = checks.filter((check) => !check.ok);
  report.summary = {
    checks: checks.length,
    passed: checks.length - failures.length,
    failed: failures.length,
    defaultWorkerRefused: report.facts?.defaultWorkerError != null,
  };
  report.note =
    'One run, one Chromium. The failure text in check 1 is the product behaviour the docstring ' +
    'used to deny; it is quoted rather than paraphrased so a change in the wording is visible.';

  mkdirSync(dirname(RESULTS), { recursive: true });
  writeFileSync(RESULTS, `${JSON.stringify(report, null, 2)}\n`);

  for (const check of checks) {
    console.log(
      `${check.ok ? 'ok  ' : 'FAIL'} ${check.name}${check.detail ? ` -- ${check.detail}` : ''}`,
    );
  }
  console.log(
    `\n${report.summary.passed}/${report.summary.checks} checks passed -> ${RESULTS}\n` +
      `bundle: main ${built.mainInputs} input(s), worker ${built.workerInputs} input(s)`,
  );
  if (failures.length > 0) process.exitCode = 1;
}

await main();
