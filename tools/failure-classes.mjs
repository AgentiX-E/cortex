#!/usr/bin/env node
/**
 * What the wrong answers are wrong *about*: a deterministic taxonomy of a run's failures.
 *
 *     node tools/failure-classes.mjs <report.json> [...more] [--json]
 *     node tools/failure-classes.mjs --self-test
 *
 * ## Why this exists, and why it is not a second accuracy table
 *
 * `MEASURE-RESOLUTION-WALL.md` §2 priced every mechanism in the queue against the population it would be
 * measured on and found that **every one of them is smaller than its own floor**: the largest ceiling was
 * 92% of the smallest floor it could be measured against, so no dispatch in this campaign has ever had the
 * resolution to fail or to succeed. The conclusion that note draws is not "stop dispatching" -- it is that a
 * mechanism must be chosen by its **ceiling** rather than by its plausibility, because the ceiling is the
 * only number in the arithmetic that does not depend on a draw.
 *
 * The queue has never had a ceiling census. It has had failure *counts* per route (`room-census.mjs`) and
 * failure *stories* per question (`MEASURE-FAILURE-STABILITY.md`), and the jump between them was made by
 * reading a handful of answers. This tool makes it mechanical: every wrong answer is assigned to one of eight
 * classes by a rule that reads only the artifact, and each class is printed with the population it lives in,
 * the ceiling it represents in points, and the floor that population can resolve.
 *
 * ## The eight classes, in three institutions
 *
 * | class | rule | what it says about the mechanism |
 * | --- | --- | --- |
 * | `empty` | the reply is blank | the reader produced nothing; a contract or parse defect, not a memory one |
 * | `declined` | the reply is the abstain token | the reader judged the evidence insufficient -- §13.72's cascade |
 * | `preference` | the gold is a preference summary ("The user would prefer ...") | the question asks for an inference about the user rather than a fact in a turn |
 * | `derived-number` | the gold **is** a number and that number appears nowhere in the delivered turns | a value to compute: the operand is the count or the sum, so its absence says nothing about delivery |
 * | `number-absent` | the gold's number sits inside a sentence and no delivered turn states it | the operand was never delivered: a **delivery** institution |
 * | `number-misselected` | the gold's number **is** in the delivered turns and the reply used another | the operand was delivered and not chosen: a **decision** institution |
 * | `text-absent` | the gold's content terms are mostly absent from the delivered turns | delivery, on the half of the corpus that carries no number |
 * | `text-misselected` | the gold's terms are present and the reply named something else | decision, on that half |
 *
 * The split that matters is `absent` against `misselected`, and it is the one thing this tool computes that
 * no existing reading does at question granularity: it is the difference between *"the reader never saw it"*
 * and *"the reader saw it and answered something else"*, decided by searching the delivered gold turns for
 * the gold's own operand. §196 drew that distinction per route from `goldOverlap.carried/total`; this draws
 * it per question from `goldOverlap.goldTurns`, which is the text.
 *
 * `derived-number` exists because the first draft of this file lacked it and misfiled all eight `MR` counting
 * failures as `number-absent` -- a full delivery (`carried == total`) with the gold `3` against a reply of
 * `2` reads as "the operand was never delivered" to any rule that searches the evidence for the number. The
 * two are opposite institutions and only one of them is a delivery fault.
 *
 * `goldTurns` rather than the prompt is deliberate. The artifact does not carry prompt text -- it carries a
 * digest -- so a tool that wanted the prompt would either re-run the product or trust a reconstruction. The
 * gold turns are the subset that matters and they are delivered verbatim in the record.
 *
 * ## What it refuses
 *
 * - a record with no `goldOverlap`, because three of the six classes are decided by it;
 * - a route the table does not name, because the per-population section would silently drop it;
 * - a record whose `correct` is not a boolean, because a string `"false"` is truthy and would file a failure
 *   as a success.
 */

import { readFileSync } from 'node:fs';

class Refusal extends Error {}

/** The product's route order, and a copy of `TURN_CAP_ROUTES` that `repo-gates.test.ts` checks. */
const ROUTES = ['multi-session', 'temporal', 'flat', 'knowledge-update', 'abstention', 'assistant'];

/**
 * The token a declining reader replies with.
 *
 * A copy of `parse.ts`'s `ABSTAIN_TOKEN`, and the gate that checks it reads the source rather than this
 * comment: a classification whose "declined" class never fires because the spelling moved would report an
 * entire cascade as `empty`, and both are silent.
 */
const ABSTAIN_TOKEN = 'INSUFFICIENT_EVIDENCE';

/**
 * Number words the corpus uses, because a gold answer spells its operands out.
 *
 * `gpt4_15e38248` answers `3` against a gold of `I attended four movie festivals.`, so a digit-only
 * extractor reads the gold as carrying **no number** and files a counting failure as a text failure. The
 * map runs to twenty because the dataset's counts are small and a fabricated bound above it would be a
 * vocabulary the corpus never uses.
 */
const NUMBER_WORDS = {
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
};

/**
 * Terms a text comparison ignores.
 *
 * Short and generic, and the rule is deliberately crude for `resolution.ts`'s reason: a stop list tuned on
 * this benchmark encodes the benchmark. These are the words that appear in a preference summary and in
 * every turn around it, so keeping them would make `text-absent` unreachable.
 */
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'in', 'on', 'at', 'to', 'for', 'from', 'with',
  'that', 'this', 'these', 'those', 'it', 'its', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'you', 'your', 'yours', 'i', 'me', 'my', 'we', 'our', 'they', 'them', 'their', 'he', 'she', 'his',
  'her', 'would', 'will', 'can', 'could', 'should', 'may', 'might', 'do', 'does', 'did', 'have', 'has',
  'had', 'not', 'no', 'as', 'by', 'so', 'than', 'then', 'there', 'here', 'when', 'what', 'which', 'who',
  'how', 'why', 'about', 'into', 'over', 'under', 'more', 'most', 'some', 'any', 'all', 'also', 'just',
  'user', 'prefer', 'prefers', 'preferred', 'preference', 'preferences', 'responses', 'response',
]);

/**
 * A gold answer that is nothing but a plain integer.
 *
 * The distinction it draws is the one the first draft of this file got wrong: a **bare** gold is a value the
 * reader has to compute (the count of items, the sum of amounts), while a number that carries a currency or a
 * percent sign, or that sits inside a sentence, is an operand it has to find. `$720` is a single amount the
 * evidence states; `4` is a total the evidence does not state anywhere, because nothing in it says "four".
 */
const BARE_NUMBER = /^\s*\d[\d,.]*\s*$/;

/** Every number a string states, whether as digits, as a currency amount, or as a word. */
export function numbersIn(text) {
  const found = [];
  const cleaned = String(text).replace(/[,$%]/g, ' ').replace(/(\d)[.](?=\d{3}\b)/g, '$1');
  for (const match of cleaned.matchAll(/\d+(?:\.\d+)?/g)) found.push(Number(match[0]));
  for (const word of String(text).toLowerCase().matchAll(/[a-z]+/g)) {
    const value = NUMBER_WORDS[word[0]];
    if (value !== undefined) found.push(value);
  }
  return found;
}

/** The content terms of a string, in the crude sense {@link STOP} defines. */
export function termsIn(text) {
  return new Set(
    String(text)
      .toLowerCase()
      .match(/[a-z]{4,}/g)
      ?.filter((term) => !STOP.has(term)) ?? [],
  );
}

/**
 * The sample floor a population of this size can resolve, in points.
 *
 * `2.8016 * sqrt(p(1-p)/n)` at Miller's constant for 80% power, the same expression
 * `MEASURE-RESOLUTION-WALL.md` §1 uses, with `p` the control accuracy the caller passes. Printed beside
 * every class so the table answers "is this worth a dispatch" rather than "how many are there".
 */
export function resolutionFloor(n, p) {
  if (n <= 0) return Number.POSITIVE_INFINITY;
  return 100 * 2.8016 * Math.sqrt((p * (1 - p)) / n);
}

/** Whether the gold's own operand reaches the reader, for the classes that turn on that question. */
function operandDelivered(truth, goldText) {
  const wanted = numbersIn(truth);
  if (wanted.length > 0) {
    const delivered = new Set(numbersIn(goldText));
    return wanted.some((value) => delivered.has(value));
  }
  const wantedTerms = termsIn(truth);
  if (wantedTerms.size === 0) return true;
  const deliveredTerms = termsIn(goldText);
  let hit = 0;
  for (const term of wantedTerms) if (deliveredTerms.has(term)) hit += 1;
  return hit / wantedTerms.size >= 0.5;
}

/**
 * Which class one record's failure belongs to, or `null` when it is not a failure.
 *
 * Throws {@link Refusal} for the three states the docblock names, because each one would silently produce a
 * class rather than an error: a missing `goldOverlap` reads as "operand absent" on every question.
 */
export function classify(record) {
  if (typeof record.correct !== 'boolean') {
    throw new Refusal(
      `question ${record.questionId ?? '?'} has no boolean \`correct\` (${JSON.stringify(record.correct)}); ` +
        'a string "false" is truthy and would file a failure as a success',
    );
  }
  if (!ROUTES.includes(record.route)) {
    throw new Refusal(
      `question ${record.questionId ?? '?'} used route ${JSON.stringify(record.route)}, which the route ` +
        `table does not name (${ROUTES.join(', ')}); its failures would be dropped from every ` +
        'per-population line rather than counted somewhere wrong',
    );
  }
  if (record.correct) return null;
  const overlap = record.goldOverlap;
  if (overlap === null || typeof overlap !== 'object' || !Array.isArray(overlap.goldTurns)) {
    throw new Refusal(
      `question ${record.questionId ?? '?'} carries no \`goldOverlap.goldTurns\`; three of the six classes ` +
        'are decided by searching that text, and their absence would read as "the operand was never ' +
        'delivered" on every question',
    );
  }

  const answer = String(record.answer ?? '');
  if (answer.trim() === '') return 'empty';
  if (answer.includes(ABSTAIN_TOKEN)) return 'declined';
  if (/^the user would prefer/i.test(String(record.groundTruth ?? ''))) return 'preference';

  const goldText = overlap.goldTurns.join('\n');
  const truth = String(record.groundTruth ?? '');
  const numeric = numbersIn(truth).length > 0;
  if (!numeric) return operandDelivered(truth, goldText) ? 'text-misselected' : 'text-absent';
  // A gold that is nothing but a number is a value the reader has to **compute**, not one it can find: on
  // `MR` the counting questions answer `3` where the facts are three separate turns, so the number appears
  // in the evidence only by coincidence. The question "was the operand delivered" therefore has no answer
  // for it, and asking it was this tool's first defect -- it read eight `MR` failures as an undelivered
  // operand when every one of them had `carried == total`, i.e. a full delivery with a wrong computation.
  //
  // Asked before the delivery test rather than after it, because a count that happens to equal a number
  // printed somewhere in the evidence would otherwise be filed as "delivered and not chosen" -- the one
  // reading that is certainly false for a value nobody stated.
  if (BARE_NUMBER.test(truth.trim())) return 'derived-number';
  return operandDelivered(truth, goldText) ? 'number-misselected' : 'number-absent';
}

/**
 * The three institutions the six classes roll up into, and the grouping is the argument of this file.
 *
 * A mechanism is dispatched against an **institution**, not against a class: `derived-number`,
 * `number-misselected` and `number-absent` are three different faults of one faculty (what the reader does
 * with an operand), so a mechanism that improves operand handling can move all three and must be priced
 * against their sum. Pricing it against one of them is how a 19-question mechanism came to be read as three
 * 8-question mechanisms, each below the floor.
 */
const BUNDLES = {
  numeric: ['derived-number', 'number-misselected', 'number-absent'],
  text: ['text-misselected', 'text-absent'],
  behaviour: ['preference', 'declined', 'empty'],
};

/** One line per class: how many, where they live, and whether the population can see them. */
function census(records) {
  const byRoute = new Map(ROUTES.map((route) => [route, { n: 0, correct: 0 }]));
  const byClass = new Map();
  for (const record of records) {
    const route = byRoute.get(record.route);
    route.n += 1;
    if (record.correct) route.correct += 1;
    const name = classify(record);
    if (name === null) continue;
    const row = byClass.get(name) ?? { count: 0, routes: new Map(), coverage: [] };
    row.count += 1;
    row.routes.set(record.route, (row.routes.get(record.route) ?? 0) + 1);
    const overlap = record.goldOverlap;
    if (overlap.total > 0) row.coverage.push(overlap.carried / overlap.total);
    byClass.set(name, row);
  }
  return { byRoute, byClass };
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function pad(value, width) {
  return String(value).padEnd(width);
}

function left(value, width) {
  return String(value).padStart(width);
}

/** The report, as lines. Separated from `main` so the self-test can assert the text rather than the exit. */
export function report(records) {
  const { byRoute, byClass } = census(records);
  const lines = [];
  const total = records.length;
  const wrong = [...byClass.values()].reduce((sum, row) => sum + row.count, 0);
  lines.push(`${total} questions, ${wrong} failures, ${byClass.size} class(es)`);
  lines.push('');
  lines.push(
    `${pad('class', 20)}${left('n', 5)}${left('share', 8)}${left('cov med', 9)}  routes`,
  );
  for (const [name, row] of [...byClass.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const routes = [...row.routes.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([route, count]) => `${route} ${count}`)
      .join(', ');
    const coverage = median(row.coverage);
    lines.push(
      `${pad(name, 20)}${left(row.count, 5)}${left(`${((100 * row.count) / total).toFixed(2)}%`, 8)}` +
        `${left(coverage === null ? '-' : `${(100 * coverage).toFixed(1)}%`, 9)}  ${routes}`,
    );
  }
  lines.push('');
  lines.push('ceiling against the population each class lives in, and that population\'s floor');
  lines.push(
    `${pad('class', 20)}${pad('route', 18)}${left('class n', 8)}${left('route n', 8)}` +
      `${left('ceiling', 9)}${left('floor', 8)}  detectable`,
  );
  for (const [name, row] of [...byClass.entries()].sort((a, b) => b[1].count - a[1].count)) {
    for (const [route, count] of row.routes) {
      const population = byRoute.get(route);
      const p = population.correct / population.n;
      const ceiling = (100 * count) / population.n;
      const floor = resolutionFloor(population.n, p);
      lines.push(
        `${pad(name, 20)}${pad(route, 18)}${left(count, 8)}${left(population.n, 8)}` +
          `${left(`${ceiling.toFixed(2)}`, 9)}${left(floor.toFixed(2), 8)}  ${ceiling >= floor ? 'yes' : 'no'}`,
      );
    }
  }
  lines.push('');
  lines.push('the same classes against the whole suite, which is the population a bundled mechanism is read on');
  const correct = records.filter((record) => record.correct).length;
  const suiteFloor = resolutionFloor(total, correct / total);
  lines.push(
    `${pad('class', 20)}${left('n', 5)}${left('ceiling', 9)}${left('floor', 8)}  detectable`,
  );
  for (const [name, row] of [...byClass.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const ceiling = (100 * row.count) / total;
    lines.push(
      `${pad(name, 20)}${left(row.count, 5)}${left(ceiling.toFixed(2), 9)}` +
        `${left(suiteFloor.toFixed(2), 8)}  ${ceiling >= suiteFloor ? 'yes' : 'no'}`,
    );
  }
  lines.push('');
  lines.push(
    `suite floor at n=${total}: ${suiteFloor.toFixed(2)} points = ${Math.ceil((suiteFloor * total) / 100)} ` +
      'questions; a class below it is a class no dispatch can certify on its own',
  );
  lines.push('');
  lines.push('the three institutions, which is the unit a mechanism is dispatched against');
  lines.push(
    `${pad('institution', 14)}${pad('route', 18)}${left('n', 5)}${left('population', 11)}` +
      `${left('ceiling', 9)}${left('floor', 8)}  detectable`,
  );
  for (const [bundle, members] of Object.entries(BUNDLES)) {
    const perRoute = new Map();
    for (const name of members) {
      for (const [route, count] of byClass.get(name)?.routes ?? []) {
        perRoute.set(route, (perRoute.get(route) ?? 0) + count);
      }
    }
    const bundleTotal = [...perRoute.values()].reduce((sum, count) => sum + count, 0);
    const suiteCeiling = (100 * bundleTotal) / total;
    lines.push(
      `${pad(bundle, 14)}${pad('-- suite --', 18)}${left(bundleTotal, 5)}${left(total, 11)}` +
        `${left(suiteCeiling.toFixed(2), 9)}${left(suiteFloor.toFixed(2), 8)}  ` +
        `${suiteCeiling >= suiteFloor ? 'yes' : 'no'}`,
    );
    for (const [route, count] of [...perRoute.entries()].sort((a, b) => b[1] - a[1])) {
      const population = byRoute.get(route);
      const ceiling = (100 * count) / population.n;
      const floor = resolutionFloor(population.n, population.correct / population.n);
      lines.push(
        `${pad('', 14)}${pad(route, 18)}${left(count, 5)}${left(population.n, 11)}` +
          `${left(ceiling.toFixed(2), 9)}${left(floor.toFixed(2), 8)}  ${ceiling >= floor ? 'yes' : 'no'}`,
      );
    }
  }
  return lines;
}

function load(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed.questions)) {
    throw new Refusal(`${path} carries no \`questions\` array; this tool reads a merged artifact`);
  }
  return parsed.questions;
}

const FIXTURE = [
  {
    questionId: 'a',
    route: 'multi-session',
    correct: false,
    answer: '3',
    groundTruth: 'I attended four movie festivals.',
    goldOverlap: { carried: 21, total: 21, goldTurns: ['I went to four festivals.'] },
  },
  {
    questionId: 'b',
    route: 'knowledge-update',
    correct: false,
    answer: '$220',
    groundTruth: '$720',
    goldOverlap: { carried: 18, total: 24, goldTurns: ['The deposit was $720 in total.'] },
  },
  {
    questionId: 'c',
    route: 'flat',
    correct: false,
    answer: 'INSUFFICIENT_EVIDENCE',
    groundTruth: 'Dark Souls 3 DLC',
    goldOverlap: { carried: 5, total: 12, goldTurns: ['I finished every Dark Souls 3 DLC.'] },
  },
  {
    questionId: 'd',
    route: 'flat',
    correct: false,
    answer: '',
    groundTruth: 'Yes',
    goldOverlap: { carried: 9, total: 24, goldTurns: ['Yes, that worked.'] },
  },
  {
    questionId: 'e',
    route: 'temporal',
    correct: false,
    answer: 'The user would prefer a summary.',
    groundTruth: 'The user would prefer responses that take into account their interest in hiking.',
    goldOverlap: { carried: 3, total: 14, goldTurns: ['I like hiking on weekends.'] },
  },
  {
    questionId: 'f',
    route: 'multi-session',
    correct: true,
    answer: '4',
    groundTruth: 'I attended four movie festivals.',
    goldOverlap: { carried: 21, total: 21, goldTurns: ['I went to four festivals.'] },
  },
  {
    questionId: 'g',
    route: 'assistant',
    correct: false,
    answer: 'Transcriptionist',
    groundTruth: 'Sound engineer',
    goldOverlap: { carried: 2, total: 2, goldTurns: ['I work as a sound engineer.'] },
  },
];

function selfTest() {
  const cases = [
    ['number-misselected', FIXTURE[0], 'a digit answer against a spelled-out gold number'],
    ['number-misselected', FIXTURE[1], 'the operand was delivered and another one was used'],
    ['declined', FIXTURE[2], 'the token'],
    ['empty', FIXTURE[3], 'a blank reply'],
    ['preference', FIXTURE[4], 'a preference summary as the gold'],
    [null, FIXTURE[5], 'a correct answer is not a failure'],
    ['text-misselected', FIXTURE[6], 'the gold term is in the delivered turn'],
  ];
  for (const [expected, record, why] of cases) {
    const actual = classify(record);
    if (actual !== expected) {
      throw new Error(`self-test: ${why} -- expected ${expected}, read ${actual}`);
    }
  }

  // The absent half of the split, which the fixture above cannot reach: a gold number inside a sentence
  // that is nowhere in the delivered turns. Without this case the tool would pass every assertion while
  // `number-absent` was unreachable, which is the failure mode `resolution.ts` records for an unreachable
  // cut branch -- and the class that does reach it is the bare gold below, which is a different institution.
  const absent = classify({
    questionId: 'h',
    route: 'temporal',
    correct: false,
    answer: '27',
    groundTruth: 'The deposit was 38 dollars.',
    goldOverlap: { carried: 9, total: 24, goldTurns: ['I set the thermostat.'] },
  });
  if (absent !== 'number-absent') {
    throw new Error(`self-test: an undelivered operand must read number-absent, read ${absent}`);
  }

  // And the class that this tool's first draft got wrong: a bare gold is a value to compute, so its absence
  // from the evidence is not a delivery reading at all. The fixture is a counting question with a full
  // delivery, which is the shape of all eight `MR` failures the first draft misfiled.
  const derived = classify({
    questionId: 'i',
    route: 'multi-session',
    correct: false,
    answer: '3',
    groundTruth: '4',
    goldOverlap: { carried: 21, total: 21, goldTurns: ['I went to a festival.', 'Another festival too.'] },
  });
  if (derived !== 'derived-number') {
    throw new Error(`self-test: a bare gold with a full delivery must read derived-number, read ${derived}`);
  }

  // And the refusals, each of which would otherwise produce a class rather than an error.
  const refusals = [
    [{ ...FIXTURE[0], correct: 'false' }, 'a non-boolean correct'],
    [{ ...FIXTURE[0], route: 'session' }, 'an unknown route'],
    [{ ...FIXTURE[0], goldOverlap: { carried: 1, total: 1 } }, 'no goldTurns'],
  ];
  for (const [record, why] of refusals) {
    let threw = false;
    try {
      classify(record);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      threw = true;
    }
    if (!threw) throw new Error(`self-test: ${why} must be refused`);
  }

  // The floor is the arithmetic the table's last column turns on, so it is asserted at a known value
  // rather than only for being finite: 121 questions at 84% is the `MR` row of the resolution-wall note,
  // which prints 9.37. The tolerance is a tenth of a point, so a formula changed to the *paired* floor
  // (which divides by `pi` rather than `p(1-p)`) or to a standard error without the 2.8016 factor fails here
  // rather than printing a plausible number in a table nobody re-derives.
  const floor = resolutionFloor(121, 0.84);
  if (Math.abs(floor - 9.37) > 0.1) {
    throw new Error(`self-test: floor at MR's denominator must read 9.37, read ${floor.toFixed(2)}`);
  }

  // And the report must actually print a class per line: a census that classifies correctly and prints
  // nothing is the shape `room-census.mjs` was written against.
  const lines = report(FIXTURE);
  for (const name of ['empty', 'declined', 'preference', 'number-misselected', 'text-misselected']) {
    if (!lines.some((line) => line.startsWith(name))) {
      throw new Error(`self-test: the report printed no ${name} row`);
    }
  }
  // And the institution table must print every bundle, because a bundle nobody prints is a bundle nobody
  // prices -- the defect that made three 8-question faults look like three mechanisms instead of one.
  for (const bundle of Object.keys(BUNDLES)) {
    if (!lines.some((line) => line.startsWith(bundle))) {
      throw new Error(`self-test: the report printed no ${bundle} bundle`);
    }
  }
  console.log('self-test: 7 classifications, 1 absent operand, 1 derived value, 3 refusals, 1 floor, 5 report rows');
}

function main(argv) {
  if (argv.includes('--self-test')) {
    selfTest();
    return;
  }
  const files = argv.filter((argument) => !argument.startsWith('--'));
  if (files.length === 0) {
    console.error('usage: node tools/failure-classes.mjs <report.json> [--json] [--self-test]');
    process.exitCode = 2;
    return;
  }
  const records = files.flatMap(load);
  if (argv.includes('--json')) {
    const { byRoute, byClass } = census(records);
    console.log(
      JSON.stringify(
        {
          questions: records.length,
          routes: Object.fromEntries(byRoute),
          classes: Object.fromEntries(
            [...byClass.entries()].map(([name, row]) => [
              name,
              { count: row.count, routes: Object.fromEntries(row.routes), coverage: median(row.coverage) },
            ]),
          ),
        },
        null,
        2,
      ),
    );
    return;
  }
  for (const line of report(records)) console.log(line);
}

if (process.argv[1] && process.argv[1].endsWith('failure-classes.mjs')) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof Refusal) {
      console.error(`REFUSED: ${error.message}`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
