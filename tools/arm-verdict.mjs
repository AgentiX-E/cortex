#!/usr/bin/env node
/**
 * The verdict on one arm, read out of two ablation reports and printed once.
 *
 *     node tools/arm-verdict.mjs --control 42355323615.json --arm 42758152902.json \
 *       --capability KU --require-identical-evidence --bar conversions=3,falsifier=2
 *
 * ## Why this is a tool and not four lines in a document
 *
 * `§13.354.5` registers `V4` after two administrations of one mechanism were read by hand and the
 * hand readings produced two claims the artifacts contradict: an arm's `baseline` line compared
 * against the other arm's `perCapability` field (`§13.353.4`), and a bar whose population was a
 * `max` across repetitions where the artifacts hold a per-question mask (`§13.353.3`). Neither was
 * arithmetic; both were **population** mistakes, and a population mistake is exactly what a second
 * reading of the same two files cannot catch. So the projection from report to masks lives here,
 * once, and the statistics live in `packages/cortex-eval/src/arm-verdict.ts` where they are tested.
 *
 * ## What it refuses, and why refusing is the point
 *
 * - **Different question sets.** Two artifacts over different populations are not a pair. The
 *   archive is 500 questions and a scoped arm is 72, so the capability filter is applied to both and
 *   the result must come out identical; if it does not, the run was not the filter it claims.
 * - **Unequal repetitions.** A per-question pass *count* is not comparable across repetition counts,
 *   for the same reason `efficiency-frontier.mjs` exits 2 on unequal `runs` (`§13.313`: the cache
 *   share is a function of the repetition count, and so is a mean).
 * - **Evidence that moved,** when the caller says the mechanism cannot move it. This is the check
 *   that made the two `conflicts` readings admissible at all: the block is inserted after the budget
 *   decided the carried set, so `evidenceChars` must be equal question for question.
 * - **A different corpus,** whenever both artifacts name one. The dataset is served from a moving
 *   branch, so two dispatches can agree on all five hundred question ids and disagree on what the
 *   sessions say; the ids cannot show that, and a paired reading over a moved corpus is two datasets
 *   under one label. `--require-same-dataset` adds the other half -- an artifact that predates the
 *   field cannot show that its corpus was the same one.
 *
 * Exit codes: `0` a reading was taken; `2` usage; `3` the pair is inadmissible (the refusals are
 * printed and nothing is decided).
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

import { armVerdict } from '../packages/cortex-eval/dist/arm-verdict.js';

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const has = (name) => argv.includes(name);

const usage = `usage: node tools/arm-verdict.mjs --control <report.json> --arm <report.json>
         [--capability KU] [--side feature|baseline] [--require-identical-evidence]
         [--require-same-dataset] [--bar conversions=<n>,falsifier=<n>[,net=<n>]] [--json]`;

const controlPath = flag('--control');
const armPath = flag('--arm');
if (controlPath === undefined || armPath === undefined) {
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}

const capability = flag('--capability');
const side = flag('--side') ?? 'feature';
if (side !== 'feature' && side !== 'baseline') {
  process.stderr.write(`--side must be feature or baseline, got ${side}\n${usage}\n`);
  process.exit(2);
}

const barArgument = flag('--bar');
let bar;
if (barArgument !== undefined) {
  const parts = new Map(
    barArgument.split(',').map((piece) => {
      const [key, value] = piece.split('=');
      return [key, Number(value)];
    }),
  );
  const conversions = parts.get('conversions');
  const falsifierLoss = parts.get('falsifier');
  if (!Number.isInteger(conversions) || !Number.isInteger(falsifierLoss)) {
    process.stderr.write(
      `--bar needs conversions=<integer>,falsifier=<integer>, got ${barArgument}\n${usage}\n`,
    );
    process.exit(2);
  }
  // The third clause is optional and is refused when present but not an integer, for the reason the
  // first two are: a `net=x` that fell back to "no net clause" would print REJECTED-as-ACCEPTED
  // against a criterion that never reached the tool.
  const net = parts.has('net') ? parts.get('net') : undefined;
  if (net !== undefined && !Number.isInteger(net)) {
    process.stderr.write(
      `--bar net=<integer> is optional, but when given it must be an integer, got ${barArgument}\n${usage}\n`,
    );
    process.exit(2);
  }
  bar = { conversions, falsifierLoss, ...(net === undefined ? {} : { net }) };
}

/**
 * One report, projected to the rows a paired reading needs.
 *
 * The masks come from `ablation.<side>CorrectByRun`, which is `runs` strings of `questions.length`
 * characters in `questions[]` order. The alternative — `ablation.<side>ByCapability` — is refused on
 * purpose: it carries `min`/`avg`/`max` **across repetitions**, and every claim this tool exists to
 * check is a per-question predicate.
 */
function project(path, label) {
  let report;
  try {
    report = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    process.stderr.write(`cannot read ${label} report ${path}: ${error.message}\n`);
    process.exit(2);
  }
  const masks = report?.ablation?.[`${side}CorrectByRun`];
  const questions = report?.questions;
  if (!Array.isArray(masks) || !Array.isArray(questions)) {
    process.stderr.write(
      `${label} report ${path} has no ablation.${side}CorrectByRun or no questions[]\n`,
    );
    process.exit(2);
  }
  if (masks.some((mask) => mask.length !== questions.length)) {
    process.stderr.write(
      `${label} report ${path}: a mask is ${masks.map((mask) => mask.length).join('/')} characters for ${questions.length} questions\n`,
    );
    process.exit(2);
  }
  const rows = questions
    .map((question, index) => ({
      id: question.questionId,
      capability: question.capability,
      correctByRun: masks.map((mask) => mask[index]).join(''),
      evidenceChars: question.evidenceChars,
    }))
    .filter((row) => (capability === undefined ? true : row.capability === capability));
  // Carried out of the file rather than compared here: the refusal lives with the statistics, and the
  // field is optional because the first artifacts predate it.
  const datasetFingerprint =
    typeof report?.datasetFingerprint === 'string' ? report.datasetFingerprint : undefined;
  return { label, path, repetitions: masks.length, rows, datasetFingerprint };
}

const control = project(controlPath, 'control');
const arm = project(armPath, 'arm');

const verdict = armVerdict(
  { questions: control.rows, datasetFingerprint: control.datasetFingerprint },
  { questions: arm.rows, datasetFingerprint: arm.datasetFingerprint },
  {
    ...(bar === undefined ? {} : { bar }),
    ...(has('--require-identical-evidence') ? { requireIdenticalEvidence: true } : {}),
    ...(has('--require-same-dataset') ? { requireSameDataset: true } : {}),
  },
);

const percent = (value) => `${(value * 100).toFixed(2)}%`;

/**
 * The bar, on one line, with the net clause shown only when the criterion asked for it.
 *
 * Conditional rather than always-printed so a two-clause bar keeps the line it has always had: the
 * strings in the tests and in `docs/MEASURE-CONFLICT-SURFACING.md` §5 are the record of a verdict
 * that was decided, and a cosmetic change to them would make two readings of one bar look like two
 * different bars. The counts are printed beside `met` because the clause is a subtraction, and a
 * reader should not have to do it to check the verdict.
 */
const barLine = (verdict) => {
  const { bar } = verdict;
  const net =
    bar.netMet === null
      ? ''
      : ` net up ${verdict.questionsUp} - down ${verdict.questionsDown} = ${
          verdict.questionsUp - verdict.questionsDown
        } met=${bar.netMet}`;
  return `bar: conversions met=${bar.conversionsMet} no-regression met=${bar.noRegressionMet}${net} falsified=${bar.falsified} -> ${bar.accepted ? 'ACCEPTED' : 'REJECTED'}`;
};
const moveLine = (move) =>
  `  ${move.id.padEnd(10)} ${move.control} -> ${move.arm}   ${move.controlPasses} -> ${move.armPasses}`;

if (has('--json')) {
  process.stdout.write(
    `${JSON.stringify(
      {
        control: { path: control.path, questions: control.rows.length, repetitions: control.repetitions },
        arm: { path: arm.path, questions: arm.rows.length, repetitions: arm.repetitions },
        capability: capability ?? null,
        side,
        verdict,
      },
      null,
      2,
    )}\n`,
  );
} else {
  process.stdout.write(
    [
      `control  ${control.path}`,
      `arm      ${arm.path}`,
      `${capability ?? 'all capabilities'}, ${side} side, ${control.repetitions} repetition(s)`,
      `dataset  ${control.datasetFingerprint ?? 'unrecorded'} / ${arm.datasetFingerprint ?? 'unrecorded'}`,
      '',
      verdict.comparable
        ? [
            `questions ${verdict.questions}, cells ${verdict.cells}`,
            `passes ${verdict.controlPasses} -> ${verdict.armPasses}  (${percent(verdict.controlRate)} -> ${percent(verdict.armRate)}, ${verdict.deltaPoints >= 0 ? '+' : ''}${verdict.deltaPoints.toFixed(2)} points)`,
            `cells ${verdict.improvedCells} improved / ${verdict.worsenedCells} worsened, exact McNemar p = ${verdict.repetitionP.toFixed(4)}`,
            `questions up/down ${verdict.questionsUp} / ${verdict.questionsDown}, exact sign test p = ${verdict.questionP.toFixed(4)}`,
            `control-perfect ${verdict.controlPerfect}`,
            `conversions ${verdict.conversions.length}`,
            ...verdict.conversions.map(moveLine),
            `regressions ${verdict.regressions.length}`,
            ...verdict.regressions.map(moveLine),
            `control-perfect regressions ${verdict.controlPerfectRegressions.length}`,
            ...verdict.controlPerfectRegressions.map(moveLine),
            ...(verdict.bar === null
              ? ['bar: none given, so nothing is decided']
              : [barLine(verdict)]),
          ].join('\n')
        : `INADMISSIBLE: ${verdict.refusals.join(', ')}`,
      '',
    ].join('\n'),
  );
}

process.exit(verdict.comparable ? 0 : 3);
