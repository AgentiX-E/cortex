#!/usr/bin/env node
/**
 * Re-grade a fixed set of recorded answers, repeatedly, and count how often the judge changes its mind.
 *
 *     node tools/judge-regrade.mjs --artifact <report.json> [--passes 2] [--limit 500] [--out <file>] [--plan-only]
 *
 * ## Why this tool exists, and why it is not `judge-audit.mjs`
 *
 * `judge-audit.mjs` asks the judge about answers that are **wrong by construction**, and its reading
 * is a false-accept rate — a statement about the judge's bias.
 *
 * This asks the judge about answers that are **already in an artifact, unchanged**, twice or more, and
 * its reading is a flip rate — a statement about the judge's variance. The distinction is the one
 * §13.255.3 could not make: two dispatches of one configuration produced **identical bytes** and still
 * moved 16 questions, so the arm's ±1.6-point noise floor is the sum of the reader's non-determinism
 * and the judge's, and a single pair of runs says nothing about the split.
 *
 * ## Why the cache must be cleared between passes, and what happens if it is not
 *
 * `createLlmJudge` memoises on the prompt (`judge.ts`, `judgeCache`). Re-grading the same answer with
 * the same template therefore hits that cache and returns the **first** verdict, so a naive two-pass
 * loop reports a 0.0% flip rate and reads as "the judge is perfectly reproducible". That is the exact
 * failure this tool is built around rather than after: the first version of the run below printed 0%
 * on 500 questions, and the number was a property of a `Map`.
 *
 * `clearJudgeCache()` is called before every pass, which is the only thing that makes pass N a fresh
 * request.
 *
 * ## What is deliberately out of scope
 *
 * No reader, no retrieval, no prompt building, no embedding. Every request this makes is a judge
 * request over a string that is already in the artifact, which is what makes the flip rate
 * attributable to the judge alone.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

import {
  clearJudgeCache,
  createLlmFromEnv,
  createLlmJudge,
  toJudgeQuestionType,
} from '../packages/cortex-eval/dist/index.js';

function flag(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : (process.argv[index + 1] ?? '');
}

/**
 * The questions this can re-grade.
 *
 * Every question with a gold and an answer, **including abstention**: unlike the false-accept audit,
 * nothing here is perturbed, so an abstention question is graded exactly as the benchmark graded it.
 * Excluding it would understate the flips on the one capability whose gold is an explanation and
 * whose verdict is therefore the least mechanical.
 */
/**
 * The opening LongMemEval gives a gold that describes a **criterion** rather than an answer.
 *
 * `The user would prefer responses that build upon their existing efforts to organize their
 * kitchen` cannot be matched, only judged, so this question type is the one whose verdict is least
 * mechanical -- and on the `M1` pair it was 5.8% of the dataset and 42% of the gap between two
 * readers. `tools/arm-delta-decomposition.py` carries the same constant for the same reason, and
 * the two must agree: a filter that disagrees with the decomposition would select a different
 * population than the one whose gap is being explained.
 */
export const PREFERENCE_OPENING = 'The user would prefer';

/** True when the gold states what a good answer should do, rather than the answer. */
export function isPreferenceGold(gold) {
  return typeof gold === 'string' && gold.startsWith(PREFERENCE_OPENING);
}

export function gradableFrom(questions, limit, only) {
  const eligible = questions.filter(
    (question) =>
      typeof question.question === 'string' &&
      typeof question.groundTruth === 'string' &&
      question.groundTruth.trim().length > 0 &&
      typeof question.answer === 'string' &&
      question.answer.trim().length > 0,
  );
  // `only` selects a sub-population, and it is applied before `limit` so a bounded run reads the
  // population it names rather than the first N questions that happen to be in it.
  const selected =
    only === 'preference'
      ? eligible.filter((question) => isPreferenceGold(question.groundTruth))
      : only === 'non-preference'
        ? eligible.filter((question) => !isPreferenceGold(question.groundTruth))
        : eligible;
  return selected.slice(0, limit).map((question) => ({
    questionId: String(question.questionId),
    question: String(question.question),
    gold: String(question.groundTruth),
    answer: String(question.answer),
    ...(typeof question.capability === 'string' ? { capability: question.capability } : {}),
    recorded: question.correct === true,
    type: toJudgeQuestionType(String(question.questionType ?? ''), question.capability === 'ABS'),
  }));
}

/**
 * The exact two-sided sign test over the questions whose verdict moved.
 *
 * A flip rate alone cannot say whether the judge is drifting in one direction, and a judge that
 * accepted everything on the second pass would look identical to one that flipped at random. The
 * p-value answers the second question; the up/down split answers the first.
 */
export function signTest(up, down) {
  const n = up + down;
  if (n === 0) return 1;
  const tail = Math.min(up, down);
  let cumulative = 0;
  let term = 1;
  for (let k = 0; k <= tail; k += 1) {
    if (k > 0) term = (term * (n - k + 1)) / k;
    cumulative += term;
  }
  return Math.min(1, (2 * cumulative) / Math.pow(2, n));
}

/**
 * The majority verdict over one pass vector, with a tie resolved to `false`.
 *
 * ## Why the direction matters as much as the rate
 *
 * A flip rate says the verdict moved. It cannot say whether the artifact was **strict** or
 * **lenient**, and on a population of 29 questions eleven disagreements are consistent with both:
 * if the re-grade accepted them, the artifact understated the arm by 11; if it rejected them, it
 * overstated it. Those two readings support opposite conclusions about whether a stronger reader
 * scored worse, which is the question this campaign is trying to answer. So the count of questions
 * the majority rescues is reported beside the count it revokes.
 *
 * Strict `>` rather than `>=`: a 1–1 split is not a win for either side, and calling it one would
 * let a two-pass reading manufacture agreement. Ties are counted separately, because an instrument
 * that ties often cannot be majority-voted at all and the count is the evidence for that.
 */
export function majority(verdicts) {
  const yes = verdicts.filter((verdict) => verdict).length;
  return yes * 2 > verdicts.length;
}

/** True when no side of a pass vector has a majority. */
function isTie(row) {
  return row.verdicts.filter((verdict) => verdict).length * 2 === row.verdicts.length;
}

/** Count what the passes did, from the verdict vectors alone. */
export function tally(rows) {
  const judged = rows.length;
  const flips = rows.filter((row) => new Set(row.verdicts).size > 1);
  const up = flips.filter((row) => row.verdicts[0] === false).length;
  const down = flips.length - up;
  const byCapability = new Map();
  for (const row of rows) {
    const key = row.capability ?? 'unknown';
    const entry = byCapability.get(key) ?? { n: 0, flips: 0 };
    entry.n += 1;
    if (new Set(row.verdicts).size > 1) entry.flips += 1;
    byCapability.set(key, entry);
  }
  return {
    judged,
    flips: flips.length,
    rate: judged === 0 ? 0 : flips.length / judged,
    up,
    down,
    p: signTest(up, down),
    // The first pass is a re-grade of the same bytes with the same template, so any disagreement with
    // the artifact is itself a judge reading: `recorded` is what the run's own grading said.
    agreesWithArtifact: rows.filter((row) => row.verdicts[0] === row.recorded).length,
    // What the re-grade says the arm actually scored, and where the artifact differed from it. Ties
    // are excluded from the two direction counts rather than assigned to the artifact's side: a
    // question the instrument could not decide is not evidence about which grader was wrong.
    regradedCorrect: rows.filter((row) => majority(row.verdicts)).length,
    artifactOnlyCorrect: rows.filter(
      (row) => !isTie(row) && row.recorded && !majority(row.verdicts),
    ).length,
    regradeOnlyCorrect: rows.filter((row) => !isTie(row) && !row.recorded && majority(row.verdicts))
      .length,
    ties: rows.filter(isTie).length,
    byCapability: Object.fromEntries(
      [...byCapability.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, value]) => [
          key,
          { ...value, rate: value.n === 0 ? 0 : value.flips / value.n },
        ]),
    ),
    flippedIds: flips.map((row) => row.questionId),
  };
}

async function main() {
  const artifactPath = flag('--artifact');
  if (!artifactPath) {
    console.error(
      'usage: judge-regrade.mjs --artifact <report.json> [--passes 2] [--limit 500] [--out <file>] ' +
        '[--plan-only] [--preference-only | --non-preference-only]',
    );
    return 2;
  }
  const passes = Number(flag('--passes') ?? '2');
  if (!Number.isInteger(passes) || passes < 2) {
    console.error(`--passes must be an integer >= 2, got ${flag('--passes')}`);
    return 2;
  }
  const limit = Number(flag('--limit') ?? '500');
  const report = JSON.parse(readFileSync(artifactPath, 'utf8'));
  if (!Array.isArray(report.questions)) throw new Error(`${artifactPath} has no questions array`);

  // Two flags rather than one valued argument, because they are mutually exclusive readings of the
  // same list and a `--population x` would let a typo select everything.
  const only = process.argv.includes('--preference-only')
    ? 'preference'
    : process.argv.includes('--non-preference-only')
      ? 'non-preference'
      : undefined;
  const sources = gradableFrom(report.questions, limit, only);
  if (sources.length === 0) {
    console.error('no gradable questions: the artifact has no answer with a gold');
    return 1;
  }
  console.log(`artifact        ${artifactPath}`);
  console.log(`questions       ${sources.length}`);
  console.log(`passes          ${passes}`);
  console.log(
    `recorded correct ${sources.filter((source) => source.recorded).length} / ${sources.length}`,
  );

  if (process.argv.includes('--plan-only')) {
    // The reviewable form: no key, no request, and the same list a real run would grade.
    for (const source of sources.slice(0, 3)) {
      console.log(`\n[${source.questionId}] ${source.capability ?? 'unknown'} (${source.type})`);
      console.log(`  gold     ${source.gold.slice(0, 160)}`);
      console.log(`  answer   ${source.answer.slice(0, 160)}`);
    }
    return 0;
  }

  const judge = createLlmFromEnv(process.env);
  const grade = createLlmJudge(judge);
  const verdicts = sources.map(() => []);
  for (let pass = 0; pass < passes; pass += 1) {
    // The line that makes this a measurement rather than a memoised read. See the header.
    clearJudgeCache();
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index];
      verdicts[index].push(await grade(source.question, source.answer, source.gold, source.type));
    }
    console.log(`pass ${pass + 1}/${passes} done`);
  }

  const rows = sources.map((source, index) => ({
    questionId: source.questionId,
    capability: source.capability,
    recorded: source.recorded,
    verdicts: verdicts[index],
  }));
  const reading = tally(rows);

  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  console.log('\njudge flips on byte-identical questions');
  console.log(
    `  ${reading.flips}/${reading.judged} = ${percent(reading.rate)}   ` +
      `up ${reading.up} / down ${reading.down}   exact sign test p = ${reading.p.toFixed(3)}`,
  );
  console.log(
    `  first pass agrees with the artifact on ${reading.agreesWithArtifact}/${reading.judged}`,
  );
  console.log(
    `  re-graded correct ${reading.regradedCorrect} / ${reading.judged}` +
      `  (artifact ${rows.filter((row) => row.recorded).length},` +
      ` artifact-only ${reading.artifactOnlyCorrect},` +
      ` re-grade-only ${reading.regradeOnlyCorrect},` +
      ` ties ${reading.ties})`,
  );
  for (const [capability, entry] of Object.entries(reading.byCapability)) {
    console.log(
      `  ${capability.padEnd(6)} n=${String(entry.n).padStart(3)} flips=${String(entry.flips).padStart(2)} = ${percent(entry.rate).padStart(6)}`,
    );
  }

  const out = flag('--out');
  if (out) {
    const payload = {
      what: 'How often the judge changes its verdict on the same answer, re-read with the same template.',
      artifact: artifactPath,
      generatedAt: new Date().toISOString(),
      passes,
      reading,
    };
    writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`\nwrote ${out}`);
  }
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('judge-regrade.mjs')) {
  process.exitCode = await main();
}
