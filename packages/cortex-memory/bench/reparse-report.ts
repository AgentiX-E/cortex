/**
 * Does this artifact's `answer` field still equal what today's parser would produce?
 *
 * ## Why this exists, and the run that made it necessary
 *
 * Run `39076055833` was dispatched, completed, and read against five registered predictions
 * before anyone noticed that **eighteen of its answers were blank** — not because the model
 * wrote nothing, but because `afterLastStepHeading` sliced from `offset + line.length + 1`
 * and the `+ 1` is a newline that does not exist when the heading is the last line. Every
 * answer written *beside* the heading was read as `''`. §13.60 is the measurement.
 *
 * The run was not wrong about the model; it was wrong about the reader. Re-parsing the
 * stored `rawOutputs` with the repaired parser took a minute and changed eighteen answers.
 * **That minute belongs before the reading, not after it.**
 *
 * ## What it cannot do
 *
 * It cannot rescore. The artifact carries one repetition's roster and the registered
 * statistic is a mean over four, so a drift count is a statement about *this roster's
 * answers*, never about the run's headline. Nor does it re-judge: a recovered answer whose
 * number matches the gold is not thereby correct, because the scorer's exact, numeric and
 * judge channels decide that together.
 *
 * ## Usage
 *
 *     pnpm --filter @agentix-e/cortex-memory drift path/to/benchmark-…-report.json
 *
 * Exits **1** when any answer drifts, so a readout step can gate on it, and 0 when the
 * artifact is readable by the parser that is about to read it.
 */
import { readFileSync } from 'node:fs';

import { parseAnswer } from '../src/parse.js';

/** The fields this needs from a roster record, named rather than typed loosely. */
interface Record {
  readonly questionId?: string;
  readonly capability?: string;
  readonly groundTruth?: string;
  readonly answer?: string | null;
  readonly rawOutput?: string | null;
}

interface Report {
  readonly questions?: readonly Record[];
  readonly records?: readonly Record[];
}

const NUMBER = /-?\d[\d,]*(?:\.\d+)?/g;

function numbers(text: unknown): string[] {
  return typeof text === 'string'
    ? [...text.matchAll(NUMBER)].map((m) => m[0].replace(/,/g, ''))
    : [];
}

function roster(report: Report): readonly Record[] {
  // The two keys a report may use, in the order `readout-arm-run.py` reads them, so the two
  // tools cannot disagree about which array is the roster.
  for (const candidate of [report.questions, report.records]) {
    if (Array.isArray(candidate) && candidate.length > 0) return candidate;
  }
  return [];
}

const path = process.argv[2];
if (!path) {
  console.error('usage: drift path/to/benchmark-cortex-memory-ablation-report.json');
  process.exit(2);
}

const report = JSON.parse(readFileSync(path, 'utf8')) as Report;
const questions = roster(report);
if (questions.length === 0) {
  console.error(`${path}: no per-question roster in this report`);
  process.exit(2);
}

interface Drift {
  readonly id: string;
  readonly capability: string;
  readonly stored: string | null | undefined;
  readonly today: string | null;
  readonly gold: string | undefined;
  readonly goldMatches: boolean;
}

const drifts: Drift[] = [];
let read = 0;
for (const question of questions) {
  if (typeof question.rawOutput !== 'string') continue;
  read += 1;
  const today = parseAnswer(question.rawOutput);
  if (today === question.answer) continue;
  const gold = numbers(question.groundTruth);
  const recovered = numbers(today);
  drifts.push({
    id: question.questionId ?? '?',
    capability: question.capability ?? '?',
    stored: question.answer,
    today,
    gold: question.groundTruth,
    goldMatches: gold.length > 0 && recovered.length > 0 && gold[0] === recovered[0],
  });
}

console.log(`${path}`);
console.log(`  records with a rawOutput: ${read} of ${questions.length}`);
console.log(`  answers that differ under today's parser: ${drifts.length}`);
if (drifts.length > 0) {
  const byCapability = new Map<string, number>();
  for (const drift of drifts) {
    byCapability.set(drift.capability, (byCapability.get(drift.capability) ?? 0) + 1);
  }
  console.log(`  by capability: ${[...byCapability].map(([c, n]) => `${c} ${n}`).join(', ')}`);
  console.log(
    `  of which the gold's first number matches the recovered answer: ${drifts.filter((d) => d.goldMatches).length}`,
  );
  console.log('  first ten:');
  for (const drift of drifts.slice(0, 10)) {
    const stored = drift.stored === undefined ? '<absent>' : JSON.stringify(drift.stored);
    console.log(
      `    ${drift.id} [${drift.capability}] stored ${stored} -> today ${JSON.stringify(drift.today)}` +
        (drift.goldMatches ? `  (gold ${JSON.stringify(drift.gold)})` : ''),
    );
  }
  console.log(
    '\n  The stored answers are not what this parser produces. Read the artifact with the\n' +
      '  parser that produced it, or fix the parser and compare — but do not report predictions\n' +
      '  against a roster the current reader does not agree with.',
  );
  process.exit(1);
}
