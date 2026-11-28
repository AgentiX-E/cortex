#!/usr/bin/env node
/**
 * What the prompts of one benchmark report permit a cache to serve, beside what the provider credited.
 *
 *     node tools/cache-credit-arithmetic.mjs \
 *       --report shard0/benchmark-cortex-memory-ablation-report.json
 *     node tools/cache-credit-arithmetic.mjs --report ... --json > evidence.json
 *
 * ## Why this is a tool and not a paragraph
 *
 * `docs/AUDIT-CACHE-CREDIT.md` states five numbers, and four of them are computed from the artifact's
 * own delivered evidence: the longest prefix any two prompts share, and the share of a prompt whose
 * sentences an earlier prompt already sent. Those were computed once by hand, which is the shape this
 * repository has already paid for twice -- a reading that lives in prose and cannot be recomputed is a
 * reading nobody can check, and a re-derivation from memory is a second implementation waiting to
 * disagree with the first.
 *
 * The two measures are `positionExpectation` and `contentExpectation` from the eval package, so the
 * definitions this prints are the ones `probe-cache-credit.yml` scores the probe against. One
 * definition, two callers.
 *
 * ## What it refuses
 *
 * A report with no `questions[].turns[].text` is a report whose prompts are not in it, and a mean over
 * an empty population is not a measurement. A report whose `usageBySide` is absent prints the two
 * expectations and says the credit is unknown rather than printing zero.
 */
import { readFileSync } from 'node:fs';
import {
  contentExpectation,
  positionExpectation,
  sharedPrefixChars,
} from '../packages/cortex-eval/dist/cache-credit.js';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
  return value;
}

/** The prompt each question was handed: its delivered turns, in delivery order, as the reader saw them. */
function promptsOf(report) {
  const questions = report.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('report has no questions[]: the prompts are not in this artifact');
  }
  return questions.map((question) => {
    const turns = question.turns;
    if (!Array.isArray(turns) || turns.length === 0) {
      throw new Error(`question ${question.questionId ?? '?'} carries no turns`);
    }
    return turns.map((turn) => turn.text).join('\n');
  });
}

// An empty population has no mean. `0 / 0` is `NaN`, which the Markdown printed as `NaN%` and
// JSON.stringify silently turned into `null` -- an unwritten refusal masquerading as a value the
// tool declined to state. Return null so both renderers say "not measured" on the same condition.
const mean = (values) =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
const max = (values) => values.reduce((best, value) => Math.max(best, value), 0);

function main() {
  const path = arg('report', '');
  if (path === '') throw new Error('--report <path to benchmark-cortex-memory-ablation-report.json>');
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const prompts = promptsOf(report);

  // Order matters for both models: each is scored against the prompts already sent, so the source
  // order is kept rather than sorted. A report is written in the order the questions were answered.
  const position = prompts.map((_, index) => positionExpectation(prompts, index));
  const content = prompts.map((_, index) => contentExpectation(prompts, index));
  let longestShared = 0;
  for (let later = 1; later < prompts.length; later += 1) {
    for (let earlier = 0; earlier < later; earlier += 1) {
      longestShared = Math.max(longestShared, sharedPrefixChars(prompts[later], prompts[earlier]));
    }
  }

  const sides = report.usageBySide ?? {};
  const side = (name) => {
    const entry = sides[name];
    if (entry === undefined || entry.promptTokens === 0) return null;
    return {
      calls: entry.calls,
      promptTokens: entry.promptTokens,
      cacheHitPromptTokens: entry.cacheHitPromptTokens,
      creditedShare: entry.cacheHitPromptTokens / entry.promptTokens,
    };
  };

  const reading = {
    kind: 'cache-credit-arithmetic',
    report: path.split('/').pop(),
    dispatch: report.dispatch ?? null,
    questionCount: prompts.length,
    runs: report.runs ?? null,
    meanPromptChars: Math.round(mean(prompts.map((prompt) => prompt.length))),
    longestSharedPrefixChars: longestShared,
    position: { mean: mean(position), max: max(position) },
    content: { mean: mean(content.slice(1)), max: max(content) },
    sides: { baseline: side('baseline'), feature: side('feature') },
    // Two runs of one prompt can reuse at most one copy, which is the only bound that needs no model.
    ceilingFromRepetitions: report.runs === 2 ? 0.5 : null,
    contentPerPrompt: content,
    note:
      'The credited share is the provider field. This file says what the prompt text permits; it does ' +
      'not say what the provider counts. See docs/AUDIT-CACHE-CREDIT.md.',
  };

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(reading, null, 1)}\n`);
    return 0;
  }

  // A null expectation (the empty `content` population on a one-question report) is "not measured",
  // not a 0% or a NaN%. Render it in words so the Markdown and the JSON say the same thing.
  const percent = (value) =>
    value === null || !Number.isFinite(value) ? 'n/a' : `${(value * 100).toFixed(2)}%`;
  const lines = [
    `prompts: ${reading.questionCount}  mean ${reading.meanPromptChars} chars  runs: ${reading.runs}`,
    '',
    '| measure | value |',
    '| --- | ---: |',
    `| longest shared prefix | ${reading.longestSharedPrefixChars} chars |`,
    `| position expectation (mean / max) | ${percent(reading.position.mean)} / ${percent(
      reading.position.max,
    )} |`,
    `| content expectation (mean / max) | ${percent(reading.content.mean)} / ${percent(
      reading.content.max,
    )} |`,
  ];
  for (const name of ['baseline', 'feature']) {
    const entry = reading.sides[name];
    lines.push(
      entry === null
        ? `| ${name} credited | unknown (no usageBySide) |`
        : `| ${name} credited | ${percent(entry.creditedShare)} of ${entry.promptTokens.toLocaleString(
            'en-US',
          )} over ${entry.calls} calls |`,
    );
  }
  if (reading.ceilingFromRepetitions !== null) {
    lines.push(`| ceiling from ${reading.runs} runs of one prompt | ${percent(reading.ceilingFromRepetitions)} |`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

process.exitCode = main();
