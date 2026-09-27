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
 *   3. Only then judge the arms.
 *
 * Usage: node tools/read-b7-criterion.mjs <control.json> <feature.json>
 */

import { readFileSync } from 'node:fs';
import {
  computeTargetCohort,
  verifyTargetCohort,
  judgeCriterion,
} from '../packages/cortex-eval/dist/b7-cohort.js';

const PUBLISHED_TARGET_COUNT = 9;

function load(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Pull per-question records out of a benchmark report.
 *
 * The report's exact key names are not assumed here beyond the ones the
 * criterion needs; a missing key is reported rather than defaulted, because a
 * silently-empty cohort would make the verdict vacuous.
 */
function extractQuestions(report, label) {
  const candidates = [report.questions, report.perQuestion, report.results, report.details].filter(
    Array.isArray,
  );
  if (candidates.length === 0) {
    throw new Error(
      `${label}: no per-question array found. Top-level keys: ${Object.keys(report).join(', ')}`,
    );
  }
  return candidates[0];
}

function normaliseAnswer(value) {
  if (value === undefined || value === null) return null;
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

  const controlQuestions = extractQuestions(control, 'control');
  const featureQuestions = extractQuestions(feature, 'feature');
  console.log(`control questions: ${controlQuestions.length}`);
  console.log(`feature questions: ${featureQuestions.length}`);

  // Every per-question record is passed through, including ungrounded ones. An
  // earlier revision filtered to `grounded === true` here, which made
  // `computeTargetCohort`'s `notGrounded` bucket structurally empty in this
  // reader — a bucket that always reads 0 looks like "nothing was excluded"
  // when the truth is "the exclusion happened before the counter could see it".
  // The module classifies; this reader only transcribes.
  const cohortInput = controlQuestions
    .map((q) => ({
      questionId: String(q.questionId ?? q.id ?? q.question_id ?? ''),
      question: String(q.question ?? ''),
      groundTruth: q.groundTruth ?? q.truth ?? q.answer_true ?? null,
      answer: q.answer ?? q.predicted ?? null,
      turns: (q.turns ?? q.context ?? []).map((t, i) => ({
        index: Number(t.index ?? i),
        text: String(t.text ?? t.content ?? ''),
      })),
      grounded: q.grounded === true,
    }))
    .filter((q) => q.questionId !== '');

  const missingIds = cohortInput.filter((q) => q.questionId === '').length;
  if (missingIds > 0) {
    console.log(`WARNING: ${missingIds} question(s) had no usable id and were dropped`);
  }

  const cohort = computeTargetCohort(cohortInput);
  console.log(`\n--- recomputed cohort ---`);
  console.log(`questions considered: ${cohortInput.length}`);
  console.log(`targets: ${cohort.targets.length}`);
  console.log(`identical: ${cohort.identical.length}`);
  console.log(`unseparable: ${cohort.unseparable.length}`);
  console.log(`notGrounded: ${cohort.notGrounded.length}`);

  const verdict = verifyTargetCohort(cohort, []);
  console.log(`\n--- cohort verification (published roster is empty: a count is not a roster) ---`);
  if (verdict.kind === 'matches') {
    console.log(`matches: ${verdict.count}`);
  } else {
    console.log(`published count claimed: ${verdict.published}`);
    console.log(`computed roster size:    ${verdict.computed}`);
    console.log(
      `publication says ${PUBLISHED_TARGET_COUNT}; recomputation found ${verdict.computed}`,
    );
    if (verdict.computed !== PUBLISHED_TARGET_COUNT) {
      console.log(
        `>>> DISAGREEMENT with the published count. The published "9" is a claim about a\n` +
          `    snapshot; this run's inputs give ${verdict.computed}. Report this BEFORE the arms.`,
      );
    } else {
      console.log(
        `>>> Count agrees (${verdict.computed}), but identity is still unconfirmable — the\n` +
          `    publication names no ids. The ids above are the roster.`,
      );
    }
  }

  const toOutcome = (questions) =>
    questions
      .map((q) => ({
        questionId: String(q.questionId ?? q.id ?? q.question_id ?? ''),
        answer: normaliseAnswer(q.answer ?? q.predicted ?? null),
      }))
      .filter((o) => o.questionId !== '');

  const criterion = judgeCriterion({
    cohort,
    control: toOutcome(controlQuestions),
    feature: toOutcome(featureQuestions),
  });

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

process.exit(main());
