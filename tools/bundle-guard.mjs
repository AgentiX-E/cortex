#!/usr/bin/env node
/**
 * Bundle guard: what the published browser subpaths cost, and what a real bundler does with them.
 *
 * ## Why the entry guard is not enough
 *
 * `tools/entry-guard.mjs` walks `src/` as text and follows relative specifiers itself. That answers
 * "can this file ever reach a native module", and it answers it well. It cannot answer the three
 * questions a consumer's build asks:
 *
 *   1. **Does the subpath resolve?** `exports` maps `./opfs` to `dist/browser/opfs.js`, a file that
 *      exists only after `tsc`. The source walk never looks at that path, so a broken `files` list,
 *      a stale `dist`, or a typo in `exports` passes it and fails in the consumer's build.
 *   2. **Does a browser bundle of it succeed?** esbuild with `platform: 'browser'` refuses a `node:`
 *      builtin that arrives *through a dependency*, which the regex list cannot see because the list
 *      is applied to first-party sources only.
 *   3. **What does the user pay?** The walk's budget is source bytes. The number a user pays is the
 *      gzipped bundle, roughly six times smaller, and it is the only number that should be quoted.
 *
 * ## The fourth question, which is the one this repository got wrong
 *
 * `openOpfsStorage` defaults its worker to `new URL('./opfs-worker.js', import.meta.url)` and its
 * docstring said `import.meta.url` "is rewritten by Vite, webpack 5 and esbuild". Two of those three
 * do rewrite it. **esbuild does not**: it has no worker support, so `new URL(specifier, import.meta.url)`
 * survives into the output verbatim, and the emitted `.js` then asks for a file the bundler never
 * wrote. A consumer following the docstring gets a worker that 404s, `openOpfsStorage` throws "the
 * storage worker failed to start", and `openBrowserStorage` falls through to IndexedDB -- the product
 * works, so nobody notices that the tier they paid for is gone.
 *
 * This guard therefore *reports* the worker assets instead of asserting them away: for every
 * `new URL(x, import.meta.url)` in the emitted bundle it prints whether the bundler emitted `x`.
 * `emitted: false` is the true reading for esbuild and the reason the option exists. Turning that
 * into a pass/fail would either forbid a working design or bless a broken one; naming it lets the
 * contract be written correctly and lets the next bundler be measured rather than assumed.
 *
 * ## Usage
 *
 *   node tools/bundle-guard.mjs                     # check, against the recorded baseline
 *   node tools/bundle-guard.mjs --write             # accept the current sizes as the baseline
 *   node tools/bundle-guard.mjs --self-test         # asserts the guard can fail
 *   node tools/bundle-guard.mjs --json              # the reading, for a test to assert on
 *
 * Exit status is 1 when a subpath fails to resolve or bundle, reaches a forbidden module, or grows
 * past its recorded budget plus the bundler-upgrade allowance.
 */

import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const BASELINE = join(HERE, 'bundle-guard-baseline.json');

/** Default package. A second package can be guarded by pointing `--package` at it. */
const DEFAULT_PACKAGE = 'packages/cortex-storage';

/**
 * Modules no browser subpath may reach.
 *
 * The bundler already fails on `node:` for `platform: 'browser'`, so this list is about *naming*
 * the failure: "could not resolve node:fs" is the message, and the path that pulled it in is what a
 * reader needs. The native addons are not caught by the bundler at all -- they resolve fine from
 * `node_modules` and simply do not work in a browser -- so for those this list is the only check.
 */
const FORBIDDEN = [/^better-sqlite3$/, /^pg$/, /^pg-/, /^node:/];

/**
 * The platform each subpath is built for, declared rather than discovered.
 *
 * Deriving it from "does the browser build succeed" would make the guard circular: a Node backend
 * that accidentally became portable would silently join the browser surface, and the day it stops
 * being portable the guard would report a *new* failure in a file nobody touched. So the claim is
 * data here, `exports` is checked against it, and an unclassified subpath fails the run -- a new
 * backend cannot arrive without someone writing down which platform it belongs to.
 *
 * `./pg` is worth reading twice. It bundles for the browser because its driver arrives as an
 * injected `Pool` and the `pg` import is type-only, so the emitted adapter is 1 KB with no client in
 * it. That makes it *portable*, not *usable in a browser*: a PostgreSQL connection needs a socket.
 * The distinction is why the manifest below says `node` and the bundle still succeeds.
 */
const TARGETS = {
  '.': 'browser',
  './opfs': 'browser',
  './opfs/worker': 'browser',
  './idb': 'browser',
  './sqlite': 'node',
  './pg': 'node',
};

/**
 * Allowance for a bundler upgrade.
 *
 * esbuild's minifier is deterministic for a fixed version and input, so a re-run must reproduce the
 * baseline byte for byte. A *different* version legitimately shifts output by a fraction of a percent
 * from mangling and from the helper preamble. Two percent is above that and far below any accidental
 * dependency being pulled in (the smallest of those, `pg`, is 40 KB gzipped -- two orders of
 * magnitude above this window), so the window cannot hide a regression.
 */
const UPGRADE_ALLOWANCE = 0.02;

function parse(argv) {
  const options = {
    packageDir: DEFAULT_PACKAGE,
    write: false,
    selfTest: false,
    json: false,
    baseline: BASELINE,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--package') options.packageDir = argv[++index];
    else if (arg === '--baseline') options.baseline = resolve(argv[++index]);
    else if (arg === '--write') options.write = true;
    else if (arg === '--self-test') options.selfTest = true;
    else if (arg === '--json') options.json = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

/** The subpaths a consumer can import, read from `exports` so a new one is guarded on arrival. */
function subpathsOf(packageDir) {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const rows = [];
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    const entry = typeof target === 'string' ? target : (target.import ?? target.default);
    if (typeof entry !== 'string') continue;
    rows.push({ subpath, file: join(packageDir, entry) });
  }
  return rows.sort((a, b) => (a.subpath < b.subpath ? -1 : 1));
}

/**
 * Bundle one subpath for the browser and collect what a consumer would experience.
 *
 * `write: false` keeps the run read-only; the bytes are returned in memory and gzipped there, which
 * is also what makes this cheap enough to run on every `pnpm check`.
 */
async function bundleOne(esbuild, row) {
  const platform = TARGETS[row.subpath] ?? 'browser';
  const outdir = mkdtempSync(join(tmpdir(), 'cortex-bundle-'));
  try {
    const result = await esbuild.build({
      entryPoints: [{ in: row.file, out: 'bundle' }],
      bundle: true,
      write: false,
      outdir,
      format: 'esm',
      platform,
      target: platform === 'browser' ? 'es2022' : 'node22',
      minify: true,
      sourcemap: false,
      metafile: true,
      logLevel: 'silent',
      // The condition the target platform uses. Without this the bundler would take the `import`
      // condition of every dependency too, including the ones that only work in Node.
      conditions: platform === 'browser' ? ['browser', 'import'] : ['node', 'import'],
      mainFields: platform === 'browser' ? ['browser', 'module', 'main'] : ['module', 'main'],
    });
    const output = result.outputFiles.find((file) => file.path.endsWith('.js'));
    const text = output ? output.text : '';
    const gzip = output ? gzipSync(output.contents).length : 0;
    const inputs = Object.keys(result.metafile.inputs);
    const forbidden = inputs
      .map((input) => bareNameOf(input))
      .filter((name) => name !== null && FORBIDDEN.some((pattern) => pattern.test(name)));
    return {
      subpath: row.subpath,
      platform,
      ok: true,
      errors: [],
      bytes: output ? output.contents.length : 0,
      gzip,
      inputs: inputs.length,
      forbidden: [...new Set(forbidden)].sort(),
      workerAssets: workerAssetsIn(text, result.outputFiles),
    };
  } catch (error) {
    return {
      subpath: row.subpath,
      platform,
      ok: false,
      errors: (error.errors ?? [{ text: error.message }]).map(
        (item) => `${item.text}${item.location ? ` @ ${item.location.file}` : ''}`,
      ),
      bytes: 0,
      gzip: 0,
      inputs: 0,
      forbidden: [],
      workerAssets: [],
    };
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

/**
 * The bare module name behind a metafile input path, or `null` for a first-party file.
 *
 * `node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/index.js` has to be read as `pg`, not as the
 * store path, or every workspace dependency would be misnamed and the list would match nothing.
 */
function bareNameOf(input) {
  const marker = input.lastIndexOf('node_modules/');
  if (marker === -1) return null;
  const rest = input.slice(marker + 'node_modules/'.length);
  if (rest.startsWith('@')) {
    const [scope, name] = rest.split('/');
    return `${scope}/${name}`;
  }
  return rest.split('/')[0] ?? null;
}

/**
 * Every `new URL(<literal>, import.meta.url)` in the bundle, and whether the bundler emitted it.
 *
 * A worker reference is the one asset a bundle cannot inline: the constructor takes a URL, the
 * bundler has no idea a second program is behind it, and the failure is a 404 at runtime rather
 * than a build error. Reporting `emitted: false` is the whole point -- it is a fact about the
 * bundler, not a defect in the package, and the package's answer is the `workerUrl` option.
 */
function workerAssetsIn(text, outputFiles) {
  const pattern = /new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g;
  const emitted = new Set(
    outputFiles
      .map((file) => file.path)
      .filter((path) => !path.endsWith('.js'))
      .map((path) => path.split('/').pop()),
  );
  const rows = [];
  for (const match of text.matchAll(pattern)) {
    const specifier = match[1];
    rows.push({ specifier, emitted: emitted.has(specifier.split('/').pop()) });
  }
  return rows;
}

function readBaseline(path = BASELINE) {
  if (!existsSync(path)) return { entries: {} };
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeBaseline(reading, path = BASELINE) {
  const entries = {};
  for (const row of reading.entries) {
    if (!row.ok) continue;
    entries[row.subpath] = { gzip: row.gzip, bytes: row.bytes };
  }
  writeFileSync(
    path,
    `${JSON.stringify({ note: 'Written by tools/bundle-guard.mjs --write. Byte counts are gzipped esbuild output for platform: browser; a re-run must reproduce them.', esbuild: reading.esbuild, entries }, null, 2)}\n`,
  );
}

/** Compare a reading against the baseline and name what moved. */
function budgetVerdicts(reading, baseline) {
  const verdicts = [];
  for (const row of reading.entries) {
    const recorded = baseline.entries?.[row.subpath];
    if (!row.ok || recorded === undefined) {
      verdicts.push({
        subpath: row.subpath,
        verdict: recorded === undefined ? 'unbaselined' : 'unreadable',
      });
      continue;
    }
    const limit = Math.floor(recorded.gzip * (1 + UPGRADE_ALLOWANCE));
    const delta = row.gzip - recorded.gzip;
    verdicts.push({
      subpath: row.subpath,
      verdict: row.gzip > limit ? 'over' : 'within',
      baseline: recorded.gzip,
      measured: row.gzip,
      delta,
      limit,
    });
  }
  return verdicts;
}

/**
 * Self-test: three cases that must fail, plus the control that must pass.
 *
 * The control is the one that matters. A guard whose subject is "the browser entries" and which
 * reports nothing is indistinguishable from a guard that walks nothing, so `./idb` is bundled here
 * and its byte count is asserted to be positive. `./sqlite` reaching `better-sqlite3` is the other
 * control: it proves the forbidden-name extraction sees a native module when one is present.
 */
async function selfTest(esbuild) {
  const dir = mkdtempSync(join(tmpdir(), 'cortex-bundle-selftest-'));
  const lines = [];
  let failures = 0;
  const expect = (label, condition) => {
    lines.push(`self-test: ${label} -- ${condition ? 'ok' : 'FAILED'}`);
    if (!condition) failures += 1;
  };
  try {
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'good.js'), 'export const value = 1;\n');
    writeFileSync(
      join(dir, 'builtin.js'),
      "import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n",
    );
    writeFileSync(
      join(dir, 'native.js'),
      "import Database from 'better-sqlite3';\nexport const x = Database;\n",
    );
    const fakeNative = join(dir, 'node_modules', 'better-sqlite3');
    mkdirSync(fakeNative, { recursive: true });
    writeFileSync(
      join(fakeNative, 'package.json'),
      JSON.stringify({ name: 'better-sqlite3', main: 'index.js' }),
    );
    writeFileSync(join(fakeNative, 'index.js'), 'export default function Database() {}\n');

    const clean = await bundleOne(esbuild, { subpath: '.', file: join(dir, 'good.js') });
    expect('a browser-clean entry bundles', clean.ok && clean.bytes > 0);

    const builtin = await bundleOne(esbuild, {
      subpath: './builtin',
      file: join(dir, 'builtin.js'),
    });
    expect('a node: builtin is refused by the browser platform', !builtin.ok);

    const native = await bundleOne(esbuild, { subpath: './native', file: join(dir, 'native.js') });
    expect(
      'a native addon that resolves is named rather than bundled silently',
      native.ok && native.forbidden.includes('better-sqlite3'),
    );

    const missing = await bundleOne(esbuild, {
      subpath: './missing',
      file: join(dir, 'absent.js'),
    });
    expect('a subpath whose target file does not exist is refused', !missing.ok);

    const worker = await bundleOne(esbuild, { subpath: './worker', file: join(dir, 'worker.js') });
    expect(
      'an unreferenced worker file is reported as not emitted',
      worker.workerAssets.length === 0,
    );

    writeFileSync(
      join(dir, 'spawn.js'),
      "export const go = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });\n",
    );
    writeFileSync(join(dir, 'worker.js'), 'self.onmessage = () => {};\n');
    const spawned = await bundleOne(esbuild, { subpath: './spawn', file: join(dir, 'spawn.js') });
    expect(
      'a worker URL survives the bundle and is reported as not emitted',
      spawned.ok &&
        spawned.workerAssets.length === 1 &&
        spawned.workerAssets[0].specifier === './worker.js' &&
        spawned.workerAssets[0].emitted === false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { lines, failures };
}

async function main() {
  const options = parse(process.argv.slice(2));
  const esbuild = await import('esbuild');
  const version = JSON.parse(
    readFileSync(join(REPO, 'node_modules', 'esbuild', 'package.json'), 'utf8'),
  ).version;

  if (options.selfTest) {
    const result = await selfTest(esbuild);
    for (const line of result.lines) console.log(line);
    process.exit(result.failures === 0 ? 0 : 1);
  }

  const packageDir = resolve(REPO, options.packageDir);
  const rows = subpathsOf(packageDir);
  if (rows.length === 0) {
    console.error(`${options.packageDir}: no exports to guard, which cannot be a pass`);
    process.exit(1);
  }
  const unclassified = rows.filter((row) => TARGETS[row.subpath] === undefined);
  if (unclassified.length > 0) {
    console.error(
      `${options.packageDir}: ${unclassified.map((row) => row.subpath).join(', ')} carries no declared platform, so nobody has said what building it means`,
    );
    process.exit(1);
  }

  const entries = [];
  for (const row of rows) entries.push(await bundleOne(esbuild, row));
  const reading = { package: options.packageDir, esbuild: version, entries };
  const baseline = readBaseline(options.baseline);

  if (options.write) {
    writeBaseline(reading, options.baseline);
    console.log(
      `wrote ${relative(REPO, options.baseline)} for ${entries.length} subpath(s), esbuild ${version}`,
    );
    process.exit(0);
  }

  const verdicts = budgetVerdicts(reading, baseline);
  const output = { ...reading, verdicts };
  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(
      `${options.packageDir} (esbuild ${version}, minified + gzip, per declared platform)`,
    );
    for (const row of entries) {
      const browser = row.platform === 'browser';
      const verdict = verdicts.find((item) => item.subpath === row.subpath);
      const size =
        row.ok && verdict?.baseline !== undefined
          ? `${row.gzip} B gzip (baseline ${verdict.baseline}, ${verdict.delta >= 0 ? '+' : ''}${verdict.delta})`
          : row.ok
            ? `${row.gzip} B gzip`
            : 'unreadable';
      console.log(
        `  ${row.subpath.padEnd(9)} ${row.platform.padEnd(7)} ${row.ok ? 'bundles' : 'FAILED '}  ${size}`,
      );
      for (const error of row.errors) console.log(`      error: ${error}`);
      if (row.ok && row.forbidden.length > 0) {
        // A node target is expected to reach these; saying so out loud is what keeps the browser
        // rows' silence meaningful.
        console.log(
          `      reaches: ${row.forbidden.join(', ')} (${browser ? 'FORBIDDEN for a browser entry' : 'expected on this platform'})`,
        );
      }
      if (row.ok && row.workerAssets.length > 0) {
        for (const asset of row.workerAssets) {
          console.log(
            `      worker: ${asset.specifier} ${asset.emitted ? 'emitted by the bundler' : 'NOT emitted -- the consumer must copy it or pass workerUrl'}`,
          );
        }
      }
      if (verdict?.verdict === 'over') {
        console.log(
          `      over budget: ${row.gzip} > ${verdict.limit} (baseline ${verdict.baseline} + 2%)`,
        );
      }
    }
  }

  const failed = entries.some((row) => !row.ok);
  const unbudgeted = verdicts.filter((item) => item.verdict === 'unbaselined');
  const over = verdicts.filter((item) => item.verdict === 'over');
  const violations = entries.filter(
    (row) => row.ok && row.platform === 'browser' && row.forbidden.length > 0,
  );

  if (!options.json) {
    if (unbudgeted.length > 0 && !failed) {
      console.log(
        `\nno baseline for ${unbudgeted.map((item) => item.subpath).join(', ')}: run --write`,
      );
    }
    if (violations.length > 0) {
      console.log(
        `\nspecifiers a browser entry must not reach: ${violations.map((row) => `${row.subpath} -> ${row.forbidden.join(', ')}`).join('; ')}`,
      );
    }
    const verdict = failed || over.length > 0 || violations.length > 0 ? 'FAIL' : 'PASS';
    console.log(`\n${verdict}`);
  }
  process.exit(failed || over.length > 0 || violations.length > 0 ? 1 : 0);
}

await main();
