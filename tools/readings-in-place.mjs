#!/usr/bin/env node
/**
 * Fail when the suites left a file behind in the checkout.
 *
 *     node tools/readings-in-place.mjs [--repo <dir>]
 *
 * ## Why this is a separate tool and not four lines in the workflow
 *
 * The browser suites write a JSON reading each: `last-run.json`, `last-run-firefox.json`,
 * `corpus-run.json`, `bundle-run.json`. All four are committed, because they are the evidence for
 * `§10.2` gates 1 and 2 and a browser gate cannot run in `pnpm check`. Every one of them is
 * overridable by an environment variable so that a run can write somewhere else, and the comparison
 * step then has two files to compare -- the committed one and the fresh one.
 *
 * `CORTEX_RESULTS_BUNDLE` was defined for exactly that purpose and set nowhere. The consequence was
 * not an error: CI re-ran the bundle probe, the probe wrote over the committed `bundle-run.json`, the
 * comparison step that did not exist ran against nothing, and the artifact upload showed the fresh
 * file where the evidence had been. A suite writing into the checkout is the *silent* form of an
 * un-compared reading, and it is indistinguishable from a passing run -- every step green, every
 * number in the documents now describing a run that is no longer in the repository.
 *
 * So the property is stated once, where it can be asserted: **on a clean checkout, running the
 * suites changes no tracked file.** CI checks it after the suites, and a fifth probe that forgets its
 * override is caught on the run that introduces it rather than by a reader diffing JSON by hand.
 *
 * ## Why it is not in `pnpm check`
 *
 * A developer's tree is dirty by definition; this would fail on every uncommitted edit and be deleted
 * within a week. It is meaningful only where the checkout starts clean, which is CI. That is a
 * property of the *caller*, so it is stated here rather than inferred by the tool: the tool answers
 * "did this checkout change", and the workflow is what knows the answer should be no.
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value !== undefined && !value.startsWith('--') ? value : undefined;
}

/**
 * Tracked changes and new files, but not ignored ones.
 *
 * Ignored paths are the build's own output (`dist/`, `.turbo/`) and they are supposed to appear; a
 * check that refused them would refuse every run. Untracked non-ignored paths are included because a
 * probe writing a new file is the same defect as a probe rewriting a committed one.
 */
function changesIn(repo) {
  const porcelain = execFileSync('git', ['status', '--porcelain'], {
    cwd: repo,
    encoding: 'utf8',
  });
  return porcelain
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function main() {
  const repo = arg('repo') ?? process.cwd();
  const changes = changesIn(repo);

  if (changes.length === 0) {
    console.log(
      'ok    the checkout is unchanged: no suite wrote a reading back into the repository',
    );
    return;
  }

  console.log(`FAIL  ${changes.length} path(s) changed while the suites ran:`);
  for (const change of changes) console.log(`      ${change}`);
  console.log(
    '\nA reading regenerated in place is not compared by anything: the comparison needs the committed\n' +
      'file and a fresh one, and writing the fresh one over the committed one leaves a single file that\n' +
      'always agrees with itself. Point the probe somewhere else -- `CORTEX_RESULTS`,\n' +
      '`CORTEX_RESULTS_CORPUS`, `CORTEX_RESULTS_BUNDLE`, `CORTEX_RESULTS_TWO_TAB`,\n' +
      '`CORTEX_RESULTS_QUOTA` or `CORTEX_RESULTS_INCOGNITO` -- and let the run be\n' +
      'compared.',
  );
  process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.log(`FAIL  could not read the checkout state: ${error.message}`);
  process.exitCode = 1;
}
