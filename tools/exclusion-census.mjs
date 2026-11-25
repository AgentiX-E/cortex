#!/usr/bin/env node
/**
 * What a reply says when it leaves an item out, and whether that reason is right.
 *
 *     node tools/exclusion-census.mjs <report.json> [...more] [--capability MR] [--json]
 *     node tools/exclusion-census.mjs --self-test
 *
 * ## Why the population is the exclusions and not the failures
 *
 * `reply-shape-census.mjs` asks what a reply *looks like* (committed, declined, echo, shape-failed).
 * This asks what it *decided*, because §13.292 found the decision carrying `MR`'s remaining error: on the
 * adopted arm's merged artifact (`45543010618`, 500 of 500, two repetitions) the route reads 108 of 121
 * and **ten of the thirteen failures carry every gold turn**, so the reader had the answer in the window
 * and chose not to count it. A shape census cannot see a choice; a screen census can, because a reply that
 * drops an item writes the reason down.
 *
 * The headline split is the one that decides whether the mechanism is worth a dispatch:
 *
 * | replies | correct | accuracy |
 * | --- | ---: | ---: |
 * | exclude **nothing** | 47 of 49 | **95.9%** |
 * | exclude something | 61 of 72 | **84.7%** |
 *
 * An eleven-point gap on a 49/72 split, with eight of the thirteen failures inside the second row. What it
 * does **not** say is that excluding is wrong: 72 replies exclude and 61 of them are right, which is why
 * the buckets below exist — the question is *which* licence the wrong ones used.
 *
 * ## The buckets, and why they are not a classifier
 *
 * Each `excluded` line is matched against the reason vocabularies the replies actually use. A line can land
 * in more than one bucket and that is correct rather than sloppy: *"excluded from the last-month window:
 * described as received last month"* is one decision citing a period and a wording. The buckets are a
 * **diagnostic**, not a gate — nothing dispatches on their output — and the four that matter are stated in
 * §13.292's registration with the three hand-read replies each of them cites.
 *
 * ## Why `correct` is read from the record
 *
 * The record's own verdict is the judge's, which is the same verdict the report's accuracy is built from.
 * Recomputing it here would make this tool a second scorer, the defect every instrument in this directory
 * states for the others.
 */

import { readFileSync } from 'node:fs';

/** The reason vocabularies, as the replies write them. Order is the order of the printed table. */
const BUCKETS = [
  [
    'period',
    /\b(month|months|week|weeks|year|years|date|dates|window|last|prior|earlier|before|after|outside|within|during|january|february|march|april|may|june|july|august|september|october|november|december|\d{4}\/\d{2})\b/,
  ],
  ['verb', /\b(verb|action|wording|described as|says|saying|phrasing|not "[a-z])/],
  ['category', /\b(not furniture|not a purchase|decor|category|unrelated|different kind|not the kind)\b/],
  ['planning', /\b(plan|planned|planning|future|consider|considering|explor|recommend|intend|thinking about)\b/],
  ['absence', /\b(no (mention|evidence|cost|separate|reference)|does not|doesn't|not stated|nothing|never|absent|missing)\b/],
  ['duplicate', /\b(duplicate|counted once|same event|already (counted|included)|overlaps)\b/],
];

const EXCLUSION = /exclud/i;

function pad(value, width) {
  return String(value).padStart(width);
}

function fixed(value, width) {
  return String(value.toFixed(1)).padStart(width);
}

/** Every `excluded` line of one reply, in the order the reply wrote them. */
function exclusionLines(raw) {
  if (typeof raw !== 'string') return [];
  return raw.split('\n').filter((line) => EXCLUSION.test(line));
}

/** The buckets one reply's exclusion lines fall into, deduplicated across lines. */
function reasons(lines) {
  const hit = new Set();
  for (const line of lines) {
    const lower = line.toLowerCase();
    for (const [name, pattern] of BUCKETS) if (pattern.test(lower)) hit.add(name);
  }
  return hit;
}

/**
 * The census of one report.
 *
 * `questions` is the artifact's per-question vector. A report without one is refused rather than read as
 * an empty population: a table of zeros would print as a finding.
 */
function censusOf(report, capability) {
  const records = Array.isArray(report?.questions) ? report.questions : [];
  if (records.length === 0) throw new Error('the report carries no questions, so there is nothing to census');
  const population = capability === undefined ? records : records.filter((r) => r.capability === capability);
  if (population.length === 0) throw new Error(`no question in the report carries capability ${capability}`);

  const buckets = new Map(BUCKETS.map(([name]) => [name, { replies: 0, correct: 0, lines: 0 }]));
  const silent = { replies: 0, correct: 0 };
  const speaking = { replies: 0, correct: 0 };
  for (const record of population) {
    const lines = exclusionLines(record.rawOutput);
    const correct = record.correct === true;
    if (lines.length === 0) {
      silent.replies += 1;
      if (correct) silent.correct += 1;
      continue;
    }
    speaking.replies += 1;
    if (correct) speaking.correct += 1;
    for (const name of reasons(lines)) {
      const row = buckets.get(name);
      row.replies += 1;
      if (correct) row.correct += 1;
    }
    // Lines rather than replies, because one reply can cite a reason six times and the count is what a
    // reader uses to check the bucket against the reply it quotes.
    for (const line of lines) {
      const lower = line.toLowerCase();
      for (const [name, pattern] of BUCKETS) if (pattern.test(lower)) buckets.get(name).lines += 1;
    }
  }

  const failures = population.filter((r) => r.correct !== true);
  const failureReasons = new Map(BUCKETS.map(([name]) => [name, 0]));
  for (const record of failures) {
    for (const name of reasons(exclusionLines(record.rawOutput))) {
      failureReasons.set(name, failureReasons.get(name) + 1);
    }
  }

  return { population, silent, speaking, buckets, failures, failureReasons };
}

function print(report, capability) {
  const result = censusOf(report, capability);
  const { population, silent, speaking, buckets, failures, failureReasons } = result;
  const name = capability === undefined ? 'all capabilities' : capability;
  const total = population.length;
  const correct = population.filter((r) => r.correct === true).length;
  const out = [
    `${name}  ${total} questions, ${correct} correct (${((100 * correct) / total).toFixed(1)}%), ${failures.length} wrong`,
    '',
    `  ${'reply'.padEnd(26)}${pad('replies', 8)}${pad('correct', 9)}${pad('acc', 7)}`,
    `  ${'excludes nothing'.padEnd(26)}${pad(silent.replies, 8)}${pad(silent.correct, 9)}${fixed((100 * silent.correct) / Math.max(silent.replies, 1), 6)}%`,
    `  ${'excludes something'.padEnd(26)}${pad(speaking.replies, 8)}${pad(speaking.correct, 9)}${fixed((100 * speaking.correct) / Math.max(speaking.replies, 1), 6)}%`,
    '',
    `  ${'reason it cites'.padEnd(26)}${pad('replies', 8)}${pad('correct', 9)}${pad('acc', 7)}${pad('lines', 7)}${pad('in wrong', 9)}`,
  ];
  for (const [key, row] of buckets) {
    if (row.replies === 0) continue;
    out.push(
      `  ${key.padEnd(26)}${pad(row.replies, 8)}${pad(row.correct, 9)}${fixed((100 * row.correct) / row.replies, 6)}%${pad(row.lines, 7)}${pad(failureReasons.get(key), 9)}`,
    );
  }
  return out.join('\n');
}

function assertEqual(actual, expected, what) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, read ${JSON.stringify(actual)}`);
  }
}

/** A constructed population, so every number below is arithmetic rather than a fixture's accident. */
function selfTest() {
  const report = {
    questions: [
      { questionId: 'q1', capability: 'MR', correct: false, rawOutput: '- plant | acquired | 2023/05/25\nexcluded: received last month, which is the prior calendar month' },
      { questionId: 'q2', capability: 'MR', correct: true, rawOutput: '- plant | acquired | 2023/05/20\n- fern | acquired | 2023/05/21' },
      { questionId: 'q3', capability: 'IE', correct: true, rawOutput: 'excluded: the verb differs, and the act is missing' },
      { questionId: 'q4', capability: 'MR', correct: true, rawOutput: 'excluded: duplicate of the same event, counted once' },
    ],
  };
  const result = censusOf(report, 'MR');
  assertEqual(result.population.length, 3, 'the capability filter keeps its own population');
  assertEqual(result.silent, { replies: 1, correct: 1 }, 'q2 excludes nothing and is right');
  assertEqual(result.speaking, { replies: 2, correct: 1 }, 'q1 and q4 exclude and split');
  assertEqual(result.buckets.get('period').replies, 1, 'q1 cites a period');
  assertEqual(result.buckets.get('duplicate').replies, 1, 'q4 cites a duplicate');
  assertEqual(result.buckets.get('period').lines, 1, 'one line, one period bucket');
  assertEqual(result.failures.length, 1, 'one failure in this population');
  assertEqual(result.failureReasons.get('period'), 1, 'and it cites a period');
  // A line can cite two vocabularies, which is the design rather than a defect: this reply names a verb
  // *and* an absence, and a census that forced one bucket would hide whichever it dropped.
  const both = censusOf({ questions: [report.questions[2]] }, undefined);
  assertEqual(both.buckets.get('verb').replies, 1, 'verb bucket');
  assertEqual(both.buckets.get('absence').replies, 1, 'absence bucket on the same line');
  // Refusals, because a table of zeros prints as a finding.
  let refused = 0;
  try {
    censusOf({ questions: [] }, undefined);
  } catch {
    refused += 1;
  }
  try {
    censusOf(report, 'KU');
  } catch {
    refused += 1;
  }
  assertEqual(refused, 2, 'an empty population and an absent capability are both refused');
  process.stdout.write(`exclusion-census self-test: 11 assertions over a constructed population\n`);
}

function load(path) {
  const text = readFileSync(path, 'utf8');
  const document = JSON.parse(text);
  // A merged artifact wraps the per-question vector the same way a shard does, so one reader serves both.
  if (!Array.isArray(document.questions)) {
    throw new Error(`${path} carries no questions array, so it is not an artifact this tool reads`);
  }
  return document;
}

function main(argv) {
  if (argv.includes('--self-test')) {
    selfTest();
    return 0;
  }
  const capabilityIndex = argv.indexOf('--capability');
  const capability = capabilityIndex === -1 ? undefined : argv[capabilityIndex + 1];
  if (capabilityIndex !== -1 && capability === undefined) {
    process.stderr.write('refused: --capability needs a value\n');
    return 1;
  }
  const asJson = argv.includes('--json');
  const paths = argv.filter(
    (argument, index) =>
      !argument.startsWith('--') && (capabilityIndex === -1 || index !== capabilityIndex + 1),
  );
  if (paths.length === 0) {
    process.stderr.write('usage: exclusion-census.mjs <report.json> [...more] [--capability MR] [--json]\n');
    return 1;
  }
  // Several shards of one dispatch are one population, so the questions are concatenated rather than
  // printed as separate tables: a per-shard accuracy is a number about a shard.
  const merged = { questions: paths.flatMap((path) => load(path).questions) };
  if (asJson) {
    const result = censusOf(merged, capability);
    const rows = {};
    for (const [name, row] of result.buckets) rows[name] = { ...row, wrong: result.failureReasons.get(name) };
    process.stdout.write(
      `${JSON.stringify(
        {
          capability: capability ?? 'all',
          questions: result.population.length,
          correct: result.population.filter((r) => r.correct === true).length,
          wrong: result.failures.length,
          excludesNothing: result.silent,
          excludesSomething: result.speaking,
          buckets: rows,
        },
        null,
        1,
      )}\n`,
    );
    return 0;
  }
  process.stdout.write(`${print(merged, capability)}\n`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
