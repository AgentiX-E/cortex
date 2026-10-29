#!/usr/bin/env node
/**
 * How many questions a query-decomposition treatment could touch, read from the question text.
 *
 *     node tools/cue-census.mjs <report.json> [--json]
 *
 * ## What this is and what it is not
 *
 * It is a **ceiling** tool, not an implementation. A treatment in the family of `analyzeQuery` (see §13.137)
 * reads the question for the things it names — a period, a count, a comparison, a pair — and searches once per
 * thing instead of once for the whole sentence. Whether that helps depends on whether the question names anything
 * separable, which is a property of the **question text alone** and therefore computable before any model call.
 *
 * So this file answers exactly one question: **of the questions this arm gets wrong, how many mention a period, a
 * count, a comparison or a pair?** That number is the treatment's population. It is not its yield: naming a count
 * is necessary for a decomposition to help and nowhere near sufficient, and §13.137 records both the ceiling this
 * prints and the yield somebody else measured on the same benchmark.
 *
 * ## Why the ceiling has to be printed before dispatching
 *
 * §13.126.4 established the rule for the retrieval axis — a proposal must state its own ceiling before it is
 * dispatched, because a ceiling of five questions and a prediction of "+3" are the same sentence to a reader who
 * cannot see the ceiling. §13.135 then showed what a claim looks like when its ceiling is *below* its threshold:
 * §13.129.8's claim 1 asked for four conversions out of a population of three.
 *
 * This tool is that check for the decomposition axis, and it is deliberately dumb: four regular expressions over
 * the `question` field of a report's roster, plus `correct`. No model, no dataset, no retrieval index — so it runs
 * on artifacts that already exist and cannot be tuned into agreeing with a hope.
 *
 * ## Why the union and not the sum
 *
 * A question can name a period and a count at once (eight do in the MR capability), and a treatment that
 * decomposes on both still touches one question. Adding the columns is the double-count the ledger refuses for
 * increments; here it would inflate a ceiling, which is the one direction a ceiling must never be wrong in.
 */

import { readFileSync } from 'node:fs';

const MONTHS =
  'january|february|march|april|may|june|july|august|september|october|november|december';
const WEEKDAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday';

/**
 * The four cue classes, each written to match the shape the question is in rather than a keyword list.
 *
 * `period` has four forms because a period is named four ways — a month (`in April`), a relative window (`the past
 * two weeks`), a weekday (`last Thursday`), a range (`from July to October`) — and a rule that caught only the first
 * would report a ceiling a quarter of the true one. `count` and `compare` are the cues `analyzeQuery` is documented
 * to read. `pair` is the weakest of the four: `A and B` covers a sentence like "my sister and I" that names no two
 * things to search for, so it is reported separately and its contribution to the union is visible rather than
 * folded in.
 */
const CUES = {
  period: new RegExp(
    [
      `\\b(?:in|during)\\s+(?:${MONTHS})\\b`,
      '\\b(?:the\\s+)?(?:past|last|previous)\\s+(?:\\d+|two|three|four|five|six|few)\\s+(?:day|week|month|year)s?\\b',
      `\\b(?:last|this)\\s+(?:${WEEKDAYS})\\b`,
      `\\bfrom\\s+(?:${MONTHS})\\s+(?:to|until|through)\\s+(?:${MONTHS})\\b`,
    ].join('|'),
    'i',
  ),
  count: /\bhow\s+many\b|\bhow\s+much\b|\bin\s+total\b|\btotal\b|\baltogether\b|\bcombined\b/i,
  compare:
    /\bwhich\s+(?:one\s+)?(?:came|happened|did|was)\s+first\b|\bbefore\b|\bafter\b|\bearlier\b|\blater\b/i,
  pair: /\b\w+\s+and\s+\w+\b/i,
};

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const paths = argv.filter((argument) => !argument.startsWith('--'));

if (paths.length !== 1) {
  process.stderr.write('usage: node tools/cue-census.mjs <report.json> [--json]\n');
  process.exit(1);
}

/**
 * One report's roster, refused rather than defaulted when it cannot answer the question.
 *
 * A report without `questions` predates the roster field, and an empty one would print a ceiling of zero — the
 * confident-wrong-answer shape this repository refuses everywhere else. A question without `question` text cannot
 * be classified at all, for the same reason.
 */
function rosterOf(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const questions = parsed.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error(
      `${file} carries no per-question roster, so it cannot be censused: a ceiling of zero and an artifact that ` +
        'cannot say would look the same',
    );
  }
  for (const question of questions) {
    if (typeof question.question !== 'string' || question.question.length === 0) {
      throw new Error(
        `${file} has a question (${question.questionId ?? 'no id'}) with no text, so its cues cannot be read`,
      );
    }
  }
  return { questions, generatedAt: parsed.generatedAt ?? 'unknown' };
}

/** @returns {Record<string, boolean>} which cue classes this question names */
function cuesOf(text) {
  const found = {};
  for (const [name, pattern] of Object.entries(CUES)) found[name] = pattern.test(text);
  return found;
}

const CAPABILITIES = ['IE', 'MR', 'KU', 'TR', 'ABS'];

function census(questions) {
  const byCapability = new Map();
  for (const capability of CAPABILITIES) {
    byCapability.set(capability, {
      questions: 0,
      wrong: 0,
      period: 0,
      count: 0,
      compare: 0,
      pair: 0,
      wrongUnion: 0,
      wrongBoth: 0,
    });
  }
  for (const question of questions) {
    if (!byCapability.has(question.capability)) continue;
    const row = byCapability.get(question.capability);
    const cues = cuesOf(question.question);
    const wrong = question.correct !== true;
    row.questions += 1;
    if (wrong) row.wrong += 1;
    for (const name of Object.keys(CUES)) if (cues[name]) row[name] += 1;
    if (wrong) {
      if (Object.values(cues).some(Boolean)) row.wrongUnion += 1;
      if (cues.period && cues.count) row.wrongBoth += 1;
    }
  }
  const total = {
    questions: 0,
    wrong: 0,
    wrongUnion: 0,
  };
  for (const row of byCapability.values()) {
    total.questions += row.questions;
    total.wrong += row.wrong;
    total.wrongUnion += row.wrongUnion;
  }
  return { byCapability, total };
}

const { questions, generatedAt } = rosterOf(paths[0]);
const { byCapability, total } = census(questions);

if (asJson) {
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: 'cue-census',
        report: { path: paths[0], generatedAt, roster: questions.length },
        capabilities: Object.fromEntries(byCapability),
        total,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

const lines = [];
lines.push('', 'Cue census', '');
lines.push(`- report: ${paths[0]} generatedAt=${generatedAt} roster=${questions.length}`);
lines.push('');
lines.push('| capability | n | wrong | period | count | compare | A-and-B | wrong with any cue |');
lines.push('| ---------- | -: | ----: | -----: | ----: | ------: | ------: | -----------------: |');
for (const [capability, row] of byCapability) {
  if (row.questions === 0) continue;
  lines.push(
    `| ${capability} | ${row.questions} | ${row.wrong} | ${row.period} | ${row.count} | ` +
      `${row.compare} | ${row.pair} | **${row.wrongUnion}** |`,
  );
}
lines.push('');
lines.push(
  `- A decomposition treatment's population on this artifact is **${total.wrongUnion} of ${total.wrong} wrong ` +
    `questions** — the ones that name a period, a count, a comparison or a pair. That is a ceiling and not a ` +
    `yield: naming a count is necessary for a decomposition to help and nowhere near sufficient.`,
);
lines.push(
  '- The union, not the sum: a question naming two cue classes is still one question, and adding the columns ' +
    'would inflate a ceiling, which is the one direction a ceiling must never be wrong in.',
);
lines.push(
  '- This reads question text and verdicts only. It implements no part of `analyzeQuery` and calls no model, so ' +
    'it can be run on artifacts that already exist and cannot be tuned to agree with a hope.',
);
lines.push('');

process.stdout.write(`${lines.join('\n')}\n`);
