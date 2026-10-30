#!/usr/bin/env node
/**
 * The census §13.164 registered: what the reference-only failures actually are.
 *
 * ## Why a census and not a reading
 *
 * §13.164.2 read eight of the twenty-six MR questions and found seven enumeration errors. Eight
 * questions chosen because they were first in the roster's order is a reason but not a sample, so
 * the registration asked for three things before any repair: an exhaustive partition of the
 * twenty-six, a rule that reads the partition from the **gold and the answer** rather than from the
 * question text, and a statement of which class dominates. This tool is that registration made
 * executable, and the classes are decided from a pair of strings.
 *
 * ## The four classes, in the order they are tested
 *
 * | class | the test | why it is a class |
 * | --- | --- | --- |
 * | `decline` | the answer is absent | the reader had the question and refused it |
 * | `off-by-one` | both sides are one number and they differ by exactly one | the arm's own count is one member away |
 * | `aggregation` | both sides are one number and they differ by more | the arm's count is not one member away, in either direction |
 * | `other` | everything left | the class that exists so the partition is total rather than nearly so |
 *
 * The order matters and is stated rather than implied: a decline has no answer to compare, so it
 * cannot be off by one; and a pair of numbers is off by one *because of its value*, not because the
 * question sounds like a counting question. `0a995998` answers `2` where the gold says `3` and is
 * off by one; `a9f6b44c` answers `9` where the gold says `2` and is not, and a classifier that
 * decided from the wording would have called both the same thing.
 *
 * ## Why the refusal to be clever about "one number"
 *
 * The gold side may spell the number (`I attended four movie festivals.`) and the answer side may be
 * an expression the parser passed through untouched (`17 + 5 = 22`). Reading the last number after
 * an `=` is not a convenience, it is the definition of what that expression evaluates to; reading
 * the *first* number would score `25 + 40 = 65` as 25 and put a 40-unit error in the `off-by-one`
 * class. Both rules are tested.
 *
 * ## The second axis, and why the first one is not enough
 *
 * The class says what went wrong; it does not say whether anything in this repository could have
 * prevented it. Every decline is therefore also run through the product's **own** recovery planner
 * (`planAbstentionRecovery`, imported rather than restated), which answers a different question:
 * would the pass that exists for a decline-with-a-list have fired on this reply? A decline whose
 * list is empty is the state the contract licenses and no pass can help; a decline with a list is a
 * question the arm answered and then un-answered.
 *
 * Importing the predicate rather than copying it is the rule `test/mr-census/run.mjs` already
 * follows: a second implementation of "which part of a reply is a decline" is how two layers come
 * to disagree about the same artifact.
 */

import { readFileSync } from 'node:fs';
import {
  DECLINE_TOKEN,
  isBareDecline,
  planAbstentionRecovery,
} from '../packages/cortex-memory/dist/abstention-recovery.js';
import { classifyQuestionShape } from '../packages/cortex-memory/dist/question-shape.js';
import { classifyAggregationKind } from '../packages/cortex-eval/dist/natural-language-memory.js';

/** Word numbers, because four of the gold answers spell the count rather than print it. */
const WORDS = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/** The tokens that mean "the reader produced no answer", which is a shape rather than a value. */
const NULLISH = new Set(['', 'none', 'null', 'n/a', 'na', 'unknown', 'insufficient_evidence']);

/** A number, with or without thousands separators or a decimal part. */
const DIGITS = /\d+(?:,\d{3})*(?:\.\d+)?/g;

/** The spellings of a number, matched as whole words so `one` does not match `someone`. */
const WORD_NUMBER =
  /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/i;

/**
 * The **first** number a string states, with the unit word that follows it.
 *
 * First rather than last, and that is the correction this function needed: the gold for
 * `gpt4_7fce9456` is a sentence -- *"I viewed four properties before making an offer ... The ..."* --
 * whose tail mentions other numbers, and reading the last one scored a count of four as two and put
 * a three-unit error where there was a one-member error. A sentence states its quantity where the
 * sentence starts; an **expression** states its value after the `=`, which is the one case where the
 * last number is the right one, so that case is handled by its own branch rather than by a rule that
 * tries to serve both.
 */
function firstNumber(text) {
  const digits = new RegExp(DIGITS.source, 'g');
  const digit = digits.exec(text);
  const word = WORD_NUMBER.exec(text);
  if (digit === null && word === null) return null;
  const digitAt = digit?.index ?? Number.POSITIVE_INFINITY;
  const wordAt = word?.index ?? Number.POSITIVE_INFINITY;
  if (digitAt <= wordAt) {
    const value = Number((digit?.[0] ?? '').replace(/,/g, ''));
    if (Number.isFinite(value) === false) return null;
    return { value, at: digitAt, length: (digit?.[0] ?? '').length };
  }
  const value = WORDS[(word?.[1] ?? '').toLowerCase()];
  if (value === undefined) return null;
  return { value, at: wordAt, length: (word?.[0] ?? '').length };
}

/**
 * The number a string means, or `null` when it does not mean one.
 *
 * Two shapes are read and everything else is refused: a quantity, and an arithmetic expression the
 * parser passed through untouched (`17 + 5 = 22`). A permissive parser would turn
 * `four festivals, one workshop` into 1 and the census would report an `off-by-one` it never saw.
 */
export function scalarOf(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;

  // An expression: its value is the right-hand side. `25 + 40 = 65` read as 25 would file a
  // 120-unit error as nothing at all, and `17 + 5 = 22` read as 17 would file a one-member error
  // as a six-unit one.
  const equals = trimmed.lastIndexOf('=');
  const body = equals === -1 ? trimmed : trimmed.slice(equals + 1);
  const number = firstNumber(body);
  if (number === null) return null;
  if (equals !== -1) return number.value;

  // Durations are reduced to months so `1 year and 5 months` (17) is comparable to `3 years and
  // 9 months` (45). Only the unit that follows the number is read: `50` on its own is 50 of
  // whatever the question asked for, and guessing the unit would be inventing the comparison.
  const tail = trimmed.slice(number.at + number.length);
  const unit = /^\s*(years?|months?)\b/i.exec(tail);
  if (unit !== null) {
    const years = /^years?$/i.test(unit[1] ?? '');
    let months = years ? number.value * 12 : number.value;
    const secondary = /^\s*and\s+(\d+)\s+months?\b/i.exec(tail.slice((unit[0] ?? '').length));
    if (years && secondary !== null) months += Number(secondary[1]);
    return months;
  }
  return number.value;
}

/** Whether the arm produced no answer at all. */
export function isDecline(answer) {
  if (answer === null || answer === undefined) return true;
  const text = String(answer).trim().toLowerCase();
  return NULLISH.has(text);
}

/**
 * The class of one failure, read from its gold and its answer.
 *
 * Returns `{ klass, detail }` where `detail` is the comparison that decided it, so a reader can
 * check the verdict instead of trusting the label.
 */
export function classify(gold, answer) {
  if (isDecline(answer)) {
    return { klass: 'decline', detail: 'no answer' };
  }
  const answerValue = scalarOf(String(answer));
  const goldValue = scalarOf(typeof gold === 'string' ? gold : String(gold));
  if (answerValue === null || goldValue === null) {
    return {
      klass: 'other',
      detail: `gold=${goldValue === null ? 'not a number' : goldValue} answer=${
        answerValue === null ? 'not a number' : answerValue
      }`,
    };
  }
  const delta = answerValue - goldValue;
  if (Math.abs(delta) === 1) {
    return {
      klass: 'off-by-one',
      detail: `${goldValue} -> ${answerValue} (${delta > 0 ? '+' : ''}${delta})`,
    };
  }
  return {
    klass: 'aggregation',
    detail: `${goldValue} -> ${answerValue} (${delta > 0 ? '+' : ''}${delta})`,
  };
}

/** The reference-only questions of one capability, in the roster's own order. */
export function referenceOnly(report, capability) {
  const questions = new Map(report.questions.map((question) => [question.questionId, question]));
  const ids = report.ablation?.discordantQuestions?.baselineCorrectFeatureIncorrect ?? [];
  return ids
    .filter((id) => capability === undefined || questions.get(id)?.capability === capability)
    .map((id) => questions.get(id))
    .filter((question) => question !== undefined);
}

/**
 * Everything one report says about the population, as plain data.
 *
 * The counts are produced by the same walk that produces the rows, so a total cannot disagree with
 * the table it summarises.
 */
export function censusOf(report, capability) {
  const questions = referenceOnly(report, capability);
  const rows = questions.map((question) => {
    const verdict = classify(question.groundTruth, question.answer);
    const raw = question.rawOutput ?? '';
    const plan = planAbstentionRecovery(
      raw,
      question.answer !== null && question.answer !== undefined,
      true,
    );
    return {
      id: question.questionId,
      capability: question.capability,
      question: question.question,
      gold: question.groundTruth,
      answer: question.answer,
      klass: verdict.klass,
      detail: verdict.detail,
      declineShape: verdict.klass === 'decline' ? shapeOf(raw, plan) : null,
      wouldRetry: plan.kind === 'retry',
      listed: plan.kind === 'retry' ? plan.items.length : 0,
      // Which block `ask: 'operands'` would give this question, read through the product's own
      // classifier. A treatment whose reach is a predicate over the question cannot be counted by a
      // dispatch field, so the artifact is not asked to: this tool counts the population instead.
      shape: classifyQuestionShape(question.question),
    };
  });

  const classes = { decline: 0, 'off-by-one': 0, aggregation: 0, other: 0 };
  for (const row of rows) classes[row.klass] += 1;

  const declines = rows.filter((row) => row.klass === 'decline');
  const shapes = { bare: 0, 'absence-only': 0, list: 0, prose: 0 };
  for (const row of declines) shapes[row.declineShape] += 1;

  /** How many of each class the operand block would reach, which is its whole population. */
  const byShape = {};
  for (const row of rows) {
    byShape[row.klass] ??= { derivation: 0, enumeration: 0 };
    byShape[row.klass][row.shape] += 1;
  }

  return {
    capability: capability ?? 'all',
    population: rows.length,
    classes,
    declineShapes: shapes,
    reach: byShape,
    operands: rows.filter((row) => row.shape === 'derivation').length,
    retryable: rows.filter((row) => row.wouldRetry).length,
    rows,
  };
}

/**
 * Which shape a decline has, using the product's own predicates.
 *
 * Four shapes rather than two, because "declined with no list" and "declined with a list of
 * absences" are different findings that a bare/list split reports as one. The second is the honest
 * refusal the contract licenses -- `157a136e` writes *"No item in the evidence states the user's
 * age"* and means it -- and the difference decides whether a repair has anything to reach.
 */
function shapeOf(raw, plan) {
  if (plan.kind === 'retry') return 'list';
  if (isBareDecline(raw)) return 'bare';
  const text = String(raw ?? '').trim();
  if (text === '') return 'bare';
  const firstStep = text.split(/^\s*step\s*2\s*(?:[—\-:.]|$)/im)[0] ?? '';
  const bullets = firstStep.split('\n').filter((line) => /^\s*[-*]\s+\S/.test(line));
  return bullets.length === 0 ? 'prose' : 'absence-only';
}

const PAD = (text, width) => String(text).padEnd(width);

/** The human reading: the table, its totals, and the sum check that makes the partition total. */
export function render(census) {
  const lines = [];
  lines.push(
    `reference-only failures, capability ${census.capability}: ${census.population} question(s)`,
  );
  lines.push('');
  lines.push(
    `${PAD('question', 13)}${PAD('class', 14)}${PAD('shape', 12)}${PAD('gold', 24)}${PAD('answer', 22)}detail`,
  );
  for (const row of census.rows) {
    lines.push(
      PAD(row.id, 13) +
        PAD(row.klass, 14) +
        PAD(row.shape, 12) +
        PAD(preview(row.gold), 24) +
        PAD(preview(row.answer), 22) +
        row.detail,
    );
  }
  lines.push('');
  const total = Object.values(census.classes).reduce((sum, count) => sum + count, 0);
  for (const [klass, count] of Object.entries(census.classes)) {
    lines.push(`  ${PAD(klass, 14)}${count}`);
  }
  lines.push(`  ${PAD('sum', 14)}${total}` + (total === census.population ? '' : '  MISMATCH'));
  lines.push('');
  lines.push(`  declines by shape: ${JSON.stringify(census.declineShapes)}`);
  lines.push(
    `  declines the recovery pass would re-ask: ${census.retryable} of ${census.population}`,
  );
  lines.push(`  derivation-shaped by class: ${JSON.stringify(census.reach)}`);
  lines.push(`  population of \`ask: operands\`: ${census.operands} of ${census.population}`);
  return lines.join('\n');
}

const preview = (value) => {
  const text = value === null || value === undefined ? `${DECLINE_TOKEN} (none)` : String(value);
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 22 ? `${flat.slice(0, 21)}…` : flat;
};

/** The item list of a retryable decline, for the questions a repair has to reach by name. */
export function itemLists(census) {
  return census.rows
    .filter((row) => row.wouldRetry)
    .map((row) => ({ id: row.id, listed: row.listed, detail: row.detail }));
}

/**
 * Every question where the arm's classifier and the reference pipeline's disagree.
 *
 * ## Why the guard is here rather than in a test of its own
 *
 * `classifyQuestionShape` is a copy of `classifyAggregationKind`, and the copy exists because the
 * dependency runs the other way: `cortex-eval` does not depend on `cortex-memory`, so the two
 * classifiers cannot share a constant without inverting the graph. The project's rule for that pair
 * is a test that holds them together, and the honest place for it is **where the copy is used to
 * count a treatment's population** -- a parity test in some other file would keep passing while this
 * tool printed a reach computed from a pattern that had drifted.
 *
 * The comparison is over the whole roster and not over the population, because a drift that moved a
 * question *out* of the population is exactly the drift that would leave the reach looking correct.
 */
export function classifierDisagreements(report) {
  return report.questions
    .filter(
      (question) =>
        classifyQuestionShape(question.question) !== classifyAggregationKind(question.question),
    )
    .map((question) => ({
      id: question.questionId,
      question: question.question,
      arm: classifyQuestionShape(question.question),
      reference: classifyAggregationKind(question.question),
    }));
}

function main(argv) {
  const args = [...argv];
  const flag = (name) => {
    const index = args.indexOf(name);
    if (index === -1) return undefined;
    const value = args[index + 1];
    args.splice(index, 2);
    return value;
  };
  const report = flag('--report');
  const capability = flag('--capability');
  const asJson = args.includes('--json');
  if (report === undefined) {
    process.stderr.write(
      'usage: mr-failure-census.mjs --report <artifact.json> [--capability MR] [--json]\n',
    );
    return 2;
  }
  const parsed = JSON.parse(readFileSync(report, 'utf8'));
  // The copy is checked before the number it produces is printed. A reach computed from a pattern
  // that no longer matches the reference's is a fact about this file, not about the arm.
  const drifted = classifierDisagreements(parsed);
  if (drifted.length > 0) {
    process.stderr.write(
      `the two classifiers disagree on ${drifted.length} question(s), so the reach below would describe this tool:${'\n'}` +
        drifted
          .map((row) => `  ${row.id}  arm=${row.arm} reference=${row.reference}  ${row.question}`)
          .join('\n') +
        '\n',
    );
    return 3;
  }
  const census = censusOf(parsed, capability);
  if (asJson) {
    process.stdout.write(`${JSON.stringify(census, null, 2)}\n`);
  } else {
    process.stdout.write(`${render(census)}\n`);
  }
  // A partition that does not add up is an instrument failure, so it is an exit code rather than a
  // line a reader may skip.
  return Object.values(census.classes).reduce((sum, count) => sum + count, 0) === census.population
    ? 0
    : 1;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('mr-failure-census.mjs')) {
  process.exitCode = main(process.argv.slice(2));
}
