#!/usr/bin/env node
/**
 * Compare two competition runs question by question, and say whether the difference is real.
 *
 *     node tools/paired-test.mjs baseline.json treatment.json [--alpha 0.05]
 *     node tools/paired-test.mjs --within run.json [--alpha 0.05]
 *
 * The first form pairs one arm across two runs. The second pairs **every pair of read arms inside one run**,
 * which is the shape a competitor comparison has.
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
 * Across two files it does not pool providers, and it does not compare a provider against a different provider:
 * two runs differ in their sample as well as in their arm, so pairing `cortex-session` from one with `mem0` from
 * the other would compare two experiments and report the result as one condition against another.
 *
 * **Within one file it does exactly that**, and the reason is a fact about the harness rather than a change of
 * mind. One invocation samples the question list once and hands every arm the same one, so two arms in one run
 * share their questions by construction — that is the definition of a paired comparison, and it is the only
 * shape in which a competitor comparison exists at all. `--within` is that mode, and it is the reason the
 * 100-question reading can say whether six questions between two systems is a difference instead of arguing about
 * two percentages.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { compareArmsInRun, compareRuns } from '../packages/cortex-eval/dist/index.js';

const argv = process.argv.slice(2);
const positional = argv.filter((arg) => !arg.startsWith('--'));
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const alpha = Number(flag('--alpha') ?? 0.05);
const within = argv.includes('--within');

if (within ? positional.length !== 1 : positional.length !== 2) {
  process.stderr.write(
    'usage: node tools/paired-test.mjs baseline.json treatment.json [--alpha 0.05]\n' +
      '       node tools/paired-test.mjs --within run.json [--alpha 0.05]\n',
  );
  process.exit(2);
}

/**
 * The per-question records of one run, from either artifact shape.
 *
 * ## Why two shapes and still one comparator
 *
 * The competition harness writes `scores[]`, one entry per provider, each with its own `records[]`. The
 * benchmark's ablation report writes `questions[]`, one entry per question, and carries the **feature** side's
 * verdict in `correct`. Both are a set of (question, correct) pairs; only the envelope differs.
 *
 * So the adapter lives here and the statistic does not move. The alternative -- a second McNemar implementation
 * for the second format -- is the defect this repository has caught twice: `paired-test` was deliberately
 * exported as one entry point so that a later caller could not build a second comparison, and a second reader
 * would have been the same mistake wearing a different hat.
 *
 * A report is labelled `feature` because that is what its `correct` field describes: the arm with the switch on.
 * A competitor run and a report therefore share no provider name, and pairing them reports "nothing here can be
 * paired" rather than silently comparing two different things.
 */
function scoresOf(payload) {
  if (Array.isArray(payload.scores)) return payload.scores;
  if (Array.isArray(payload.questions)) {
    const records = payload.questions.map((question) => ({
      id: question.id,
      capability: question.capability,
      // Retrieval columns do not exist in a report, and inventing `false` for them would make an arm look empty.
      found: true,
      foundAll: true,
      read: true,
      correct: question.correct === true,
    }));
    const correct = records.filter((record) => record.correct).length;
    return [
      {
        provider: 'feature',
        build: 'n/a',
        questions: records.length,
        measured: records.length,
        unmeasurable: 0,
        found: records.length,
        foundAll: records.length,
        empty: 0,
        recallAtK: 1,
        recallAllAtK: 1,
        mrr: 1,
        sessions: 0,
        turns: 0,
        meanContextChars: 0,
        correct,
        read: records.length,
        accuracy: records.length === 0 ? null : correct / records.length,
        abstained: 0,
        skipped: [],
        byCapability: {},
        ingestSkipped: 0,
        records,
      },
    ];
  }
  throw new Error(
    'this file does not look like a harness run: it has neither a scores[] array nor a questions[] array',
  );
}

/** The dataset label of one run, from either shape. */
function datasetOf(payload) {
  return payload.config?.dataset ?? payload.dataset ?? 'unstated';
}

function load(file) {
  const payload = JSON.parse(readFileSync(file, 'utf8'));
  const scores = scoresOf(payload);
  return { name: path.basename(file), payload, scores, dataset: datasetOf(payload) };
}

const pad = (value, width) => String(value).padEnd(width);
const pct = (value) => `${(100 * value).toFixed(1)}%`;

/** `improved` / `regressed` / `not significant`, with the no-change case named separately. */
function verdictOf(result) {
  if (result.improved + result.regressed === 0) return 'no change';
  if (result.p >= alpha) return 'not significant';
  return result.delta > 0 ? 'improved' : 'regressed';
}

function rowOf(result, width) {
  const unmatched = result.unmatched === 0 ? '' : ` (${result.unmatched} unmatched)`;
  return (
    `${pad(result.provider, width)}${pad(result.n, 6)}${pad(result.improved, 6)}` +
    `${pad(result.regressed, 6)}${pad(pct(result.delta), 9)}${pad(result.p.toFixed(4), 10)}` +
    `${verdictOf(result)}${unmatched}\n`
  );
}

if (within) {
  const run = load(positional[0]);
  // "Read" is the only filter applied here, and it is stated rather than silent: an arm that never reached the
  // reader has `correct: false` on every question, so pairing it would measure the floor and call it the arm.
  const read = run.scores.filter((score) => score.records.some((record) => record.read));
  const unread = run.scores.filter((score) => !score.records.some((record) => record.read));

  process.stdout.write(`run      : ${run.name}  (${run.dataset})\n`);
  process.stdout.write(`alpha    : ${alpha}\n`);
  process.stdout.write(
    `arms read: ${read.map((score) => `${score.provider} ${score.correct}/${score.read}`).join(', ')}\n`,
  );
  if (unread.length > 0) {
    process.stdout.write(
      `excluded : ${unread.map((score) => score.provider).join(', ')} — not read, so every question scores as\n` +
        `           wrong and a pair would report the floor as a difference\n`,
    );
  }
  process.stdout.write('\n');

  if (read.length < 2) {
    process.stdout.write(
      `one read arm in this run, so there is no pair to test. A paired test needs two arms answering the same\n` +
        `questions; set the run's read arms to at least two.\n`,
    );
    process.exit(0);
  }

  const width = Math.max(...read.map((score) => score.provider.length)) * 2 + 2;
  process.stdout.write(
    `${pad('baseline->treatment', width)}${pad('n', 6)}${pad('+', 6)}${pad('-', 6)}${pad('delta', 9)}` +
      `${pad('p', 10)}verdict\n`,
  );
  for (const [i, baselineArm] of read.entries()) {
    for (const treatmentArm of read.slice(i + 1)) {
      // Both arms come from this one file, which is what makes the pairing legitimate: the run sampled the
      // question list once and every arm answered that list. `compareArmsInRun` refuses anything else.
      process.stdout.write(
        rowOf(compareArmsInRun(run.scores, baselineArm.provider, treatmentArm.provider), width),
      );
    }
  }

  process.stdout.write(
    `\nPairing comes from the run, not from matching provider names: one invocation hands every arm the same\n` +
      `questions, so each pair is the same questions under two systems. 'delta' is the treatment's accuracy minus\n` +
      `the baseline's, and '+'/'-' count the questions that changed direction. The p-value is the two-tailed\n` +
      `exact McNemar test over those two counts only.\n`,
  );
  process.exit(0);
}

const baseline = load(positional[0]);
const treatment = load(positional[1]);

const sameCorpus = baseline.dataset === treatment.dataset;
if (!sameCorpus) {
  // Not fatal — a reader may be comparing two subsets on purpose — but it has to be said before the p-value,
  // because a paired test over two different samples is not a paired test.
  process.stdout.write(
    `warning: the two runs name different datasets ` +
      `(${baseline.dataset} vs ${treatment.dataset}); ` +
      `pairing by question id still applies to whatever they share\n\n`,
  );
}

const results = compareRuns(baseline.scores, treatment.scores);

process.stdout.write(`baseline : ${baseline.name}  (${baseline.dataset})\n`);
process.stdout.write(`treatment: ${treatment.name}  (${treatment.dataset})\n`);
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
  process.stdout.write(rowOf(result, 20));
}

process.stdout.write(
  `\n'+' is a question the treatment got right and the baseline did not; '-' is the reverse. The p-value is the\n` +
    `two-tailed exact McNemar test over those two counts only, so a run where nothing moved reads 'no change'\n` +
    `rather than 'significant'.\n`,
);
