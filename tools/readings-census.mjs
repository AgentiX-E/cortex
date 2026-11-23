#!/usr/bin/env node
/**
 * Every reading this repository commits has to say how it gets re-derived, or say why it does not.
 *
 *     node tools/readings-census.mjs            # the table
 *     node tools/readings-census.mjs --check    # fail on a reading that says neither
 *     node tools/readings-census.mjs --write    # regenerate docs/COMMITTED-READINGS.md
 *
 * ## The defect, stated once
 *
 * `§10.2`'s two browser gates are argued from committed JSON: a browser suite cannot run inside
 * `pnpm check`, so the reading is the evidence and the documents cite it. That makes every committed
 * reading a claim with no expiry date, and the previous two rounds found four of them making a claim
 * nothing was checking:
 *
 *   - `bundle-run.json` was compared by nothing, and CI **overwrote it** on every push, so the run
 *     that disagreed with it replaced the file it disagreed with;
 *   - `last-run-firefox.json` is the entire content of "gate 2 holds on a second engine", and no
 *     workflow mentioned `firefox`;
 *   - `guard:browser` compared two *committed* files and printed a sentence about "this tree";
 *   - `CORTEX_RESULTS_BUNDLE` existed to prevent exactly this and was set nowhere.
 *
 * Each was repaired by hand, one file at a time. Repairing them one at a time is how the fifth one
 * gets missed, so this asks the question of the whole set: **for each committed reading, what turns
 * these bytes into a fact again?**
 *
 * ## Three answers, and what each one obliges
 *
 * | kind | what it says | what this tool checks |
 * | --- | --- | --- |
 * | `recomputed` | a job re-runs the probe on every push and compares | the named job exists in the named workflow, names this path, and names a location outside the checkout |
 * | `one-shot` | it was measured once, on purpose, and re-measuring costs something | the recorded hash equals the file's, so the bytes cannot be edited quietly |
 * | `input` | it is not a measurement at all; it is what a measurement reads | nothing but the reason, which is the point: it is the only kind that cannot rot |
 *
 * The middle row is the one that needed a decision. A one-shot reading is a legitimate artefact -- a
 * 62 MB benchmark report that is not checked in, a model that has to be downloaded from a mirror, a
 * Chromium page whose probe takes eleven seconds -- and pretending otherwise would mean either
 * deleting evidence the documents cite or adding a CI job that spends ¥14 per push. What is *not*
 * legitimate is a one-shot reading that has been edited since it was measured, because then it is a
 * number with a provenance nothing can check. So the hash is recorded, and `--check` refuses a file
 * whose bytes no longer match it. The fix when that fires is to re-measure and update the row, which
 * is precisely the work the row exists to make visible.
 *
 * ## What the population is
 *
 * Every committed `*.json` under a `test/` or `__tests__/` directory. That includes the fixtures,
 * which is deliberate: a JSON under a test directory is either a measurement or the input to one, and
 * a repository where that is not true is a repository where a reading can hide. There are 23 of them
 * and each is one line, so the cost of being exhaustive is a paragraph, not a policy.
 *
 * The walk is `git ls-files`, not the filesystem: a reading is evidence because it is *committed*,
 * and an untracked file in a working tree is a run, not evidence. `tools/readings-in-place.mjs` is
 * what objects to those.
 *
 * ## Why `--check` is not in the prose of the ledger
 *
 * Because a table of 23 hand-typed judgements is the thing that rots. This file derives the
 * population from the index and derives each `recomputed` claim from the workflow YAML, so the two
 * editable facts are "which job" and "why" -- and both are named in the failure.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');
const RECORD = 'tools/committed-readings.json';
const DOCUMENT = 'docs/COMMITTED-READINGS.md';

/** A path under a test directory: `test/` or `__tests__/`, at any depth. */
const IN_TEST_DIR = /(^|\/)(test|__tests__)\//;
const KINDS = new Set(['recomputed', 'one-shot', 'input']);
const SHA256 = /^[0-9a-f]{64}$/;

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value !== undefined && !value.startsWith('--') ? value : undefined;
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * The committed population: every tracked JSON under a test directory.
 *
 * A failure to read the index is fatal rather than empty. A census that silently audits zero files
 * reports `ok` and is the exact failure this file exists to find, one level up.
 */
function population(root) {
  let listing;
  try {
    listing = git(root, ['ls-files', '-z']);
  } catch (error) {
    throw new Error(`cannot read the index to find the readings: ${error.message}`);
  }
  const files = listing
    .split('\0')
    .filter((name) => name.length > 0)
    .filter((name) => name.endsWith('.json') && IN_TEST_DIR.test(name));
  if (files.length === 0) {
    throw new Error(`the index under ${root} lists no JSON under a test directory`);
  }
  return files.sort();
}

/**
 * The jobs of one workflow file, as indented blocks.
 *
 * A job key is a two-space-indented `name:` under a top-level `jobs:`; the block runs until the next
 * such key or the next top-level line. This is the subset of YAML GitHub requires, and parsing it
 * here rather than adding a YAML dependency keeps the tool's answer independent of whatever else the
 * lockfile holds: `js-yaml` is present as a transitive dependency today and hoisting assumptions are
 * how a gate starts failing for a reason nobody changed.
 *
 * Comment lines are dropped. That is not cosmetic: a path named in a comment is a path nothing runs,
 * and `§10.2`'s browser section had a comment describing a comparison step that did not exist.
 */
function jobBlocks(text) {
  const blocks = new Map();
  let inJobs = false;
  let current;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (!inJobs) {
      if (/^jobs:(\s|$)/.test(line)) inJobs = true;
      continue;
    }
    if (indent === 0) {
      inJobs = false;
      current = undefined;
      continue;
    }
    const job = /^ {2}([A-Za-z0-9_.-]+):(\s|$)/.exec(line);
    if (job !== null) {
      current = job[1];
      blocks.set(current, []);
      continue;
    }
    if (current !== undefined) blocks.get(current).push(line);
  }
  return blocks;
}

/** Whether a workflow still contains a job, and what that job's block says. */
function jobBlock(root, workflow, job, cache) {
  if (!cache.has(workflow)) {
    const file = path.join(root, workflow);
    cache.set(workflow, existsSync(file) ? jobBlocks(readFileSync(file, 'utf8')) : undefined);
  }
  const blocks = cache.get(workflow);
  if (blocks === undefined) return { error: `there is no ${workflow}` };
  const block = blocks.get(job);
  if (block === undefined) {
    const known = [...blocks.keys()].sort().join(', ');
    return { error: `${workflow} has no job "${job}" (it has: ${known})` };
  }
  return { block };
}

function sha256Of(root, relative) {
  return createHash('sha256')
    .update(readFileSync(path.join(root, relative)))
    .digest('hex');
}

/**
 * Whether any tracked code file names this path.
 *
 * Code, not documents: a markdown file mentioning `corpus.json` is a reader, not a re-derivation, and
 * the claim an `input` row makes is that something *runs* against it. `git grep` rather than a walk
 * because the index is the population the rest of this tool uses, and one subprocess per input is
 * nine subprocesses.
 *
 * The check is deliberately weak, and the weakness is worth stating because it is the difference
 * between a gate and a claim: it asks whether any tracked code file *names the file*, which a comment
 * satisfies and a path built from an f-string does not. A stronger question -- does a test open it? --
 * cannot be answered by a string search, and the weak version already earns its place: on its first
 * run it found `mr-roster-38953157688.json`, committed so `§13.40`'s table could be re-derived, named
 * in a comment, and opened by nothing. The repair was a test that re-derives the table, and the
 * fixture now appears in a literal tuple so the next reader can see what depends on it.
 */
function namedByCode(root, relative) {
  const name = path.basename(relative);
  try {
    return git(root, ['grep', '-F', '-l', '-e', name, '--', '*.ts', '*.mjs', '*.py'])
      .split('\n')
      .map((line) => line.trim())
      .some((file) => file.length > 0 && file !== relative);
  } catch {
    // `git grep` exits 1 when nothing matched, which is the answer this function exists to give.
    return false;
  }
}

/** Parse a reading, so a zero-byte or truncated file is a named failure rather than a passing row. */
function parse(root, relative) {
  const text = readFileSync(path.join(root, relative), 'utf8');
  if (text.trim().length === 0) {
    throw new Error(`${relative} is ${text.length} bytes: a reading that declares nothing`);
  }
  try {
    return { bytes: Buffer.byteLength(text), value: JSON.parse(text) };
  } catch (error) {
    throw new Error(`${relative} is not JSON: ${error.message}`);
  }
}

/**
 * Every disagreement between the tree and the record.
 *
 * Each problem is a sentence naming the file and what to do, because the reader of a red job is
 * usually not the person who added the reading.
 */
function disagreements(root) {
  const problems = [];
  const recordPath = path.join(root, RECORD);
  if (!existsSync(recordPath)) throw new Error(`there is no ${RECORD}`);
  let record;
  try {
    record = JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch (error) {
    throw new Error(`${RECORD} is not JSON: ${error.message}`);
  }
  const rows = record.rows;
  if (!Array.isArray(rows)) throw new Error(`${RECORD} has no "rows" array`);

  const files = population(root);
  const declared = new Map();
  for (const row of rows) {
    if (typeof row?.path !== 'string' || row.path.length === 0) {
      problems.push('a row has no "path"');
      continue;
    }
    if (declared.has(row.path)) problems.push(`${row.path} has two rows`);
    declared.set(row.path, row);
  }

  for (const file of files) {
    if (!declared.has(file)) {
      problems.push(
        `${file} is a JSON under a test directory and no row says what re-derives it: ` +
          'add it to ' +
          RECORD +
          ' as "recomputed", "one-shot" or "input"',
      );
    }
  }
  for (const file of declared.keys()) {
    if (!files.includes(file)) {
      problems.push(
        `there is a row for ${file}, which is not a committed JSON under a test directory`,
      );
    }
  }

  const cache = new Map();
  for (const file of files) {
    const row = declared.get(file);
    if (row === undefined) continue;
    if (!KINDS.has(row.kind)) {
      problems.push(`${file} has kind "${row.kind}"; it has to be one of ${[...KINDS].join(', ')}`);
      continue;
    }
    if (typeof row.why !== 'string' || row.why.trim().length < 20) {
      problems.push(`${file} needs a "why": one sentence saying how this reading stays true`);
    }
    try {
      parse(root, file);
    } catch (error) {
      problems.push(error.message);
      continue;
    }

    if (row.kind === 'recomputed') {
      if (row.sha256 !== undefined) {
        problems.push(
          `${file} is re-derived on every push, so a recorded hash would be wrong by the next one`,
        );
      }
      for (const key of ['workflow', 'job']) {
        if (typeof row[key] !== 'string' || row[key].length === 0) {
          problems.push(`${file} is re-derived by a job, so it needs a "${key}"`);
        }
      }
      if (typeof row.workflow !== 'string' || typeof row.job !== 'string') continue;
      const found = jobBlock(root, row.workflow, row.job, cache);
      if (found.error !== undefined) {
        problems.push(`${file}: ${found.error}`);
        continue;
      }
      if (!found.block.some((line) => line.includes(file))) {
        problems.push(
          `no step of job "${row.job}" in ${row.workflow} names ${file}, so that job does not ` +
            're-derive this reading',
        );
      }
      // A reading re-derived in place is the defect `readings-in-place.mjs` exists for: the fresh
      // file overwrites the evidence, and the comparison then has one file that agrees with itself.
      if (!found.block.some((line) => line.includes('/tmp/'))) {
        problems.push(
          `job "${row.job}" in ${row.workflow} never names a path outside the checkout, so the run ` +
            'it does writes over the reading it is supposed to be compared with',
        );
      }
    }

    if (row.kind === 'one-shot') {
      if (typeof row.sha256 !== 'string' || !SHA256.test(row.sha256)) {
        problems.push(
          `${file} is measured once, so it needs the "sha256" of the bytes that were measured ` +
            '(64 lowercase hex characters)',
        );
      } else {
        const actual = sha256Of(root, file);
        if (actual !== row.sha256) {
          problems.push(
            `${file} is not the file that was measured: recorded ${row.sha256.slice(0, 12)}..., ` +
              `on disk ${actual.slice(0, 12)}... -- re-measure it, or say why the edit keeps the ` +
              'claim true, and update the row',
          );
        }
      }
    }

    if (row.kind === 'input') {
      // `input` is the only kind whose truth is carried by something else, so it is the only kind
      // that could be a free pass. The obligation it does have: some code names the file, which is
      // what "the suite re-reads it on every push" means when it is true. An input nothing reads is
      // the same defect as a mechanism nothing calls, and it is cheaper to catch here than to
      // notice that a corpus has been sitting in the repository since a suite was deleted.
      if (!namedByCode(root, file)) {
        problems.push(
          `${file} is declared an input, and no tracked .ts, .mjs or .py file names it: ` +
            'an input nothing reads is not an input',
        );
      }
    }
  }

  return { problems, rows: declared, files };
}

function table(rows, files) {
  return files.map((file) => {
    const row = rows.get(file) ?? {};
    return {
      path: file,
      kind: row.kind ?? '(undeclared)',
      by: row.kind === 'recomputed' ? `\`${row.job}\` in ${path.basename(row.workflow ?? '')}` : '',
      how: row.why ?? '',
    };
  });
}

/** The date a reading last changed, for the terminal table only. */
function committedOn(root, file) {
  try {
    return git(root, ['log', '-1', '--format=%cs', '--', file]).trim();
  } catch {
    return '?';
  }
}

function markdown(entries) {
  const counts = entries.reduce(
    (acc, entry) => acc.set(entry.kind, (acc.get(entry.kind) ?? 0) + 1),
    new Map(),
  );
  const out = [];
  out.push('# Committed readings, and what re-derives each one');
  out.push('');
  out.push(
    'Generated by `node tools/readings-census.mjs --write`. Do not edit by hand: a row that is not in',
  );
  out.push('`tools/committed-readings.json` is a row that `pnpm readings:check` will refuse.');
  out.push('');
  out.push(
    'A reading is committed when a claim cannot be produced inside `pnpm check` -- a browser suite, a',
  );
  out.push(
    'model download, a 62 MB benchmark report that is not in the repository. Being committed',
  );
  out.push('makes it a claim with no expiry date, so each one says which of three things it is:');
  out.push('');
  out.push('| kind | meaning |');
  out.push('| --- | --- |');
  out.push(
    '| `recomputed` | a CI job re-runs the probe on every push, writes elsewhere, and compares |',
  );
  out.push(
    '| `one-shot` | measured once on purpose; the bytes are pinned by hash so they cannot be edited quietly |',
  );
  out.push('| `input` | not a measurement: the corpus or fixture a measurement reads |');
  out.push('');
  out.push(
    `${entries.length} readings: ` +
      [...counts.entries()]
        .map(([kind, count]) => `${count} ${kind}`)
        .sort()
        .join(', ') +
      '.',
  );
  out.push('');
  // No date column. A reading's last-commit date changes on the commit that touches it, so a document
  // carrying that date could never be checked against the tree: writing it before the commit records
  // the old date, and the check after the commit sees the new one. The date is in the terminal table
  // for a human asking "how old is this", where being one commit stale means nothing.
  out.push('| reading | kind | re-derived by | why this stays true |');
  out.push('| --- | --- | --- | --- |');
  for (const entry of entries) {
    out.push(`| \`${entry.path}\` | ${entry.kind} | ${entry.by} | ${entry.how} |`);
  }
  out.push('');
  return `${out.join('\n')}\n`;
}

/** `3 input, 18 one-shot, 2 recomputed` -- a fixed order, so two runs are diffable. */
function tally(kinds) {
  const counts = new Map();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...KINDS]
    .filter((kind) => counts.has(kind))
    .map((kind) => `${counts.get(kind)} ${kind}`)
    .join(', ');
}

function main() {
  const root = arg('repo') ?? process.env.READINGS_CENSUS_ROOT ?? DEFAULT_ROOT;
  const { problems, rows, files } = disagreements(root);

  const entries = table(rows, files);

  if (process.argv.includes('--check')) {
    // The document is generated from the same record, so a document that no longer matches it is a
    // second artefact claiming something the first one stopped saying -- which is the defect this
    // whole file is about, one level up. Comparing here rather than in a second tool keeps the two
    // in one place.
    const document = path.join(root, DOCUMENT);
    if (existsSync(document) && readFileSync(document, 'utf8') !== markdown(entries)) {
      problems.push(`${DOCUMENT} is not what the record generates: run pnpm readings:write`);
    }
    for (const problem of problems) console.log(`FAIL  ${problem}`);
    if (problems.length > 0) {
      process.exitCode = 1;
      return;
    }
    console.log(
      `ok    ${files.length} committed readings, each says what re-derives it: ` +
        tally([...rows.values()].map((row) => row.kind)),
    );
    return;
  }

  if (process.argv.includes('--write')) {
    const target = path.join(root, DOCUMENT);
    writeFileSync(target, markdown(entries));
    console.log(`wrote ${target} (${entries.length} readings)`);
    if (problems.length > 0) process.exitCode = 1;
    return;
  }

  for (const entry of entries) {
    const by = entry.by === '' ? '' : ` [${entry.by}]`;
    console.log(`${entry.kind.padEnd(10)} ${committedOn(root, entry.path)}  ${entry.path}${by}`);
  }
  console.log(`\n${entries.length} readings`);
  if (problems.length > 0) {
    console.log(`${problems.length} problem(s); run with --check to see them`);
  }
}

try {
  main();
} catch (error) {
  console.log(`FAIL  ${error.message}`);
  process.exitCode = 1;
}
