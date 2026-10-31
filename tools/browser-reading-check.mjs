#!/usr/bin/env node
/**
 * Does the committed browser reading still describe the tree, or is it an old run someone kept?
 *
 *     node tools/browser-reading-check.mjs --committed <last-run.json> --fresh <fresh-run.json>
 *
 * ## Why this exists
 *
 * `test/browser/last-run.json` and `last-run-firefox.json` are committed because they are the evidence
 * for `§10.2` gates 1 and 2: a browser gate cannot run in `pnpm check`, so its reading is an artefact
 * and the artefact is what the documents cite. An artefact has one failure mode a test does not: it can
 * stop describing the tree. The suite keeps passing, the file keeps saying `24/24`, and a check that
 * quietly stopped being asserted is indistinguishable from one that passes.
 *
 * The rewrite is the risky part. `page.html` builds the check list, so renaming a check there renames
 * it in the committed reading only when someone re-runs the probe by hand -- and CI, which does re-run
 * it, writes its own output somewhere else. This compares the two.
 *
 * ## What it does not compare
 *
 * The digest and the throughput numbers. The digest is a function of the row count, and CI runs fewer
 * rows than the committed 2,000 because a committed file is evidence and a CI job is a smoke test;
 * comparing them would force CI to spend two minutes proving arithmetic. Both readings are required to
 * say the digest matched **their own** rows, which is the property that matters: rows written before a
 * restart are the rows read after it.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value !== undefined && !value.startsWith('--') ? value : undefined;
}

function load(path, label) {
  if (path === undefined) {
    throw new Error(`--${label} is required`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read the ${label} reading at ${path}: ${error.message}`);
  }
}

function names(reading) {
  const checks = reading.checks;
  if (!Array.isArray(checks)) {
    throw new Error('a reading without a `checks` array cannot be compared');
  }
  return checks.map((check) => check.name);
}

/**
 * The comparisons, in the order a reader would ask them.
 *
 * Each returns a message on disagreement or `undefined` on agreement, so the caller can print all of
 * them rather than the first: two differences are a different problem from one.
 */
function disagreements(committed, fresh) {
  const problems = [];

  const committedNames = names(committed);
  const freshNames = names(fresh);
  if (committedNames.length === freshNames.length) {
    committedNames.forEach((name, index) => {
      if (freshNames[index] !== name) {
        problems.push(
          `check ${index + 1} is "${name}" in the committed reading and "${freshNames[index]}" in this run`,
        );
      }
    });
  } else {
    problems.push(
      `the committed reading has ${committedNames.length} checks and this run has ${freshNames.length}`,
    );
    for (const extra of freshNames.filter((name) => !committedNames.includes(name))) {
      problems.push(`new check "${extra}"`);
    }
    for (const missing of committedNames.filter((name) => !freshNames.includes(name))) {
      problems.push(`check "${missing}" was not asserted by this run`);
    }
  }

  if (committed.summary?.failed !== 0) {
    problems.push(
      `the committed reading itself records ${committed.summary?.failed} failed checks`,
    );
  }
  if (fresh.summary?.failed !== 0) {
    problems.push(`this run records ${fresh.summary?.failed} failed checks`);
  }
  if (fresh.summary?.digestMatches !== true) {
    problems.push('this run did not read back the digest it wrote');
  }

  // The tier is a criterion, not a detail: a reading taken on the IndexedDB fallback would still print
  // 24 passes, and every one of them would be about a different storage engine than the file claims.
  for (const [label, reading] of [
    ['the committed reading', committed],
    ['this run', fresh],
  ]) {
    const tier = reading.phases?.write?.tier;
    if (tier !== 'opfs') {
      problems.push(`${label} wrote on ${tier ?? 'no recorded tier'}, not opfs`);
    }
  }

  return problems;
}

function main() {
  const committed = load(arg('committed'), 'committed');
  const fresh = load(arg('fresh'), 'fresh');
  const problems = disagreements(committed, fresh);

  for (const problem of problems) console.log(`FAIL  ${problem}`);
  if (problems.length === 0) {
    console.log(
      `ok    the committed reading still describes this tree: ${names(committed).length} checks, ` +
        `identical in order and string, both on opfs, both digest-matched`,
    );
    return;
  }
  process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.log(`FAIL  ${error.message}`);
  process.exitCode = 1;
}
