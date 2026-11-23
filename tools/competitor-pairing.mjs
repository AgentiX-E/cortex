#!/usr/bin/env node
/**
 * Split the competitor gap into the part that is the judge and the part that is the system.
 *
 *     node tools/competitor-pairing.mjs --ours <benchmark-report.json> --regrade <regrade.json> --out <dir>
 *
 * ## The three readings, and why two of them are not the headline
 *
 * Before the re-grade there is one number: 95.60% against 91.20%, a 4.40-point gap. It mixes three
 * things and separates none of them:
 *
 * | reading | our answers | their answers | judge |
 * | --- | --- | --- | --- |
 * | **ruler** | — | ✓ | theirs vs ours, **same answers** |
 * | **system** | ✓ | ✓ | **ours, both sides** |
 * | reference | ✓ | ✓ | mixed -- the old headline |
 *
 * *Ruler* holds the answers fixed and varies the judge, so what moves is the instrument. *System* holds
 * the judge fixed and varies the answers, so what moves is the system. The reference is what the
 * campaign quoted before the re-grade existed, and it cannot attribute its own gap -- which is the whole
 * reason this file exists.
 *
 * ## Why `rescued`/`revoked` are reported per reading rather than once
 *
 * The names mean different things on the two sides. Under *ruler*, "we accept what they rejected" is a
 * statement about strictness; under *system*, "we are right where they are wrong" is a statement about
 * answers. One counter serving both would let a strictness finding be quoted as a capability finding.
 *
 * ## Why this is a tool and not a paragraph in the report
 *
 * Because the pairing must be re-derivable for free. `--ours` and `--regrade` are two artefacts on
 * disk; a claim about which of the two readings is the real one has to be checkable without another
 * dispatch, or it gets checked once.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

function flag(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : (process.argv[index + 1] ?? '');
}

/**
 * The exact two-sided sign test over discordant pairs.
 *
 * The same test as `discordantPValue` in `competitor-regrade.mjs`, written out rather than imported:
 * that module pulls the `cortex-eval` build at import time for its scorer, and a tool that only counts
 * pairs has no business needing a built workspace. The duplication is two functions and a loop, and the
 * alternative is a free check that cannot run when the build is stale.
 */
export function signTest(movedOneWay, movedTheOther) {
  const n = movedOneWay + movedTheOther;
  if (n === 0) return 1;
  const tail = Math.min(movedOneWay, movedTheOther);
  let cumulative = 0;
  let term = 1;
  for (let k = 0; k <= tail; k += 1) {
    if (k > 0) term = (term * (n - k + 1)) / k;
    cumulative += term;
  }
  return Math.min(1, (2 * cumulative) / Math.pow(2, n));
}

/** One two-sided comparison over questions both sides answered. */
function compare(rows, left, right, leftName, rightName) {
  const paired = rows.filter((row) => row[left] !== null && row[left] !== undefined && row[right] !== null && row[right] !== undefined);
  const leftWins = paired.filter((row) => row[left] && !row[right]).length;
  const rightWins = paired.filter((row) => !row[left] && row[right]).length;
  const leftCount = paired.filter((row) => row[left]).length;
  const rightCount = paired.filter((row) => row[right]).length;
  return {
    paired: paired.length,
    [`${leftName}`]: leftCount,
    [`${rightName}`]: rightCount,
    [`${leftName}Rate`]: paired.length === 0 ? null : leftCount / paired.length,
    [`${rightName}Rate`]: paired.length === 0 ? null : rightCount / paired.length,
    delta:
      paired.length === 0 ? null : (leftCount - rightCount) / paired.length,
    [`${leftName}Only`]: leftWins,
    [`${rightName}Only`]: rightWins,
    agreeBoth: paired.filter((row) => row[left] && row[right]).length,
    agreeNeither: paired.filter((row) => !row[left] && !row[right]).length,
    pValue: signTest(leftWins, rightWins),
  };
}

/**
 * The cortex side, keyed by question id, from a benchmark report.
 *
 * `questions[].correct` is the per-question verdict (456 of 500 on the registered arm). The report's
 * headline `costEfficiency.accuracy` divides 1,825 by **2,000** -- four passes -- and is deliberately
 * not read here: pairing it against a single pass would compare two denominators, which is the units
 * error `PREREGISTRATION-COMPETITOR-REGRADE.md` §1 corrects.
 */
export function oursById(report) {
  const questions = Array.isArray(report?.questions) ? report.questions : [];
  return new Map(
    questions
      .filter((question) => typeof question?.questionId === 'string')
      .map((question) => [question.questionId, question.correct === true]),
  );
}

async function main() {
  const oursPath = flag('--ours');
  const regradePath = flag('--regrade');
  const outDir = flag('--out-dir') ?? flag('--out');
  if (oursPath === undefined || regradePath === undefined || outDir === undefined) {
    throw new TypeError('pass --ours, --regrade and --out-dir');
  }

  const ours = oursById(JSON.parse(readFileSync(oursPath, 'utf8')));
  const regrade = JSON.parse(readFileSync(regradePath, 'utf8'));
  const rows = Array.isArray(regrade?.rows) ? regrade.rows : [];
  if (rows.length === 0) throw new TypeError('the regrade artefact carries no rows');

  const paired = rows
    .filter((row) => ours.has(row.questionId))
    .map((row) => ({
      questionId: row.questionId,
      questionType: row.questionType,
      abstention: row.abstention,
      ours: ours.get(row.questionId),
      theirsUnderOurJudge: row.ourVerdict === true,
      theirsUnderTheirJudge: row.publishedVerdict,
    }));

  const readings = {
    // Same answers, two judges. What moves is the instrument.
    ruler: compare(paired, 'theirsUnderOurJudge', 'theirsUnderTheirJudge', 'underOurJudge', 'underTheirJudge'),
    // Same judge, two sets of answers. What moves is the system.
    system: compare(paired, 'ours', 'theirsUnderOurJudge', 'ours', 'theirs'),
    // The old headline: two judges and two sets of answers, so it cannot attribute its own gap.
    reference: compare(paired, 'ours', 'theirsUnderTheirJudge', 'ours', 'theirs'),
  };

  const result = {
    sources: { ours: oursPath, regrade: regradePath },
    judge: regrade.judge ?? null,
    channels: regrade.channels ?? null,
    abstentionUnknown: regrade.abstentionUnknown ?? null,
    pairedQuestions: paired.length,
    readings,
    rows: paired,
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'pairing.json'), `${JSON.stringify(result, null, 2)}\n`);

  const line = (name, reading, leftName, rightName) =>
    `${name.padEnd(10)} ${String(reading.paired).padStart(3)} paired  ` +
    `${leftName} ${(100 * reading[`${leftName}Rate`]).toFixed(2)}%  ` +
    `${rightName} ${(100 * reading[`${rightName}Rate`]).toFixed(2)}%  ` +
    `delta ${(100 * reading.delta).toFixed(2)}  ` +
    `only-left ${reading[`${leftName}Only`]}  only-right ${reading[`${rightName}Only`]}  ` +
    `p ${reading.pValue.toFixed(4)}`;

  process.stdout.write(
    [
      line('ruler', readings.ruler, 'underOurJudge', 'underTheirJudge'),
      line('system', readings.system, 'ours', 'theirs'),
      line('reference', readings.reference, 'ours', 'theirs'),
    ].join('\n') + '\n',
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
