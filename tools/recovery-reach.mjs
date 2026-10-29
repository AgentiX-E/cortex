#!/usr/bin/env node
/**
 * Read the abstention-recovery pass's own population, and its transitions, from two artifacts.
 *
 * ## Why this is not `ledger.mjs --treated capability=MR`
 *
 * `ledger.mjs` splits a roster by a **record field**, which is right for a treatment whose reach is a
 * field of the record. This pass's reach is a **predicate over a reply**: a decline whose own Step 1
 * list is non-empty (`declinedItems`). §13.128.1 counted that population with the product's own
 * function rather than with a script written for the paragraph, and a reading tool has to do the same
 * or the population it reads is a second definition of the one the registration made.
 *
 * ## Why the population is read from the CONTROL and never from the treatment
 *
 * The record keeps the **last** thing the reader said (`memory.ts`, the recovery branch). For a question
 * the pass consults and loses, that is the retry's own reply -- and the retry's prompt carries no list,
 * so the question stops looking reachable. Measured on `40751394094` against `40883121464`: the control
 * has 10 MR declines carrying a list, the treatment has **0**, while the treatment's own census says it
 * consulted 33 times across four runs. A tool that computed the population from the treatment would
 * report an empty reach on a pass that fired, which is the §13.141.1 shape one layer down: a reading
 * that looks like "the mechanism did nothing" when the mechanism's own trace was overwritten.
 *
 * So the population is the control's, by question id, and the transitions are read against it. That is
 * also the only definition available for the artifacts written before `recoveryAttempted` existed
 * (§13.146) -- and it stays the right one afterwards, because it is the population the *registration*
 * counted.
 *
 * ## What it refuses, and why each refusal is a reading that would otherwise print
 *
 * - A treatment whose `recovery.attempted` is 0 while the population is non-empty: the run did not
 *   administer its treatment, and its 0 conversions are an assembly failure rather than a measurement
 *   (§13.141.1's own criterion).
 * - A population question missing from the treatment: unpaired, so its "no change" would be fabricated.
 * - A record without `answer` (as opposed to `answer: null`): absent is not a decline, the §13.107 rule
 *   `ledger.mjs` states for its own counters.
 *
 * ## Usage
 *
 *     node tools/recovery-reach.mjs --control <control.json> --treatment <treatment.json> [--json]
 *
 * Exit 2 is malformed input, exit 1 is an artifact that cannot support the reading, exit 0 is a reading.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

import { declinedItems, asksForCount } from '../packages/cortex-memory/dist/index.js';
import { evidenceRouteOf } from '../packages/cortex-eval/dist/index.js';

/** The route the pass is wired into. Every other route is unreachable by construction (§13.141.1). */
const TREATMENT_ROUTE = 'multi-session';

/**
 * The reader's own churn floor: two arms whose prompts are byte-identical changed 19 of 379 verdicts
 * (§13.127.2). A gross flow above this share of its denominator is a change the reader could have made
 * on its own, and below it is inside noise.
 */
const READER_FLOOR = 0.05;

/**
 * The registered conversion bar, from §13.141.5 claim 1 (which had already been scaled down from
 * §13.128.3's "5 of the 16" when §13.141.2 removed the six unreachable questions).
 */
const REGISTERED_CONVERSIONS = 4;

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');

function takeOption(name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name) {
      const value = argv[index + 1];
      if (value === undefined) {
        process.stderr.write(`${name} needs a value\n`);
        process.exit(2);
      }
      values.push(value);
    } else if (argv[index].startsWith(`${name}=`)) {
      values.push(argv[index].slice(name.length + 1));
    }
  }
  return values;
}

const controls = takeOption('--control');
const treatments = takeOption('--treatment');

if (controls.length !== 1 || treatments.length !== 1) {
  process.stderr.write(
    'usage: node tools/recovery-reach.mjs --control <control.json> --treatment <treatment.json> [--json]\n' +
      '       The population is read from the control and the transitions from the treatment; one of each.\n',
  );
  process.exit(2);
}

if (controls[0] === treatments[0]) {
  process.stderr.write(
    'the control and the treatment are the same file, so every transition would be "unchanged" by construction\n',
  );
  process.exit(2);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

/** One artifact's records, validated on the fields this reading divides by. */
function loadReport(path, role) {
  let body;
  try {
    body = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${role}: ${path} is not readable JSON (${error.message})`);
  }
  const questions = body?.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    fail(`${role}: ${path} carries no questions array, so it is not a memory-arm report`);
  }
  const byId = new Map();
  for (const record of questions) {
    const { questionId, capability, correct, answer, rawOutput } = record ?? {};
    if (typeof questionId !== 'string' || questionId === '') {
      fail(`${role}: a record has no questionId, so nothing can be paired`);
    }
    if (typeof capability !== 'string' || capability === '') {
      fail(`${role}: ${questionId} has no capability`);
    }
    if (typeof correct !== 'boolean') {
      // `null` is not `false` here: an artifact that did not grade a question cannot contribute a
      // transition, and reading its absence as a wrong answer would buy a question for free.
      fail(`${role}: ${questionId} carries correct=${JSON.stringify(correct)}, which is not a boolean`);
    }
    if (answer === undefined) {
      fail(`${role}: ${questionId} carries no answer field, and an absent field is not a decline`);
    }
    if (rawOutput !== null && typeof rawOutput !== 'string') {
      fail(`${role}: ${questionId} carries rawOutput=${typeof rawOutput}, not text or null`);
    }
    if (byId.has(questionId)) {
      fail(`${role}: ${questionId} appears twice, so its population membership is ambiguous`);
    }
    byId.set(questionId, record);
  }
  return { path, byId, body };
}

const control = loadReport(controls[0], 'control');
const treatment = loadReport(treatments[0], 'treatment');

/**
 * `runs` is how many repetitions the artifact aggregates. Absent is not one: a per-run rate divided by
 * the wrong count is a confident lie, so it is reported as unknown rather than assumed.
 */
function runsOf(report) {
  const runs = report.body?.runs;
  return Number.isInteger(runs) && runs > 0 ? runs : null;
}

const controlRuns = runsOf(control);
const treatmentRuns = runsOf(treatment);

// ---------------------------------------------------------------- the census, per capability

const capabilities = [...new Set([...control.byId.values()].map((record) => record.capability))].sort();

const census = capabilities.map((capability) => {
  const rows = [...control.byId.values()].filter((record) => record.capability === capability);
  const declines = rows.filter((record) => record.answer === null);
  const listed = declines
    .map((record) => ({ record, items: declinedItems(record.rawOutput ?? '') }))
    .filter((entry) => entry.items.length > 0);
  const counting = listed.filter((entry) => asksForCount(entry.record.question));
  const meanItems =
    listed.length === 0 ? 0 : listed.reduce((total, entry) => total + entry.items.length, 0) / listed.length;
  return {
    capability,
    route: evidenceRouteOf(capability),
    questions: rows.length,
    declines: declines.length,
    listed,
    counting: counting.length,
    meanItems,
    reachable: evidenceRouteOf(capability) === TREATMENT_ROUTE,
  };
});

const population = census.filter((row) => row.reachable).flatMap((row) => row.listed);

if (population.length === 0) {
  fail(
    `the control has no decline on the ${TREATMENT_ROUTE} route carrying a Step 1 list, so the pass has no ` +
      'population to reach and this pair cannot be read',
  );
}

const reachableIds = new Set(population.map((entry) => entry.record.questionId));
const unpaired = [...reachableIds].filter((id) => !treatment.byId.has(id));

if (unpaired.length > 0) {
  fail(
    `${unpaired.length} of the population's questions are absent from the treatment (${unpaired
      .slice(0, 3)
      .join(', ')}), so their "no change" would be fabricated`,
  );
}

// ---------------------------------------------------------------- the assembly check

const attempted = treatment.body?.recovery?.attempted;
const answered = treatment.body?.recovery?.answered;

if (!Number.isInteger(attempted) || !Number.isInteger(answered)) {
  process.stderr.write(
    'warning: the treatment carries no recovery census, so whether the pass fired cannot be checked\n',
  );
} else if (attempted === 0) {
  process.stderr.write(
    `the treatment consulted its population 0 times against a population of ${population.length}: this is an ` +
      'assembly failure and not a reading (§13.141.1)\n',
  );
  process.exit(1);
}

// ---------------------------------------------------------------- transitions

/**
 * One bucket's transitions. Direction is stated rather than netted: a net of zero over a gross flow of
 * fourteen is the finding this tool exists to make visible, and it cannot be read from a sum.
 */
function transitions(rows) {
  let bought = 0;
  let sold = 0;
  let unchanged = 0;
  for (const before of rows) {
    const after = treatment.byId.get(before.questionId);
    if (after === undefined) continue;
    if (before.correct === after.correct) unchanged += 1;
    else if (after.correct) bought += 1;
    else sold += 1;
  }
  return { questions: rows.length, bought, sold, unchanged, net: bought - sold };
}

const populationRecords = population.map((entry) => control.byId.get(entry.record.questionId));
const populationTransition = transitions(populationRecords);
const controlRecords = [...control.byId.values()];
const untouchedRecords = controlRecords.filter((record) => !reachableIds.has(record.questionId));
const untouchedTransition = transitions(untouchedRecords);
/**
 * The split that makes the comparison the section is about: the same capability's untouched questions,
 * and every other capability. Netted together -- as "untouched (all other)" -- they hide the number that
 * matters, which is how much the reader moves the questions on the route the pass lives on.
 */
const sameRouteUntouched = untouchedRecords.filter(
  (record) => evidenceRouteOf(record.capability) === TREATMENT_ROUTE,
);
const otherCapabilityRecords = untouchedRecords.filter(
  (record) => evidenceRouteOf(record.capability) !== TREATMENT_ROUTE,
);
const sameRouteTransition = transitions(sameRouteUntouched);
const otherCapabilityTransition = transitions(otherCapabilityRecords);
const rosterTransition = transitions(controlRecords);

const declinedRecords = controlRecords.filter((record) => record.answer === null);
const answeredRecords = controlRecords.filter((record) => record.answer !== null);
const declinedTransition = transitions(declinedRecords);
const answeredTransition = transitions(answeredRecords);

// ---------------------------------------------------------------- the registered claims

const countingConverted = population.filter(
  (entry) => asksForCount(entry.record.question) && treatment.byId.get(entry.record.questionId).correct,
).length;
const countingPopulation = population.filter((entry) => asksForCount(entry.record.question)).length;
const otherConverted = populationTransition.bought - countingConverted;
const otherPopulation = population.length - countingPopulation;

const absRows = controlRecords.filter((record) => record.capability === 'ABS');
const absTransition = transitions(absRows);

const answeredFlips = answeredTransition.bought + answeredTransition.sold;
const answeredFlipRate = answeredRecords.length === 0 ? 0 : answeredFlips / answeredRecords.length;
/**
 * The floor is an **estimate** from 379 questions, so a flow is compared against it with the floor's own
 * binomial spread rather than against the point value. Reading `5.36% > 5.0%` as a falsification would
 * treat a one-question difference as a signal, which is the §13.132.1 error in the other direction.
 */
const expectedFlips = answeredRecords.length * READER_FLOOR;
const floorSpread = Math.sqrt(answeredRecords.length * READER_FLOOR * (1 - READER_FLOOR));
const withinFloor = answeredRecords.length > 0 && Math.abs(answeredFlips - expectedFlips) <= 2 * floorSpread;

const claims = [
  {
    id: 1,
    statement: `at least ${REGISTERED_CONVERSIONS} of the ${population.length} reachable questions convert to correct`,
    measured: `${populationTransition.bought} converted`,
    verdict: populationTransition.bought >= REGISTERED_CONVERSIONS ? 'holds' : 'falsified',
  },
  {
    id: 2,
    statement: `ABS does not move (${absRows.length} questions)`,
    measured: absRows.length === 0 ? 'no ABS questions in this roster' : `${absTransition.bought} bought, ${absTransition.sold} sold`,
    verdict:
      absRows.length === 0 ? 'not applicable' : absTransition.bought === 0 && absTransition.sold === 0 ? 'holds' : 'falsified',
  },
  {
    id: 3,
    statement: `no question that did not decline changes verdict beyond the ${(READER_FLOOR * 100).toFixed(1)}% reader floor`,
    measured:
      `${answeredFlips} of ${answeredRecords.length} (${(answeredFlipRate * 100).toFixed(2)}%), ` +
      `floor ${expectedFlips.toFixed(1)} +/- ${(2 * floorSpread).toFixed(1)}`,
    verdict: withinFloor ? 'holds' : 'falsified',
  },
  {
    id: 4,
    statement: 'the counting questions are the ones most likely to convert',
    measured: `${countingConverted} of ${countingPopulation} counting, ${otherConverted} of ${otherPopulation} not`,
    verdict: countingConverted > 0 || otherConverted === 0 ? 'holds' : 'falsified',
  },
];

const perRunAttempted = treatmentRuns === null ? null : attempted / treatmentRuns;
const perRunAnswered = treatmentRuns === null ? null : answered / treatmentRuns;

if (asJson) {
  process.stdout.write(
    `${JSON.stringify(
      {
        control: control.path,
        treatment: treatment.path,
        route: TREATMENT_ROUTE,
        census: census.map((row) => ({
          capability: row.capability,
          route: row.route,
          questions: row.questions,
          declines: row.declines,
          listed: row.listed.length,
          counting: row.counting,
          meanItems: Number(row.meanItems.toFixed(2)),
        })),
        population: population.map((entry) => ({
          questionId: entry.record.questionId,
          items: entry.items.length,
          counting: asksForCount(entry.record.question),
        })),
        transitions: {
          population: populationTransition,
          sameRouteUntouched: sameRouteTransition,
          otherCapabilities: otherCapabilityTransition,
          roster: rosterTransition,
          declined: declinedTransition,
          answered: answeredTransition,
        },
        censusOfPass: { attempted, answered, treatmentRuns, perRunAttempted, perRunAnswered },
        claims,
      },
      null,
      1,
    )}\n`,
  );
  process.exit(0);
}

const lines = [];
lines.push(`control  : ${control.path}`);
lines.push(`treatment: ${treatment.path}`);
lines.push(`route    : ${TREATMENT_ROUTE} -- the only route the pass is wired into (§13.141.1)`);
lines.push('');
lines.push('Census of the control, with the product\'s own predicate (declinedItems / asksForCount):');
lines.push('  capability  route            questions  declines  listed  counting  mean items');
for (const row of census) {
  lines.push(
    `  ${row.capability.padEnd(11)} ${row.route.padEnd(16)} ${String(row.questions).padStart(9)}` +
      ` ${String(row.declines).padStart(9)} ${String(row.listed.length).padStart(7)}` +
      ` ${String(row.counting).padStart(9)} ${row.meanItems.toFixed(2).padStart(11)}${row.reachable ? '  <- reached' : ''}`,
  );
}
lines.push('');
lines.push(`Population: ${population.length} questions -- declines on ${TREATMENT_ROUTE} carrying a non-empty Step 1 list.`);
for (const entry of population) {
  const after = treatment.byId.get(entry.record.questionId);
  const before = entry.record.correct;
  const moved = before === after.correct ? 'unchanged' : after.correct ? 'bought' : 'sold';
  lines.push(
    `  ${entry.record.questionId}  items=${entry.items.length}  counting=${asksForCount(entry.record.question) ? 'yes' : 'no '}` +
      `  ${before ? 'right' : 'wrong'} -> ${after.correct ? 'right' : 'wrong'}  ${moved}` +
      `  answer=${JSON.stringify(after.answer ?? null).slice(0, 48)}`,
  );
}
lines.push('');
lines.push('Transitions, paired by question id:');
for (const [label, table] of [
  ['population (reached)', populationTransition],
  [`untouched, ${TREATMENT_ROUTE}`, sameRouteTransition],
  ['untouched, other caps', otherCapabilityTransition],
  ['roster', rosterTransition],
  ['declined, whole roster', declinedTransition],
  ['answered, whole roster', answeredTransition],
]) {
  lines.push(
    `  ${label.padEnd(24)} n=${String(table.questions).padStart(3)} bought=${String(table.bought).padStart(2)}` +
      ` sold=${String(table.sold).padStart(2)} net=${String(table.net).padStart(3)} unchanged=${table.unchanged}`,
  );
}
lines.push('');
if (Number.isInteger(attempted)) {
  const rate =
    perRunAttempted === null
      ? 'per-run rate unknown (the artifact does not record its repetition count)'
      : `attempted ${perRunAttempted.toFixed(2)} per run, answered ${perRunAnswered.toFixed(2)} per run, over ${treatmentRuns} runs`;
  lines.push(`The pass's own census: ${rate} (${attempted} and ${answered} in total).`);
  if (perRunAttempted !== null) {
    lines.push(
      `  Both rates use the same denominator as the population above -- one repetition -- so ` +
        `attempted/population is ${(perRunAttempted / population.length).toFixed(2)}x. It is below 1 because the ` +
        'population here is one repetition\'s declines and the decline set moves between repetitions.',
    );
  }
}
lines.push('');
lines.push('Registered claims, read against this pair:');
for (const claim of claims) {
  lines.push(`  ${String(claim.id)}. ${claim.statement}`);
  lines.push(`     measured ${claim.measured} -> ${claim.verdict.toUpperCase()}`);
}
lines.push('');
lines.push(
  `The pass reached ${populationTransition.bought} questions of its own population. On the ` +
    `${sameRouteTransition.questions} questions of the same route it cannot reach, the reader moved ` +
    `${sameRouteTransition.bought + sameRouteTransition.sold} gross (${sameRouteTransition.bought} bought, ` +
    `${sameRouteTransition.sold} sold); the two together are what a mean over this capability reports.`,
);

process.stdout.write(`${lines.join('\n')}\n`);
