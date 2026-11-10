#!/usr/bin/env node
/**
 * Evaluate every acceptance criterion and fail the build on a regression.
 *
 *     node tools/acceptance-check.mjs [--html path/to/review.html] [--root /workspace] [--json]
 *
 * This script exists because a criterion written in prose cannot fail. Each row in
 * `packages/cortex-eval/src/acceptance.ts` declares a threshold **and where its current value comes from**;
 * this file evaluates those sources and compares. Nothing here is a number typed by hand, so a document and
 * this table cannot disagree about a measurement — one of them is generated from the other.
 *
 * Three statuses, and the distinction between the last two is the point:
 *
 * - `pass` — the number was computed and met the threshold.
 * - `fail` — the number was computed and missed. Exit code 1.
 * - `unrun` — the number could not be computed, because no run exists or a required artifact is absent.
 *   Exit code 2 **only** when `--strict-unrun` is given, because a project with one unrun benchmark should
 *   still be able to gate on the readings it does have.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  CRITERIA,
  attestationOf,
  CONFIGURATION_ATTESTED,
  currentOf,
  describe,
  verdictOf,
} from '../packages/cortex-eval/dist/acceptance.js';
import {
  ablate,
  buildCases,
  pollutionGap,
  scoreArm,
} from '../packages/cortex-eval/dist/assumption-ablation.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const asJson = argv.includes('--json');
const strictUnrun = argv.includes('--strict-unrun');
const root = flag('--root') ?? path.resolve(REPO, '..');
const reviewHtml =
  flag('--html') ??
  process.env.CORTEX_REVIEW_HTML ??
  path.join(root, 'cortex-docs/evidence/a3-review/review-remote.html');

/** Read a dotted path out of a JSON document, or `undefined` when any step is missing. */
function pluckRaw(value, key) {
  let cursor = value;
  for (const step of key.split('.')) {
    if (cursor === null || typeof cursor !== 'object' || !(step in cursor)) return undefined;
    cursor = cursor[step];
  }
  return cursor;
}

/** The same path, restricted to numbers — a reading is always a number and a string is not one. */
function pluck(value, key) {
  const found = pluckRaw(value, key);
  return typeof found === 'number' ? found : undefined;
}

/**
 * The artifact cache, so one file is parsed once per invocation rather than once per criterion.
 *
 * `undefined` is cached as `undefined` deliberately: a file that is missing stays missing for the length of
 * one run, and re-reading it per row would turn a single absence into thirty syscalls and the same note.
 */
const artifactCache = new Map();
function artifactAt(relative) {
  if (artifactCache.has(relative)) return artifactCache.get(relative);
  const file = path.resolve(root, relative);
  let parsed;
  try {
    parsed = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  } catch {
    parsed = undefined;
  }
  artifactCache.set(relative, parsed);
  return parsed;
}

/** The controlled set, evaluated once and reused, because every arm row reads from it. */
let setCache;
function controlledSet() {
  if (setCache === undefined) {
    setCache = { cases: buildCases({ cascade: true }), rows: ablate() };
  }
  return setCache;
}

/** The probe, run once per invocation. */
let probeCache;
function probe() {
  if (probeCache !== undefined) return probeCache;
  if (!existsSync(reviewHtml)) {
    probeCache = null;
    return null;
  }
  try {
    const out = execFileSync(
      process.execPath,
      [path.join(REPO, 'tools/knowledge-probe.mjs'), '--html', reviewHtml, '--json'],
      { encoding: 'utf8' },
    );
    probeCache = JSON.parse(out);
  } catch (error) {
    // A probe that failed is an unrun reading, not a zero. Recorded so the note says which.
    probeCache = { error: String(error).slice(0, 200) };
  }
  return probeCache;
}

function probeReading(name) {
  const data = probe();
  if (data === null || data.error !== undefined) return undefined;
  switch (name) {
    case 'strict-accepted':
      return data.strictAcceptedRate;
    case 'unresolved-markers':
      return data.unresolvedMarkers;
    case 'block-tokens':
      return data.tokens?.grouped;
    case 'naive-tokens':
      return data.tokens?.naive;
    case 'block-saving':
      return data.tokens?.saving;
    default:
      return undefined;
  }
}

/** Where every kind of reading comes from, in this caller's case. */
const resolve = {
  probe: probeReading,
  artifact: (relative, key) => {
    const parsed = artifactAt(relative);
    return parsed === undefined ? undefined : pluck(parsed, key);
  },
  artifactRaw: (relative, key) => {
    const parsed = artifactAt(relative);
    return parsed === undefined ? undefined : pluckRaw(parsed, key);
  },
  arm: (name) => scoreArm(controlledSet().cases, name).accuracy,
  gap: () => {
    const { cases } = controlledSet();
    return scoreArm(cases, 'gated').accuracy - scoreArm(cases, 'flat').accuracy;
  },
  floor: () => pollutionGap(controlledSet().cases),
  leak: () => scoreArm(controlledSet().cases, 'gated').retiredServed,
  ablation: (removed) => controlledSet().rows.find((row) => row.removed === removed)?.accuracy,
};

/**
 * Evidence files that name a configuration which is not the one the project registers.
 *
 * `github.com/AgentiX-E/cortex-docs` and this repository are separate checkouts, so the comparison crosses a
 * root that `attestationOf`'s resolvers do not span: the evidence files are addressed relative to the
 * workspace and the registration record is addressed relative to this repository. That is the mechanical
 * reason this is a check of its own; the reason it fails the build rather than marking a row stale is that
 * a file describing another configuration is not a weak reading of this one, it is a reading of something
 * else, and §13.336 published one for a round.
 *
 * The list of files is `CONFIGURATION_ATTESTED` in `acceptance.ts`, not a copy here.
 */
function registryDefects(skipped) {
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(path.join(REPO, 'tools/arm-config-baseline.json'), 'utf8'));
  } catch (error) {
    return [`tools/arm-config-baseline.json cannot be read, so no configuration can be attested: ${error.message}`];
  }
  const registered = baseline.memoryArmConfigFingerprint;
  if (typeof registered !== 'string' || registered === '') {
    return ['tools/arm-config-baseline.json carries no `memoryArmConfigFingerprint`, so nothing can be compared'];
  }
  const defects = [];
  for (const { path: relative, key } of CONFIGURATION_ATTESTED) {
    const parsed = artifactAt(relative);
    // Absent is **skipped**, not failed. This repository's CI checks out one repository, so every
    // `cortex-docs/...` path is missing there and the five rows that read one print `unrun` for exactly
    // that reason. Reporting an absent file as a defect would turn a single-repository checkout red on
    // every push and teach the next person to delete the check; the state is printed instead.
    if (parsed === undefined) {
      skipped.push(relative);
      continue;
    }
    const found = pluckRaw(parsed, key);
    if (found === registered) continue;
    defects.push(
      `${relative}#${key} reads ${JSON.stringify(found ?? null)} and the registered configuration is ` +
        `${JSON.stringify(registered)} (run ${baseline.run}, adopted by §${baseline.adoptedBy}). ` +
        'Regenerate the file from an artifact of the registered configuration, or record the new ' +
        'baseline in the change that adopts it.',
    );
  }
  return defects;
}

const registrySkipped = [];
const registry = registryDefects(registrySkipped);

const evaluations = CRITERIA.map((criterion) => {
  const value = currentOf(criterion, resolve);
  const current = value === undefined ? null : value;
  const stale = attestationOf(criterion, resolve);
  return { criterion, evaluation: verdictOf(criterion, current, stale) };
});

const pct = (value) => `${(100 * value).toFixed(1)}%`;
/** A unit decides how a number is written; a ratio printed as points is how a 28pp gap reads as 0.28. */
const show = (criterion, value) => {
  if (value === null || value === undefined) return '—';
  if (criterion.unit === 'ratio') return pct(value);
  if (criterion.unit === 'points') return `${(100 * value).toFixed(1)}pp`;
  return value.toFixed(0);
};
const want = (criterion) => {
  const sign =
    criterion.comparator === 'at-least' ? '≥' : criterion.comparator === 'at-most' ? '≤' : '=';
  return `${sign} ${show(criterion, criterion.threshold)}`;
};
/** The word in the status column: a status is not enough once aims and accepted misses exist. */
const label = (criterion, evaluation) => {
  if (evaluation.status === 'unrun') return 'unrun';
  // `stale` is not `FAIL`: nothing was compared, because the number describes a different system. It is not
  // `unrun` either, because the value exists and is printed beside the label.
  if (evaluation.status === 'stale') return 'STALE';
  if (evaluation.status === 'pass') return 'pass';
  if (criterion.accepted === true) return 'accept';
  return criterion.kind === 'gate' ? 'FAIL' : 'aim';
};

if (asJson) {
  process.stdout.write(
    `${JSON.stringify(
      evaluations.map(({ criterion, evaluation }) => ({
        id: criterion.id,
        capability: criterion.capability,
        metric: criterion.metric,
        dataset: criterion.dataset,
        comparator: criterion.comparator,
        // The unit travels with the number so a consumer can format it rather than guess: `C1` is a count
        // and rendering it as a ratio would put 12105% in a table.
        unit: criterion.unit,
        threshold: criterion.threshold,
        source: describe(criterion.source),
        current: evaluation.current,
        status: evaluation.status,
        // The stale reason travels in `note` like the unrun one, so a consumer does not have to special-case
        // which statuses carry an explanation.

        note: evaluation.note,
      })),
      null,
      2,
    )}\n`,
  );
} else {
  const pad = (value, width) => String(value).padEnd(width);
  process.stdout.write(`acceptance matrix — ${CRITERIA.length} criteria\n\n`);
  process.stdout.write(
    `${pad('id', 5)}${pad('current', 10)}${pad('want', 10)}${pad('status', 8)}capability\n`,
  );
  process.stdout.write(`${pad('', 5)}${pad('', 10)}${pad('', 10)}${pad('', 8)}\n`.slice(0, 0));
  for (const { criterion, evaluation } of evaluations) {
    process.stdout.write(
      `${pad(criterion.id, 5)}${pad(show(criterion, evaluation.current), 10)}${pad(want(criterion), 10)}${pad(label(criterion, evaluation), 8)}${criterion.capability}\n`,
    );
  }

  if (registry.length > 0) {
    process.stdout.write(`\n${registry.length} evidence file(s) describe a configuration that is not registered\n`);
    for (const line of registry) process.stdout.write(`  ${line}\n`);
  }
  if (registrySkipped.length > 0) {
    process.stdout.write(
      `\n${registrySkipped.length} configuration-bearing evidence file(s) are not in this checkout, so their ` +
        'configuration cannot be attested here\n',
    );
    for (const relative of registrySkipped) process.stdout.write(`  ${relative}\n`);
  }

  const failed = evaluations.filter((entry) => entry.evaluation.blocking);
  const aims = evaluations.filter(
    (entry) => entry.evaluation.status === 'fail' && !entry.evaluation.blocking,
  );
  // `stale` counts as missing for the release gate, because a row whose number is about another system is
  // not a measurement of this one. It is listed separately so the repair differs: a stale row needs the
  // artifact re-hung, an unrun row needs a dispatch.
  const missing = evaluations.filter(
    (entry) => entry.evaluation.status === 'unrun' || entry.evaluation.status === 'stale',
  );

  if (failed.length > 0) {
    process.stdout.write(`\n${failed.length} gate(s) below threshold\n`);
    for (const { criterion, evaluation } of failed) {
      process.stdout.write(`\n  ${criterion.id}  ${criterion.metric}\n`);
      process.stdout.write(`    on ${criterion.dataset}\n`);
      process.stdout.write(
        `    got ${show(criterion, evaluation.current)}, want ${want(criterion)}\n`,
      );
      process.stdout.write(`    on miss: ${criterion.onMiss}\n`);
    }
  }

  if (aims.length > 0) {
    process.stdout.write(`\n${aims.length} aim(s) not yet reached — reported, not blocking\n`);
    for (const { criterion, evaluation } of aims) {
      process.stdout.write(
        `  ${pad(criterion.id, 5)}${pad(show(criterion, evaluation.current), 10)}of ${want(criterion)}  ${criterion.metric}\n`,
      );
    }
  }

  if (missing.length > 0) {
    process.stdout.write(
      `\n${missing.length} without a usable value — reported as unrun or stale, never as a pass\n`,
    );
    for (const { criterion, evaluation } of missing) {
      const tag = evaluation.status === 'stale' ? 'stale' : 'unrun';
      process.stdout.write(
        `  ${pad(criterion.id, 5)}${pad(tag, 6)}${describe(criterion.source)}: ${evaluation.note}\n`,
      );
    }
  }

  const withCompetitors = CRITERIA.filter((criterion) => (criterion.competitors ?? []).length > 0);
  if (withCompetitors.length > 0) {
    process.stdout.write('\ncompetitor figures, with the grade that limits what may be claimed\n');
    for (const criterion of withCompetitors) {
      process.stdout.write(`  ${criterion.id} ${criterion.metric}\n`);
      // The name column is measured, not fixed. A fixed width was correct while every competitor had a short
      // name; the first long one printed `...GPT-4o84.2%`, which reads as a name ending in a percentage. A column
      // that silently loses its boundary is the smallest possible version of what this repository keeps finding:
      // two values rendered into one field.
      const nameWidth = Math.max(26, ...criterion.competitors.map((peer) => peer.name.length + 2));
      for (const peer of criterion.competitors) {
        // The unit belongs to the criterion, not to the figure: `C1` is a count and its competitors are
        // written in tokens, so the ratio formatter turned Zep's 4,400 tokens into `440000.0%` the first
        // time that row had a value. `show` already knows the rule; the competitor column was the one place
        // that did not ask it.
        process.stdout.write(
          `    ${pad(`[${peer.grade}]`, 5)}${pad(peer.name, nameWidth)}${pad(show(criterion, peer.value), 8)}${peer.recipe}\n`,
        );
      }
    }
  }
}

const failed = evaluations.filter((entry) => entry.evaluation.blocking).length;
const missing = evaluations.filter(
  (entry) => entry.evaluation.status === 'unrun' || entry.evaluation.status === 'stale',
).length;
// `process.exitCode`, never `process.exit()`. A write to a pipe is asynchronous in node, so an explicit exit
// can terminate while `--json`'s document is still in flight: the exit code is the same and the output is
// truncated mid-string, which a consumer reports as malformed JSON rather than as a check that failed. It was
// intermittent -- small documents usually flushed in time -- and `test_reading_render.py` caught it as an
// occasional `Unterminated string` while every gate was passing.
// An evidence file describing another configuration is a failure of the same severity as a gate: nothing
// was compared, because the number is about a different system.
const blocking = failed > 0 || registry.length > 0;
process.exitCode = blocking ? 1 : strictUnrun && missing > 0 ? 2 : 0;
