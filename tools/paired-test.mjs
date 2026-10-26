#!/usr/bin/env node
/**
 * Compare two competition runs question by question, and say whether the difference is real.
 *
 *     node tools/paired-test.mjs baseline.json treatment.json [--alpha 0.05]
 *
 * ## Why this exists as a tool rather than a paragraph
 *
 * The 100-question reading moved temporal accuracy `11/20 -> 15/20` and the honest question was whether to
 * believe it. Answering that in prose produced a sentence ("four questions on twenty is not a difference") that
 * nobody could check and that would have to be re-argued for every later ablation. The same numbers as a paired
 * test give a p-value, and the p-value is the same computation every time.
 *
 * Both inputs are the `--json` output of `tools/competitor-harness.mjs`, which carries one record per measured
 * question. Two runs of the same corpus therefore pair up by question id, and the pairing is what makes the test
 * sensitive to a prompt change rather than to the sample.
 *
 * ## What it refuses to do
 *
 * It does not pool providers, and it does not compare a provider against a different provider. An arm's question
 * set is part of the arm; pairing `cortex-session` with `cortex/trim-2.8k` would compare two experiments and
 * report the result as one condition against another.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { compareRuns } from '../packages/cortex-eval/dist/index.js';

const argv = process.argv.slice(2);
const positional = argv.filter((arg) => !arg.startsWith('--'));
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const alpha = Number(flag('--alpha') ?? 0.05);

if (positional.length !== 2) {
  process.stderr.write(
    'usage: node tools/paired-test.mjs baseline.json treatment.json [--alpha 0.05]\n',
  );
  process.exit(2);
}

function load(file) {
  const payload = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(payload.scores)) {
    throw new Error(`${file} does not look like a harness run: no 'scores' array`);
  }
  return { name: path.basename(file), payload };
}

const baseline = load(positional[0]);
const treatment = load(positional[1]);

const sameCorpus = baseline.payload.config?.dataset === treatment.payload.config?.dataset;
if (!sameCorpus) {
  // Not fatal — a reader may be comparing two subsets on purpose — but it has to be said before the p-value,
  // because a paired test over two different samples is not a paired test.
  process.stdout.write(
    `warning: the two runs name different datasets ` +
      `(${baseline.payload.config?.dataset} vs ${treatment.payload.config?.dataset}); ` +
      `pairing by question id still applies to whatever they share\n\n`,
  );
}

const results = compareRuns(baseline.payload.scores, treatment.payload.scores);

const pad = (value, width) => String(value).padEnd(width);
const pct = (value) => `${(100 * value).toFixed(1)}%`;

process.stdout.write(`baseline : ${baseline.name}  (${baseline.payload.config?.dataset})\n`);
process.stdout.write(`treatment: ${treatment.name}  (${treatment.payload.config?.dataset})\n`);
process.stdout.write(`alpha    : ${alpha}\n\n`);

if (results.length === 0) {
  process.stdout.write(
    'no provider appears as read in both runs. A paired test needs the same arm answering the same questions\n' +
      'twice; nothing here can be paired.\n',
  );
  process.exit(0);
}

process.stdout.write(
  `${pad('provider', 20)}${pad('n', 6)}${pad('+', 6)}${pad('-', 6)}${pad('delta', 9)}${pad('p', 10)}verdict\n`,
);
for (const result of results) {
  const verdict =
    result.improved + result.regressed === 0
      ? 'no change'
      : result.p < alpha
        ? result.delta > 0
          ? 'improved'
          : 'regressed'
        : 'not significant';
  const unmatched = result.unmatched === 0 ? '' : ` (${result.unmatched} unmatched)`;
  process.stdout.write(
    `${pad(result.provider, 20)}${pad(result.n, 6)}${pad(result.improved, 6)}${pad(result.regressed, 6)}` +
      `${pad(pct(result.delta), 9)}${pad(result.p.toFixed(4), 10)}${verdict}${unmatched}\n`,
  );
}

process.stdout.write(
  `\n'+' is a question the treatment got right and the baseline did not; '-' is the reverse. The p-value is the\n` +
    `two-tailed exact McNemar test over those two counts only, so a run where nothing moved reads 'no change'\n` +
    `rather than 'significant'.\n`,
);
