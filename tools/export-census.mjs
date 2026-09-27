#!/usr/bin/env node
/**
 * The caller census, as a command.
 *
 * Reports every exported symbol in `packages/<pkg>/src/**` that no non-test,
 * non-barrel source file references. Such a symbol cannot be doing any work in
 * production: nothing calls it. See `packages/cortex-core/src/export-census.ts`
 * for why this measurement exists and what it deliberately does not claim.
 *
 * Usage:
 *   node tools/export-census.mjs            # report orphans, exit 0
 *   node tools/export-census.mjs --check    # fail on any orphan not in the baseline
 *   node tools/export-census.mjs --json     # machine-readable, for the record
 *
 * The `--check` mode compares against `tools/export-census-baseline.json`. That
 * baseline is a debt ledger, not an allowlist: it records orphans that existed
 * when the gate was introduced and that the roadmap has not yet adjudicated.
 * The gate's job is to stop NEW orphans from appearing silently, which is the
 * defect that let B7's annotation producer ship with no callers.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  censusPackage,
  buildCensusReport,
  listOrphans,
} from '../packages/cortex-core/dist/export-census.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const BASELINE_PATH = join(HERE, 'export-census-baseline.json');

/** Recursively collects files under `dir`, skipping build output and deps. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * Reads every source file the census should consider: each package's `src` tree
 * for declarations, plus the tool scripts as callers.
 *
 * The tool scripts import from the packages' `dist` output, so they are
 * production consumers of the exported API. Without them the census reports its
 * own public surface as orphaned.
 */
function readAllSources() {
  const packagesDir = join(REPO_ROOT, 'packages');
  const fromPackages = readdirSync(packagesDir).flatMap((packageName) =>
    walk(join(packagesDir, packageName, 'src'))
      .filter((path) => /\.tsx?$/.test(path))
      .map((path) => ({ path: relative(REPO_ROOT, path), text: readFileSync(path, 'utf8') })),
  );
  const fromTools = walk(join(REPO_ROOT, 'tools'))
    .filter((path) => /\.mjs$/.test(path))
    .map((path) => ({ path: relative(REPO_ROOT, path), text: readFileSync(path, 'utf8') }));
  return [...fromPackages, ...fromTools];
}

/**
 * Censuses each package, but searches for callers repository-wide.
 *
 * The whole file list goes to every `censusPackage` call, because a symbol
 * exported by one package is regularly called by another across the workspace
 * boundary. Scoping the search to the declaring package would report every
 * cross-package use as an orphan.
 */
function readSources() {
  const all = readAllSources();
  const packageNames = [
    ...new Set(
      all
        .filter((file) => file.path.startsWith('packages/'))
        .map((file) => file.path.split('/')[1]),
    ),
  ].sort();
  return packageNames.map((packageName) => censusPackage(packageName, all));
}

/** The stable identity of an orphan, used to match it against the baseline. */
function orphanKey(line) {
  // `pkg: name (file:line)` -> `pkg: name`, so that moving the declaration to a
  // different line does not make a known orphan look brand new.
  const match = /^([^:]+): ([^(]+) \(/.exec(line);
  return match === null ? line : `${match[1]}: ${match[2]}`;
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const json = argv.includes('--json');

  const report = buildCensusReport(readSources());
  const orphans = listOrphans(report);

  if (json) {
    process.stdout.write(`${JSON.stringify({ report, orphans }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(
    `export census: ${report.totalSymbols} exported symbols, ` +
      `${report.totalSymbols - report.orphanCount} with a non-test caller, ` +
      `${report.orphanCount} orphaned\n`,
  );

  if (orphans.length === 0) {
    process.stdout.write('no orphans: every exported symbol has a non-test caller\n');
    return 0;
  }

  process.stdout.write(`\n${orphans.length} orphaned export(s):\n`);
  for (const line of orphans) process.stdout.write(`  ${line}\n`);

  if (!check) {
    process.stdout.write('\n(report only; pass --check to enforce)\n');
    return 0;
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const known = new Set(baseline.knownOrphans.map(orphanKey));
  const fresh = orphans.filter((line) => !known.has(orphanKey(line)));

  if (fresh.length === 0) {
    process.stdout.write('\nno new orphans beyond the recorded baseline\n');
    return 0;
  }

  process.stdout.write(`\n${fresh.length} NEW orphan(s) not in the baseline:\n`);
  for (const line of fresh) process.stdout.write(`  ${line}\n`);
  process.stdout.write(
    '\nA new orphan is an export nothing calls. Either wire it to a caller, ' +
      'delete it, or add it to tools/export-census-baseline.json with a reason ' +
      'and a roadmap reference.\n',
  );
  return 1;
}

process.exit(main());
