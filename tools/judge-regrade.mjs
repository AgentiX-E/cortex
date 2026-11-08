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
 *
 * ## Why the judge is rebuilt from the artifact rather than from the dispatch (§13.312)
 *
 * The first two readings this tool produced were taken with **a different judge than the one that
 * produced the artifacts**, and nothing said so. Three independent causes, each silent:
 *
 *  * the judge was built by `createLlmFromEnv`, the *reader* factory. `run-ablation.ts` and
 *    `regrade-partial.ts` both call `createJudgeFromEnv`, so two of the four callers were measuring
 *    an instrument the other two had never measured. The reader factory also **refuses** a
 *    route-scoped `DEEPSEEK_THINKING` -- which both M1 arms were dispatched under -- so on the two
 *    artifacts this campaign is arguing about, it either threw or graded something else;
 *  * the workflow passed the model in `CORTEX_LLM_MODEL`, which is `cortex-ai`'s profile variable.
 *    The factory reads `DEEPSEEK_MODEL`. Every audit ever dispatched therefore graded with
 *    `deepseek-chat`, whatever the input said, because an unset variable is not an error;
 *  * `TEMPERATURE` was never set, so `withTemperature` was never applied and the judge ran at the
 *    provider's default temperature while every artifact it re-read was graded at `0`.
 *
 * The consequence is not hypothetical. Re-reading arm B's 29 preference answers with
 * `deepseek-chat` at the default temperature rescued 10 of them that `deepseek-v4-pro` at `0` had
 * rejected, with 0 flips across 5 passes and 0 unjudged verdicts in the artifact -- a 34.5-point
 * move on the one question type whose verdict is entirely the judge's opinion. That was read as
 * "the artifact was wrong about arm B", and it was an instrument swap.
 *
 * So the identity is no longer an input somebody may forget. `memoryArmConfig.reader` records the
 * provider, the model and the temperature a run was graded at, and this tool reads it back. A
 * dispatch may still name a different judge -- that is a legitimate experiment about the *judge* --
 * but it can no longer do so by accident, because the two identities are printed side by side and
 * the reading records whether they match.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

import {
  clearJudgeCache,
  createJudgeFromEnv,
  createLlmJudge,
  describeScorerChannels,
  judgeScorer,
  scorerChannelStats,
  toJudgeQuestionType,
} from '../packages/cortex-eval/dist/index.js';
import {
  JUDGE_MODEL_VARIABLE,
  artifactJudgeIdentity,
  judgeEnvFor,
  judgeMatchesArtifact,
  selectionFor,
} from './judge-identity.mjs';

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
    // The raw dataset tag as well as the mapped one. `judgeScorer` derives its template from the tag
    // (`_abs` on the end is how LongMemEval marks an abstention question), so handing it the already
    // mapped value would map it twice and grade a preference question with the default template.
    rawType: String(question.questionType ?? ''),
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
        '[--verdicts <file>] [--scorer judge|full] [--plan-only] ' +
        '[--preference-only | --non-preference-only]',
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
  const scorer = flag('--scorer') ?? 'judge';
  if (scorer !== 'judge' && scorer !== 'full') {
    console.error(`--scorer must be judge or full, got ${scorer}`);
    return 2;
  }
  const identity = artifactJudgeIdentity(report);
  const judgeEnv = judgeEnvFor(report, process.env);
  const matches = judgeMatchesArtifact(report, judgeEnv);
  console.log(`artifact        ${artifactPath}`);
  console.log(`questions       ${sources.length}`);
  console.log(`passes          ${passes}`);
  console.log(
    `recorded correct ${sources.filter((source) => source.recorded).length} / ${sources.length}`,
  );
  // Two lines rather than one, because the reading is about the difference between them: a single
  // "judge model" line would be the same shape that let three versions of this identity disagree
  // without any of them being wrong (§13.312).
  console.log(
    `artifact judge  model=${selectionFor(identity.provider, identity.model) ?? 'unrecorded'} ` +
      `temperature=${identity.temperature ?? 'unrecorded'}`,
  );
  console.log(`re-grade scorer ${scorer}`);
  console.log(
    `re-grade judge  model=${judgeEnv[JUDGE_MODEL_VARIABLE] ?? '(provider default)'} ` +
      `temperature=${judgeEnv.TEMPERATURE ?? 'default'} ` +
      `matchesArtifact=${matches === null ? 'unknown' : String(matches)}`,
  );
  if (matches === false) {
    console.log(
      'WARNING: this reading describes a different judge than the one that graded the artifact. ' +
        'It is a measurement of that judge, not a correction of the artifact.',
    );
  }

  if (process.argv.includes('--plan-only')) {
    // The reviewable form: no key, no request, and the same list a real run would grade.
    for (const source of sources.slice(0, 3)) {
      console.log(`\n[${source.questionId}] ${source.capability ?? 'unknown'} (${source.type})`);
      console.log(`  gold     ${source.gold.slice(0, 160)}`);
      console.log(`  answer   ${source.answer.slice(0, 160)}`);
    }
    return 0;
  }

  const judge = createJudgeFromEnv(judgeEnv);
  // Two instruments, named rather than implied, because they answer different questions about the
  // same bytes. `judge` is the judge channel: one question to a model per answer, which is the
  // whole verdict for a preference question (no gold string exists) and is NOT an arm's accuracy for
  // the other five capabilities -- an answer `exact` would have accepted is submitted to the model
  // instead. `full` is `judgeScorer`: the artifact's own instrument, deterministic channels first,
  // the model only where they cannot decide (`J8`).
  const judgeOneAnswer = createLlmJudge(judge);
  const grade =
    scorer === 'full'
      ? (source) =>
          judgeScorer(judgeOneAnswer)(
            {
              id: source.questionId,
              capability: source.capability ?? 'IE',
              questionType: source.rawType,
              question: source.question,
              expected: source.gold,
              context: [],
            },
            source.answer,
          )
      : (source) => judgeOneAnswer(source.question, source.answer, source.gold, source.type);
  const verdicts = sources.map(() => []);
  for (let pass = 0; pass < passes; pass += 1) {
    // The line that makes this a measurement rather than a memoised read. See the header.
    clearJudgeCache();
    for (let index = 0; index < sources.length; index += 1) {
      verdicts[index].push(await grade(sources[index]));
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

  // Only under `full`, because only that instrument has channels: printing `judge <n>/<n>` under the
  // judge channel would be a true statement that reads as a finding. The split is what says whether a
  // re-graded number is an arm score -- a reading where `judge` is 500 of 500 is the judge channel
  // again, wearing the full scorer's name.
  const channels = scorerChannelStats();
  if (scorer === 'full') console.log(`  ${describeScorerChannels(channels)}`);

  // `J9d`. The vector `tally` builds and throws away. Two re-grades of two arms are a paired
  // comparison, and the aggregate file has no pairing in it: the flips are counts and the ids are only
  // the ones that moved, so a paired test over two `--out` files would have to reconstruct which
  // question each verdict belonged to. Written beside the summary rather than instead of it, because
  // the summary is what a reader quotes and this is what an instrument reads.
  const verdictsPath = flag('--verdicts');
  if (verdictsPath) {
    const vector = rows.map((row) => ({
      questionId: row.questionId,
      ...(row.capability === undefined ? {} : { capability: row.capability }),
      recorded: row.recorded,
      verdicts: row.verdicts,
    }));
    writeFileSync(verdictsPath, `${JSON.stringify(vector, null, 2)}\n`);
    console.log(`wrote ${verdictsPath} (${vector.length} question(s))`);
  }

  const out = flag('--out');
  if (out) {
    const payload = {
      what: 'How often the judge changes its verdict on the same answer, re-read with the same template.',
      artifact: artifactPath,
      generatedAt: new Date().toISOString(),
      passes,
      scorer,
      // The channel split, and only for the instrument that has channels. `null` under the judge
      // channel is the absence of a claim rather than a zero.
      channels: scorer === 'full' ? channels : null,
      // The instrument, in the reading's own file. A flip rate without it is a number about an
      // unnamed model at an unnamed temperature, which is what §13.312 had to reconstruct from a
      // job log before it could be read at all.
      judge: {
        artifact: {
          provider: identity.provider,
          model: identity.model,
          temperature: identity.temperature,
        },
        regrade: {
          selection: judgeEnv[JUDGE_MODEL_VARIABLE] ?? null,
          temperature: judgeEnv.TEMPERATURE ?? null,
          thinking: 'disabled',
        },
        matchesArtifact: matches,
      },
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
