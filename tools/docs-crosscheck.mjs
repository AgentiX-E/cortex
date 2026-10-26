#!/usr/bin/env node
/**
 * Check that the numbers in the documents match the numbers the code produces.
 *
 *     node tools/docs-crosscheck.mjs [--root /workspace] [--list]
 *
 * ## The failure this prevents
 *
 * A measurement is written into a report, the code changes, the report keeps its number. Nobody notices because
 * nothing reads the report. Six months later a reviewer finds three documents quoting three values for one
 * metric and has no way to tell which was ever true.
 *
 * The fix is a marker: a document states a number **and its criterion id**, and this script recomputes the
 * criterion and compares. A marker whose value drifted fails the build, and the failure names the file, the line
 * and both numbers.
 *
 *     <!-- reading:K2 -->58.8%
 *
 * A marker is deliberately not hidden. It renders as nothing in a viewer that ignores comments, so a document
 * reads normally, and it is greppable for anyone who wants to audit the claim.
 *
 * ## What is not checked
 *
 * Prose. A sentence that says "about six in ten" cannot be compared with 58.8%, and pretending otherwise would
 * mean either a very clever parser or a lot of false failures. The markers cover the numbers a reader would
 * check; the prose is for the reader who wants the argument.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { CRITERIA, currentOf, verdictOf } from '../packages/cortex-eval/dist/acceptance.js';
import { ablate, buildCases, scoreArm } from '../packages/cortex-eval/dist/assumption-ablation.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const root = flag('--root') ?? path.resolve(REPO, '..');
const listOnly = argv.includes('--list');
const reviewHtml =
  flag('--html') ??
  process.env.CORTEX_REVIEW_HTML ??
  path.join(root, 'cortex-docs/evidence/a3-review/review-remote.html');

let setCache;
const controlledSet = () => {
  setCache ??= { cases: buildCases({ cascade: true }), rows: ablate() };
  return setCache;
};

let probeCache;
function probeReading(name) {
  if (probeCache === undefined) {
    if (!existsSync(reviewHtml)) {
      probeCache = null;
    } else {
      try {
        probeCache = JSON.parse(
          execFileSync(
            process.execPath,
            [path.join(REPO, 'tools/knowledge-probe.mjs'), '--html', reviewHtml, '--json'],
            { encoding: 'utf8' },
          ),
        );
      } catch {
        probeCache = null;
      }
    }
  }
  if (probeCache === null) return undefined;
  const map = {
    'strict-accepted': probeCache.strictAcceptedRate,
    'unresolved-markers': probeCache.unresolvedMarkers,
    'block-tokens': probeCache.tokens?.grouped,
    'naive-tokens': probeCache.tokens?.naive,
    'block-saving': probeCache.tokens?.saving,
  };
  return map[name];
}

const resolve = {
  probe: probeReading,
  artifact: (relative, key) => {
    const file = path.resolve(root, relative);
    if (!existsSync(file)) return undefined;
    try {
      let cursor = JSON.parse(readFileSync(file, 'utf8'));
      for (const step of key.split('.')) {
        if (cursor === null || typeof cursor !== 'object' || !(step in cursor)) return undefined;
        cursor = cursor[step];
      }
      return typeof cursor === 'number' ? cursor : undefined;
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

/** How a criterion writes its own number. The document must use the same form, or the comparison is a guess. */
function render(criterion, value) {
  if (criterion.unit === 'ratio') return `${(100 * value).toFixed(1)}%`;
  if (criterion.unit === 'points') return `${(100 * value).toFixed(1)}pp`;
  return String(Number.isInteger(value) ? value : value.toFixed(2));
}

const readings = new Map();
for (const criterion of CRITERIA) {
  const value = currentOf(criterion, resolve);
  const evaluation = verdictOf(criterion, value === undefined ? null : value);
  readings.set(criterion.id, {
    criterion,
    value: value === undefined ? null : value,
    rendered: value === undefined ? null : render(criterion, value),
    status: evaluation.status,
  });
}

if (listOnly) {
  const pad = (value, width) => String(value).padEnd(width);
  process.stdout.write('criterion  value      status  marker\n');
  for (const [id, entry] of readings) {
    process.stdout.write(
      `${pad(id, 11)}${pad(entry.rendered ?? '—', 11)}${pad(entry.status, 8)}<!-- reading:${id} -->${entry.rendered ?? ''}\n`,
    );
  }
  process.exit(0);
}

/** Every markdown file the two repositories publish. */
function markdownFiles() {
  const roots = [path.join(REPO, 'docs'), path.join(root, 'cortex-docs/docs')];
  const found = [];
  for (const dir of roots) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (statSync(file).isFile() && name.endsWith('.md')) found.push(file);
    }
  }
  return found;
}

const MARKER = /<!--\s*reading:([A-Z0-9]+)\s*-->\s*([^\n]*)/g;
const problems = [];
const skipped = [];
let markers = 0;

for (const file of markdownFiles()) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(MARKER)) {
    markers += 1;
    const [, id, tail] = match;
    const line = text.slice(0, match.index).split('\n').length;
    const entry = readings.get(id);
    if (entry === undefined) {
      problems.push({
        file,
        line,
        id,
        claimed: tail.trim(),
        actual: null,
        why: 'no such criterion',
      });
      continue;
    }
    if (entry.rendered === null) {
      // Not a mismatch: in an environment without the evidence (a bare checkout, CI without the documents
      // repository) a criterion has no value, and comparing a document against "no value" would fail every
      // documented number at once. Reported as skipped so the count is visible rather than silently zero.
      skipped.push({ file, line, id, claimed: tail.trim() });
      continue;
    }
    // Take the leading number-with-unit rather than the first whitespace-delimited token: a Chinese sentence
    // runs straight into the value, so `81.0%（405/500）` is one token and the comparison would fail on prose
    // rather than on the number.
    const leading = tail.trim().match(/^-?[\d.]+(?:%|pp)?/);
    const claimed = leading === null ? (tail.trim().split(/[\s|]/)[0] ?? '') : leading[0];
    if (claimed !== entry.rendered) {
      problems.push({
        file,
        line,
        id,
        claimed,
        actual: entry.rendered,
        why: 'document and code disagree',
      });
    }
  }
}

const relative = (file) => path.relative(root, file);

const verified = markers - skipped.length - problems.length;

if (problems.length === 0) {
  process.stdout.write(
    `docs cross-check: ${verified} of ${markers} marker(s) verified against the code` +
      `${skipped.length === 0 ? '' : `, ${skipped.length} skipped (no value in this checkout)`} — ` +
      `${markdownFiles().length} document(s) scanned\n`,
  );
  if (markers === 0) {
    process.stdout.write(
      '  note: no markers found — the check passed vacuously. Run with --list to see the markers a document should carry.\n',
    );
  }
  if (verified === 0 && skipped.length > 0) {
    process.stdout.write(
      '  note: nothing was verified in this environment. The evidence for those criteria lives in the paired\n' +
        '  documents repository, so this checkout can only confirm that the markers are well formed.\n',
    );
    for (const entry of skipped) {
      process.stdout.write(`    ${relative(entry.file)}:${entry.line}  ${entry.id}\n`);
    }
  }
  process.exit(0);
}

process.stdout.write(`docs cross-check: ${problems.length} of ${markers} marker(s) disagree\n\n`);
for (const problem of problems) {
  process.stdout.write(`  ${relative(problem.file)}:${problem.line}  ${problem.id}\n`);
  process.stdout.write(`    document: ${problem.claimed || '(empty)'}\n`);
  process.stdout.write(`    code:     ${problem.actual ?? '(no value)'}\n`);
  process.stdout.write(`    ${problem.why}\n\n`);
}
process.exit(1);
