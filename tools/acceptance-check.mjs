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
  currentOf,
  describe,
  verdictOf,
} from '../packages/cortex-eval/dist/acceptance.js';
import {
  ablate,
  buildCases,
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
  flag('--html') ?? process.env.CORTEX_REVIEW_HTML ?? path.join(root, 'cortex-docs/evidence/a3-review/review-remote.html');

/** Read a dotted path out of a JSON document, or `undefined` when any step is missing. */
function pluck(value, key) {
  let cursor = value;
  for (const step of key.split('.')) {
    if (cursor === null || typeof cursor !== 'object' || !(step in cursor)) return undefined;
    cursor = cursor[step];
  }
  return typeof cursor === 'number' ? cursor : undefined;
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
    const file = path.resolve(root, relative);
    if (!existsSync(file)) return undefined;
    try {
      return pluck(JSON.parse(readFileSync(file, 'utf8')), key);
    } catch {
      return undefined;
    }
  },
  arm: (name) => scoreArm(controlledSet().cases, name).accuracy,
  gap: () => {
    const { cases } = controlledSet();
    return scoreArm(cases, 'gated').accuracy - scoreArm(cases, 'flat').accuracy;
  },
  leak: () => scoreArm(controlledSet().cases, 'gated').retiredServed,
  ablation: (removed) => controlledSet().rows.find((row) => row.removed === removed)?.accuracy,
};

const evaluations = CRITERIA.map((criterion) => {
  const value = currentOf(criterion, resolve);
  return { criterion, evaluation: verdictOf(criterion, value === undefined ? null : value) };
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
  const sign = criterion.comparator === 'at-least' ? '≥' : criterion.comparator === 'at-most' ? '≤' : '=';
  return `${sign} ${show(criterion, criterion.threshold)}`;
};
/** The word in the status column: a status is not enough once aims and accepted misses exist. */
const label = (criterion, evaluation) => {
  if (evaluation.status === 'unrun') return 'unrun';
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
        threshold: criterion.threshold,
        source: describe(criterion.source),
        current: evaluation.current,
        status: evaluation.status,
        note: evaluation.note,
      })),
      null,
      2,
    )}\n`,
  );
} else {
  const pad = (value, width) => String(value).padEnd(width);
  process.stdout.write(`acceptance matrix — ${CRITERIA.length} criteria\n\n`);
  process.stdout.write(`${pad('id', 5)}${pad('current', 10)}${pad('want', 10)}${pad('status', 8)}capability\n`);
  process.stdout.write(
    `${pad('', 5)}${pad('', 10)}${pad('', 10)}${pad('', 8)}\n`.slice(0, 0),
  );
  for (const { criterion, evaluation } of evaluations) {
    process.stdout.write(
      `${pad(criterion.id, 5)}${pad(show(criterion, evaluation.current), 10)}${pad(want(criterion), 10)}${pad(label(criterion, evaluation), 8)}${criterion.capability}\n`,
    );
  }

  const failed = evaluations.filter((entry) => entry.evaluation.blocking);
  const aims = evaluations.filter(
    (entry) => entry.evaluation.status === 'fail' && !entry.evaluation.blocking,
  );
  const missing = evaluations.filter((entry) => entry.evaluation.status === 'unrun');

  if (failed.length > 0) {
    process.stdout.write(`\n${failed.length} gate(s) below threshold\n`);
    for (const { criterion, evaluation } of failed) {
      process.stdout.write(`\n  ${criterion.id}  ${criterion.metric}\n`);
      process.stdout.write(`    on ${criterion.dataset}\n`);
      process.stdout.write(`    got ${show(criterion, evaluation.current)}, want ${want(criterion)}\n`);
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
    process.stdout.write(`\n${missing.length} with no value — reported as unrun, never as a pass\n`);
    for (const { criterion, evaluation } of missing) {
      process.stdout.write(`  ${pad(criterion.id, 5)}${describe(criterion.source)}: ${evaluation.note}\n`);
    }
  }

  const withCompetitors = CRITERIA.filter((criterion) => (criterion.competitors ?? []).length > 0);
  if (withCompetitors.length > 0) {
    process.stdout.write('\ncompetitor figures, with the grade that limits what may be claimed\n');
    for (const criterion of withCompetitors) {
      process.stdout.write(`  ${criterion.id} ${criterion.metric}\n`);
      for (const peer of criterion.competitors) {
        process.stdout.write(
          `    ${pad(`[${peer.grade}]`, 5)}${pad(peer.name, 26)}${pad(pct(peer.value), 8)}${peer.recipe}\n`,
        );
      }
    }
  }
}

const failed = evaluations.filter((entry) => entry.evaluation.blocking).length;
const missing = evaluations.filter((entry) => entry.evaluation.status === 'unrun').length;
if (failed > 0) process.exit(1);
if (strictUnrun && missing > 0) process.exit(2);
process.exit(0);
