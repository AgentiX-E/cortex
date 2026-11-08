#!/usr/bin/env node
/**
 * The coverage gate, per file and per dimension.
 *
 * ## What the threshold it replaces could not say
 *
 * Every package's `vitest.config.ts` carries `thresholds: { statements: 95, branches: 95,
 * functions: 95, lines: 95 }`, and those numbers are compared against the **package mean**. A mean
 * is an average over files, so one file at 60% and forty at 100% clears it with room to spare, and
 * the gate reports `PASS`. That is not hypothetical. On the first run of this tool against this
 * repository, `@agentix-e/cortex-ai` read 98.38 / 97.55 / 96.55 / 98.48 at the package level and
 * passed, while `src/llm/openai-compatible.ts` — the adapter every remote provider goes through —
 * read **86.27 / 84.21 / 84.62 / 85.42**. Sixteen files were below the floor on some dimension.
 *
 * The mean also hides the **denominator**. `coverage.include` is a glob, and a file that never
 * loads contributes nothing to the mean rather than a failure. `cortex-core` reported one file
 * while its `src/` held forty-one, because the report on disk came from a filtered run; the
 * package mean over that report was `100.00` on all four dimensions and meant nothing at all. No
 * threshold can catch this, because the missing files are not in the arithmetic.
 *
 * ## The four rules
 *
 *  1. **Census.** Every `src/**` TypeScript file the package ships must appear in the report, or be
 *     recorded in the baseline's `exempt` map, with its kind and a reason. A file that is absent
 *     cannot fail a threshold, so absence is the violation.
 *  2. **`0/0` is not a pass.** A report entry with zero statements, branches, functions and lines
 *     has nothing to execute: a barrel of `export … from`, an interfaces-only module. It reads as
 *     100% in every reporter. It is either recorded as `nothing-to-execute` with the reason, or it
 *     is a file the instrumenter silently failed on — and only the record distinguishes them.
 *  3. **Floor.** Every file, on every dimension, at `>= 95`.
 *  4. **Ratchet.** A file may not fall below the rate the baseline records for it. Without this
 *     every repair is free to be undone by the next commit that touches the file.
 *
 * Rule 3 is the one that needs the ratchet to be honest. A file at 92 today would fail rule 3 on
 * the day the gate lands, and a gate that is red on the day it lands gets deleted or exempted. So
 * the baseline records today's debt **once**, in a diff a reader can audit, and then:
 *
 *   - the file's floor becomes its own recorded rate (rule 4), which is stricter than 95 for a file
 *     at 97 and no looser than yesterday for a file at 92;
 *   - a file with **no** baseline entry is floor-95 with no exceptions, so new code cannot arrive as
 *     debt;
 *   - `--write-baseline` refuses to record a new below-floor file unless `--accept-debt` is passed,
 *     and refuses to lower a recorded rate unless `--allow-lower` is passed. Both print what they
 *     accepted, so the audit trail is the command line rather than a convention;
 *   - every below-floor file is printed under `debt` on every run, green or red. A gate that hides
 *     its debt until the debt blocks a release is the gate this file replaces.
 *
 * ## Integer arithmetic, and why not percentages
 *
 * Rates are compared as `covered / total` against `covered / total` by cross-multiplication, never
 * by converting to a float first. `98.455` against a recorded `98.45` is a comparison of two
 * roundings of two different rationals, and the winner then depends on the third decimal place of a
 * number nobody printed. Counts are also what a reader can re-derive from the report by hand, which
 * is the property `verify.yml`'s "every claimed number is re-derivable" note asks for.
 *
 * ## Usage
 *
 *   node tools/coverage-per-file.mjs                     # check (also the default)
 *   node tools/coverage-per-file.mjs --table             # print every file, not only violations
 *   node tools/coverage-per-file.mjs --write-baseline    # record today's counts
 *   node tools/coverage-per-file.mjs --package cortex-eval
 *
 * Exit code is 0 only when every rule above holds; 2 when the invocation itself is wrong.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const DIMENSIONS = ['statements', 'branches', 'functions', 'lines'];
const FLOOR = 95;
const KINDS = new Set(['nothing-to-execute', 'not-instrumented']);

/** Source paths that are never instrumented, matched against the path inside the package. */
const NOT_ENUMERATED = [/\.d\.ts$/, /(^|\/)__tests__(\/|$)/];

function parseArgs(argv) {
  const options = {
    mode: 'check',
    table: false,
    packages: [],
    root: REPO,
    baseline: null,
    acceptDebt: false,
    allowLower: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') options.mode = 'check';
    else if (argument === '--write-baseline') options.mode = 'write';
    else if (argument === '--table') options.table = true;
    else if (argument === '--accept-debt') options.acceptDebt = true;
    else if (argument === '--allow-lower') options.allowLower = true;
    else if (argument === '--package') {
      const value = argv[index + 1];
      if (!value) throw new Error('--package needs a name');
      options.packages.push(value);
      index += 1;
    } else if (argument === '--root') {
      const value = argv[index + 1];
      if (!value) throw new Error('--root needs a path');
      options.root = resolve(value);
      index += 1;
    } else if (argument === '--baseline') {
      const value = argv[index + 1];
      if (!value) throw new Error('--baseline needs a path');
      options.baseline = resolve(value);
      index += 1;
    } else {
      throw new Error(`unrecognised argument ${argument}`);
    }
  }
  options.baseline ??= join(options.root, 'tools', 'coverage-per-file-baseline.json');
  return options;
}

/**
 * The four counts for one report entry, as `[covered, total]`.
 *
 * Branches are the one that is not `Object.values().length`: istanbul stores one array per branch
 * point holding a count per arm, so the total is the sum of the array lengths, and a branch point
 * with one arm taken is `[1, 2]` rather than a single hit.
 *
 * Lines are derived from `statementMap`, because the report does not carry them: a line counts as
 * covered when any statement starting on it executed, which is the rule istanbul's own line
 * reporter applies. Deriving rather than trusting is deliberate — the arithmetic here is checked
 * against the package means vitest prints, and the two agree at the printed precision.
 */
function countsOf(entry) {
  const statements = [0, 0];
  for (const hits of Object.values(entry.s ?? {})) {
    statements[1] += 1;
    if (hits > 0) statements[0] += 1;
  }
  const functions = [0, 0];
  for (const hits of Object.values(entry.f ?? {})) {
    functions[1] += 1;
    if (hits > 0) functions[0] += 1;
  }
  const branches = [0, 0];
  for (const arms of Object.values(entry.b ?? {})) {
    for (const hits of arms) {
      branches[1] += 1;
      if (hits > 0) branches[0] += 1;
    }
  }
  const perLine = new Map();
  for (const [id, location] of Object.entries(entry.statementMap ?? {})) {
    const line = location.start.line;
    perLine.set(line, (perLine.get(line) ?? 0) + (entry.s?.[id] > 0 ? 1 : 0));
  }
  const lines = [0, 0];
  for (const hits of perLine.values()) {
    lines[1] += 1;
    if (hits > 0) lines[0] += 1;
  }
  return { statements, branches, functions, lines };
}

function isNothingToExecute(counts) {
  return DIMENSIONS.every((dimension) => counts[dimension][1] === 0);
}

/** `covered / total < floor / 100`, in integers. A `0/0` rate is not below anything. */
function belowFloor([covered, total], floor = FLOOR) {
  if (total === 0) return false;
  return covered * 100 < floor * total;
}

/** `current < baseline` as rationals: `c1/t1 < c2/t2` iff `c1*t2 < c2*t1`, when both totals are positive. */
function rateBelow([[c1, t1], [c2, t2]]) {
  if (t1 === 0 || t2 === 0) return false;
  return c1 * t2 < c2 * t1;
}

function percent([covered, total]) {
  if (total === 0) return '     -';
  return ((100 * covered) / total).toFixed(2).padStart(6);
}

function walk(directory, out = []) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

function packageNames(root) {
  const packagesDir = join(root, 'packages');
  return readdirSync(packagesDir)
    .filter((name) => existsSync(join(packagesDir, name, 'vitest.config.ts')))
    .sort();
}

function emptyBaseline() {
  return { policy: { floor: FLOOR, dimensions: DIMENSIONS }, exempt: {}, files: {} };
}

function loadBaseline(path) {
  if (!existsSync(path)) return emptyBaseline();
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const baseline = {
    policy: parsed.policy ?? { floor: FLOOR, dimensions: DIMENSIONS },
    exempt: parsed.exempt ?? {},
    files: parsed.files ?? {},
  };
  for (const [key, value] of Object.entries(baseline.exempt)) {
    // An untyped exemption is a note, not a rule: it cannot say whether the file is absent because
    // it has no code or absent because the report never saw it, and those are different failures.
    if (typeof value !== 'object' || !KINDS.has(value.kind) || !value.reason) {
      throw new Error(`baseline exemption ${key} needs {kind, reason}, with kind in ${[...KINDS].join('|')}`);
    }
  }
  return baseline;
}

function readPackage(root, name) {
  const packageDir = join(root, 'packages', name);
  const reportPath = join(packageDir, 'coverage', 'coverage-final.json');
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
  const inReport = new Map();
  for (const [absolute, entry] of Object.entries(report ?? {})) {
    inReport.set(relative(packageDir, absolute).split(sep).join('/'), countsOf(entry));
  }
  const sourceDir = join(packageDir, 'src');
  const onDisk = existsSync(sourceDir)
    ? walk(sourceDir)
        .map((path) => `src/${relative(sourceDir, path).split(sep).join('/')}`)
        .filter((path) => path.endsWith('.ts'))
        .filter((path) => !NOT_ENUMERATED.some((pattern) => pattern.test(path)))
    : [];
  return { name, reportPath, hasReport: report !== null, inReport, onDisk };
}

function check(options) {
  const baseline = loadBaseline(options.baseline);
  const names = options.packages.length ? options.packages : packageNames(options.root);
  const violations = [];
  const debt = [];
  const rows = [];
  let measuredFiles = 0;

  for (const name of names) {
    const pkg = readPackage(options.root, name);
    if (!pkg.hasReport) {
      violations.push(
        `${name}: no report at ${relative(options.root, pkg.reportPath)}. The gate would measure ` +
          'nothing, which is the state a missing `json` reporter and a skipped test run both arrive in.',
      );
      continue;
    }
    const seen = new Set();
    for (const path of pkg.onDisk) {
      const key = `${name}/${path}`;
      seen.add(key);
      const exemption = baseline.exempt[key];
      const counts = pkg.inReport.get(path);
      if (!counts) {
        if (exemption?.kind !== 'not-instrumented') {
          violations.push(
            `${key}: absent from the report and not recorded as not-instrumented. A file the ` +
              'instrumenter never saw cannot fail a threshold, so absence is the violation.',
          );
        }
        continue;
      }
      const empty = isNothingToExecute(counts);
      if (empty) {
        if (exemption?.kind !== 'nothing-to-execute') {
          violations.push(
            `${key}: 0 statements, 0 branches, 0 functions, 0 lines, and not recorded as ` +
              'nothing-to-execute. A 0/0 entry reads as 100% and means the opposite.',
          );
        }
        continue;
      }
      if (exemption) {
        // The exemption outlived its cause: the file now has code, and every rule below applies to
        // it. Silence here would exempt a file from the gate by having once been empty.
        violations.push(
          `${key}: exempt as ${exemption.kind} but the report now carries ${counts.statements[1]} ` +
            'statements. An exemption that outlives its cause hides the file it was written for.',
        );
        continue;
      }
      measuredFiles += 1;
      const floor = baseline.files[key];
      for (const dimension of DIMENSIONS) {
        const current = counts[dimension];
        if (current[1] === 0) continue;
        if (floor && rateBelow([current, floor[dimension]])) {
          violations.push(
            `${key} ${dimension}: ${current[0]}/${current[1]} (${percent(current).trim()}%) is below ` +
              `the recorded ${floor[dimension][0]}/${floor[dimension][1]} ` +
              `(${percent(floor[dimension]).trim()}%). The floor is a floor; the ratchet is what ` +
              'makes 100% reachable.',
          );
        } else if (!floor && belowFloor(current)) {
          violations.push(
            `${key} ${dimension}: ${current[0]}/${current[1]} (${percent(current).trim()}%) is below ` +
              `the ${FLOOR}% floor and has no baseline entry. New code may not be admitted as debt.`,
          );
        } else if (floor && belowFloor(floor[dimension])) {
          debt.push(
            `${key} ${dimension}: ${percent(current).trim()}% (recorded ${percent(floor[dimension]).trim()}%, floor ${FLOOR})`,
          );
        }
      }
      rows.push({ key, counts });
    }
    for (const key of Object.keys(baseline.exempt)) {
      if (!key.startsWith(`${name}/`)) continue;
      const path = key.slice(name.length + 1);
      if (!pkg.onDisk.includes(path)) {
        violations.push(
          `${key}: recorded as ${baseline.exempt[key].kind} but no such source file exists. A stale ` +
            'exemption is how a directory of unmeasured files accumulates.',
        );
      } else if (baseline.exempt[key].kind === 'nothing-to-execute' && !pkg.inReport.has(path)) {
        violations.push(
          `${key}: recorded as nothing-to-execute but absent from the report. Nothing-to-execute is ` +
            'a fact about an entry; a missing entry is a different failure.',
        );
      }
    }
  }

  if (options.table) {
    for (const row of rows) {
      const cells = DIMENSIONS.map(
        (dimension) => `${dimension.slice(0, 4)} ${percent(row.counts[dimension])}`,
      ).join('  ');
      process.stdout.write(`  ${row.key.padEnd(52)} ${cells}\n`);
    }
    process.stdout.write('\n');
  }

  for (const name of names) {
    const row = rows.filter((entry) => entry.key.startsWith(`${name}/`));
    if (row.length === 0) continue;
    const cells = DIMENSIONS.map((dimension) => {
      const total = row.reduce(
        (accumulator, entry) => [
          accumulator[0] + entry.counts[dimension][0],
          accumulator[1] + entry.counts[dimension][1],
        ],
        [0, 0],
      );
      return `${dimension.slice(0, 4)} ${percent(total)}`;
    }).join('  ');
    process.stdout.write(`  ${name.padEnd(16)} ${String(row.length).padStart(3)} files  ${cells}\n`);
  }

  if (debt.length) {
    process.stdout.write(`\ndebt (${debt.length} below-floor readings, ratcheted, not waived)\n`);
    for (const line of debt) process.stdout.write(`  ${line}\n`);
  }

  if (violations.length) {
    process.stdout.write(`\n${violations.length} violation(s)\n`);
    for (const line of violations) process.stdout.write(`  ${line}\n`);
    return { code: 1, violations, debt, measuredFiles };
  }
  process.stdout.write(
    `\nok: ${measuredFiles} files gated on ${DIMENSIONS.length} dimensions, ` +
      `${Object.keys(baseline.exempt).length} exempt, ${debt.length} ratcheted\n`,
  );
  return { code: 0, violations, debt, measuredFiles };
}

function writeBaseline(options) {
  const path = options.baseline;
  const previous = loadBaseline(path);
  const names = options.packages.length ? options.packages : packageNames(options.root);
  const files = {};
  const lowered = [];
  const admitted = [];
  const debt = [];

  for (const name of names) {
    const pkg = readPackage(options.root, name);
    if (!pkg.hasReport) throw new Error(`${name}: no report; run that package's tests with coverage first`);
    for (const sourcePath of pkg.onDisk) {
      const key = `${name}/${sourcePath}`;
      const counts = pkg.inReport.get(sourcePath);
      if (!counts || isNothingToExecute(counts)) continue;
      if (key in previous.exempt) continue;
      files[key] = counts;
      const floor = previous.files[key];
      if (floor) {
        for (const dimension of DIMENSIONS) {
          if (rateBelow([counts[dimension], floor[dimension]])) {
            lowered.push(
              `${key} ${dimension}: ${percent(floor[dimension]).trim()}% -> ${percent(counts[dimension]).trim()}%`,
            );
          }
        }
      }
      const below = DIMENSIONS.filter((dimension) => belowFloor(counts[dimension], 100));
      if (below.length) {
        debt.push(`${key}: ${below.map((dimension) => `${dimension} ${percent(counts[dimension]).trim()}%`).join(', ')}`);
      }
      if (!floor && DIMENSIONS.some((dimension) => belowFloor(counts[dimension]))) admitted.push(key);
    }
  }

  if (lowered.length && !options.allowLower) {
    process.stdout.write(`${lowered.length} recorded rate(s) would fall\n`);
    for (const line of lowered) process.stdout.write(`  ${line}\n`);
    throw new Error('refusing to lower a recorded rate without --allow-lower');
  }
  if (admitted.length && !options.acceptDebt) {
    process.stdout.write(`${admitted.length} file(s) with no baseline entry are below the floor\n`);
    for (const line of admitted) process.stdout.write(`  ${line}\n`);
    throw new Error('refusing to record new debt without --accept-debt');
  }
  for (const line of lowered) process.stdout.write(`  lowered  ${line}\n`);
  for (const line of admitted) process.stdout.write(`  admitted ${line}\n`);

  const sortedFiles = {};
  for (const key of Object.keys(files).sort()) sortedFiles[key] = files[key];
  const payload = {
    policy: {
      floor: FLOOR,
      dimensions: DIMENSIONS,
      note:
        'Counts, not rates: the gate compares covered/total by cross-multiplication so no comparison ' +
        'goes through a float. Regenerate with tools/coverage-per-file.mjs --write-baseline, which ' +
        'refuses to lower a recorded rate or admit new debt without being told to.',
    },
    exempt: Object.fromEntries(Object.keys(previous.exempt).sort().map((key) => [key, previous.exempt[key]])),
    files: sortedFiles,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(
    `wrote ${relative(options.root, path)}: ${Object.keys(sortedFiles).length} files, ` +
      `${debt.length} below 100%, ${lowered.length} lowered, ${admitted.length} admitted\n`,
  );
  return 0;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
    return options.mode === 'write' ? writeBaseline(options) : check(options).code;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
