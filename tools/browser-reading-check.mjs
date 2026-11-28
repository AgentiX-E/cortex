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
 * ## The two sides, and what each caller may say afterwards
 *
 * The verdict names both files, because the same tool is invoked for two different questions:
 *
 *   * In `verify.yml` the fresh side is a run of **this** tree (`/tmp/fresh-*.json`), so a disagreement
 *     means the committed reading has stopped describing the code. That is the question the tool was
 *     written for.
 *   * In `pnpm check` the fresh side is `last-run-firefox.json` -- a second *committed* artefact. No
 *     browser runs, so nothing about the tree is tested there; what is tested is that two engines
 *     assert the same check list in the same order. Both are worth asserting and they are not the same
 *     claim, so the verdict prints the paths it read instead of a sentence about "the tree". Earlier
 *     versions printed `the committed reading still describes this tree` in both cases, which was true
 *     in CI and unearned locally.
 *
 * ## Where a reading records its tier
 *
 * Not in one place, because the suites record it in different shapes: the restart and corpus suites
 * open the tier as a phase, so it lands at `phases.write.tier`; the bundle suite opens it through a
 * bundled worker and records it as a fact about the bundle, at `facts.tier`. Reading only the first
 * shape is why this file could not be pointed at `bundle-run.json` at all -- and that reading went
 * un-compared by anything until someone noticed, which is the failure mode this file exists to
 * prevent, one level up.
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
 * Every place a reading in this repository records the tier it wrote on, in the order to try them.
 *
 * Two entries rather than a walk: a walk would also find `phases.matrix.tiers.idb.tier`, which is the
 * IndexedDB tier the matrix opens *on purpose*, and reporting `idb` for a correct reading is a worse
 * failure than reporting nothing. The keys are named here so a fourth suite has to add a line rather
 * than hope its shape is guessed right.
 */
const TIER_PATHS = [
  ['phases', 'write', 'tier'],
  ['facts', 'tier'],
];

/** The tier a reading says it wrote on, or `undefined` if it says nothing this file can read. */
function tierOf(reading) {
  for (const path of TIER_PATHS) {
    let node = reading;
    for (const key of path) node = node?.[key];
    if (typeof node === 'string') return node;
  }
  return undefined;
}

/**
 * Whether a reading says the digest it wrote is the digest it read back, or `undefined` if it says
 * nothing this file can read.
 *
 * Three files, three shapes, for the same reason as the tier: the restart and corpus suites run twice
 * and record `summary.digestMatches`; the bundle suite runs once, so the page compares the two numbers
 * itself and records them as `facts.roundTrip.written` and `.read`. Reading only `summary` would have
 * made the bundle reading fail a criterion it satisfies -- and the tempting repair, dropping the
 * criterion for readings without `summary`, would have removed the one property that proves the round
 * trip was a round trip.
 */
const DIGEST_PROOFS = [
  // The restart and corpus suites: two launches, so the suite compares the digests and records a flag.
  (reading) =>
    typeof reading.summary?.digestMatches === 'boolean' ? reading.summary.digestMatches : undefined,
  // The bundle suite: one launch, so the page compares the two numbers itself.
  (reading) => {
    const trip = reading.facts?.roundTrip;
    if (typeof trip?.written !== 'number' || typeof trip?.read !== 'number') return undefined;
    return trip.written === trip.read;
  },
];

function digestHeld(reading) {
  for (const proof of DIGEST_PROOFS) {
    const verdict = proof(reading);
    if (verdict !== undefined) return verdict;
  }
  return undefined;
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
  // Both sides, not just the fresh one: the verdict below claims "both digest-matched", and a committed
  // artefact is exactly the file that can stop describing the tree while still printing 24/24. The
  // committed side's failed count and tier are already checked above; the digest was the one criterion
  // applied only to fresh, so a committed reading whose round trip never held was waved through.
  if (digestHeld(committed) !== true) {
    problems.push('the committed reading did not read back the digest it wrote');
  }
  if (digestHeld(fresh) !== true) {
    problems.push('this run did not read back the digest it wrote');
  }

  // The tier is a criterion, not a detail: a reading taken on the IndexedDB fallback would still print
  // 24 passes, and every one of them would be about a different storage engine than the file claims.
  for (const [label, reading] of [
    ['the committed reading', committed],
    ['this run', fresh],
  ]) {
    const tier = tierOf(reading);
    if (tier === undefined) {
      problems.push(`${label} records no tier anywhere this check can read`);
    } else if (tier !== 'opfs') {
      problems.push(`${label} wrote on ${tier}, not opfs`);
    }
  }

  return problems;
}

function main() {
  const committedPath = arg('committed');
  const freshPath = arg('fresh');
  const committed = load(committedPath, 'committed');
  const fresh = load(freshPath, 'fresh');
  const problems = disagreements(committed, fresh);

  for (const problem of problems) console.log(`FAIL  ${problem}`);
  if (problems.length === 0) {
    // Both paths, not a claim about the tree: see "The two sides" above. A reader who sees
    // `pnpm check --fresh .../last-run-firefox.json` in this line knows no browser ran.
    console.log(
      `ok    ${freshPath} agrees with ${committedPath}: ${names(committed).length} checks, ` +
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
