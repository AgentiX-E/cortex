#!/usr/bin/env node
/**
 * Entry guard: what a package's public entry points are allowed to reach.
 *
 * ## The property, stated as a check
 *
 * Two packages are guarded, for the same reason in two directions:
 *
 *  * `cortex-storage` exports a browser-safe root plus Node-only backend subpaths. The root must
 *    never reach `better-sqlite3`, `pg`, or a `node:` builtin -- if it does, every consumer that
 *    imports the root drags a native module into a bundle that was supposed to be portable, and the
 *    failure shows up at *their* build time, as a cryptic "cannot resolve" rather than as a bug
 *    here.
 *  * `cortex-ai` exports the remote adapters at the root and the local model runtime at `./local`.
 *    The root must not reach `@huggingface/transformers`, or every service that talks to an HTTP
 *    provider inherits an ONNX runtime and 90 MB of weights. `./local` is the control: it *is*
 *    expected to reach the peer, so a clean report there means the walk is broken.
 *
 * A size budget alone would not catch that: the root is a few hundred bytes and would pass any
 * threshold while quietly importing a database. So the check is a **closure walk** of the source
 * graph, and the budget is a secondary bound on the result.
 *
 * ## Why it is a separate tool and not a test in the package
 *
 * The package tests run under vitest with the package's own resolution rules. This check is about
 * the *published* shape -- which entry reaches what -- so it reads `src/` as text and follows
 * relative specifiers itself. That also makes it usable as a mutation target: point it at a file
 * that does import a native module and it must fail.
 *
 * ## Usage
 *
 *   node tools/entry-guard.mjs --package packages/cortex-storage
 *   node tools/entry-guard.mjs --self-test           # asserts the guard can fail
 *
 * Exit status is 1 when a forbidden specifier is reachable from a guarded entry.
 */

import { readFileSync, existsSync, statSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Specifiers a portable entry must never reach. Matched against the bare name. */
const FORBIDDEN = [
  /^better-sqlite3$/,
  /^pg$/,
  /^pg-/,
  /^node:/,
  /^fs$/,
  /^path$/,
  /^os$/,
  /^crypto$/,
];

/** Byte budget for the whole closure of a guarded entry. */
const BUDGET = 300 * 1024;

/** Entries to guard, per package. Anything not listed is unguarded on purpose. */
const PLAN = {
  'packages/cortex-ai': [
    // The root is the remote-provider entry: a service that talks HTTP must not inherit an ONNX
    // runtime and 90 MB of weights.
    {
      entry: 'src/index.ts',
      portable: true,
      forbid: ['@huggingface/transformers'],
    },
    // The control for THIS package: `./local` is supposed to reach the peer. A clean report here
    // means the walk stopped following dynamic imports and the root's result is therefore empty.
    { entry: 'src/local/index.ts', portable: false, expect: '@huggingface/transformers' },
    // The web entry reaches a platform global and nothing else.
    {
      entry: 'src/web/index.ts',
      portable: true,
      forbid: ['@huggingface/transformers'],
    },
  ],
  'packages/cortex-storage': [
    { entry: 'src/index.ts', portable: true },
    // The browser entries are guarded as well, and more strictly than by name: they must not reach
    // a `node:` builtin, which is the mistake that turns a browser subpath into a build error in
    // somebody else's bundler. `Worker`, `indexedDB` and OPFS are globals, so nothing needs to be
    // imported to get them -- which is exactly why an accidental `node:fs` would be easy to add.
    { entry: 'src/browser/opfs.ts', portable: true },
    { entry: 'src/browser/idb.ts', portable: true },
    { entry: 'src/browser/opfs-worker.ts', portable: true },
    // The control: this entry is *expected* to reach better-sqlite3. If the guard ever reports it
    // clean, the walk is broken and the portable result above means nothing.
    { entry: 'src/storage/sqlite.ts', portable: false, expect: 'better-sqlite3' },
  ],
};

const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

/**
 * Comments are blanked before matching.
 *
 * Named `blankComments` rather than `stripComments` on purpose: `cortex-core` exports a
 * `stripComments` of its own, and the export census counts a symbol as *called* when its
 * identifier appears anywhere in `tools/*.mjs` (that is deliberate -- those scripts consume the
 * packages through `dist`). A same-named helper here would have silently retired a real orphan
 * entry in `tools/export-census-baseline.json`, which is exactly the kind of false "covered"
 * signal this repository keeps catching.
 *
 * Without this the walk reads example code out of documentation: the root entry's docstring
 * contains `import { ... } from '@agentix-e/cortex-storage'` as an illustration, and the guard
 * reported the package as reaching itself. A guard that fires on prose is a guard people learn to
 * ignore -- and the same blind spot would let a commented-out native import fail a clean build.
 * Bytes are still counted from the raw file, because that is what ships.
 */
function blankComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Resolve a relative specifier to a file on disk, trying the TypeScript source first. */
function resolveRelative(from, specifier) {
  const base = resolve(dirname(from), specifier);
  const candidates = [base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts')];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

/** Walk the import graph, returning reached files and bare specifiers. */
export function closure(entryFile) {
  const files = [];
  const seen = new Set();
  const bare = new Map();
  const queue = [entryFile];

  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(file);
    const text = blankComments(readFileSync(file, 'utf8'));
    for (const match of text.matchAll(IMPORT_RE)) {
      const specifier = match[1];
      if (specifier.startsWith('.')) {
        const resolved = resolveRelative(file, specifier);
        if (resolved === undefined) {
          bare.set(`${specifier} (unresolved from ${relative(REPO, file)})`, file);
        } else {
          queue.push(resolved);
        }
      } else {
        bare.set(specifier, file);
      }
    }
  }

  const bytes = files.reduce((total, file) => total + statSync(file).size, 0);
  return { files, bare: [...bare.keys()], bytes };
}

export function forbiddenIn(bare) {
  return bare.filter((specifier) => FORBIDDEN.some((pattern) => pattern.test(specifier)));
}

function check(pkgDir, entries) {
  const failures = [];
  const report = [];

  for (const item of entries) {
    const entryFile = join(REPO, pkgDir, item.entry);
    if (!existsSync(entryFile)) {
      failures.push(`${pkgDir}/${item.entry}: entry does not exist`);
      continue;
    }
    const result = closure(entryFile);
    const bad = forbiddenIn(result.bare);

    if (item.expect !== undefined) {
      // Positive control: the walk must *see* the forbidden module here, or it is not walking.
      const found = result.bare.some((specifier) => specifier === item.expect);
      if (!found) {
        failures.push(
          `${pkgDir}/${item.entry}: expected to reach ${item.expect} and did not -- the walk is broken`,
        );
      }
      report.push({
        entry: item.entry,
        role: 'control',
        files: result.files.length,
        bytes: result.bytes,
        reached: result.bare,
      });
      continue;
    }

    // Entry-specific bans, on top of the package-wide list. `cortex-ai` needs one: the root must
    // not reach the transformers peer, while `./local` must. Expressing that as a global FORBIDDEN
    // pattern would make the positive control impossible to write.
    const extra = (item.forbid ?? []).filter((specifier) => result.bare.includes(specifier));
    if (extra.length > 0) {
      failures.push(
        `${pkgDir}/${item.entry}: reaches ${extra.join(', ')}, which this entry must not`,
      );
    }

    if (bad.length > 0) {
      failures.push(
        `${pkgDir}/${item.entry}: reaches ${bad.join(', ')} -- a portable entry must not`,
      );
    }
    if (result.bytes > BUDGET) {
      failures.push(
        `${pkgDir}/${item.entry}: closure is ${result.bytes} bytes, over the ${BUDGET} budget`,
      );
    }
    report.push({
      entry: item.entry,
      role: 'portable',
      files: result.files.length,
      bytes: result.bytes,
      reached: result.bare,
    });
  }

  return { failures, report };
}

function main(argv) {
  const selfTest = argv.includes('--self-test');
  const packageIndex = argv.indexOf('--package');
  const targets =
    packageIndex === -1
      ? Object.keys(PLAN)
      : [argv[packageIndex + 1].replace(/^\.\/?/, '').replace(/\/$/, '')];

  const failures = [];
  const rows = [];

  for (const target of targets) {
    const plan = PLAN[target];
    if (plan === undefined) {
      failures.push(`${target}: no guard plan -- add one to tools/entry-guard.mjs`);
      continue;
    }
    const result = check(target, plan);
    failures.push(...result.failures);
    rows.push(...result.report.map((row) => ({ package: target, ...row })));
  }

  for (const row of rows) {
    console.log(
      `${row.role === 'control' ? 'control ' : 'portable'} ${row.package}/${row.entry}: ` +
        `${row.files} file(s), ${row.bytes} bytes, bare: [${row.reached.join(', ')}]`,
    );
  }

  if (selfTest) {
    // A guard that cannot fail is not a guard. The mutation is a real file on disk that reaches a
    // forbidden module from a path declared portable.
    const dir = mkdtempSync(join(tmpdir(), 'entry-guard-'));
    writeFileSync(join(dir, 'index.ts'), "import Database from 'better-sqlite3';\n");
    const probe = closure(join(dir, 'index.ts'));
    const caught = forbiddenIn(probe.bare).length > 0;
    console.log(
      `${caught ? 'ok  ' : 'FAIL'} self-test: a portable entry importing better-sqlite3 is rejected`,
    );
    if (!caught) failures.push('self-test: the guard did not reject a native import');
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('entry-guard: all entries hold');
  }
}

// Run only when executed, not when imported. The package tests import `closure`/`forbiddenIn` so
// that the *same* walk decides both the build-time gate and the per-package assertion -- two
// implementations of "what does this entry reach" would disagree exactly when it matters.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main(process.argv.slice(2));
