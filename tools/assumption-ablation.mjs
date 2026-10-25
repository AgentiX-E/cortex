#!/usr/bin/env node
/**
 * The ablation, printed.
 *
 *     node tools/assumption-ablation.mjs [--verbose] [--json]
 *
 * Three arms over one controlled set, then the same set with one mechanism removed at a time. Nothing here
 * calls a model, so the reading is reproducible to the byte: two runs disagreeing is a bug, not noise.
 *
 * The number this prints is **not** a claim about Cortex on any benchmark. The set is synthetic and tiny,
 * and its baseline is a lexical tie-break chosen to be honest rather than strong. What it measures is
 * whether each mechanism acts where it is supposed to act and stays out of the way where it is not — a
 * fixture that mixes those two questions measures nothing.
 */

import {
  ablate,
  buildCases,
  scoreArm,
  TARGETS,
} from '../packages/cortex-eval/dist/assumption-ablation.js';

const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const asJson = argv.includes('--json');

const cases = buildCases(true);
const arms = ['flat', 'annotated', 'gated'].map((arm) => scoreArm(cases, arm));

if (asJson) {
  process.stdout.write(
    `${JSON.stringify({ cases: cases.length, arms, ablation: ablate() }, null, 2)}\n`,
  );
  process.exit(0);
}

const pct = (value) => `${(100 * value).toFixed(1)}%`;
const pad = (value, width) => String(value).padEnd(width);

process.stdout.write(`controlled contradiction set: ${cases.length} cases\n\n`);

process.stdout.write(
  `${pad('arm', 12)}${pad('correct', 10)}${pad('accuracy', 10)}retired served\n`,
);
for (const report of arms) {
  process.stdout.write(
    `${pad(report.arm, 12)}${pad(`${report.correct}/${report.n}`, 10)}${pad(pct(report.accuracy), 10)}${report.retiredServed}\n`,
  );
}

const families = Object.keys(arms[0].byFamily);
process.stdout.write(`\n${pad('family', 14)}${pad('flat', 10)}${pad('annotated', 10)}gated\n`);
for (const family of families) {
  const cells = arms.map(
    (report) => `${report.byFamily[family].correct}/${report.byFamily[family].n}`,
  );
  process.stdout.write(`${pad(family, 14)}${pad(cells[0], 10)}${pad(cells[1], 10)}${cells[2]}\n`);
}

process.stdout.write('\nablation (gated arm, one mechanism removed)\n');
process.stdout.write(
  `${pad('removed', 16)}${pad('accuracy', 10)}${pad('delta', 9)}targeted families\n`,
);
const base = arms[2].accuracy;
for (const row of ablate()) {
  const delta = row.accuracy - base;
  const sign = delta > 0 ? '+' : '';
  const targets = TARGETS[row.removed].length === 0 ? '—' : TARGETS[row.removed].join(', ');
  process.stdout.write(
    `${pad(row.removed, 16)}${pad(pct(row.accuracy), 10)}${pad(`${sign}${(100 * delta).toFixed(1)}pp`, 9)}${targets}\n`,
  );
}

if (verbose) {
  process.stdout.write('\nper case\n');
  for (const report of arms) {
    process.stdout.write(`  ${report.arm}\n`);
    for (const outcome of report.outcomes) {
      const mark = outcome.correct ? 'ok  ' : 'MISS';
      process.stdout.write(
        `    ${mark} ${pad(outcome.caseId, 34)} got ${String(outcome.answer)} want ${String(outcome.expected)}\n`,
      );
    }
  }
}

process.stdout.write(
  '\nThis set measures mechanism attribution, not effect size: a 25% baseline is a property of the\n' +
    'fixture, and no number here may be quoted as Cortex performance on any published benchmark.\n',
);
