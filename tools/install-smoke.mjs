#!/usr/bin/env node
/**
 * Install smoke: does the thing we publish work when somebody installs it?
 *
 * ## The question no other guard asks
 *
 * `tools/entry-guard.mjs` walks `src/` as text and asks which specifiers a published entry can reach.
 * `tools/bundle-guard.mjs` bundles a subpath for the browser and asks what a consumer's build pays.
 * Neither of them **installs** anything, so neither can see the three defects below, and all three were
 * live in this repository before this file existed:
 *
 * | defect | how it survived | what a consumer got |
 * | --- | --- | --- |
 * | the compiled test suite ships | `files: ["dist"]` is true and `tsc -p tsconfig.json` compiles `src/__tests__` into `dist/__tests__` | **821 files** of tests in the `dist` as found -- 45% of the 1,834 published -- and **1,540** on a clean rebuild of the same code, because the emit was incremental. They import `vitest` and three packages the manifest declares as `devDependencies` |
 * | the source maps point at nothing | `sourceMap` and `declarationMap` are on, `files` ships `dist` only, so every `sources` entry resolves to `../src/x.ts` which the tarball does not contain | a debugger that cannot find the source it is asked to show, which is worse than no map because it looks like one |
 * | `workspace:*` reaches the registry | `pnpm pack` rewrites the protocol, `npm publish` from a workspace does not | a tarball npm refuses to install, or one that resolves a sibling from the public registry by accident |
 *
 * The first row is the one this file was written for and the one a size budget would have missed: the
 * package was not too big to publish, it was too big to *read*. A consumer auditing a dependency tree
 * finds their vendored copy of this library contains assertions about `multi-session` that no product
 * behaviour depends on, and the licence and provenance of `vitest` in a production install.
 *
 * ## What is checked, and it is deliberately four kinds of thing
 *
 * 1. **Inventory** -- what the tarball actually contains, from the tarball, not from `package.json`.
 *    Test files, a missing entry, an `exports` target with no file behind it, a declaration map with no
 *    source behind it, a map whose `sourcesContent` does not cover its `sources`.
 * 2. **Manifest** -- the packed `package.json`, which is the one that installs: `workspace:` in any
 *    dependency field, and every `exports` target resolving inside the tarball.
 * 3. **Install** -- a temporary project that depends on the tarballs by `file:` and nothing else, so the
 *    resolution is the resolution a stranger gets. A missing runtime dependency fails here and nowhere
 *    else, because `pnpm -r build` in the workspace resolves through the workspace.
 * 4. **Quickstart** -- `assembleMemory` over a `Storage` written in the probe, three turns appended, one
 *    question asked, and the delivered prompt read back. This is the only check in the repository that
 *    says the **installed** product renders the **registered** arm: the default profile, the room table,
 *    and the multi-session block the 500-question readings were taken with.
 *
 * ## Why the quickstart pins strings
 *
 * Because "the product works" is not a property, and "it returned a string" is satisfied by a stub. The
 * three pinned literals are the ones a customer's prompt must contain -- the evidence, the question's
 * subject, and the shipped instruction block -- so a rendering change arrives here as a red check and a
 * person decides whether it is an adoption or a regression. They are duplicated from the product on
 * purpose: this file is outside the package, which is what makes it evidence about the package.
 *
 * ## Cost
 *
 * Zero model calls. The reader is a function that returns a sentence, the storage is a `Map`, and the
 * pack-and-install leg runs against the local registry pnpm already has (`file:` dependencies only).
 *
 * ## Usage
 *
 *     node tools/install-smoke.mjs                  # pack, install, ask -- the whole check
 *     node tools/install-smoke.mjs --json           # machine-readable findings
 *     node tools/install-smoke.mjs --keep           # keep the temporary project, print its path
 *     node tools/install-smoke.mjs --self-test      # hermetic: six fixtures, five mutations, one table check
 *
 * Exit status is 1 when any check fails.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** The packages this repository publishes, in dependency order. */
const PACKAGES = ['cortex-core', 'cortex-storage', 'cortex-ai', 'cortex-eval', 'cortex-memory'];

/** Every finding this tool can print. A code is a name for a defect, not a message. */
const CODES = [
  'tests-shipped',
  'test-file-shipped',
  'entry-missing',
  'export-target-missing',
  'declaration-map-without-source',
  'map-not-self-contained',
  'workspace-protocol',
  'manifest-unreadable',
  'install-failed',
  'import-failed',
  'quickstart-failed',
];

/**
 * Test files, matched the way the repository writes them.
 *
 * Three conventions live here -- `src/__tests__/x.test.ts`, `src/x.test.ts` and the compiled forms in
 * `dist` -- and the check is on the **shipped path**, because that is the only one a consumer receives.
 */
const TEST_PATH = /(^|\/)__tests__\//;
const TEST_FILE = /\.test\.(?:js|d\.ts|mjs|cjs)$/;

/** How many findings are printed before the counts take over. */
const LIST_LIMIT = 20;

const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies'];

/**
 * Everything wrong with one packed package, as codes.
 *
 * `entries` are the tarball's paths with the leading `package/` stripped, `maps` maps a path to its
 * parsed JSON, and `manifest` is the packed `package.json`. Nothing here reads the workspace: a check
 * that consulted `src/` would answer a question about the checkout rather than about the download.
 */
export function inspect({ name, manifest, entries, maps = {} }) {
  const findings = [];
  const add = (code, detail) => findings.push({ package: name, code, detail });

  const shipped = new Set(entries);

  for (const entry of entries) {
    if (TEST_PATH.test(entry)) {
      add('tests-shipped', `${entry} -- a test directory is published`);
      continue;
    }
    if (TEST_FILE.test(entry)) add('test-file-shipped', `${entry} -- a test file is published`);
  }

  if (!shipped.has('dist/index.js')) add('entry-missing', 'dist/index.js is not in the tarball');

  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    const paths = typeof target === 'string' ? [target] : Object.values(target);
    for (const path of paths) {
      const rel = path.replace(/^\.\//, '');
      if (!shipped.has(rel)) add('export-target-missing', `exports["${subpath}"] -> ${path} is not shipped`);
    }
  }

  for (const [path, map] of Object.entries(maps)) {
    // A declaration map is refused outright rather than inspected, and the reason is that it cannot be
    // made honest in a package that ships `dist` only: `inlineSources` fills a `.js.map` with the source
    // text but leaves the `.d.ts.map` pointing at `../src/x.ts`, which no tarball here contains. An editor
    // following it lands on a missing file, which is a worse outcome than landing on the `.d.ts` -- so the
    // build turns `declarationMap` off and this rule keeps it off.
    if (path.endsWith('.d.ts.map')) {
      add('declaration-map-without-source', `${path} -- a declaration map names a source the package does not ship`);
      continue;
    }
    const sources = map.sources ?? [];
    const content = map.sourcesContent ?? [];
    if (content.length !== sources.length || content.some((text) => text === null || text === undefined)) {
      add('map-not-self-contained', `${path} -- ${content.length} of ${sources.length} sources carried inline`);
    }
  }

  for (const field of DEPENDENCY_FIELDS) {
    for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
      if (typeof range === 'string' && range.startsWith('workspace:')) {
        add('workspace-protocol', `${field}.${dep} = ${range} -- this is not installable outside the workspace`);
      }
    }
  }

  return findings;
}

/** The probe that runs inside the temporary project, as source. */
function probeSource() {
  return `import { assembleMemory, REGISTERED_ROOMS } from '@agentix-e/cortex-memory';

const tables = new Map();
const key = (table, k) => table + '\\u0000' + k;
const storage = {
  async put(table, k, value) { tables.set(key(table, k), structuredClone(value)); },
  async get(table, k) { const v = tables.get(key(table, k)); return v === undefined ? undefined : structuredClone(v); },
  async del(table, k) { tables.delete(key(table, k)); },
  async query(table) {
    const prefix = table + '\\u0000';
    return [...tables.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => structuredClone(v));
  },
  async transaction(fn) { return fn(storage); },
  async close() {},
};

const REPLY = 'Dana moved to Lisbon in March.';
let lastPrompt = '';
const llm = {
  async complete(prompt) { lastPrompt = prompt; return REPLY; },
  async completeStructured() { return {}; },
};

const assembled = assembleMemory({ llm, now: 1700000000000, storage });
await assembled.corpus.append([
  { sessionId: 's1', ordinal: 0, text: 'user: I live in Berlin and I have two cats.' },
  { sessionId: 's1', ordinal: 1, text: 'assistant: Two cats in Berlin, noted.' },
  { sessionId: 's2', ordinal: 0, text: 'user: I moved to Lisbon in March.' },
  { sessionId: 's2', ordinal: 1, text: 'assistant: Lisbon since March, got it.' },
]);
const answer = await assembled.memory.askStored('Where does the user live now?');

process.stdout.write(JSON.stringify({
  profile: assembled.profile,
  corpusSize: await assembled.corpus.size(),
  answer,
  reply: REPLY,
  promptChars: lastPrompt.length,
  prompt: lastPrompt,
  rooms: REGISTERED_ROOMS,
}));
`;
}

/** The literals a customer's prompt has to contain, and the values the registration names. */
const EXPECT = {
  profile: 'reader',
  corpusSize: 4,
  rooms: { 'multi-session': 48460, temporal: 24000, 'knowledge-update': 24000, flat: 24000, abstention: 24000, assistant: 24000 },
  contains: ['Lisbon', 'Berlin', 'Work in two steps.'],
};

/** Check the quickstart's answer against {@link EXPECT}. Exported so `--self-test` can mutate it. */
export function inspectQuickstart(reading) {
  const findings = [];
  const add = (detail) => findings.push({ package: 'cortex-memory', code: 'quickstart-failed', detail });

  if (reading.profile !== EXPECT.profile) add(`default profile is ${String(reading.profile)}, not ${EXPECT.profile}`);
  if (reading.corpusSize !== EXPECT.corpusSize) add(`corpus holds ${String(reading.corpusSize)} turns, not ${EXPECT.corpusSize}`);
  if (reading.answer !== reading.reply) add(`the memory answered ${JSON.stringify(reading.answer)}, not the reader's reply`);

  for (const [route, room] of Object.entries(EXPECT.rooms)) {
    if (reading.rooms?.[route] !== room) add(`room for ${route} is ${String(reading.rooms?.[route])}, not ${room}`);
  }
  for (const literal of EXPECT.contains) {
    if (!reading.prompt.includes(literal)) add(`the delivered prompt does not contain ${JSON.stringify(literal)}`);
  }
  return findings;
}

/** Pack one package into `destination`, returning the tarball path. */
function pack(name, destination) {
  const dir = join(ROOT, 'packages', name);
  execFileSync('pnpm', ['pack', '--pack-destination', destination], { cwd: dir, stdio: 'pipe' });
  const tarball = join(destination, `agentix-e-${name}-0.1.0.tgz`);
  if (!existsSync(tarball)) throw new Error(`pnpm pack produced no tarball for ${name}`);
  return tarball;
}

/** Every path in a tarball, with `package/` stripped. */
function entries(tarball) {
  return execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.replace(/^package\//, ''))
    .filter((line) => line !== 'package' && !line.endsWith('/'));
}

/** Read one file out of a tarball. */
function read(tarball, path) {
  return execFileSync('tar', ['-xzOf', tarball, `package/${path}`], { encoding: 'utf8' });
}

/**
 * Inspect one packed tarball end to end.
 *
 * One return shape rather than two: a manifest that cannot be parsed is a **finding**, not a different
 * kind of answer, because the caller's job is the same either way -- print what is wrong and exit 1. The
 * first draft returned an array in that case and an object otherwise, which made the caller ask
 * `Array.isArray`, and a caller that has to ask what shape it got is a caller that will one day guess
 * wrong.
 */
export function inspectTarball(tarball, name) {
  const paths = entries(tarball);
  let manifest;
  try {
    manifest = JSON.parse(read(tarball, 'package.json'));
  } catch (error) {
    return {
      paths,
      findings: [{ package: name, code: 'manifest-unreadable', detail: `package.json: ${String(error)}` }],
    };
  }
  const maps = {};
  for (const path of paths) {
    if (!path.endsWith('.map')) continue;
    try {
      maps[path] = JSON.parse(read(tarball, path));
    } catch {
      // A map that will not parse is reported by the self-contained rule below rather than here: one
      // defect, one code, so a mutation still has to turn exactly one rule red.
      maps[path] = { sources: [path], sourcesContent: [] };
    }
  }
  return { paths, findings: inspect({ name, manifest, entries: paths, maps }) };
}

/** Write the temporary project and install the tarballs into it. */
function install(tarballs, project) {
  const dependencies = {};
  const overrides = {};
  for (const [name, tarball] of Object.entries(tarballs)) {
    dependencies[`@agentix-e/${name}`] = `file:${tarball}`;
    overrides[`@agentix-e/${name}`] = `file:${tarball}`;
  }
  writeFileSync(
    join(project, 'package.json'),
    `${JSON.stringify({ name: 'cortex-install-smoke', private: true, type: 'module', dependencies, pnpm: { overrides } }, null, 2)}\n`,
  );
  writeFileSync(join(project, 'probe.mjs'), probeSource());

  const result = spawnSync('pnpm', ['install', '--ignore-scripts', '--reporter=silent'], {
    cwd: project,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-6).join(' | ');
    return [{ package: 'install', code: 'install-failed', detail: detail === '' ? 'pnpm install exited non-zero' : detail }];
  }
  return [];
}

/** Run the probe inside the installed project. */
function quickstart(project) {
  const result = spawnSync('node', ['probe.mjs'], { cwd: project, encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}`.trim().split('\n').slice(0, 3).join(' | ');
    return { findings: [{ package: 'cortex-memory', code: 'import-failed', detail }], reading: undefined };
  }
  let reading;
  try {
    reading = JSON.parse(result.stdout);
  } catch (error) {
    return { findings: [{ package: 'cortex-memory', code: 'quickstart-failed', detail: String(error) }], reading: undefined };
  }
  return { findings: inspectQuickstart(reading), reading };
}

/** A packed package that satisfies every rule, and the mutations that must each break one. */
const FIXTURES = {
  clean: () => ({
    name: 'clean',
    manifest: { name: 'clean', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } }, dependencies: { a: '1.0.0' } },
    entries: ['dist/index.js', 'dist/index.d.ts', 'dist/index.js.map', 'package.json'],
    maps: { 'dist/index.js.map': { sources: ['../src/index.ts'], sourcesContent: ['export const a = 1;'] } },
  }),
  'tests-shipped': () => {
    const base = FIXTURES.clean();
    base.entries = [...base.entries, 'dist/__tests__/index.test.js'];
    return base;
  },
  'export-target-missing': () => {
    const base = FIXTURES.clean();
    base.manifest.exports['./sqlite'] = { import: './dist/storage/sqlite.js' };
    return base;
  },
  'map-not-self-contained': () => {
    const base = FIXTURES.clean();
    base.maps['dist/index.js.map'] = { sources: ['../src/index.ts'] };
    return base;
  },
  'workspace-protocol': () => {
    const base = FIXTURES.clean();
    base.manifest.dependencies = { '@agentix-e/cortex-core': 'workspace:*' };
    return base;
  },
  'declaration-map-without-source': () => {
    const base = FIXTURES.clean();
    base.entries = [...base.entries, 'dist/index.d.ts.map'];
    base.maps['dist/index.d.ts.map'] = { sources: ['../src/index.ts'] };
    return base;
  },
};

function selfTest() {
  const lines = [];
  let assertions = 0;
  const assert = (ok, message) => {
    assertions += 1;
    if (!ok) throw new Error(`self-test: ${message}`);
  };

  const clean = inspect(FIXTURES.clean());
  assert(clean.length === 0, `the clean fixture reported ${JSON.stringify(clean)}`);

  // Each mutation must produce its own code **and only its own**, so a check that fires for the wrong
  // reason is a failure rather than a pass with noise.
  const expected = {
    'tests-shipped': 'tests-shipped',
    'export-target-missing': 'export-target-missing',
    'map-not-self-contained': 'map-not-self-contained',
    'workspace-protocol': 'workspace-protocol',
    'declaration-map-without-source': 'declaration-map-without-source',
  };
  for (const [fixture, code] of Object.entries(expected)) {
    const findings = inspect(FIXTURES[fixture]());
    const codes = new Set(findings.map((finding) => finding.code));
    assert(codes.has(code), `${fixture} did not report ${code} (reported ${[...codes].join(', ') || 'nothing'})`);
    assert(codes.size === 1, `${fixture} reported more than one code: ${[...codes].join(', ')}`);
    lines.push(`  ${fixture.padEnd(32)} -> ${code}`);
  }

  // A stray `.test.js` outside `__tests__` is a second convention and must be caught by its own rule.
  const stray = FIXTURES.clean();
  stray.entries = [...stray.entries, 'dist/thing.test.js'];
  const strayFindings = inspect(stray);
  assert(strayFindings.length === 1 && strayFindings[0].code === 'test-file-shipped', 'a stray .test.js was not reported');
  lines.push(`  ${'test-file-shipped'.padEnd(32)} -> test-file-shipped`);

  // The quickstart's own check, mutated: the same reading with each pinned literal removed must fail.
  const reading = {
    profile: 'reader',
    corpusSize: 4,
    answer: 'x',
    reply: 'x',
    promptChars: 10,
    prompt: 'Lisbon Berlin Work in two steps.',
    rooms: EXPECT.rooms,
  };
  assert(inspectQuickstart(reading).length === 0, 'a conforming quickstart reading was refused');
  for (const mutation of [
    { ...reading, profile: 'minimal' },
    { ...reading, corpusSize: 3 },
    { ...reading, answer: 'y' },
    { ...reading, prompt: 'Berlin Work in two steps.' },
    { ...reading, rooms: { ...EXPECT.rooms, 'multi-session': 24000 } },
  ]) {
    assert(inspectQuickstart(mutation).length === 1, `a mutated quickstart reading produced ${JSON.stringify(inspectQuickstart(mutation))}`);
  }
  assert(CODES.length === new Set(CODES).size, 'CODES holds a duplicate');

  // Every code the file can emit is in `CODES`, and every entry in `CODES` is emitted somewhere. Read
  // from this file's own text, because that is the only copy that cannot drift: a code added to `add()`
  // and forgotten in the table would make the summary lie about what it counted, and a code left in the
  // table after its check was deleted would make a reader look for a rule that no longer runs.
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const emitted = new Set([
    ...[...source.matchAll(/code: '([a-z-]+)'/g)].map((match) => match[1]),
    ...[...source.matchAll(/add\('([a-z-]+)'/g)].map((match) => match[1]),
  ]);
  const declared = new Set(CODES);
  const undeclared = [...emitted].filter((code) => !declared.has(code));
  const unused = [...declared].filter((code) => !emitted.has(code));
  assert(undeclared.length === 0, `codes emitted but not declared: ${undeclared.join(', ')}`);
  assert(unused.length === 0, `codes declared but never emitted: ${unused.join(', ')}`);

  process.stdout.write(
    `install-smoke --self-test: ${assertions} assertions\n${lines.join('\n')}\n  every mutation turned exactly one rule red\n`,
  );
}

function main(argv) {
  if (argv.includes('--self-test')) {
    selfTest();
    return 0;
  }

  const json = argv.includes('--json');
  const keep = argv.includes('--keep');
  const work = mkdtempSync(join(tmpdir(), 'cortex-install-'));
  const findings = [];
  const inventory = [];

  try {
    const tarballs = {};
    for (const name of PACKAGES) tarballs[name] = pack(name, work);

    for (const name of PACKAGES) {
      const inspected = inspectTarball(tarballs[name], name);
      findings.push(...inspected.findings);
      inventory.push({
        package: name,
        files: inspected.paths.length,
        tests: inspected.paths.filter((path) => TEST_PATH.test(path) || TEST_FILE.test(path)).length,
        bytes: readFileSync(tarballs[name]).length,
      });
    }

    const project = join(work, 'app');
    mkdirSync(project, { recursive: true });
    findings.push(...install(tarballs, project));
    if (!findings.some((finding) => finding.code === 'install-failed')) {
      const ran = quickstart(project);
      findings.push(...ran.findings);
      if (json && ran.reading !== undefined) inventory.push({ package: 'quickstart', reading: ran.reading });
      if (!json && ran.reading !== undefined) {
        process.stdout.write(
          `quickstart: profile=${ran.reading.profile} turns=${ran.reading.corpusSize} promptChars=${ran.reading.promptChars} ` +
            `multi-session room=${ran.reading.rooms['multi-session']}\n`,
        );
      }
    }
  } finally {
    if (keep) process.stdout.write(`temporary project kept at ${work}\n`);
    else rmSync(work, { recursive: true, force: true });
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ inventory, findings }, null, 2)}\n`);
  } else {
    const totalFiles = inventory.reduce((sum, row) => sum + (row.files ?? 0), 0);
    const totalBytes = inventory.reduce((sum, row) => sum + (row.bytes ?? 0), 0);
    process.stdout.write(
      `tarballs: ${PACKAGES.length} packages, ${totalFiles} files, ${(totalBytes / 1024).toFixed(0)} KiB\n`,
    );
    for (const row of inventory) {
      if (row.bytes === undefined) continue;
      process.stdout.write(`  ${row.package.padEnd(16)} files=${String(row.files).padStart(4)} tests=${row.tests} ${(row.bytes / 1024).toFixed(0)} KiB\n`);
    }
    for (const finding of findings.slice(0, LIST_LIMIT)) {
      process.stdout.write(`FAIL ${finding.package}: [${finding.code}] ${finding.detail}\n`);
    }
    if (findings.length > LIST_LIMIT) {
      // Listed rather than truncated silently: one broken build produces a hundred rows, and a hundred
      // rows is a wall a reader skips. The counts say what the wall is made of.
      const counts = new Map();
      for (const finding of findings) counts.set(finding.code, (counts.get(finding.code) ?? 0) + 1);
      const summary = [...counts.entries()].map(([code, n]) => `${code} x${n}`).join(', ');
      process.stdout.write(`... ${findings.length - LIST_LIMIT} more findings (${summary})\n`);
    }
  }

  return findings.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
