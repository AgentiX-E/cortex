#!/usr/bin/env node
/**
 * Re-grade a competitor's published answers with this repository's judge, and report both readings.
 *
 *     node tools/competitor-regrade.mjs --answers <records-answers.json> --out <dir> --plan-only
 *     node tools/competitor-regrade.mjs --answers <records-answers.json> --out <dir>
 *
 * ## The one thing this measures
 *
 * Cortex reads 91.25% on LongMemEval-S and Maximem Synap publishes 95.6%. Those two numbers were
 * produced by **different judges** (§169.5): theirs by the official `evaluate_qa.py` prompts under a
 * judge model its manifest does not pin, ours by `deepseek-chat` at temperature 0. A 4.35-point gap
 * between two readings taken with two rulers is not a gap. This re-takes theirs with ours, on their
 * answers, so that the difference that survives is the difference between two systems rather than
 * between two instruments.
 *
 * ## Why `judgeScorer` and not the judge directly
 *
 * Cortex's own 91.25% was scored through `judgeScorer`, which decides some questions **without an LLM**:
 * a structurally absent answer, an exact normalised match, and a numeric comparison on counting
 * questions. Calling the judge on every answer would put the competitor through a *stricter* pipeline
 * than the one that produced 91.25% -- every exact match would be re-litigated by a model that may say
 * no -- and the resulting gap would be an artefact of this file. So the scorer is the same object, the
 * channels are counted, and the split is printed: the share of verdicts the model decided is the share
 * of the comparison that is the model's opinion.
 *
 * ## Why the abstention flag is appended to the type rather than inferring it
 *
 * `toJudgeQuestionType` reads two things: the dataset's `question_type`, and whether it ends in `_abs`.
 * LongMemEval marks abstention that way in its ids; these records instead carry `retrieval.abstention`.
 * Setting `expected` to null would select the abstention template and destroy the explanation the
 * template needs, so the flag is folded into the type -- the same encoding the dataset uses -- and a
 * record whose flag is missing keeps its plain type. What that costs is stated in the output: a `null`
 * count, printed, because "no abstention questions" and "this file does not say" grade the same way and
 * mean different things.
 *
 * ## Why the cost is tokens and not money
 *
 * The prompt size is computable before a call (`buildJudgePrompt` is a pure function) and the token
 * estimate uses the repository's own measured characters-per-token (`tools/token-basis.json`). Money
 * needs a price, and a price written into this file is a number nobody re-checks that silently becomes
 * wrong. So the default output is calls and tokens; `--price-cny-per-mtok` adds an amount for a caller
 * who has looked the current price up, and the reading says which of the two it is.
 *
 * ## What it refuses
 *
 *  * **an answer file with no converged answer field** -- the preparation tool refuses to guess, and
 *    grading a file whose answer field is `null` would grade an empty population;
 *  * **a population where most records have no published verdict** -- the two readings would then be
 *    a comparison against a number that covers a different subset;
 *  * **exceeding the call budget** -- `--max-calls` defaults to 600 and the run stops before the first
 *    call rather than after the budget is spent.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  buildJudgePrompt,
  clearJudgeCache,
  createJudgeFromEnv,
  createLlmJudge,
  describeScorerChannels,
  judgeScorer,
  resolveJudgeIdentity,
  scorerChannelStats,
  toJudgeQuestionType,
} from '../packages/cortex-eval/dist/index.js';

/** The repository's own measured characters per token (`tools/token-basis.json`). */
const CHARS_PER_TOKEN = 3.8528;

function flag(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : (process.argv[index + 1] ?? '');
}

function has(name) {
  return process.argv.includes(name);
}

/**
 * The questions this can re-grade, and the ones it has to skip with a reason.
 *
 * A record is gradable when it has a question, a gold, and a non-empty answer. The skips are counted
 * by cause rather than lumped, because "the competitor declined to answer" and "the field extraction
 * produced an empty string" look identical in a total and are different findings about the file.
 */
export function gradable(questions) {
  const taken = [];
  const skipped = { noQuestion: 0, noGold: 0, noAnswer: 0 };
  for (const question of questions) {
    if (typeof question.question !== 'string' || question.question.trim() === '') {
      skipped.noQuestion += 1;
      continue;
    }
    if (typeof question.gold !== 'string' || question.gold.trim() === '') {
      skipped.noGold += 1;
      continue;
    }
    if (typeof question.response !== 'string' || question.response.trim() === '') {
      skipped.noAnswer += 1;
      continue;
    }
    taken.push(question);
  }
  return { taken, skipped };
}

/** The `Question` shape `judgeScorer` reads, built from one competitor record. */
export function asQuestion(record) {
  // The abstention flag is folded into the type, and only when the record actually carries one: a
  // `false` that was never in the file must not be invented, or the abstention rate is a claim about
  // this tool rather than about the competitor.
  const questionType =
    record.abstention === true ? `${record.questionType}_abs` : String(record.questionType ?? '');
  return {
    id: String(record.questionId),
    capability: 'IE',
    questionType,
    question: String(record.question),
    expected: String(record.gold),
    context: [],
  };
}

/** Exact two-sided sign test over the discordant pairs; the paired counterpart of a two-proportion test. */
export function discordantPValue(rescued, revoked) {
  const n = rescued + revoked;
  if (n === 0) return 1;
  const tail = Math.min(rescued, revoked);
  let cumulative = 0;
  let term = 1;
  for (let k = 0; k <= tail; k += 1) {
    if (k > 0) term = (term * (n - k + 1)) / k;
    cumulative += term;
  }
  return Math.min(1, (2 * cumulative) / Math.pow(2, n));
}

/**
 * The two readings, and the cell counts that make them checkable.
 *
 * `agreement` alone cannot say which instrument was stricter, which is why `rescued` and `revoked` are
 * both reported: a re-grade that accepts 30 questions the vendor rejected and rejects 3 it accepted is
 * a statement about strictness, and the same agreement rate can be produced by its opposite.
 */
export function readings(rows) {
  const judged = rows.filter((row) => row.publishedVerdict !== null && row.ourVerdict !== null);
  const ours = judged.filter((row) => row.ourVerdict).length;
  const theirs = judged.filter((row) => row.publishedVerdict).length;
  const rescued = judged.filter((row) => row.ourVerdict && !row.publishedVerdict).length;
  const revoked = judged.filter((row) => !row.ourVerdict && row.publishedVerdict).length;
  const paired = judged.length;
  return {
    paired,
    ours,
    theirs,
    ourAccuracy: paired === 0 ? null : ours / paired,
    publishedAccuracy: paired === 0 ? null : theirs / paired,
    agreement: paired === 0 ? null : (paired - rescued - revoked) / paired,
    rescued,
    revoked,
    discordantPValue: discordantPValue(rescued, revoked),
  };
}

async function main() {
  const answersPath = flag('--answers');
  const outDir = flag('--out-dir') ?? flag('--out');
  if (answersPath === undefined || outDir === undefined) throw new TypeError('pass --answers and --out-dir');

  const file = JSON.parse(readFileSync(answersPath, 'utf8'));
  if (file.answerField === null || file.answerField === undefined) {
    throw new TypeError(
      `the answer file carries no converged answer field (${file.refused ?? 'no reason recorded'}); ` +
        're-run the preparation tool before grading an empty population',
    );
  }

  const { taken, skipped } = gradable(file.questions ?? []);
  const limit = Number(flag('--limit') ?? 0);
  const population = limit > 0 ? taken.slice(0, limit) : taken;
  const maxCalls = Number(flag('--max-calls') ?? 600);
  if (population.length > maxCalls) {
    throw new TypeError(
      `${population.length} calls requested, budget is ${maxCalls}; raise --max-calls deliberately`,
    );
  }

  const abstentionUnknown = population.filter((question) => question.abstention === null).length;
  const withoutVerdict = population.filter((question) => question.publishedVerdict === null).length;

  // The prompt size is exact and free: `buildJudgePrompt` is the function the call will use, so the
  // token estimate is about the strings that will be sent rather than about their length in the file.
  let promptChars = 0;
  for (const record of population) {
    const question = asQuestion(record);
    promptChars += buildJudgePrompt(
      question.question,
      String(record.response),
      String(record.gold),
      toJudgeQuestionType(question.questionType ?? '', record.abstention === true),
    ).length;
  }
  const estimatedPromptTokens = Math.round(promptChars / CHARS_PER_TOKEN);

  const price = flag('--price-cny-per-mtok');
  const cost = {
    calls: population.length,
    promptChars,
    estimatedPromptTokens,
    charsPerToken: CHARS_PER_TOKEN,
    ...(price === undefined || price === ''
      ? {}
      : { estimatedCny: (estimatedPromptTokens / 1_000_000) * Number(price), priceCnyPerMtok: Number(price) }),
  };

  const run = {
    source: answersPath,
    answerField: file.answerField,
    records: file.records ?? (file.questions ?? []).length,
    population: population.length,
    skipped,
    abstentionUnknown,
    publishedVerdictMissing: withoutVerdict,
    cost,
    planOnly: has('--plan-only'),
  };

  if (has('--plan-only')) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'regrade-plan.json'), `${JSON.stringify(run, null, 2)}\n`);
    process.stdout.write(
      [
        `population       ${population.length} of ${run.records}`,
        `skipped          ${JSON.stringify(skipped)}`,
        `abstention ?     ${abstentionUnknown}`,
        `no verdict       ${withoutVerdict}`,
        `calls            ${cost.calls}`,
        `promptTokens     ~${estimatedPromptTokens}`,
        price === undefined || price === ''
          ? 'cost             tokens only: pass --price-cny-per-mtok to price them'
          : `cost             ~${cost.estimatedCny.toFixed(4)} CNY at ${price}/Mtok`,
      ].join('\n') + '\n',
    );
    return;
  }

  clearJudgeCache();
  const judge = createLlmJudge(createJudgeFromEnv(process.env), {
    onUnrecognised: () => {
      run.unrecognisedReplies = (run.unrecognisedReplies ?? 0) + 1;
    },
  });
  const scorer = judgeScorer(judge);
  const before = scorerChannelStats();

  const rows = [];
  for (const record of population) {
    const question = asQuestion(record);
    const verdict = await scorer(question, String(record.response));
    rows.push({
      questionId: record.questionId,
      questionType: record.questionType,
      abstention: record.abstention,
      publishedVerdict: record.publishedVerdict,
      ourVerdict: verdict,
    });
  }

  const after = scorerChannelStats();
  const channels = Object.fromEntries(
    Object.keys(after).map((key) => [key, after[key] - (before[key] ?? 0)]),
  );

  const result = {
    ...run,
    judge: resolveJudgeIdentity(process.env),
    channels,
    channelsLine: describeScorerChannels(channels),
    ...readings(rows),
    rows,
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'regrade.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(
    [
      `population       ${result.paired} paired`,
      `ours             ${(100 * result.ourAccuracy).toFixed(2)}% (${result.ours}/${result.paired})`,
      `published        ${(100 * result.publishedAccuracy).toFixed(2)}% (${result.theirs}/${result.paired})`,
      `delta            ${(100 * (result.ourAccuracy - result.publishedAccuracy)).toFixed(2)} points`,
      `rescued/revoked  ${result.rescued}/${result.revoked}  (p = ${result.discordantPValue.toFixed(4)})`,
      `channels         ${result.channelsLine}`,
      `unrecognised     ${result.unrecognisedReplies ?? 0}`,
    ].join('\n') + '\n',
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
