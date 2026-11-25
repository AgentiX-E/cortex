#!/usr/bin/env node
/**
 * What moved between two artifacts, question by question, and which predicate explains it.
 *
 * ## Why a paired census and not two accuracies
 *
 * The reader-axis reading on record (`40698867439` against `40698883428`) was reported as **417 to 381**, and
 * the sentence attached to it in the tracking report attributed the whole loss to one population: bare abstention
 * replies on questions whose gold is an answer. A difference of two aggregates cannot support that sentence, and
 * the per-question records can. This tool reads both artifacts, pairs them by `questionId`, and prints the only
 * table that can support or refuse an attribution:
 *
 *   - the 2x2 per capability -- lost, gained, both, neither -- so a net of -36 cannot hide a +22 that came from
 *     somewhere else;
 *   - the reply shape of every lost and every gained question, through the product's own classifier, so a
 *     "declines" claim is counted rather than asserted;
 *   - and, on request, the separation of one named predicate over both sides, so a hypothesis about *why* is a
 *     number with a false-positive count instead of a paragraph that survives because nobody tested it.
 *
 * ## What it refuses
 *
 * A pair whose populations differ is not a pair. Two artifacts that disagree about `questionCount`, about
 * `dataset`, or about the set of question ids are refused rather than intersected: an intersection is the
 * quantity that makes "500 questions" and "492 questions" print the same table, and this repository has retracted
 * that shape more than once.
 *
 * ## Why the classifier is imported rather than re-implemented
 *
 * `classifyReply` is the product's own reading of a reply. A copy here would be a second scorer, and the first
 * time the two disagree the tool would be describing its own vocabulary instead of the product's -- the defect
 * `tools/reply-shape-census.mjs` states for itself and `tools/efficiency-frontier.mjs` for every instrument in
 * this directory.
 *
 * Usage:
 *   node tools/paired-delta-census.mjs <control.json> <treatment.json> [--discriminant heading-instantiation] [--json]
 *   node tools/paired-delta-census.mjs --self-test
 */

import { readFileSync } from 'node:fs';
import { classifyReply } from '../packages/cortex-memory/dist/reply-repair.js';

/** The capability order every table in this repository prints in. */
const CAPABILITIES = ['IE', 'MR', 'KU', 'TR', 'ABS'];

/**
 * The reply kinds a lost or gained question is split into.
 *
 * `declined` collapses the two refusal states because the claim being tested is about declines as a population;
 * the four others keep the product's own names so a reader can look one up in `reply-repair.ts`.
 */
const SHAPES = ['declined', 'committed', 'evidence-echo', 'shape-failed'];

function pad(value, width) {
  return String(value).padStart(width);
}

function shapeOf(raw) {
  const kind = classifyReply(raw ?? null);
  return kind === 'bare-decline' || kind === 'prose-decline' ? 'declined' : kind;
}

/**
 * The content terms of a string, by the same stoplist rule the discriminants use.
 *
 * Deliberately crude and deliberately local: a discriminant is a hypothesis about a *rendering*, and the one
 * property every hypothesis here shares is that it must be decidable from the record without a model call. A
 * richer tokenizer would make the predicate harder to state and no easier to falsify.
 */
const STOPWORDS = new Set(
  (
    'a an the of in on at to for and or is are was were be been being i me my we our you your it its this that ' +
    'these those with without from by as what which who whom whose when where why how did do does have has had ' +
    'not no yes if then than so such can could should would will may might must about into over under more most ' +
    'less least all any each every other some own same very just also there their them they he she his her him ' +
    'mention mentions mentioned evidence question answer'
  ).split(' '),
);

function askedTerms(text) {
  const words = String(text).toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [];
  return new Set(words.filter((word) => word.length > 1 && !STOPWORDS.has(word)));
}

const STEP_HEADING = /^\s*(?:\*\*)?step\s*\d+\b/i;

/**
 * Whether a reply carries a step heading that says nothing about the question it was asked.
 *
 * The hypothesis, stated so it can fail: a two-step contract asks the reader to write `Step 1 -- ...`, and a
 * reader that copies the contract's own generic wording writes a heading whose content terms are disjoint from
 * the question's. A reader that instantiates the contract paraphrases the question into the heading, and the two
 * sets intersect. If the predicate separates lost from kept questions it is a mechanism; if it does not, the
 * numbers below say so and the hypothesis is refused rather than softened.
 */
function uninstantiatedHeading(question, raw) {
  if (typeof raw !== 'string') return false;
  const asked = askedTerms(question);
  if (asked.size === 0) return false;
  for (const line of raw.split('\n')) {
    if (!STEP_HEADING.test(line)) continue;
    const heading = askedTerms(line);
    let shared = false;
    for (const term of heading) {
      if (asked.has(term)) {
        shared = true;
        break;
      }
    }
    if (!shared) return true;
  }
  return false;
}

const DISCRIMINANTS = { 'heading-instantiation': uninstantiatedHeading };

function index(report, label) {
  const records = Array.isArray(report.questions) ? report.questions : [];
  const byId = new Map();
  for (const record of records) byId.set(record.questionId, record);
  return { label, report, records, byId };
}

/**
 * A refusal is an exception rather than an exit, so the self-test can assert the refusal.
 *
 * The first draft called `process.exit` here, and the test that followed could only assert that no exception was
 * thrown -- which is the shape of a check that passes because it cannot fail. The self-test now catches it and
 * compares the message, so the population rule is exercised on the same path a real pair takes.
 */
class Refusal extends Error {}

function pair(control, treatment) {
  if (control.report.dataset !== treatment.report.dataset) {
    throw new Refusal(`dataset differs: ${control.report.dataset} against ${treatment.report.dataset}`);
  }
  if (control.records.length !== treatment.records.length) {
    throw new Refusal(
      `questionCount differs: ${control.records.length} against ${treatment.records.length}; an intersection ` +
        'would print a table neither artifact produced',
    );
  }
  const ids = [...control.byId.keys()].filter((id) => treatment.byId.has(id));
  if (ids.length !== control.records.length) {
    throw new Refusal(`${control.records.length - ids.length} control question(s) are absent from the treatment artifact`);
  }
  return ids.sort();
}

/** The 2x2, per capability and in total. */
function census(control, treatment, ids) {
  const rows = new Map(CAPABILITIES.map((capability) => [capability, { n: 0, lost: 0, gained: 0, both: 0, neither: 0 }]));
  const lost = [];
  const gained = [];
  for (const id of ids) {
    const left = control.byId.get(id);
    const right = treatment.byId.get(id);
    const row = rows.get(left.capability) ?? rows.set(left.capability, { n: 0, lost: 0, gained: 0, both: 0, neither: 0 }).get(left.capability);
    row.n += 1;
    const a = left.correct === true;
    const b = right.correct === true;
    if (a && b) row.both += 1;
    else if (a) {
      row.lost += 1;
      lost.push(id);
    } else if (b) {
      row.gained += 1;
      gained.push(id);
    } else row.neither += 1;
  }
  return { rows, lost, gained };
}

function shapeSplit(treatment, ids) {
  const counts = new Map(SHAPES.map((shape) => [shape, 0]));
  for (const id of ids) {
    const shape = shapeOf(treatment.byId.get(id)?.rawOutput);
    counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }
  return counts;
}

function discriminantSplit(name, other, side, ids) {
  const predicate = DISCRIMINANTS[name];
  const groups = new Map([
    [true, { matched: 0, correct: 0, lost: 0 }],
    [false, { matched: 0, correct: 0, lost: 0 }],
  ]);
  for (const id of ids) {
    const record = side.byId.get(id);
    const hit = predicate(record.question, record.rawOutput);
    const group = groups.get(hit);
    group.matched += 1;
    if (record.correct === true) group.correct += 1;
    if (other.byId.get(id).correct === true && record.correct !== true) group.lost += 1;
  }
  return groups;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 'n/a' : `${((100 * numerator) / denominator).toFixed(1)}%`;
}

function render(control, treatment, ids, censusResult, options) {
  const lines = [];
  lines.push(`control   ${control.label}  (${control.records.length} questions)`);
  lines.push(`treatment ${treatment.label}  (${treatment.records.length} questions)`);
  lines.push(`paired    ${ids.length}`);
  lines.push('');
  lines.push('| capability |    n | lost | gained | both | neither | net |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  let total = { n: 0, lost: 0, gained: 0, both: 0, neither: 0 };
  for (const [capability, row] of censusResult.rows) {
    if (row.n === 0) continue;
    lines.push(
      `| ${capability} | ${pad(row.n, 3)} | ${pad(row.lost, 4)} | ${pad(row.gained, 6)} | ${pad(row.both, 4)} | ` +
        `${pad(row.neither, 7)} | ${pad(row.gained - row.lost, 3)} |`,
    );
    total = {
      n: total.n + row.n,
      lost: total.lost + row.lost,
      gained: total.gained + row.gained,
      both: total.both + row.both,
      neither: total.neither + row.neither,
    };
  }
  lines.push(
    `| **all** | ${pad(total.n, 3)} | ${pad(total.lost, 4)} | ${pad(total.gained, 6)} | ${pad(total.both, 4)} | ` +
      `${pad(total.neither, 7)} | ${pad(total.gained - total.lost, 3)} |`,
  );
  lines.push('');
  lines.push('| reply shape (treatment) | lost | gained |');
  lines.push('| --- | ---: | ---: |');
  const lostShapes = shapeSplit(treatment, censusResult.lost);
  const gainedShapes = shapeSplit(treatment, censusResult.gained);
  for (const shape of SHAPES) {
    lines.push(`| ${shape} | ${pad(lostShapes.get(shape) ?? 0, 4)} | ${pad(gainedShapes.get(shape) ?? 0, 6)} |`);
  }
  if (options.discriminant !== undefined) {
    const groups = discriminantSplit(options.discriminant, control, treatment, ids);
    lines.push('');
    lines.push(`discriminant: ${options.discriminant}`);
    lines.push('| group | matched | correct (treatment) | accuracy | lost |');
    lines.push('| --- | ---: | ---: | ---: | ---: |');
    for (const [name, key] of [
      ['predicate true', true],
      ['predicate false', false],
    ]) {
      const group = groups.get(key);
      lines.push(
        `| ${name} | ${group.matched} | ${group.correct} | ${ratio(group.correct, group.matched)} | ${group.lost} |`,
      );
    }
  }
  return lines.join('\n');
}

function load(path, label) {
  return index(JSON.parse(readFileSync(path, 'utf8')), label);
}

function main(argv) {
  if (argv.includes('--self-test')) {
    selfTest();
    return 0;
  }
  const positional = [];
  let discriminant;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--discriminant') {
      discriminant = argv[(index += 1)];
      continue;
    }
    if (argument.startsWith('--')) continue;
    positional.push(argument);
  }
  if (discriminant !== undefined && DISCRIMINANTS[discriminant] === undefined) {
    process.stderr.write(`refused: unknown discriminant ${JSON.stringify(discriminant)}\n`);
    return 1;
  }
  if (positional.length !== 2) {
    process.stderr.write('usage: paired-delta-census.mjs <control.json> <treatment.json> [--discriminant <name>] [--json]\n');
    return 1;
  }
  const control = load(positional[0], 'control');
  const treatment = load(positional[1], 'treatment');
  let ids;
  try {
    ids = pair(control, treatment);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    process.stderr.write(`refused: ${error.message}\n`);
    return 1;
  }
  const counted = census(control, treatment, ids);
  if (argv.includes('--json')) {
    const payload = {
      paired: ids.length,
      lost: counted.lost,
      gained: counted.gained,
      byCapability: Object.fromEntries(counted.rows),
      lostShapes: Object.fromEntries(shapeSplit(treatment, counted.lost)),
      gainedShapes: Object.fromEntries(shapeSplit(treatment, counted.gained)),
      ...(discriminant === undefined
        ? {}
        : {
            discriminant: {
              name: discriminant,
              treatment: Object.fromEntries(
                [...discriminantSplit(discriminant, control, treatment, ids)].map(([key, value]) => [String(key), value]),
              ),
              control: Object.fromEntries(
                [...discriminantSplit(discriminant, treatment, control, ids)].map(([key, value]) => [String(key), value]),
              ),
            },
          }),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 1)}\n`);
    return 0;
  }
  process.stdout.write(`${render(control, treatment, ids, counted, { discriminant })}\n`);
  return 0;
}

/**
 * The self-test builds the pair rather than reading one.
 *
 * A tool whose only exercise is a real artifact cannot be run on a machine without that artifact, and the three
 * properties below are the ones a real artifact is worst at proving: a net of zero that hides a symmetric
 * movement, a refusal on a mismatched population, and a shape split that must not be inferred from the net.
 */
function selfTest() {
  const record = (id, capability, correct, rawOutput, question = 'how many items did I buy') => ({
    questionId: id,
    capability,
    correct,
    rawOutput,
    question,
  });
  const control = index(
    {
      dataset: 'fixture',
      questionCount: 7,
      questions: [
        record('q1', 'MR', true, 'Step 1 - list every item matching what I bought\n- one\n\n4'),
        record('q2', 'MR', false, 'INSUFFICIENT_EVIDENCE'),
        record('q3', 'TR', true, '2023/05/20'),
        record('q4', 'ABS', true, 'INSUFFICIENT_EVIDENCE'),
        record('q5', 'KU', true, '4'),
        record('q6', 'IE', false, 'I am not sure'),
        record('q7', 'IE', false, 'unclear'),
      ],
    },
    'control',
  );
  const treatment = index(
    {
      dataset: 'fixture',
      questionCount: 7,
      questions: [
        record('q1', 'MR', false, 'INSUFFICIENT_EVIDENCE'),
        record('q2', 'MR', true, '4'),
        record('q3', 'TR', true, '2023/05/20'),
        record('q4', 'ABS', true, 'INSUFFICIENT_EVIDENCE'),
        record('q5', 'KU', false, 'Step 1 - list every item in the evidence that matches the question'),
        record('q6', 'IE', false, 'I am not sure'),
        record('q7', 'IE', true, '4'),
      ],
    },
    'treatment',
  );
  const ids = pair(control, treatment);
  assertEqual(ids.length, 7, 'pairing keeps every shared id');
  const counted = census(control, treatment, ids);
  assertEqual(counted.rows.get('MR').lost, 1, 'MR loses one');
  assertEqual(counted.rows.get('MR').gained, 1, 'MR gains one');
  assertEqual(counted.rows.get('ABS').lost, 0, 'ABS loses none');
  assertEqual(counted.gained.length - counted.lost.length, 0, 'the net is zero and the movement is not');
  assertEqual(counted.gained.length, 2, 'two questions moved up');
  const lostShapes = shapeSplit(treatment, counted.lost);
  assertEqual(lostShapes.get('declined'), 1, 'one loss is a decline');
  assertEqual(lostShapes.get('committed'), 1, 'the other loss is a well-formed reply that answers the wrong thing');
  assertEqual(lostShapes.get('shape-failed'), 0, 'and neither loss is a contract violation');
  assertEqual(
    uninstantiatedHeading('how many items did I buy', treatment.byId.get('q5').rawOutput),
    true,
    'generic heading is uninstantiated',
  );
  assertEqual(
    uninstantiatedHeading('how many items did I buy', treatment.byId.get('q1').rawOutput),
    false,
    'instantiated heading is not',
  );
  const groups = discriminantSplit('heading-instantiation', control, treatment, ids);
  assertEqual(groups.get(true).matched, 1, 'the discriminant selects one treatment record');
  assertEqual(groups.get(true).correct, 0, 'and that record is wrong');
  assertEqual(groups.get(false).matched, 6, 'every other record is in the negative group');

  let refusal = null;
  try {
    pair(control, index({ dataset: 'fixture', questionCount: 3, questions: treatment.records.slice(0, 3) }, 'short'));
  } catch (error) {
    refusal = error;
  }
  assertEqual(refusal instanceof Refusal, true, 'a population mismatch is refused');
  assertEqual(/questionCount differs/.test(refusal.message), true, 'and the refusal names the population');

  let datasetRefusal = null;
  try {
    pair(control, index({ dataset: 'other', questionCount: 7, questions: treatment.records }, 'other'));
  } catch (error) {
    datasetRefusal = error;
  }
  assertEqual(datasetRefusal instanceof Refusal, true, 'a dataset mismatch is refused');

  process.stdout.write('paired-delta-census: self-test ok\n');
}

function assertEqual(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('paired-delta-census.mjs')) {
  process.exit(main(process.argv.slice(2)));
}

export { census, discriminantSplit, pair, shapeSplit, uninstantiatedHeading };
