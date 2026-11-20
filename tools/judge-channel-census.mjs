#!/usr/bin/env node
/**
 * How much of the grading still needs a model, and how much of what needs one could not be decided mechanically.
 *
 * ## The question this answers, and the constraint it answers for
 *
 * Constraint ⑰ is "audit every LLM and embedding call, and do not waste any". The judge is the one place where
 * a call is spent on a decision that is sometimes pure arithmetic, and `metrics.ts` already short-circuits the
 * two mechanical cases (`exact`, `numeric`) before it consults a model. What no artifact states is the **split**
 * between those three doors: a run prints `scorer channels: structural …, exact …, numeric …, judge …` on its
 * own log line, but a log line is not a population, and an artifact is what a reader can re-derive.
 *
 * So this tool recomputes the split from an artifact, using **the same exported functions the scorer uses**
 * (`normalizeAnswer`, `numericAnswerVerdict`) rather than a second implementation of them. A reimplementation
 * would be a second place for "what counts as an exact match" to be decided, which is how two readings of one
 * run come to disagree.
 *
 * ## The number worth acting on
 *
 * `judgeWithNumericGold` is the count of verdicts that (a) reached the model and (b) have a gold that parses as a
 * single number. Those are the calls a widened numeric gate *could* have avoided. It is not a target: the
 * numeric gate refuses a gold that states more than one acceptable value on purpose
 * (`numericAnswerVerdict`'s docblock), and widening it would trade a saved call for a wrong verdict. The count
 * is published so that "how much is left" is a measurement rather than an intuition.
 *
 * ## Why it reports agreement rather than only counts
 *
 * A mechanical door that disagrees with the published verdict is a defect either in the door or in the
 * artifact, and the pair is invisible in the split alone. `--check` therefore exits non-zero when a mechanically
 * decided verdict disagrees with the artifact's own `correct` field -- the same discipline the coverage gate
 * uses: a reading that cannot fail is not a reading.
 *
 * Usage:
 *
 *   node tools/judge-channel-census.mjs <artifact.json> [--out <file.json>] [--check]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { normalizeAnswer, numericAnswerVerdict } from '../packages/cortex-eval/dist/index.js';

const args = process.argv.slice(2);
const artifactPath = args.find((arg) => !arg.startsWith('--'));
if (artifactPath === undefined) {
  console.error('usage: judge-channel-census.mjs <artifact.json> [--out <file.json>] [--check]');
  process.exit(2);
}
const outIndex = args.indexOf('--out');
const out = outIndex === -1 ? null : args[outIndex + 1];
const check = args.includes('--check');

const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
const questions = artifact.questions;
if (!Array.isArray(questions) || questions.length === 0) {
  console.error(`${artifactPath}: no questions -- an empty population would report a perfect split`);
  process.exit(2);
}

/** Whether a string is a single number once the usual decorations are removed. */
function soleNumber(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text
    .trim()
    .replace(/^[$€£¥]\s*/, '')
    .replace(/[,\s]/g, '')
    .replace(/(?:%|percent)$/i, '');
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

const channels = { structural: 0, exact: 0, numeric: 0, judge: 0 };
const disagreements = [];
const judgeRows = [];
const byCapability = new Map();

for (const q of questions) {
  const capability = q.capability ?? 'unknown';
  const bucket = byCapability.get(capability) ?? {
    structural: 0,
    exact: 0,
    numeric: 0,
    judge: 0,
    judgeWithNumericGold: 0,
  };
  const gold = q.groundTruth ?? null;
  const answer = q.answer ?? null;

  let channel;
  let verdict = null;
  if (gold === null || answer === null) {
    channel = 'structural';
    verdict = gold === null ? answer === null : false;
  } else if (normalizeAnswer(answer) === normalizeAnswer(gold)) {
    channel = 'exact';
    verdict = true;
  } else {
    const numeric = numericAnswerVerdict(q.question ?? '', answer, gold);
    if (numeric === undefined) {
      channel = 'judge';
      const goldNumber = soleNumber(gold);
      if (goldNumber !== null) {
        bucket.judgeWithNumericGold += 1;
        judgeRows.push({ questionId: q.questionId, gold, answer: String(answer).slice(0, 80) });
      }
    } else {
      channel = 'numeric';
      verdict = numeric;
    }
  }

  channels[channel] += 1;
  bucket[channel] += 1;
  byCapability.set(capability, bucket);

  if (verdict !== null && verdict !== (q.correct === true)) {
    disagreements.push({
      questionId: q.questionId,
      capability,
      channel,
      mechanical: verdict,
      artifact: q.correct === true,
    });
  }
}

const total = questions.length;
const share = (n) => `${((n / total) * 100).toFixed(1)}%`;
const reading = {
  artifact: artifactPath,
  generatedAt: artifact.generatedAt ?? null,
  questionCount: total,
  channels,
  shares: Object.fromEntries(Object.entries(channels).map(([k, v]) => [k, share(v)])),
  judgeWithNumericGold: judgeRows.length,
  disagreements,
  judgeRowsWithNumericGold: judgeRows,
  byCapability: Object.fromEntries(
    [...byCapability.entries()].sort(([a], [b]) => a.localeCompare(b)),
  ),
};

const lines = [
  `judge channel census -- ${artifactPath}`,
  `  population: ${total} question(s)${artifact.generatedAt ? `, generated ${artifact.generatedAt}` : ''}`,
  `  structural ${channels.structural} (${share(channels.structural)}), ` +
    `exact ${channels.exact} (${share(channels.exact)}), ` +
    `numeric ${channels.numeric} (${share(channels.numeric)}), ` +
    `judge ${channels.judge} (${share(channels.judge)})`,
  `  model calls that a numeric gold could have decided: ${judgeRows.length}`,
  `  mechanical verdicts disagreeing with the artifact: ${disagreements.length}`,
];
for (const [capability, bucket] of Object.entries(reading.byCapability)) {
  const n = bucket.structural + bucket.exact + bucket.numeric + bucket.judge;
  lines.push(
    `  ${capability.padEnd(3)} n=${String(n).padStart(3)} ` +
      `exact ${String(bucket.exact).padStart(3)} numeric ${String(bucket.numeric).padStart(3)} ` +
      `judge ${String(bucket.judge).padStart(3)} of which numeric gold ${bucket.judgeWithNumericGold}`,
  );
}
if (disagreements.length > 0) {
  for (const row of disagreements) {
    lines.push(
      `  DISAGREE ${row.questionId} [${row.channel}] mechanical=${row.mechanical} artifact=${row.artifact}`,
    );
  }
}
console.log(lines.join('\n'));

if (out !== null) {
  const target = resolve(out);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(reading, null, 2)}\n`);
  console.log(`wrote ${target}`);
}

if (check && disagreements.length > 0) {
  console.error(
    `judge-channel-census: ${disagreements.length} mechanical verdict(s) disagree with the artifact`,
  );
  process.exit(1);
}
