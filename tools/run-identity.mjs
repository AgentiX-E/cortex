#!/usr/bin/env node
/**
 * Which commit produced this run, and does it carry the code the number is attributed to?
 *
 *     node tools/run-identity.mjs --run 40984213349            # live: gh + git
 *     node tools/run-identity.mjs --record run-40984213349.json # replayable: two blob maps
 *     node tools/run-identity.mjs --record x.json --emit y.json # not used by --record; see below
 *
 * ## Why the artifact cannot answer this itself
 *
 * The memory arm writes `memoryArmConfig` into every report, and a report whose `queryExpansion` reads
 * `window` is evidence that the process parsed that value -- which, as `readQueryExpansion` demonstrates
 * by refusing anything else, does mean the string was in the source. What it does *not* mean is that the
 * rest of the mechanism was: §13.153.10 records a dispatch issued against a branch seven commits behind
 * the feature, and the run died only because the one value it was told to read did not exist yet. Had the
 * arm been told `none` -- which is what a treatment dispatch looks like when the input is dropped rather
 * than rejected -- it would have produced a complete, plausible, correctly-configured artifact of the
 * control pipeline under the treatment's name.
 *
 * So the check cannot be on the output. It has to be on the commit, before the output is read, and the
 * campaign has paid for the absence of it twice: §13.110 records two artifacts 7.20 points apart with
 * identical config blocks, and §13.153.10 records a cancelled run.
 *
 * ## Why the comparison is content and not SHA
 *
 * A SHA comparison is the obvious form and it is wrong here. This repository is pushed through the Git
 * Data API, which rebuilds the commit and its tree, re-rooting identical blobs under a new tree object --
 * `push-via-api.py` says so and verifies content rather than trees for that reason. The local `HEAD` and
 * the remote commit therefore have **different SHAs for byte-identical content**, so `local SHA == run
 * head_sha` would report `MISMATCH` on every correct dispatch and `MATCH` only by coincidence.
 *
 * Identity is defined on the blob map. That is also the stronger property: two commits with the same tree
 * run the same code, and two commits with different SHAs but the same tree are the ordinary state of this
 * repository after any push.
 *
 * ## The four verdicts, and the line between the middle two
 *
 * | verdict | meaning | exit |
 * | --- | --- | --- |
 * | `MATCH` | the run's tree is the expected tree | 0 |
 * | `CODE-SAME` | only non-number-bearing paths differ | 0 |
 * | `MISMATCH` | a number-bearing path differs | 1 |
 * | `UNKNOWN` | the tool cannot certify: no commit, or no map | 2 |
 *
 * The middle row is the one that keeps the gate usable. **Every** docs commit lands after a dispatch that
 * was correct at the time, so a gate that reds on a paragraph is red most of the time, and a gate that is
 * usually red is a gate that gets explained away -- at which point it is worse than absent, because it is
 * still cited. A paragraph cannot change a measured number; `packages/`, `tools/`, `.github/workflows/`
 * and the root lockfile can. Tests sit on the non-number-bearing side for the same reason the docs do:
 * they gate a merge, they do not enter the job that produces the number.
 *
 * The default for a path this file does not recognise is **number-bearing**. A list of exceptions that a
 * new directory can silently join is a list that fails open, and failing open here means attributing a
 * number to code that did not produce it.
 *
 * ## What `UNKNOWN` is not
 *
 * It is not a soft pass. A run that has not started has no `head_sha`, and so does every record whose
 * field was renamed; both are states in which the tool knows nothing, and the exit code says so. `--help`
 * prints the table above because the exit codes are the interface a script reads.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';

/**
 * Paths that cannot change a measured number, however much they change.
 *
 * `__tests__` is matched anywhere in the path, so a suite that sits beside the code it covers stays out of
 * the number-bearing set without the code tree having to be enumerated.
 */
const NON_NUMBER_BEARING = [/\/__tests__\//, /^__tests__\//, /\.md$/, /\.mdx$/];

/**
 * Paths that can. Ordered most-specific first only for legibility; membership is what matters.
 *
 * The workflow file is included because it *is* the arm's configuration: which options a dispatch passes
 * is not a detail of the run, it is the identity of the arm.
 */
const NUMBER_BEARING = [
  /^packages\//,
  /^tools\//,
  /^\.github\/workflows\//,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^turbo\.json$/,
];

const USAGE = `run-identity — does this run carry the code its number is attributed to?

usage:
  node tools/run-identity.mjs --run <run-id> [--rev <git-rev>] [--emit <record.json>]
  node tools/run-identity.mjs --record <record.json>
  node tools/run-identity.mjs --help

  --run     read the run's head_sha over the GitHub API (needs \`gh\`) and its tree; the expected
            tree comes from \`git ls-tree -r <rev>\` in this checkout (default rev: HEAD).
  --record  a JSON file {"run": {...}, "expected": <map|listing>, "actual": <map|listing>}.
            Replayable, offline, and the shape --emit writes.
  --emit    write the record that was compared, so the verdict can be re-read without the network.

verdicts and exit codes:
  MATCH      0   the run's tree is the expected tree
  CODE-SAME  0   only non-number-bearing paths differ (docs, tests); the code is identical
  MISMATCH   1   a number-bearing path differs; this run's number belongs to other code
  UNKNOWN    2   cannot certify: no head_sha, an empty map, a truncated listing, a malformed record

The comparison is on blob maps rather than commit SHAs because this repository is pushed through the Git
Data API, which re-roots identical content under a new tree — the local SHA and the remote SHA differ for
byte-identical content, so a SHA comparison would red every correct dispatch.
`;

/**
 * A state in which the tool declines to certify. Carries the sentence the operator needs.
 *
 * ## The name is not cosmetic
 *
 * It was `Refusal`, and `cortex-storage` exports a `Refusal` of its own. The export census counts a
 * caller as a whole-word occurrence of the name in any repository file that is not a test and not a
 * barrel -- it parses no imports, by design, because a per-package scope would report 118 cross-package
 * uses as dead. So the moment this file existed, `cortex-storage: Refusal` acquired a caller and stopped
 * being an orphan. Measured: the census went from 394 recorded orphans to 393, and
 * `export-census-gate.test.ts` failed on the missing one.
 *
 * Nothing imported anything. A name was enough. The prefix keeps the two identifiers disjoint under
 * whole-word matching (`y` is an identifier character, so there is no boundary before `Refusal` here), and
 * `test_run_identity.py` now asserts that no identifier in this file collides with a recorded orphan, so a
 * later tidy-up back to the shorter name fails a test instead of quietly retiring a symbol.
 */
class IdentityRefusal extends Error {}

/**
 * A tree as a path -> blob-SHA map.
 *
 * Two shapes reach here and both are real: the API's `{truncated, tree: [{path, type, sha}]}` listing, and
 * the flat map that `git ls-tree` is reduced to. Accepting only one of them would mean the live path and
 * the replayed path compare different things, which is how a replay comes to pass while the run does not.
 *
 * Directory entries are dropped rather than carried: a tree object has a SHA like any blob, so keeping
 * them makes every directory a path the other side is missing, and the diff fills with `packages`,
 * `packages/cortex-memory`, ... until the one file that matters scrolls away.
 */
export function asBlobMap(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new IdentityRefusal(`the ${label} side is not an object, so there is no tree to compare`);
  }
  if (Array.isArray(value.tree) || 'truncated' in value) {
    if (value.truncated === true) {
      // The API truncates listings above ~100k entries. A partial listing compared as complete reads as
      // "the run has none of the missing files", which is the false-MATCH direction.
      throw new IdentityRefusal(`the ${label} tree listing is truncated, so completeness cannot be claimed`);
    }
    const map = new Map();
    for (const entry of value.tree ?? []) {
      if (entry?.type !== 'blob' || typeof entry.path !== 'string') continue;
      map.set(entry.path, String(entry.sha ?? ''));
    }
    if (map.size === 0) throw new IdentityRefusal(`the ${label} tree listing contains no blobs`);
    return map;
  }
  const map = new Map();
  for (const [path, sha] of Object.entries(value)) {
    if (typeof sha !== 'string') {
      throw new IdentityRefusal(`the ${label} map has a non-string blob for ${path}`);
    }
    map.set(path, sha);
  }
  if (map.size === 0) {
    // An empty map is not "everything differs"; it is a map that was never filled. Reporting it as a diff
    // would print every path of the other side as extra and bury the reason in the noise.
    throw new IdentityRefusal(`the ${label} side is empty, so every path of the other side would read as extra`);
  }
  return map;
}

export function isNumberBearing(path) {
  if (NON_NUMBER_BEARING.some((pattern) => pattern.test(path))) return false;
  if (NUMBER_BEARING.some((pattern) => pattern.test(path))) return true;
  // Fails closed on purpose; see the header.
  return true;
}

/**
 * Every path on which the two trees disagree, with the side it disagrees on.
 *
 * Sorting is by path so two runs of the same comparison print the same lines in the same order -- the
 * campaign's transcripts are quoted in the preregistration, and a reordering makes a quote unfindable.
 */
export function compareTrees(expected, actual) {
  const differing = [];
  for (const [path, sha] of expected) {
    if (!actual.has(path)) differing.push({ path, kind: 'missing', numberBearing: isNumberBearing(path) });
    else if (actual.get(path) !== sha)
      differing.push({ path, kind: 'changed', numberBearing: isNumberBearing(path) });
  }
  for (const path of actual.keys()) {
    if (!expected.has(path)) differing.push({ path, kind: 'extra', numberBearing: isNumberBearing(path) });
  }
  differing.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return differing;
}

export function verdictOf(differing) {
  if (differing.length === 0) return 'MATCH';
  return differing.some((entry) => entry.numberBearing) ? 'MISMATCH' : 'CODE-SAME';
}

/**
 * The run's commit, from whichever envelope carries it.
 *
 * `gh run view --json` writes `headSha`; the REST payload writes `head_sha`. Both are read because the two
 * are what an operator has to hand at different moments, and a tool that silently treats the second as an
 * absent field would answer `UNKNOWN` on the runs it was written for.
 */
export function headShaOf(run) {
  const sha = run?.headSha ?? run?.head_sha;
  if (typeof sha !== 'string' || sha.trim() === '') {
    throw new IdentityRefusal('the run names no head_sha, so the code that produced it is unidentified');
  }
  return sha.trim();
}

function describeRun(run, headSha) {
  const id = run?.id ?? run?.databaseId ?? run?.runId ?? '?';
  const state = [run?.status, run?.conclusion].filter(Boolean).join('/') || 'unknown state';
  return `${id} head_sha ${headSha.slice(0, 12)} (${state})`;
}

/**
 * One verdict, printed in the order a reader needs it: what, why, which run, then the paths split by
 * whether they can move the number.
 *
 * The split is printed even when the verdict is `MISMATCH`, because the operator's next action differs:
 * a docs-only difference is "the dispatch was correct and this checkout moved on", and a code difference
 * is "the dispatch ran code that is not this code". Same verdict line for the second case only; the first
 * case is `CODE-SAME` and exits 0.
 */
function report({ verdict, reason, run, headSha, differing }) {
  const lines = [`verdict: ${verdict}`, `reason: ${reason}`];
  if (headSha) lines.push(`run: ${describeRun(run, headSha)}`);
  if (differing) {
    const code = differing.filter((entry) => entry.numberBearing);
    const prose = differing.filter((entry) => !entry.numberBearing);
    const counts = ['changed', 'missing', 'extra'].map(
      (kind) => `${differing.filter((entry) => entry.kind === kind).length} ${kind}`,
    );
    lines.push(`paths: ${differing.length} differ (${counts.join(', ')})`);
    for (const [label, group] of [
      ['code', code],
      ['docs', prose],
    ]) {
      if (group.length === 0) continue;
      lines.push(`  ${label}: ${group.length}`);
      for (const entry of group.slice(0, 20)) lines.push(`    ${entry.kind.padEnd(7)} ${entry.path}`);
      if (group.length > 20) lines.push(`    ... ${group.length - 20} more`);
    }
  }
  const text = lines.join('\n');
  process.stdout.write(`${text}\n`);
  return text;
}

const EXIT = { MATCH: 0, 'CODE-SAME': 0, MISMATCH: 1, UNKNOWN: 2 };

/** Certified verdicts, or a refusal rendered as `UNKNOWN` with its own sentence. */
function decide(record) {
  const headSha = headShaOf(record?.run);
  const expected = asBlobMap(record?.expected, 'expected');
  const actual = asBlobMap(record?.actual, 'actual');
  const differing = compareTrees(expected, actual);
  const verdict = verdictOf(differing);
  const reason =
    verdict === 'MATCH'
      ? `all ${expected.size} blobs are byte-identical, so the run executed this content`
      : verdict === 'CODE-SAME'
        ? `no number-bearing path differs; ${differing.length} doc or test path(s) moved after the dispatch`
        : `${differing.filter((entry) => entry.numberBearing).length} number-bearing path(s) differ, so the number belongs to other code`;
  return { verdict, reason, run: record.run, headSha, differing };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** `gh api <path>` as JSON. Isolated so a missing binary is a sentence rather than an ENOENT trace. */
function ghApi(path) {
  try {
    return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim().split('\n').slice(0, 3).join(' | ');
    throw new IdentityRefusal(`gh api ${path} failed: ${detail}`);
  }
}

/** The repository, read off `origin` so a checkout cannot be asked about the wrong one. */
function originRepo() {
  let listed;
  try {
    listed = git(['remote', 'get-url', 'origin']);
  } catch {
    throw new IdentityRefusal('cannot read `origin`; run this from the repository root');
  }
  const match = /github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?\s*$/.exec(listed.trim());
  if (!match) throw new IdentityRefusal(`origin is not a github.com remote (${listed.trim()})`);
  return `${match[1]}/${match[2]}`;
}

function localTree(rev) {
  const output = git(['ls-tree', '-r', rev]);
  const map = {};
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [meta, path] = line.split('\t');
    const [, kind, sha] = meta.split(/\s+/);
    if (kind === 'blob') map[path] = sha;
  }
  return map;
}

function acquire(runId, rev) {
  const repo = originRepo();
  const run = ghApi(`repos/${repo}/actions/runs/${runId}`);
  const headSha = headShaOf(run);
  const commit = ghApi(`repos/${repo}/git/commits/${headSha}`);
  const actual = ghApi(`repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
  const expected = localTree(rev);
  return { run: { id: run.id, status: run.status, conclusion: run.conclusion, headSha }, expected, actual };
}

function main(argv) {
  const args = [...argv];
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }

  let record;
  let emit;
  try {
    const valueOf = (flag) => {
      const index = args.indexOf(flag);
      return index === -1 ? undefined : args[index + 1];
    };
    const recordPath = valueOf('--record');
    const runId = valueOf('--run');
    const rev = valueOf('--rev') ?? 'HEAD';
    emit = valueOf('--emit');

    if (recordPath && runId) throw new IdentityRefusal('--record and --run are two different sources; pass one');
    if (recordPath) record = JSON.parse(readFileSync(recordPath, 'utf8'));
    else if (runId) record = acquire(runId, rev);
    else throw new IdentityRefusal('neither --record nor --run was given; see --help');
  } catch (error) {
    const reason = error instanceof IdentityRefusal ? error.message : `malformed input: ${error.message}`;
    report({ verdict: 'UNKNOWN', reason });
    return EXIT.UNKNOWN;
  }

  let decided;
  try {
    decided = decide(record);
  } catch (error) {
    // A refusal is not a verdict about the run; it is the tool saying it cannot see. Both exit 2, and the
    // reason is what separates "no commit" from "no map".
    const reason = error instanceof IdentityRefusal ? error.message : `malformed record: ${error.message}`;
    report({ verdict: 'UNKNOWN', reason });
    return EXIT.UNKNOWN;
  }

  if (emit) {
    try {
      mkdirSync(dirname(emit), { recursive: true });
      writeFileSync(emit, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    } catch (error) {
      // The verdict is already established; failing to archive it must not change the exit code into
      // "cannot certify", which is what a thrown error here would do.
      process.stderr.write(`could not write ${emit}: ${error.message}\n`);
    }
  }

  report(decided);
  return EXIT[decided.verdict];
}

process.exitCode = main(process.argv.slice(2));
