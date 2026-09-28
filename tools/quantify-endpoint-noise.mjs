#!/usr/bin/env node
/**
 * Quantify the endpoint's own movement across config-identical runs.
 *
 * ## Why this exists
 *
 * Every A/B verdict up to P3b judged a candidate arm against a floor measured by
 * running two configurationally-identical arms **inside a single run**. P4 then
 * ran the *same* configuration twice, a day apart, and the endpoint moved 25 of
 * 500 questions. A floor measured within a run does not bound a difference
 * measured across runs, so every promotion gated on that floor is unsafe.
 *
 * `variance.ts` contains the arithmetic for this and was already tested. What it
 * never had was a caller with real data: `RunObservation` carries counts, and
 * `compareQuestionVectors` needs per-question correctness vectors that no
 * artifact produced. The per-question roster (`packages/cortex-eval/src/
 * question-record.ts`) supplies them; this tool is the consumer.
 *
 * ## What it reports
 *
 * - **The range**, in questions: how far the endpoint swings across these runs.
 *   This is the primary figure, not the sd, because it is robust at the small n
 *   a dispatched A/B actually has (two or three runs).
 * - **`minQuestionsStrictlyGreaterThan`**: the effect an arm must exceed to be
 *   distinguishable from re-running the benchmark. Strictly greater, because
 *   matching the noise is not clearing it, and never below 1, because an arm
 *   that changes zero questions has shown nothing.
 * - **The discordant ids**: which questions moved, and in which direction. A
 *   count is not a roster -- §20 records an A/B whose arms differed by 2
 *   questions and whose artifacts could not name them.
 *
 * ## Usage
 *
 *   node tools/quantify-endpoint-noise.mjs <report.json | dir> [...]
 *
 * A directory is read recursively for `*.json` reports. Every input must be the
 * SAME configuration: this tool measures noise, and a set of runs that differ in
 * their switches measures the switches instead. The tool cannot verify that from
 * the artifacts (an older one may record no `featureConfig`), so it reports each
 * run's recorded configuration and leaves the judgement to the reader rather
 * than assuming sameness.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  summarizeVariance,
  compareQuestionVectors,
  requiredEffectSize,
} from '../packages/cortex-eval/dist/variance.js';
import { recordIds, correctnessVector, buildQuestionRecords } from '../packages/cortex-eval/dist/question-record.js';

/**
 * @typedef {import('../packages/cortex-eval/dist/question-record.js').QuestionRecordInput} QuestionRecordInput
 */

/**
 * Extract a report's per-question roster, plus the metadata needed to say what
 * was compared.
 *
 * A missing roster is a hard error and not an empty list. Every archived
 * artifact produced before the roster existed is in this state, and reporting
 * "0 questions moved" for one of them would hand back the most favourable
 * possible floor from a file that measured nothing -- which is worse than
 * failing, because it looks like a measurement.
 */
function loadReport(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const questions = raw.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error(
      `${path}: no per-question roster. Top-level keys: ${Object.keys(raw).join(', ')}. ` +
        'A floor cannot be derived from an artifact that recorded no per-question ' +
        'correctness; refusing rather than reporting zero movement.',
    );
  }
  const missingId = questions.filter(
    (q) => String(q.questionId ?? q.id ?? q.question_id ?? '') === '',
  ).length;
  if (missingId > 0) {
    throw new Error(`${path}: ${missingId} record(s) carry no question id`);
  }
  // The same gap `read-b7-criterion.mjs` refuses to judge on, refused here for a
  // different reason and with a different consequence.
  //
  // A record with no `answer` key means nobody recorded what the arm produced.
  // This tool does not read `answer` -- it reads `correct`, which is always
  // present because the builder writes it -- so the gap is invisible in the
  // vector itself. It is visible in what the gap DOES to the vector: `correct`
  // is `false` for a question nobody recorded, which is exactly the value it
  // has for a question the arm got WRONG. A run with a recording gap therefore
  // presents missing records as wrong answers, and the comparison against
  // another run reports those questions as flipped.
  //
  // That inflates the floor -- the number every A/B verdict is judged against
  // -- with movement that is an artifact of the recording rather than of the
  // endpoint. A floor that is too high rejects real effects; one built partly
  // from gaps is not measuring the endpoint at all. Refusing is the only way
  // this tool can keep its figure meaning what its name says.
  const unrecorded = questions.filter((q) => !('answer' in q)).length;
  if (unrecorded > 0) {
    throw new Error(
      `${path}: ${unrecorded} record(s) have no 'answer' key. That is a recording gap, ` +
        'not an abstention (which is an explicit null), and it presents in the ' +
        'correctness vector as a WRONG answer -- so it would be counted as movement ' +
        'the endpoint did not make. Refusing rather than inflating the floor.',
    );
  }
  // Delegated to the package's own builder rather than mapped here. This tool
  // reads the SAME record shape `read-b7-criterion.mjs` reads, and two parsers
  // for one artifact is two places for the field-name fallbacks to drift -- at
  // which point the two readers would disagree about the same file. `retrieved`
  // is empty because the noise model needs only the correctness vector; the
  // context is the criterion's input, and re-reading it here would make this
  // tool's memory profile scale with the retrieved text it never looks at.
  /** @type {QuestionRecordInput[]} */
  const inputs = questions.map((q) => ({
    questionId: String(q.questionId ?? q.id ?? q.question_id ?? ''),
    question: String(q.question ?? ''),
    capability: String(q.capability ?? 'unknown'),
    correct: q.correct === true,
    grounded: q.grounded === true,
    retrieved: '',
  }));
  const records = buildQuestionRecords(inputs);
  return { path, records, featureConfig: raw.featureConfig };
}

/**
 * The correctness vector of a roster, in roster order.
 *
 * Delegated to `correctnessVector` rather than written here. Order is the whole
 * comparison -- `compareQuestionVectors` compares index i of one run against
 * index i of another -- and a second implementation of "the vector of these
 * records" is a second thing that can be reordered independently of the first.
 */
function vectorOf(records) {
  return correctnessVector(records);
}

/** Every `*.json` under a directory, sorted for a deterministic report. */
function collectFrom(dir) {
  const found = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...collectFrom(path));
    } else if (entry.endsWith('.json')) {
      found.push(path);
    }
  }
  return found;
}

/** Expand the CLI arguments into a sorted list of report paths. */
function resolveInputs(args) {
  const paths = [];
  for (const arg of args) {
    if (statSync(arg).isDirectory()) {
      paths.push(...collectFrom(arg));
    } else {
      paths.push(arg);
    }
  }
  return paths.sort();
}

/**
 * The largest number of questions any pair of runs disagreed about.
 *
 * The maximum rather than the mean, and pairwise rather than versus the first
 * run only. A set where run1 and run2 agree and run3 is an outlier has a small
 * mean but is exactly the situation a floor must survive, and a mean would hide
 * it. Comparing all pairs is O(n^2) in the number of runs, which is two or three
 * for a dispatched A/B.
 */
function maxPairwiseChanged(referenceIds, reports) {
  let worst = 0;
  for (let i = 0; i < reports.length; i++) {
    for (let j = i + 1; j < reports.length; j++) {
      const comparison = compareQuestionVectors(
        referenceIds,
        vectorOf(reports[i].records),
        vectorOf(reports[j].records),
      );
      worst = Math.max(worst, comparison.changed);
    }
  }
  return worst;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: quantify-endpoint-noise.mjs <report.json | dir> [...]');
    console.error('  Every input must be the SAME configuration: this measures noise.');
    return 2;
  }

  let reports;
  try {
    reports = resolveInputs(args).map(loadReport);
  } catch (error) {
    // Named on stderr, because the reader's exit status is all a shell sees and
    // a silent zero would read as a measured floor.
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (reports.length < 2) {
    console.error(
      `need at least two reports to measure a spread, got ${reports.length}. One run ` +
        'cannot demonstrate stability -- it can only fail to demonstrate instability, ' +
        'so any floor derived from it would be invented rather than measured.',
    );
    return 1;
  }

  // Alignment before arithmetic. Two runs over different question sets have no
  // paired comparison, and comparing them by index would align unrelated
  // questions and produce a plausible number from meaningless data. Checked
  // against the FIRST report's ids rather than pairwise-adjacent, so a set that
  // is internally consistent but shifted is still caught.
  const reference = reports[0];
  const referenceIds = recordIds(reference.records);
  for (const report of reports.slice(1)) {
    const ids = recordIds(report.records);
    const same =
      ids.length === referenceIds.length && ids.every((id, i) => id === referenceIds[i]);
    if (!same) {
      console.error(
        `${report.path}: different question sets. ${reference.path} graded ` +
          `${referenceIds.length} questions, this one graded ${ids.length}, and the ids ` +
          'do not align in order. These runs have no paired comparison.',
      );
      return 1;
    }
  }

  // `RunObservation` carries counts, which is all `summarizeVariance` reads. The
  // vectors are the additive input this tool supplies.
  const observations = reports.map((report, i) => {
    const perCapability = {};
    for (const record of report.records) {
      const bucket = (perCapability[record.capability] ??= { correct: 0, total: 0 });
      bucket.total += 1;
      if (record.correct) bucket.correct += 1;
    }
    return {
      runId: `run${i + 1}`,
      perCapability,
      correct: report.records.filter((r) => r.correct).length,
      total: report.records.length,
    };
  });

  const summary = summarizeVariance(observations);
  let requirement;
  try {
    requirement = requiredEffectSize(summary);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  console.log(`observations: ${summary.n}`);
  for (const observation of observations) {
    console.log(
      `  ${observation.runId}: ${observation.correct}/${observation.total} ` +
        `(${((observation.correct / observation.total) * 100).toFixed(1)}%)`,
    );
  }
  console.log(`series (correct per run): ${summary.series.overall.join(', ')}`);

  // The configuration each run SAYS it ran, printed before the verdict. The tool
  // cannot verify that N downloaded artifacts share a configuration -- an older
  // one may predate the field -- so it reports what each claims and says so,
  // rather than assuming sameness and measuring the switches.
  const configs = reports.map((r) => r.featureConfig);
  const unrecorded = configs.filter((c) => c === undefined).length;
  console.log('');
  console.log('configuration as recorded by each run:');
  for (const [i, config] of configs.entries()) {
    if (config === undefined) {
      console.log(`  run${i + 1}: NOT RECORDED (predates the field, or was not supplied)`);
      continue;
    }
    const entries = Object.entries(config).sort(([a], [b]) => (a < b ? -1 : 1));
    console.log(
      `  run${i + 1}: ${entries.map(([k, v]) => `${k}=${v ? 'on' : 'off'}`).join(', ')}`,
    );
  }
  if (unrecorded > 0) {
    console.log(
      `  WARNING: ${unrecorded} of ${reports.length} runs recorded no configuration. ` +
        'A floor is only a floor for runs that shared a configuration, and this tool ' +
        'cannot confirm that from an artifact that does not state one.',
    );
  }

  console.log('');
  console.log('--- endpoint movement (same configuration, repeated) ---');
  console.log(
    `overall: min ${summary.overall.minCorrect}, max ${summary.overall.maxCorrect}, ` +
      `mean ${summary.overall.meanCorrect.toFixed(2)}, ` +
      `range: ${summary.overall.rangeQuestions} questions ` +
      `(${summary.overall.spreadPp.toFixed(2)} pp)`,
  );

  // Pairwise vectors, first run against each later run. Reported per pair rather
  // than pooled: a set where run1/run2 agree and run3 is an outlier is a
  // different situation from one where every consecutive pair moves a little,
  // and pooling would report the same range for both.
  console.log('');
  console.log('--- per-pair question movement ---');
  const firstVector = vectorOf(reference.records);
  for (const report of reports.slice(1)) {
    const comparison = compareQuestionVectors(
      referenceIds,
      firstVector,
      vectorOf(report.records),
    );
    console.log(
      `${reference.path} vs ${report.path}: compared ${comparison.compared}, ` +
        `stable ${comparison.stable}, changed: ${comparison.changed} ` +
        `(${comparison.flippedIn} in, ${comparison.flippedOut} out; ` +
        `${(comparison.changedRate * 100).toFixed(2)}%)`,
    );
    for (const flip of comparison.discordant) {
      console.log(`  ${flip.from ? 'correct -> wrong' : 'wrong -> correct'}  ${flip.questionId}`);
    }
  }

  console.log('');
  console.log('--- per-capability floor ---');
  const capabilities = Object.keys(summary.perCapability).sort();
  for (const capability of capabilities) {
    const stats = summary.perCapability[capability];
    const req = requirement.perCapability[capability];
    if (stats === undefined || req === undefined) continue;
    console.log(
      `  ${capability.padEnd(4)} n=${String(stats.n).padStart(2)}  ` +
        `min ${stats.minCorrect}, max ${stats.maxCorrect}, ` +
        `range: ${stats.rangeQuestions} questions (${stats.spreadPp.toFixed(2)} pp)  ` +
        `minQuestionsStrictlyGreaterThan: ${req.minQuestionsStrictlyGreaterThan}`,
    );
  }

  console.log('');
  console.log('--- required effect size ---');
  console.log(
    `basedOnObservations: ${requirement.basedOnObservations}  ` +
      `minQuestionsStrictlyGreaterThan: ${requirement.overall.minQuestionsStrictlyGreaterThan}  ` +
      `floorPp: ${requirement.overall.floorPp.toFixed(2)}`,
  );

  // The divergence between the two measurements, stated rather than left for the
  // reader to notice.
  //
  // The count-based range can be ZERO while a large fraction of questions moved:
  // two runs that swap one correct answer for another have identical accuracy and
  // two discordant questions. The bar derived from the range is then the minimum
  // of 1, which understates the noise on precisely the runs where the noise is
  // largest -- and an arm that moved exactly one question would clear it.
  //
  // Reported as a warning rather than folded into the bar because the two measure
  // different things: the range bounds how far the SCORE moves, the changed rate
  // bounds how much of the ROSTER moves. A per-question claim needs the second.
  const maxChanged = maxPairwiseChanged(referenceIds, reports);
  if (maxChanged > summary.overall.rangeQuestions) {
    console.log('');
    console.log(
      `WARNING: the count-based range is ${summary.overall.rangeQuestions} questions but up to ` +
        `${maxChanged} questions moved between a pair of these runs. The range bounds how far ` +
        'the SCORE moves; it does not bound how much of the ROSTER moves. An arm judged only ' +
        'against the range could clear it while the questions it claims to affect are the ' +
        'same ones the endpoint already moves on its own.',
    );
  }

  console.log('');
  console.log(
    'An arm must move STRICTLY MORE than the figure above to be distinguishable ' +
      'from re-running this benchmark. Matching the noise is not clearing it.',
  );
  return 0;
}

// `process.exit` does not wait for stdout to drain, so piping the per-question
// list truncates it -- the same latent defect `export-census.mjs` and
// `read-b7-criterion.mjs` carry, and this tool prints one line per discordant
// question. Setting `exitCode` lets the process end on its own.
process.exitCode = main();
