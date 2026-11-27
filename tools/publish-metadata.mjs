#!/usr/bin/env node
/**
 * What a package has to say about itself before `npm publish` will take it seriously.
 *
 *     node tools/publish-metadata.mjs             # print the table
 *     node tools/publish-metadata.mjs --check     # fail on any red row
 *     node tools/publish-metadata.mjs --self-test  # prove every rule can fail
 *
 * ## Why this exists, and why it is not `npm pkg fix`
 *
 * Every field checked here is a fact a **consumer** reads rather than a fact this repository reads, so no
 * test in this tree would ever notice it was missing. That is the shape the whole publish path has: the
 * packages build, the suite is green, the manual's examples compile against the built declarations, and
 * `npm publish` still fails -- or worse, succeeds and ships a package whose `npm repo` link is dead, whose
 * install on Node 18 fails at runtime instead of at install time, and which is **unsearchable** because it
 * carries no keywords. None of those three is a defect an integration test can see.
 *
 * The one that is not cosmetic is `publishConfig.access`. `@agentix-e/*` is a scoped name, and npm's
 * default for a scoped package is `restricted`: a first publish without `access: public` either fails or
 * lands in a paid private scope. The failure is loud; the second outcome is the expensive one, and it is
 * decided by a field nobody in a monorepo reads because `pnpm publish` is usually what runs.
 *
 * ## Why `workspace:*` is checked but not rewritten
 *
 * `pnpm publish` expands `workspace:*` into the concrete version and `npm publish` does not -- it ships the
 * protocol literally and the install then fails. The rule here is therefore not "no workspace protocol" but
 * **"the release path must be pnpm"**, which is checked in `release.yml` rather than here; what this file
 * asserts is that every `workspace:` specifier names a package that exists, because a renamed directory
 * produces a specifier that resolves in no tool at all.
 *
 * ## The tenth rule, and the only one that is about this repository rather than about npm
 *
 * `engines.node` is checked twice: present, and **equal to the root's**. Two declarations of one floor is
 * two statements, and they agree until one of them is edited -- the same defect shape `queue-price.mjs`
 * records for two prices and `arm-pairing.ts` records for two spellings of one variable. A package that
 * declares `>=18` under a root that declares `>=22` would let an install succeed into a tree whose own
 * lockfile was resolved by a tool the runtime cannot run.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The tree this tool measures.
 *
 * Injectable for the reason every guard in this repository is: a rule that cannot be shown to fail is a
 * rule nobody has read. `PUBLISH_METADATA_ROOT` lets `--self-test` build a tree containing each defect.
 */
const REPO = path.resolve(process.env['PUBLISH_METADATA_ROOT'] ?? path.join(HERE, '..'));

const SCOPE = '@agentix-e/';

/** A row that is not a *style* preference: `detail` is read by whoever has to fix it. */
function check(id, ok, detail) {
  return { id, ok: Boolean(ok), detail };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Every rule, as a function of one package and the context it is published in.
 *
 * A list rather than ten `if` blocks so `--self-test` can enumerate them: a rule that is not in this array
 * is a rule the self-test cannot prove fires, and the self-test asserts the count for exactly that reason.
 */
const RULES = [
  {
    id: 'scoped-name',
    run: (pkg) =>
      check(
        'scoped-name',
        typeof pkg.name === 'string' && pkg.name.startsWith(SCOPE),
        `name is ${JSON.stringify(pkg.name)}; every package in this tree publishes under ${SCOPE}`,
      ),
  },
  {
    id: 'semver',
    run: (pkg) => {
      const ok = typeof pkg.version === 'string' && SEMVER.test(pkg.version);
      return check('semver', ok, `version is ${JSON.stringify(pkg.version)}; npm rejects anything but semver`);
    },
  },
  {
    id: 'one-version',
    run: (pkg, ctx) => {
      // Not a preference: five packages at five versions means a consumer installing the umbrella gets a
      // mixture, and `dependencies` in the umbrella pins exact versions -- so a drift here is a consumer
      // resolving two copies of `cortex-core`.
      const differing = ctx.versions.filter((one) => one.version !== pkg.version);
      return check(
        'one-version',
        differing.length === 0,
        differing.length === 0
          ? `all ${ctx.versions.length} packages at ${pkg.version}`
          : `this package is ${pkg.version} and ${differing.map((one) => `${one.name} ${one.version}`).join(', ')}`,
      );
    },
  },
  {
    id: 'description',
    run: (pkg) => {
      const text = pkg.description;
      const ok = typeof text === 'string' && text.trim().length > 0 && text.length <= 200;
      return check('description', ok, `${typeof text === 'string' ? text.length : 'missing'} character(s), limit 200`);
    },
  },
  {
    id: 'license-file',
    run: (pkg, ctx) => {
      // Both halves: the field npm reads, and the file the field promises. A `license: MIT` with no LICENSE
      // in the tarball is a claim without the text it points at, and `files: ['dist']` means the root LICENSE
      // is NOT in the tarball unless npm copies it -- which npm does, and which is why the file is required
      // at the root rather than beside the package.
      //
      // Read from `ctx` rather than from `REPO`, and the first draft of this file got that wrong: the rule
      // closed over the module-level root, so `--self-test`'s fixture inherited the real repository's LICENSE
      // and the case that deletes it stayed green. A rule that reads the tree it is not measuring is the
      // stale-premise defect with a file path on it.
      const ok = pkg.license === 'MIT' && ctx.hasLicense;
      return check(
        'license-file',
        ok,
        pkg.license !== 'MIT'
          ? `license is ${JSON.stringify(pkg.license)}`
          : ctx.hasLicense
            ? 'MIT, and the root LICENSE the tarball carries is present'
            : 'MIT declared, and there is no LICENSE file at the root to ship',
      );
    },
  },
  {
    id: 'files-dist-only',
    run: (pkg) => {
      const files = Array.isArray(pkg.files) ? pkg.files : [];
      const hasDist = files.includes('dist');
      const leaks = files.filter((one) => ['src', 'bench', 'test', 'coverage'].includes(one));
      return check(
        'files-dist-only',
        hasDist && leaks.length === 0,
        hasDist ? (leaks.length === 0 ? 'dist' : `publishes ${leaks.join(', ')}`) : 'no `dist` in files',
      );
    },
  },
  {
    id: 'public-access',
    run: (pkg) =>
      check(
        'public-access',
        pkg.publishConfig?.access === 'public',
        // The one rule whose absence is not loud: a scoped package without this is `restricted` by default.
        `publishConfig.access is ${JSON.stringify(pkg.publishConfig?.access)}; a scoped name defaults to restricted`,
      ),
  },
  {
    id: 'engines-node',
    run: (pkg, ctx) =>
      check(
        'engines-node',
        typeof pkg.engines?.node === 'string' && pkg.engines.node === ctx.rootNode,
        pkg.engines?.node === undefined
          ? `no engines.node; the root declares ${JSON.stringify(ctx.rootNode)}`
          : `declares ${JSON.stringify(pkg.engines.node)} against the root's ${JSON.stringify(ctx.rootNode)}`,
      ),
  },
  {
    id: 'repository-directory',
    run: (pkg, ctx) => {
      const directory = pkg.repository?.directory;
      const url = pkg.repository?.url;
      const ok = typeof url === 'string' && directory === `packages/${ctx.directory}`;
      return check(
        'repository-directory',
        ok,
        ok ? `packages/${ctx.directory}` : `directory is ${JSON.stringify(directory)}, expected packages/${ctx.directory}`,
      );
    },
  },
  {
    id: 'entry-inside-dist',
    run: (pkg) => {
      // The exports a consumer resolves must be inside the one directory `files` publishes. A `main` pointing
      // outside it is a package that installs and then cannot be imported -- and it is invisible from this
      // tree because the workspace symlink resolves it locally.
      const entries = [pkg.main, pkg.types].filter((one) => typeof one === 'string');
      const outside = entries.filter((one) => !one.startsWith('./dist/'));
      return check(
        'entry-inside-dist',
        entries.length > 0 && outside.length === 0,
        outside.length === 0 ? `${entries.length} entry point(s) inside ./dist/` : `outside dist: ${outside.join(', ')}`,
      );
    },
  },
  {
    id: 'workspace-targets-exist',
    run: (pkg, ctx) => {
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const unresolved = Object.entries(deps)
        .filter(([, spec]) => typeof spec === 'string' && spec.startsWith('workspace:'))
        .map(([name]) => name)
        .filter((name) => !ctx.workspaceNames.has(name));
      return check(
        'workspace-targets-exist',
        unresolved.length === 0,
        unresolved.length === 0 ? 'every workspace specifier resolves' : `no package for: ${unresolved.join(', ')}`,
      );
    },
  },
];

function ctxLicense(repo) {
  return existsSync(path.join(repo, 'LICENSE')) || existsSync(path.join(repo, 'LICENSE.md'));
}

/** Every package, every rule, as rows. Exported so a test can assert one rule without copying it. */
export function audit(root = REPO) {
  const directory = path.join(root, 'packages');
  const names = existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => existsSync(path.join(directory, name, 'package.json')))
        .sort()
    : [];
  const rootPkg = existsSync(path.join(root, 'package.json')) ? readJson(path.join(root, 'package.json')) : {};
  const loaded = names.map((name) => ({ directory: name, pkg: readJson(path.join(directory, name, 'package.json')) }));
  const ctx = {
    rootNode: rootPkg.engines?.node,
    versions: loaded.map((one) => ({ name: one.pkg.name, version: one.pkg.version })),
    workspaceNames: new Set(loaded.map((one) => one.pkg.name)),
    hasLicense: ctxLicense(root),
  };
  return loaded.map((one) => ({
    directory: one.directory,
    name: one.pkg.name,
    rows: RULES.map((rule) => rule.run(one.pkg, { ...ctx, directory: one.directory })),
  }));
}

function render(report) {
  const lines = ['| package | rule | verdict | detail |', '| --- | --- | :---: | --- |'];
  for (const one of report) {
    for (const row of one.rows) {
      lines.push(`| \`${one.directory}\` | ${row.id} | ${row.ok ? 'ok' : '**RED**'} | ${row.detail} |`);
    }
  }
  const red = report.flatMap((one) => one.rows.filter((row) => !row.ok));
  lines.push('', `${report.length} package(s) x ${RULES.length} rule(s) = ${report.length * RULES.length} reading(s); ${red.length} red.`);
  return lines.join('\n');
}

/**
 * The self-test, which is the part that makes the other part believable.
 *
 * Each case writes a tree containing ONE defect and asserts both that the named rule goes red and that no
 * other rule does. The second half is what a fixture usually omits: a rule whose condition accidentally
 * reads a second field passes its own case and refuses three quarters of real packages.
 */
function selfTest() {
  let failures = 0;
  const say = (ok, text) => {
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${text}`);
  };

  const basePackage = (name, extra = {}) => ({
    name: `${SCOPE}${name}`,
    version: '0.1.0',
    description: 'a package',
    license: 'MIT',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    files: ['dist'],
    publishConfig: { access: 'public' },
    engines: { node: '>=22.0.0' },
    repository: { type: 'git', url: 'git+https://example.invalid/x.git', directory: `packages/${name}` },
    ...extra,
  });

  const build = (packages) => {
    const root = mkdtempSync(path.join(tmpdir(), 'publish-metadata-'));
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root', engines: { node: '>=22.0.0' } }));
    writeFileSync(path.join(root, 'LICENSE'), 'MIT\n');
    for (const [name, pkg] of Object.entries(packages)) {
      mkdirSync(path.join(root, 'packages', name), { recursive: true });
      writeFileSync(path.join(root, 'packages', name, 'package.json'), JSON.stringify(pkg));
    }
    return root;
  };

  const redsOf = (report) =>
    report.flatMap((one) => one.rows.filter((row) => !row.ok).map((row) => row.id));

  // 1. The clean tree is green, and every rule is exercised by it.
  {
    const root = build({ one: basePackage('one'), two: basePackage('two') });
    const report = audit(root);
    say(report.length === 2, 'two packages read');
    say(redsOf(report).length === 0, 'a well-formed tree has no red row');
    say(RULES.length === 11, `the rule count is eleven, and this line has to be edited when it is not (${RULES.length})`);
  }

  // 2. Each defect, one at a time, and ONLY its own rule.
  const cases = [
    ['scoped-name', { name: 'cortex-one' }],
    ['semver', { version: '0.1' }],
    ['description', { description: '' }],
    ['description', { description: 'x'.repeat(201) }],
    ['license-file', { license: 'Apache-2.0' }],
    ['files-dist-only', { files: ['src'] }],
    ['files-dist-only', { files: ['dist', 'bench'] }],
    ['public-access', { publishConfig: {} }],
    ['engines-node', { engines: {} }],
    ['engines-node', { engines: { node: '>=18.0.0' } }],
    ['repository-directory', { repository: { type: 'git', url: 'x', directory: 'packages/other' } }],
    ['entry-inside-dist', { main: './src/index.js' }],
    ['workspace-targets-exist', { dependencies: { '@agentix-e/cortex-absent': 'workspace:*' } }],
  ];
  for (const [expected, extra] of cases) {
    const root = build({ one: basePackage('one', extra) });
    const reds = redsOf(audit(root));
    say(
      reds.length === 1 && reds[0] === expected,
      `${JSON.stringify(extra).slice(0, 60)} -> [${reds.join(', ')}] and only ${expected}`,
    );
  }

  // 3. One-version is a rule about the SET, so it needs two packages to fail.
  {
    const root = build({ one: basePackage('one'), two: basePackage('two', { version: '0.2.0' }) });
    const reds = redsOf(audit(root));
    say(reds.length === 2 && reds.every((id) => id === 'one-version'), 'a version drift reds both packages');
  }

  // 4. A missing LICENSE file is the whole `license-file` rule, and the field alone cannot carry it.
  {
    const root = build({ one: basePackage('one') });
    rmSync(path.join(root, 'LICENSE'));
    say(redsOf(audit(root)).includes('license-file'), 'a `license: MIT` with no LICENSE file is red');
  }

  // 5. The report renders one row per rule per package, so a table cannot hide a red.
  {
    const root = build({ one: basePackage('one') });
    const text = render(audit(root));
    say(text.split('\n').length === 2 + RULES.length + 2, 'the table has a header, one row per rule and a summary');
  }

  console.log(failures === 0 ? '\nPASS  publish-metadata self-test' : `\nFAIL  ${failures} assertion(s)`);
  if (failures > 0) process.exitCode = 1;
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--self-test')) {
    selfTest();
    return;
  }
  const report = audit();
  if (report.length === 0) {
    console.error(`publish-metadata: no packages under ${path.join(REPO, 'packages')}`);
    process.exitCode = 1;
    return;
  }
  const text = render(report);
  if (args.has('--check')) {
    const red = report.flatMap((one) => one.rows.filter((row) => !row.ok));
    // The table is printed on BOTH paths, and the green path is the one that matters for a reader: a
    // `--check` that prints only a sentence is a check whose 55 readings nobody can audit without running
    // a second command, and the second command is the one that gets skipped. `test_publish_metadata.py`
    // asserts one row per rule per package precisely because a rule missing from the table is a rule
    // nobody applied -- a property a summary line cannot carry.
    console.log(text);
    if (red.length > 0) {
      console.error(
        `\npublish-metadata: ${red.length} red row(s). Each one is a consumer-visible fact that no test in this ` +
          'tree reads -- see the docblock for what each failure costs at publish time.',
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `\npublish-metadata: ${report.length} package(s) x ${RULES.length} rule(s) agree; the tarball a consumer ` +
        'would install describes itself correctly',
    );
    return;
  }
  console.log(text);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) main();
