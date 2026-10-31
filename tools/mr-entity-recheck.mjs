#!/usr/bin/env node
/**
 * Which of the answers the judge accepted name something the gold does not name?
 *
 *     node tools/mr-entity-recheck.mjs --artifact <report.json> [--capability MR] [--out <file>]
 *
 * ## Why this runs on an artifact rather than against a model
 *
 * `tools/judge-audit.mjs` measured the judge accepting **19.38%** of answers that were wrong by
 * construction, and the split is the finding: `entity-swap` **44.90%**, `number-swap` **14.75%**,
 * `cross-gold` **0/50**. This judge checks that an answer is about the right thing and does not check
 * which names it states. If that is true, then an answer whose names are disjoint from its gold's
 * names is an answer the judge accepted while it should not have — and it is already written down in
 * the artifact. So the screen costs no tokens, and anyone can re-derive it.
 *
 * ## What it produces, and what it does not
 *
 * One row per graded answer with the four-way relation from `nameScreen`, and two tallies: accepted
 * (where a false accept can live) and rejected (the discrimination control — those answers are wrong by
 * the judge's own verdict, so a screen that fires equally often on both is not detecting wrongness).
 * The candidate list is a **lower bound**: an answer that says `"2 people"` where the gold says
 * `"Alice and Bob"` is invisible here, which is why `unnamed-answer` is a published relation and not a
 * pass.
 *
 * ## The capability flag, and why the default is MR
 *
 * Multi-session reasoning is where the campaign's head-to-head lives: the arm reads 84/121 in round one
 * against a reference arm's 100-102, and the audit's 19.38% over 121 questions is 23.5 questions —
 * larger than that gap. So the whole reason to build this is to find out whether the gap is memory or
 * grading, and MR is the population that decides it. `--capability all` screens everything, which is the
 * form used to check that the screen is not simply silent on the other three capabilities.
 *
 * ## The gate
 *
 * Exit 1 when the capability has no accepted answer at all. That is not a reading of zero candidates,
 * it is an instrument that did not reach — a mistyped capability code or an artifact from another
 * benchmark, either of which would otherwise publish "0 candidates" as a clean result.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

import { nameScreen } from '../packages/cortex-eval/dist/index.js';

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

/** One artifact's graded answers as screen sources. Abstentions are screened like anything else. */
export function sourcesFrom(questions) {
  return questions
    .filter(
      (question) =>
        typeof question.questionId === 'string' &&
        typeof question.groundTruth === 'string' &&
        typeof question.answer === 'string' &&
        typeof question.correct === 'boolean',
    )
    .map((question) => ({
      questionId: question.questionId,
      capability: typeof question.capability === 'string' ? question.capability : '',
      gold: question.groundTruth,
      answer: question.answer,
      accepted: question.correct,
    }));
}

function percent(part, whole) {
  return whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`;
}

function printTally(label, tally) {
  console.log(
    `  ${label.padEnd(9)} ${String(tally.total).padStart(3)} rows   ` +
      `shared ${String(tally['shared-name']).padStart(3)}   ` +
      `disjoint ${String(tally['names-disjoint']).padStart(3)}   ` +
      `gold unnamed ${String(tally['unnamed-gold']).padStart(3)}   ` +
      `answer unnamed ${String(tally['unnamed-answer']).padStart(3)}`,
  );
}

function main() {
  const artifacts = flags('--artifact');
  if (artifacts.length === 0) {
    console.error(
      'usage: mr-entity-recheck.mjs --artifact <report.json> [--artifact …] [--capability MR|all] [--out <file>]',
    );
    return 2;
  }
  const capability = flag('--capability') ?? 'MR';

  const perArtifact = [];
  const all = [];
  for (const path of artifacts) {
    const report = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(report.questions)) throw new Error(`${path} has no questions array`);
    const sources = sourcesFrom(report.questions);
    const screened = sources.filter((source) => capability === 'all' || source.capability === capability);
    perArtifact.push({ path, sources, screened });
    all.push(...screened);
  }

  const reading = nameScreen(all);
  console.log(`capability        ${capability}`);
  for (const { path, sources, screened } of perArtifact) {
    console.log(`artifact          ${path}  (${screened.length} of ${sources.length} rows in scope)`);
  }

  console.log('\njudge verdict, then what the names say');
  printTally('accepted', reading.accepted);
  printTally('rejected', reading.rejected);

  // The discrimination check. Published beside the count rather than after it, because a screen that
  // fires on the two populations at the same rate is measuring something other than wrongness.
  const acceptedRate = reading.accepted.total === 0 ? 0 : reading.candidates.length / reading.accepted.total;
  const rejectedRate =
    reading.rejected.total === 0 ? 0 : reading.rejected['names-disjoint'] / reading.rejected.total;
  console.log(
    `\ndisjoint names    accepted ${reading.candidates.length}/${reading.accepted.total} ` +
      `(${percent(reading.candidates.length, reading.accepted.total)})   ` +
      `rejected ${reading.rejected['names-disjoint']}/${reading.rejected.total} ` +
      `(${percent(reading.rejected['names-disjoint'], reading.rejected.total)})`,
  );
  console.log(
    `reach             ${reading.reachable} of ${reading.accepted.total} accepted rows have a gold that names anything`,
  );

  if (reading.candidates.length > 0) {
    console.log('\ncandidates (accepted, and naming nothing the gold names)');
    for (const row of reading.candidates) {
      const source = all.find((item) => item.questionId === row.questionId);
      console.log(`\n[${row.capability}] ${row.questionId}`);
      console.log(`  gold    ${(source?.gold ?? '').replace(/\s+/g, ' ').slice(0, 200)}`);
      console.log(`  answer  ${(source?.answer ?? '').replace(/\s+/g, ' ').slice(0, 200)}`);
      console.log(`  gold names    ${row.goldNames.join(', ') || '(none)'}`);
      console.log(`  answer names  ${row.answerNames.join(', ') || '(none)'}`);
    }
  }

  const out = flag('--out');
  if (out) {
    const payload = {
      what: 'Accepted answers whose names are disjoint from their gold’s names, screened from an artifact with no model.',
      capability,
      artifacts,
      accepted: reading.accepted,
      rejected: reading.rejected,
      reachable: reading.reachable,
      discrimination: {
        acceptedRate,
        rejectedRate,
        // Stated as a ratio so a reader does not have to divide two percentages to see whether the
        // screen separates the populations at all.
        ratio: rejectedRate === 0 ? null : acceptedRate === 0 ? 0 : acceptedRate / rejectedRate,
      },
      // The rows, truncated. The full text lives in the artifact and is named above, so the reading
      // stays small enough to commit while every candidate can still be found and read in place.
      candidates: reading.candidates.map((row) => {
        const source = all.find((item) => item.questionId === row.questionId);
        return {
          questionId: row.questionId,
          capability: row.capability,
          goldNames: row.goldNames,
          answerNames: row.answerNames,
          gold: (source?.gold ?? '').slice(0, 400),
          answer: (source?.answer ?? '').slice(0, 400),
        };
      }),
    };
    writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`\nwrote ${out}`);
  }

  if (reading.accepted.total === 0) {
    console.log(`\nGATE FAILS: no accepted answer in capability ${capability}. The screen did not reach.`);
    return 1;
  }
  return 0;
}

process.exitCode = main();
