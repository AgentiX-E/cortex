#!/usr/bin/env node
/**
 * MR's accuracy, read from the numbers instead of from the judge.
 *
 *     node tools/numeric-recheck.mjs --artifact <report.json> [--capability MR|all] [--out <file>] [--sample N]
 *
 * ## Why this exists beside `tools/mr-entity-recheck.mjs`
 *
 * The name screen ran on the 84 accepted MR answers of `41159983913` and could reach 2 of them: **82 of
 * the golds name nothing at all**. Reading the golds explains it — `2`, `$50`, `20%`, `3 days`, `$5,850`,
 * `140 hours`. Multi-session reasoning on this dataset is arithmetic across sessions, so a screen built on
 * *which name appears* is blind to the one capability the head-to-head is about.
 *
 * This compares the number the answer states with the number the gold states, and the comparison needs no
 * judge. That makes it the only reading in this repository that reports accuracy for a capability while
 * the instrument under audit is exactly what is in question.
 *
 * ## What it produces
 *
 * Two populations (what the judge accepted, what it rejected) each split five ways, plus the two lists
 * that matter — accepted answers stating a different number, and **rejected answers stating the gold's
 * number**. The second list is the one the judge audit structurally cannot produce, because it perturbs
 * answers the judge already accepted.
 *
 * ## The gate
 *
 * Exit 1 when the capability has no row this instrument can read. `0 of 84 reachable` and `0 false
 * accepts` print the same number and mean opposite things, which is the failure the first name reading
 * shipped with for one run.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

import { numericScreen } from '../packages/cortex-eval/dist/index.js';

function flag(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : (process.argv[index + 1] ?? '');
}

function flags(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name) values.push(process.argv[index + 1] ?? '');
  }
  return values;
}

/**
 * One artifact's graded answers as numeric-screen sources, with the rows it could not use named.
 *
 * The first version of this function filtered on `typeof question.answer === 'string'` and dropped every
 * row whose answer was absent — which is every **decline**. On MR that silently removed 8 of 121 rows
 * (`§13.186`), and because a decline is never correct the effect was invisible in the numerator: the
 * denominator fell from 121 to 113 and the reading looked complete. A missing answer is not a row to
 * drop, it is a decline, and this instrument already has a relation for it.
 */
export function sourcesFrom(questions) {
  const usable = questions.filter(
    (question) =>
      typeof question.questionId === 'string' && typeof question.correct === 'boolean',
  );
  return {
    sources: usable.map((question) => ({
      questionId: question.questionId,
      capability: typeof question.capability === 'string' ? question.capability : '',
      gold: typeof question.groundTruth === 'string' ? question.groundTruth : '',
      // A decline, kept as an empty answer so it lands in `answer-unreachable` rather than vanishing.
      answer: typeof question.answer === 'string' ? question.answer : '',
      accepted: question.correct,
    })),
    dropped: questions.length - usable.length,
    total: questions.length,
  };
}

const RELATIONS = ['agrees', 'agrees-early', 'differs', 'gold-unreachable', 'answer-unreachable'];

function printTally(label, tally) {
  console.log(
    `  ${label.padEnd(9)} ${String(tally.total).padStart(3)} rows   ` +
      RELATIONS.map((relation) => `${relation} ${tally[relation]}`).join('   '),
  );
}

function printSample(rows, sources, size) {
  if (size <= 0) return;
  const byId = new Map(sources.map((source) => [source.questionId, source]));
  const chosen = [...rows]
    .filter((row) => row.relation !== 'agrees')
    .sort((left, right) => left.questionId.localeCompare(right.questionId))
    .slice(0, size);
  // The sample shows the rows that disagree, because those are the ones a reader has to adjudicate. A
  // sample of agreements would confirm the instrument and teach nothing.
  console.log(`\nsample (${chosen.length} disagreeing rows, id order)`);
  for (const row of chosen) {
    const source = byId.get(row.questionId);
    const clean = (text) => (text ?? '').replace(/\s+/g, ' ').slice(0, 260);
    console.log(`[${row.relation}] ${row.accepted ? 'accepted' : 'rejected'} ${row.questionId}`);
    console.log(`  gold    ${clean(source?.gold)}`);
    console.log(`  answer  ${clean(source?.answer)}`);
    console.log(`  numbers gold ${row.goldValues.join(', ') || '(none)'} | stated ${row.stated ?? '(none)'}`);
  }
}

function main() {
  const artifacts = flags('--artifact');
  if (artifacts.length === 0) {
    console.error(
      'usage: numeric-recheck.mjs --artifact <report.json> [--artifact …] [--capability MR|all] [--out <file>] [--sample N]',
    );
    return 2;
  }
  const capability = flag('--capability') ?? 'MR';

  const all = [];
  for (const path of artifacts) {
    const report = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(report.questions)) throw new Error(`${path} has no questions array`);
    const { sources, dropped, total } = sourcesFrom(report.questions);
    const screened = sources.filter((source) => capability === 'all' || source.capability === capability);
    console.log(
      `artifact          ${path}  (${screened.length} of ${sources.length} rows in scope; ` +
        `${dropped} of ${total} unusable, no verdict)`,
    );
    all.push(...screened);
  }

  const reading = numericScreen(all);
  console.log(`capability        ${capability}`);
  console.log('\njudge verdict, then the number the answer states');
  printTally('accepted', reading.accepted);
  printTally('rejected', reading.rejected);

  const { correct, total, unreachable } = reading.judgeFree;
  console.log(
    `\njudge-free accuracy  ${correct}/${total} ` +
      `(${total === 0 ? '—' : `${((correct / total) * 100).toFixed(1)}%`})` +
      `   unreachable ${unreachable} of ${reading.accepted.total + reading.rejected.total}`,
  );
  const bound = reading.falseAccept;
  console.log(
    `false accepts      ${bound.accepted}/${bound.readable} readable accepted answers ` +
      `(${(bound.rate * 100).toFixed(1)}%, Wilson 95% upper ${(bound.upper * 100).toFixed(1)}%)`,
  );
  console.log(
    `false rejects      ${reading.falseRejects.length} rejected answers stating the gold's number`,
  );

  if (reading.falseAccepts.length > 0 || reading.falseRejects.length > 0) {
    console.log('\nthe two lists, which are different failures');
    for (const row of reading.falseRejects) {
      console.log(`  false reject   ${row.questionId}  gold ${row.goldValues.join(',')} stated ${row.stated}`);
    }
    for (const row of reading.falseAccepts) {
      console.log(`  false accept   ${row.questionId}  gold ${row.goldValues.join(',')} stated ${row.stated}`);
    }
  }

  printSample(reading.rows, all, Number(flag('--sample') ?? '0'));

  const out = flag('--out');
  if (out) {
    const payload = {
      what: 'Accuracy of a numeric capability read from the numbers the answers state, with no judge in the loop.',
      capability,
      artifacts,
      accepted: reading.accepted,
      rejected: reading.rejected,
      judgeFree: reading.judgeFree,
      falseAccept: reading.falseAccept,
      falseAccepts: reading.falseAccepts.map((row) => ({
        questionId: row.questionId,
        goldValues: row.goldValues,
        stated: row.stated,
      })),
      falseRejects: reading.falseRejects.map((row) => ({
        questionId: row.questionId,
        goldValues: row.goldValues,
        stated: row.stated,
      })),
    };
    writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`\nwrote ${out}`);
  }

  if (reading.judgeFree.total === 0) {
    console.log(
      `\nGATE FAILS: no row in capability ${capability} has both a gold number and a stated number. The instrument did not reach.`,
    );
    return 1;
  }
  return 0;
}

process.exitCode = main();
