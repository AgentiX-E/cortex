#!/usr/bin/env node
/**
 * Read the B7 A/B through the pre-registered criterion.
 *
 * This is a TOOL, not a test: it consumes the two arms' benchmark reports and
 * applies `judgeCriterion` to them. It exists because the criterion was
 * published before it could be executed, and the two intervening audits
 * (`AUDIT-B7-DEAD-SWITCH.md`, `AUDIT-B7-CRITERION-COHORT.md`) made it
 * executable. Running it is what closes the loop.
 *
 * The order of operations is the criterion's, not convenience:
 *
 *   1. Recompute the target cohort from the artifacts' own inputs.
 *   2. Reconcile it against the published count BEFORE reading the arms, so a
 *      roster that no longer describes these inputs is reported as such rather
 *      than silently deciding the verdict.
 *   3. Check that BOTH arms actually recorded an answer for every question, and
 *      refuse to judge if either did not.
 *   4. Only then judge the arms.
 *
 * Step 3 is not a nicety. `QuestionRecord.answer` distinguishes `null` (the
 * reader abstained) from an ABSENT key (nobody recorded an answer), and the
 * criterion consumes only the first. This reader used to collapse both to `null`
 * with a `??` chain, which made a recording gap in the feature arm read as a
 * non-target question moving from its answer to an abstention -- i.e. as a
 * REGRESSION, the one verdict that cannot be overridden by a target gain. A
 * missing record is a fact about the artifact, not about the pipeline, and it
 * must be reported as a gap rather than spent as evidence against the arm.
 *
 * Usage: node tools/read-b7-criterion.mjs <control.json> <feature.json>
 */

import { readFileSync } from 'node:fs';
import {
  computeTargetCohort,
  verifyTargetCohort,
  judgeCriterion,
  outcomeMoved,
} from '../packages/cortex-eval/dist/b7-cohort.js';
import { buildQuestionRecords } from '../packages/cortex-eval/dist/question-record.js';

const PUBLISHED_TARGET_COUNT = 9;

function load(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Pull per-question records out of a benchmark report.
 *
 * `questions` is FIRST in the candidate list because it is the field
 * `runNaturalLanguageBenchmark` now produces, with the record shape
 * `computeTargetCohort` consumes (`questionId / question / groundTruth / answer
 * / turns / grounded`). The older names are kept as fallbacks so a run that
 * predates the field still reads rather than being reported as unreadable.
 *
 * A missing key is reported rather than defaulted, because a silently-empty
 * cohort would make the verdict vacuous — a criterion that returns `no-move`
 * because it was handed zero questions is indistinguishable from one that
 * returns `no-move` because nothing moved.
 */
function extractQuestions(report, label) {
  const candidates = [
    report.questions,
    report.perQuestion,
    report.results,
    report.details,
  ].filter(Array.isArray);
  if (candidates.length === 0) {
    throw new Error(
      `${label}: no per-question array found. Top-level keys: ${Object.keys(report).join(', ')}`,
    );
  }
  return candidates[0];
}

/**
 * Read one arm's per-question records.
 *
 * Delegated to the package's own `buildQuestionRecords`, the same function
 * `tools/quantify-endpoint-noise.mjs` uses, rather than mapped inline here. Two
 * parsers for one artifact is two places for the same field-name fallbacks to
 * drift, and the failure is silent: the two readers would disagree about the
 * same file while both looked correct. This reader previously carried its own
 * `q.questionId ?? q.id ?? q.question_id` chain; that is now the builder's job.
 *
 * `retrieved` is reassembled from `turns` because `buildQuestionRecords` accepts
 * the joined text (it splits it back into turns). The round trip is lossless for
 * what the criterion consumes: it clusters over turn TEXT, and `toTurns` drops
 * only blank lines, which carry no content terms and cannot be clustered.
 */
function readRecords(report, label) {
  const questions = extractQuestions(report, label);
  const inputs = questions.map((q, i) => {
    // The builder requires an id and throws on a duplicate; a record with no id
    // cannot be joined against anything, so it is reported here rather than
    // silently dropped, which would shrink the cohort without saying so.
    const questionId = String(q.questionId ?? '');
    if (questionId === '') {
      throw new Error(
        `${label}: question at index ${i} carries no 'questionId'. The per-question ` +
          'roster is the join key for the whole criterion; an unkeyable record cannot ' +
          'be used and dropping it would silently shrink the target cohort.',
      );
    }
    const turns = q.turns ?? [];
    return {
      questionId,
      question: String(q.question ?? ''),
      capability: String(q.capability ?? 'unknown'),
      // Spread conditionally so an absent `groundTruth` stays absent. Passing
      // `undefined` explicitly is not the same thing under
      // `exactOptionalPropertyTypes`, and "the dataset states no gold" is a real
      // case (`null` gold) distinct from "this record has no gold field".
      ...(q.groundTruth === undefined ? {} : { groundTruth: q.groundTruth }),
      ...(q.answer === undefined ? {} : { answer: q.answer }),
      correct: q.correct === true,
      grounded: q.grounded === true,
      retrieved: turns.map((t) => String(t.text ?? '')).join('\n'),
    };
  });
  return buildQuestionRecords(inputs);
}

/** Render one record's answer for the criterion: text, or `null` for abstention. */
function toAnswer(value) {
  if (value === null) return null;
  if (value === undefined) return null;
  const text = String(value).trim();
  return text.length === 0 ? null : text;
}

function main() {
  const [controlPath, featurePath] = process.argv.slice(2);
  if (!controlPath || !featurePath) {
    console.error('usage: read-b7-criterion.mjs <control.json> <feature.json>');
    return 2;
  }

  const control = load(controlPath);
  const feature = load(featurePath);

  const controlRecords = readRecords(control, 'control');
  const featureRecords = readRecords(feature, 'feature');
  console.log(`control questions: ${controlRecords.length}`);
  console.log(`feature questions: ${featureRecords.length}`);

  // Every per-question record is passed through, including ungrounded ones. An
  // earlier revision filtered to `grounded === true` here, which made
  // `computeTargetCohort`'s `notGrounded` bucket structurally empty in this
  // reader — a bucket that always reads 0 looks like "nothing was excluded"
  // when the truth is "the exclusion happened before the counter could see it".
  // The module classifies; this reader only transcribes.
  const cohortInput = controlRecords.map((record) => ({
    questionId: record.questionId,
    question: record.question,
    ...(record.groundTruth === undefined ? {} : { groundTruth: record.groundTruth }),
    ...(record.answer === undefined ? {} : { answer: record.answer }),
    turns: record.turns,
    grounded: record.grounded,
  }));

  const cohort = computeTargetCohort(cohortInput);
  console.log(`\n--- recomputed cohort ---`);
  console.log(`questions considered: ${cohortInput.length}`);
  console.log(`targets: ${cohort.targets.length}`);
  console.log(`identical: ${cohort.identical.length}`);
  console.log(`unseparable: ${cohort.unseparable.length}`);
  console.log(`notGrounded: ${cohort.notGrounded.length}`);

  const cohortVerdict = verifyTargetCohort(cohort, []);
  console.log(`\n--- cohort verification (published roster is empty: a count is not a roster) ---`);
  if (cohortVerdict.kind === 'matches') {
    console.log(`matches: ${cohortVerdict.count}`);
  } else {
    console.log(`published count claimed: ${cohortVerdict.published}`);
    console.log(`computed roster size:    ${cohortVerdict.computed}`);
    console.log(
      `publication says ${PUBLISHED_TARGET_COUNT}; recomputation found ${cohortVerdict.computed}`,
    );
    if (cohortVerdict.computed !== PUBLISHED_TARGET_COUNT) {
      console.log(
        `>>> DISAGREEMENT with the published count. The published "9" is a claim about a\n` +
          `    snapshot; this run's inputs give ${cohortVerdict.computed}. Report this BEFORE the arms.`,
      );
    } else {
      console.log(
        `>>> Count agrees (${cohortVerdict.computed}), but identity is still unconfirmable — the\n` +
          `    publication names no ids. The ids above are the roster.`,
      );
    }
  }

  // The gap check, run BEFORE the arms and reported as its own block.
  //
  // A record with no `answer` key means no trace reached this question, so nobody
  // recorded what the arm produced. That is a fact about the artifact, while the
  // criterion's input is a fact about the arm — and a `?? null` would turn the
  // first into the second by reporting the gap as an abstention. An abstention on
  // a NON-target is a regression, so the substitution does not merely mislabel:
  // it manufactures the severest verdict the criterion can return out of a
  // missing record. Refusing to judge is the only honest response, because the
  // arm's actual behaviour for that question was never captured.
  const unrecorded = [];
  for (const [arm, records] of [
    ['control', controlRecords],
    ['feature', featureRecords],
  ]) {
    for (const record of records) {
      if (record.answer === undefined) unrecorded.push(`${arm}:${record.questionId}`);
    }
  }
  console.log(`\n--- record completeness (BOTH arms must have recorded an answer) ---`);
  if (unrecorded.length > 0) {
    console.log(`UNRECORDED: ${unrecorded.length} question(s) have no recorded answer`);
    for (const entry of unrecorded) console.log(`  ${entry}`);
    console.log(
      `\nREFUSING to judge. An absent 'answer' key means nobody recorded what that arm\n` +
        `produced — it is NOT an abstention, which is recorded as an explicit null. A\n` +
        `reader that collapses the two would read the gap as that question moving to an\n` +
        `abstention, and on a non-target that manufactures the severest verdict the\n` +
        `criterion can return out of a missing record. Re-dispatch the arm whose records\n` +
        `are incomplete.\n` +
        `\nNo verdict is printed above or below this line, so a consumer that scans the\n` +
        `output for a verdict token will find none — a refusal is not a result.`,
    );
    return 1;
  }
  console.log(`complete: both arms recorded an answer for all ${controlRecords.length} questions`);

  // Both arms are now known to have an `answer` for every question, so the
  // `undefined` case that `toAnswer` also handles is unreachable here — it is
  // kept because the function is the single place the criterion's answer
  // normalization is defined, and a second definition is where the abstention
  // distinction would be lost again.
  //
  // `correct` is passed through because it is the criterion's definition of
  // movement. Without it the reader would fall back to comparing answer TEXT,
  // which is what this reader used to do — and on the C5 arms it reported 4
  // non-target regressions where the scored comparison finds 0, because
  // `three times a week` -> `Three times a week` is a reworded answer that the
  // scorer scored correct in both arms. Text is not an outcome.
  const toOutcome = (records) =>
    records.map((record) => ({
      questionId: record.questionId,
      answer: toAnswer(record.answer),
      correct: record.correct === true,
    }));

  const criterion = judgeCriterion({
    cohort,
    control: toOutcome(controlRecords),
    feature: toOutcome(featureRecords),
  });

  // Cross-check the criterion's branch against a direct question-by-question
  // application of the SAME movement test, and report the two disagreements it
  // can produce. This block exists because the two are different questions:
  //
  // - The criterion reports a VERDICT, which is a summary -- it stops at the
  //   first clause that fires, so on a regression it names no target movement at
  //   all, and a reader would take that silence for "the targets did not move".
  // - This block reports the PER-QUESTION census under both equality tests, so
  //   the reader can see how many questions changed only in wording.
  //
  // The wording count is the one that matters and the one nothing else printed.
  // `outcomeMoved` says wording is not movement; a reworded answer therefore
  // disappears from every count above, and without this line its disappearance
  // would be indistinguishable from "the arms were identical". Reporting it is
  // what keeps the fix auditable rather than merely asserted.
  const reworded = [];
  const controlById = new Map(controlRecords.map((r) => [r.questionId, r]));
  for (const record of featureRecords) {
    const before = controlById.get(record.questionId);
    if (before === undefined) continue;
    const beforeOutcome = { questionId: before.questionId, answer: toAnswer(before.answer), correct: before.correct === true };
    const afterOutcome = { questionId: record.questionId, answer: toAnswer(record.answer), correct: record.correct === true };
    if (outcomeMoved(beforeOutcome, afterOutcome)) continue;
    if (toAnswer(before.answer) === toAnswer(record.answer)) continue;
    reworded.push(record.questionId);
  }
  console.log(`\n--- movement census (both arms, one question at a time) ---`);
  console.log(
    `reworded but not moved: ${reworded.length} question(s) — the text differs, the`,
  );
  console.log(`  scorer's verdict does not. These are NOT movement and are excluded above.`);
  for (const id of reworded) console.log(`  ${id}`);

  console.log(`\n--- criterion verdict ---`);
  switch (criterion.kind) {
    case 'regression':
      console.log(`REGRESSION — non-target questions moved: ${criterion.regressed.length}`);
      for (const id of criterion.regressed) console.log(`  ${id}`);
      console.log(
        `\nThe non-target clause is checked first and cannot be overridden by a target gain.`,
      );
      break;
    case 'no-move':
      console.log(`NO-MOVE — none of the ${criterion.targets.length} target questions moved.`);
      console.log(
        `\nThe published criterion calls this a finding about the READER, not a tuning target.`,
      );
      break;
    case 'settled':
      console.log(`SETTLED — ${criterion.moved.length} target question(s) moved.`);
      for (const id of criterion.moved) console.log(`  moved ${id}`);
      if (criterion.gained.length || criterion.lost.length) {
        console.log(`  gained: ${criterion.gained.length}, lost: ${criterion.lost.length}`);
      }
      break;
  }
  return 0;
}

// See the longer note at the end of export-census.mjs. `process.exit(code)` does
// not wait for stdout to drain, so piping more than a buffer's worth of output
// truncates it. This tool prints one verdict block per question, which exceeds
// that on a full run, so it carries the same latent defect.
process.exitCode = main();
