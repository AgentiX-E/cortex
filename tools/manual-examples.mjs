#!/usr/bin/env node
/**
 * Compile the user manual, and check its two contract tables against the option types.
 *
 * ## Why this exists
 *
 * A manual is a claim about an API, and every claim in this repository that is not measured has
 * eventually been found false (§13.327's registry is the third instance). The three checks here are
 * the cheapest ones that turn the manual's claims into executable statements:
 *
 *   1. **Examples compile.** Every ```ts fence is written to a scratch directory and type-checked
 *      against the packages' built declarations, with the repository's strict settings. A renamed
 *      export, a changed option shape, or a removed method fails the build at the manual's own line
 *      number.
 *   2. **Tables are complete.** A `<!-- contract-table: X -->` block lists an option per row, and the
 *      set of rows must equal the set of keys in type `X`. An option added to the type and not
 *      documented, or documented and not present, is an error in both directions -- a table that only
 *      checks one direction is a table that silently loses rows.
 *   3. **Specifiers exist.** Every `@agentix-e/...` specifier the page names must appear in that
 *      package's `exports` map. A subpath renamed in the manifest and not in the prose is the same
 *      class of defect as the registry naming a value the run never used.
 *
 * ## What it refuses
 *
 * A page with no examples, or a page whose fence markers are unbalanced, is an error rather than a
 * pass: `0 examples checked` and `every example compiled` are the two states a naive gate cannot
 * tell apart, and that indistinguishability is the defect this repository keeps paying for. The
 * `--check-tables` half asserts the same thing about rows.
 *
 * ## Output shape
 *
 * Type errors are reported as `<manual path>:<line>:<column>` with the fence and the compiler's own
 * message, so a reader can open the page at the failing line instead of searching the scratch
 * directory.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const DEFAULT_FILE = join(REPO, 'docs/USER-MANUAL.md');
const DEFAULT_README = join(REPO, 'README.md');

/** Packages whose declarations the examples are compiled against. */
const PACKAGES = [
  'cortex-core',
  'cortex-ai',
  'cortex-memory',
  'cortex-eval',
  'cortex-storage',
];

/** Subpath exports, mirrored from each package's manifest at run time rather than restated here. */
function specifierMap() {
  const map = new Map();
  for (const pkg of PACKAGES) {
    const manifest = JSON.parse(readFileSync(join(REPO, 'packages', pkg, 'package.json'), 'utf8'));
    const name = manifest.name;
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      const specifier = subpath === '.' ? name : `${name}/${subpath.slice(2)}`;
      const types = typeof target === 'string' ? target : target.types;
      if (types === undefined) continue;
      map.set(specifier, join(REPO, 'packages', pkg, types));
    }
  }
  return map;
}

/** Every ```ts fence, with the line its first content line sits on. */
function examples(lines) {
  const found = [];
  let open = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (open === null) {
      if (/^```ts\s*$/.test(line)) open = { fenceLine: i + 1, body: [] };
      continue;
    }
    if (/^```\s*$/.test(line)) {
      found.push({ fenceLine: open.fenceLine, body: open.body.join('\n') });
      open = null;
      continue;
    }
    open.body.push(line);
  }
  if (open !== null) {
    throw new Error(`unbalanced fence: the block opened at line ${open.fenceLine} never closes`);
  }
  return found;
}

/** The keys of a `export type NAME = { ... }` declaration in a `.d.ts` file. */
function typeKeys(source, name) {
  const head = `export type ${name} = {`;
  const start = source.indexOf(head);
  if (start === -1) throw new Error(`type ${name} is not declared in the declarations`);
  let depth = 0;
  let i = start + head.length - 1;
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  // Comments are stripped before the key scan: a docblock that names an option in prose would
  // otherwise be read as a declaration of it.
  const body = source.slice(start + head.length, i).replace(/\/\*[\s\S]*?\*\//g, '');
  const keys = [];
  for (const match of body.matchAll(/^[ \t]+(?:readonly )?([A-Za-z_]\w*)\??:/gm)) {
    keys.push(match[1]);
  }
  return keys;
}

/** The rows of every `<!-- contract-table: X -->` block, first column only. */
function contractTables(lines) {
  const tables = [];
  const open = /^<!-- contract-table: ([A-Za-z_]\w*) -->$/;
  const close = /^<!-- \/contract-table -->$/;
  for (let i = 0; i < lines.length; i += 1) {
    const matched = open.exec(lines[i]);
    if (matched === null) continue;
    const name = matched[1];
    const declaredOn = i + 1;
    const rows = [];
    let j = i + 1;
    for (; j < lines.length && !close.test(lines[j]); j += 1) {
      const cell = /^\|\s*`([A-Za-z_]\w*)`\s*\|/.exec(lines[j]);
      if (cell !== null) rows.push({ name: cell[1], line: j + 1 });
    }
    if (j >= lines.length) {
      throw new Error(`contract-table ${name} opened at line ${declaredOn} never closes`);
    }
    tables.push({ name, declaredOn, rows, endLine: j + 1 });
    i = j;
  }
  return tables;
}

/** Specifiers the page names, with the line each appears on. */
function specifiers(lines, known) {
  const found = [];
  const pattern = /@agentix-e\/cortex-[a-z-]+(?:\/[A-Za-z0-9._/-]*)?/g;
  for (let i = 0; i < lines.length; i += 1) {
    for (const match of lines[i].matchAll(pattern)) {
      // A trailing slash, or a trailing `.` from sentence punctuation, is not part of the name.
      const raw = match[0].replace(/[./]+$/, '');
      found.push({ specifier: raw, line: i + 1, known: known.has(raw) });
    }
  }
  return found;
}

function compile(blocks, path, failures) {
  const dir = mkdtempSync(join(tmpdir(), 'cortex-manual-'));
  try {
    const names = [];
    for (const [index, block] of blocks.entries()) {
      const file = `example-${String(index + 1).padStart(2, '0')}.ts`;
      names.push({ file, fenceLine: block.fenceLine });
      writeFileSync(join(dir, file), `${block.body}\n`);
    }
    const tsconfig = {
      compilerOptions: {
        strict: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
        skipLibCheck: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        lib: ['ES2022', 'DOM'],
        types: ['node'],
        typeRoots: [join(REPO, 'node_modules/@types')],
        baseUrl: REPO,
        paths: Object.fromEntries([...specifierMap()].map(([name, target]) => [name, [target]])),
      },
      include: names.map((entry) => entry.file),
    };
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));

    let output = '';
    let status = 0;
    try {
      output = execFileSync(process.execPath, [join(REPO, 'node_modules/typescript/bin/tsc'), '-p', dir], {
        cwd: REPO,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      status = 1;
    }
    const byFile = new Map(names.map((entry) => [entry.file, entry.fenceLine]));
    for (const line of output.split('\n')) {
      const parsed = /(?:^|\/)(example-\d+\.ts)\((\d+),(\d+)\): (.*)$/.exec(line.trim());
      if (parsed === null) continue;
      const fenceLine = byFile.get(parsed[1]);
      // The fence's first content line is `fenceLine + 1`, and tsc counts from 1, so a `+` of the
      // compiler's line and the fence's line lands on the manual's own line.
      const manualLine = fenceLine + Number(parsed[2]);
      failures.push(`${path}:${manualLine}:${parsed[3]} ${parsed[4]}`);
    }
    if (status !== 0 && failures.length === 0) {
      failures.push(`type check failed without a mappable diagnostic:\n${output}`);
    }
    return names.length;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Check one page: its examples compile, its tables match the option types, its specifiers exist.
 *
 * Pages are checked independently so a failure names the page it is on, and the vacuity checks
 * ("no examples", "no tables") are applied to the **total** rather than per page: `ARCHITECTURE.md`
 * legitimately has neither, and a per-page rule would either fail it or have to special-case it.
 */
function checkPage(path, known, failures) {
  const lines = readFileSync(path, 'utf8').split('\n');
  const blocks = examples(lines);
  const tables = contractTables(lines);

  const declarations = readFileSync(join(REPO, 'packages/cortex-memory/dist/types.d.ts'), 'utf8');
  for (const table of tables) {
    const declared = typeKeys(declarations, table.name);
    const seen = new Set();
    for (const row of table.rows) {
      if (seen.has(row.name)) failures.push(`${path}:${row.line}: ${row.name} is listed twice`);
      seen.add(row.name);
    }
    for (const key of declared) {
      if (!seen.has(key)) {
        failures.push(
          `${path}:${table.declaredOn}: ${table.name}.${key} is declared in the type and not documented`,
        );
      }
    }
    for (const name of seen) {
      if (!declared.includes(name)) {
        const row = table.rows.find((candidate) => candidate.name === name);
        failures.push(
          `${path}:${row.line}: ${table.name}.${name} is documented and not declared in the type`,
        );
      }
    }
  }

  for (const found of specifiers(lines, known)) {
    if (!found.known) {
      failures.push(
        `${path}:${found.line}: ${found.specifier} is not an export of any workspace package`,
      );
    }
  }

  // Which documented options an example actually exercises. Not asserted -- an option can be
  // documented by its row and demonstrated by nothing, and forcing a demo for each one would buy
  // twenty contrived fences. It is *reported* because "22 options documented, 13 demonstrated" is a
  // fact a reader of the manual should be able to see, and a number that is only in prose drifts.
  const bodies = blocks.map((block) => block.body);
  const exercised = new Set();
  const documentedNames = new Set();
  for (const table of tables) {
    for (const key of typeKeys(declarations, table.name)) {
      documentedNames.add(`${table.name}.${key}`);
      const pattern = new RegExp(`\\b${key}\\b`);
      if (bodies.some((body) => pattern.test(body))) exercised.add(`${table.name}.${key}`);
    }
  }

  const compiled = blocks.length === 0 ? 0 : compile(blocks, path, failures);
  return {
    compiled,
    tables: tables.length,
    exercised,
    documentedNames,
    documented: tables.reduce((n, t) => n + t.rows.length, 0),
  };
}

function main(argv) {
  /** `--file` may be repeated; the default set is every page in the published surface. */
  const pages = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--file' && argv[i + 1] !== undefined) pages.push(resolve(argv[i + 1]));
  }
  if (pages.length === 0) pages.push(DEFAULT_FILE, DEFAULT_README);

  const known = specifierMap();
  const failures = [];
  let compiled = 0;
  let tables = 0;
  let documented = 0;
  const exercised = new Set();
  const documentedNames = new Set();
  for (const page of pages) {
    const result = checkPage(page, known, failures);
    compiled += result.compiled;
    tables += result.tables;
    documented += result.documented;
    for (const name of result.exercised) exercised.add(name);
    for (const name of result.documentedNames) documentedNames.add(name);
  }

  // Two vacuity checks, applied to the whole run rather than to one page: `0 examples checked` and
  // `every example compiled` must not print the same thing, and the same holds for the option
  // surface. A page count of zero is also a failure, because a default set that resolves to nothing
  // would otherwise report success.
  if (pages.length === 0) failures.push('no pages to check');
  if (compiled === 0) {
    failures.push('no ```ts fences found in any page -- an empty surface would otherwise pass');
  }
  if (tables === 0) {
    failures.push('no contract tables found in any page -- the option surface would otherwise go unchecked');
  }
  // A row is a claim that the option exists; an example is evidence that a caller can use it. The
  // two are held together because the failure they prevent is asymmetric: an option that is
  // documented and never exercised is the shape under which an option becomes inert in production
  // while the table still says it does something (§10.10's class).
  const undemonstrated = [...documentedNames].filter((name) => !exercised.has(name));
  if (undemonstrated.length > 0) {
    failures.push(
      `documented but demonstrated by no example: ${undemonstrated.join(', ')}. ` +
        'Add a fence that names the option, or remove the row.',
    );
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    console.error(`manual:check FAILED (${failures.length} problem(s))`);
    return 1;
  }
  console.log(
    `manual:check ok -- ${pages.length} page(s), ${compiled} example(s) compiled, ` +
      `${tables} contract table(s) matched (${exercised.size}/${documented} option(s) demonstrated by an ` +
      `example), ${known.size} specifier(s) known`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
