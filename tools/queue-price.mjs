#!/usr/bin/env node
/**
 * What a step in the queue costs, reproduced from bills this repository already paid -- and the
 * three quotations in `§205.6` that fail their own arithmetic.
 *
 * ## The defect this file exists to name
 *
 * `§205.6` ordered the queue and put a price beside three rows: **40-80 CNY** for a wider
 * population, **12** for a MemCog run, **8** for LoCoMo. None of the three could be reproduced from
 * anything in the repository, and no gate compared them with a bill. They are not simply too high;
 * they miss in **both directions**, which is the standing calibration in `§166.5` item 6 ("40 ->
 * 0.45, 0.09 -> 0.28"). This file is what turns a quotation into a claim somebody can refute.
 *
 * | queue row | quoted | reproduced | factor | what the quotation silently assumed |
 * | --- | ---: | ---: | ---: | --- |
 * | wider population, `MR` | 40-80 | **10.45 / 20.91 / 41.82** | 0.13x - 4x | 431 questions at **4 repetitions**, and 80 is that doubled for a longer population |
 * | MemCog, `MR` | 12 | **5.87 / 11.74** | 0.49x - 0.98x | 121 questions at **2 repetitions x 2 agentic steps** |
 * | LoCoMo | 8 | **7.28** | 0.91x | 300 questions at one repetition -- or **48.17** if it means the full 1,986 |
 *
 * The left column is a plan. The middle column is arithmetic over `spend-baseline.json`. When the
 * two disagree the plan is what changes, because a bill is a measurement and a plan is a sentence.
 *
 * ## Why a rate is two divisions and never a token count times a price
 *
 * `spend-baseline.json` carries the bills. A rate is `billedCny / (questions * runs)`, computed at
 * read time and never stored rounded, for the reason the baseline file itself states: a file that
 * stored `0.0243` would be a second number that disagrees with the first in the fourth decimal, and
 * the one a reader checked would not be the one the arithmetic used.
 *
 * It is also never rebuilt from `llmUsage` and a list price. On `42467`, **96.0% of prompt tokens
 * were prefix-cache hits**, so a rate rebuilt from `¥2/M` prompt and `¥8/M` completion comes out at
 * 2.4x to 5.1x the money that was actually spent. A projection that contradicts a bill it was
 * derived from is the `§13.348` defect in the cheap direction, and the cheap direction is the one
 * that gets a budget approved and then overrun.
 *
 * ## The three labels, and why the strict one refuses
 *
 * * `billed` -- this population, at or below the repetition count the bill covers. The only label
 *   that is a measurement.
 * * `extrapolated` -- a population larger than the billed one, or more repetitions than the bill
 *   covers. Everything above the observed count is scaled linearly and *said to be*, which is the
 *   same concession `scoped-spend.mjs` makes on its repetition axis and refuses on its population
 *   axis. This file allows the population axis and labels it, because a new population cannot be
 *   billed before it exists; refusing it would leave the queue's largest row unpriced, which is how
 *   a 40 CNY guess survived four rounds.
 * * `proxy` -- a capability with no bill of its own, priced at another capability's billed rate
 *   because the request says so on the command line. `TR` and LoCoMo land here. A prose assumption
 *   that a long-context route costs like `MR` is exactly the kind of sentence this file exists to
 *   convert into a flag somebody had to type.
 *
 * A capability with no bill and no `--proxy` is refused, not floored. `§10.1` of
 * `COST-AND-ACCURACY.md` keeps the floor and its `LOWER BOUND` label for the projection tool, and
 * that is right there: a projection is answering "what would this design cost" before anything has
 * run. Here the question is "should this row be bought", and a floor answers a different question
 * than the one being asked. The refusal names the two ways forward -- dispatch a screening
 * configuration, or name a proxy.
 *
 * ## The probe rule, which is the one that actually saves money
 *
 * `§166.5` states it as a rule with a receipt: **every dispatch at or above 10 CNY should have a
 * reading at or below 0.5** first. A 0.28 reading killed a 14 CNY dispatch. This file refuses to
 * price a row at or above the threshold unless the row declares its probe, and the refusal prints
 * the probe's own price -- which for the largest row in the queue is **zero**, because a retrieval
 * -side census over an artifact calls no model at all. The check is not about being frugal; it is
 * about the fact that the probe can *falsify* the dispatch, and money spent on a falsified dispatch
 * buys nothing but a table row.
 *
 * ## Usage
 *
 *     node tools/queue-price.mjs --list
 *     node tools/queue-price.mjs --id expand-population --reps 1
 *     node tools/queue-price.mjs --questions 431 --capability MR --reps 2 --population external
 *     node tools/queue-price.mjs --self-test
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The billed baseline every rate is read from. Same file the dispatch projection scales. */
export const BASELINE_PATH = join(HERE, 'spend-baseline.json');

/**
 * At or above this price a row must name its probe (`§166.5`, receipt: 0.28 against 14).
 *
 * The number is the rule's own threshold, not a preference: it is where the repository stopped
 * treating a quotation as a decision and started asking for a falsifier first.
 */
export const PROBE_THRESHOLD_CNY = 10;

/** The queue as `§205.6` listed it, with the price this file reproduces for each row. */
export const QUEUE = Object.freeze([
  Object.freeze({
    id: 'expand-population-retrieval',
    label: 'wider population, gold-delivery census only (no judge)',
    capability: 'MR',
    questions: 431,
    reps: 1,
    steps: 1,
    population: 'external',
    reader: false,
    probeCny: 0,
    plan: 'minimum',
    note: 'Retrieval side only: offline embedding plus the same window allocation. Calls no reader, so the judge is not paid and neither is the answer model. This is the probe for the row below it.',
  }),
  Object.freeze({
    id: 'expand-population',
    label: 'wider population, one reader pass',
    capability: 'MR',
    questions: 431,
    reps: 1,
    steps: 1,
    population: 'external',
    probeCny: 0,
    plan: 'minimum',
    note: 'The only row that can certify a 2.2-point gap. Its probe is the row above, which costs nothing and can falsify it.',
  }),
  Object.freeze({
    id: 'expand-population-2rep',
    label: 'wider population, two reader passes (the published reading\'s own repetition count)',
    capability: 'MR',
    questions: 431,
    reps: 2,
    steps: 1,
    population: 'external',
    probeCny: 0,
    plan: 'alternative',
    note: 'Two passes is what `45760081761` used; one pass is what a paired mechanism comparison needs. The quotation of 40 is this row at four. It is an alternative to the row above, not an addition to it.',
  }),
  Object.freeze({
    id: 'memcog-mr',
    label: 'MemCog mechanism, multi-session only, one pass, two agentic steps',
    capability: 'MR',
    questions: 121,
    reps: 1,
    steps: 2,
    population: 'billed',
    probeCny: 0,
    plan: 'minimum',
    note: 'The criterion is `MR` 88.43 against its 92.48, so the other 379 questions are not part of the claim. Two repetitions is the quotation of 12.',
  }),
  Object.freeze({
    id: 'locomo',
    label: 'LoCoMo subset, one pass',
    capability: 'TR',
    proxy: 'MR',
    questions: 300,
    reps: 1,
    steps: 1,
    population: 'external',
    probeCny: 0,
    plan: 'minimum',
    note: 'No bill covers `TR` alone, so this is priced at `MR`\'s rate by proxy -- a long-context route priced as the long-context route that has a bill. The quotation of 8 is this row; the full 1,986 questions would be 6.6x it, which is the one direction in which the plan under-reported.',
  }),
  Object.freeze({
    id: 'delivery-class',
    label: 'the three text-absent questions',
    capability: 'MR',
    questions: 3,
    reps: 2,
    steps: 1,
    population: 'billed',
    probeCny: 0,
    plan: 'refused',
    refused: 'Three members in a 121-question population: the rejection region begins at six direction-consistent discordant questions, so no conversion rate certifies and the dispatch cannot produce a reading at any price. Refused on arithmetic, not on budget.',
  }),
]);

/** A refusal carries the reason, because "no" without a reason is a floor with worse manners. */
export class Refusal extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'Refusal';
  }
}

/**
 * The billed rates, each with the bill it came from.
 *
 * @param {object} baseline the parsed `spend-baseline.json`
 * @returns {{file: {cny: number, questions: number, runs: number} | null, byCapability: Map<string, {rate: number, source: string}>, population: Map<string, number>}}
 */
export function ratesOf(baseline) {
  const measured = baseline?.capabilityRates?.measured ?? {};
  const byCapability = new Map();
  for (const [capability, entry] of Object.entries(measured)) {
    const questions = entry?.billedQuestions;
    const runs = entry?.billedRuns;
    const cny = entry?.billedCny;
    if (!(questions > 0) || !(runs > 0) || !(cny > 0)) continue;
    byCapability.set(capability, { rate: cny / (questions * runs), source: entry.source ?? '' });
  }

  const population = new Map();
  const counts = baseline?.ablation?.questionsByCapability ?? {};
  for (const [capability, count] of Object.entries(counts)) {
    if (Number.isInteger(count) && count > 0) population.set(capability, count);
  }

  // The file-wide bill exists only as a stated total; token counts are not converted to money here
  // because 96.0% of `42467`'s prompt tokens were cache hits and a list-price rebuild is 2.4x-5.1x.
  const file = null;

  return { file, byCapability, population };
}

/**
 * Price one design.
 *
 * @param {{capability: string, questions: number, reps: number, steps?: number, population?: string, proxy?: string, probeCny?: number, id?: string}} design
 * @param {ReturnType<typeof ratesOf>} rates
 * @returns {{cny: number, basis: 'billed' | 'extrapolated' | 'proxy', rate: number, reason: string}}
 */
export function priceOf(design, rates) {
  const questions = design.questions;
  const reps = design.reps ?? 1;
  const steps = design.steps ?? 1;

  if (!Number.isInteger(questions) || questions < 1) {
    throw new Refusal(`questions must be a positive integer, got ${JSON.stringify(questions)}`);
  }
  if (!Number.isInteger(reps) || reps < 1) {
    throw new Refusal(`reps must be a positive integer, got ${JSON.stringify(reps)}`);
  }
  if (!Number.isInteger(steps) || steps < 1) {
    throw new Refusal(`steps must be a positive integer, got ${JSON.stringify(steps)}`);
  }

  const external = design.population === 'external';
  const population = rates.population.get(design.capability);
  if (!external && population !== undefined && questions > population) {
    throw new Refusal(
      `${design.capability} has ${population} questions on this corpus; ${questions} is a different population and must say so with --population external`,
    );
  }
  if (!external && population === undefined) {
    throw new Refusal(`${design.capability} has no population on this corpus; name --proxy or --population external`);
  }

  if (design.reader === false) {
    if (steps !== 1) {
      throw new Refusal('a retrieval-side row takes no agentic steps; steps > 1 means a reader is called');
    }
    return {
      cny: 0,
      basis: 'billed',
      rate: 0,
      reason: 'retrieval side only: offline embedding and the arm\'s own allocation, no reader call and no judge call',
    };
  }

  const own = rates.byCapability.get(design.capability);
  const proxyName = design.proxy;
  const proxy = proxyName === undefined ? undefined : rates.byCapability.get(proxyName);
  if (own === undefined && proxy === undefined) {
    const known = [...rates.byCapability.keys()].sort().join(', ');
    throw new Refusal(
      `no bill covers ${design.capability}. Two ways forward, both of which cost something and mean something: ` +
        `dispatch a screening configuration so the artifact prices it, or name a --proxy from {${known}} ` +
        'and accept a labelled assumption in place of a measurement',
    );
  }

  const chosen = own ?? proxy;
  const billedRuns = own === undefined ? 1 : design.reps;
  const cny = chosen.rate * questions * reps * steps;

  let basis;
  let reason;
  if (own === undefined) {
    basis = 'proxy';
    reason = `no bill for ${design.capability}; priced at ${proxyName}'s billed rate by explicit proxy`;
  } else if (external || reps > billedRuns || steps > 1) {
    basis = 'extrapolated';
    const axes = [];
    if (external) axes.push(`population (${questions} questions against a bill covering ${population})`);
    if (steps > 1) axes.push(`${steps} agentic steps`);
    reason = `${axes.join(' and ')} scaled linearly from ${own === undefined ? 'the proxy rate' : 'the billed rate'}`;
  } else {
    basis = 'billed';
    reason = 'this population at or below the repetition count the bill covers';
  }

  return { cny, basis, rate: chosen.rate, reason };
}

/** The probe rule. Returns `null` when the row may be priced, or the refusal's reason. */
export function probeRefusal(design, cny) {
  if (design.refused !== undefined) return design.refused;
  if (cny < PROBE_THRESHOLD_CNY) return null;
  if (typeof design.probeCny === 'number' && design.probeCny <= 0.5) return null;
  return (
    `at ${cny.toFixed(2)} CNY this row is at or above the ${PROBE_THRESHOLD_CNY} CNY threshold and names no probe ` +
    `at or below 0.5 CNY (§166.5: a 0.28 reading killed a 14 CNY dispatch). A probe is not a discount on the ` +
    'dispatch; it is the reading that can cancel it'
  );
}

/** A row, priced and labelled. Refusals travel with the row rather than aborting the table. */
export function rowOf(design, rates) {
  try {
    const priced = priceOf(design, rates);
    const refusal = probeRefusal(design, priced.cny);
    return { id: design.id, label: design.label, ...priced, refusal, note: design.note };
  } catch (error) {
    if (error instanceof Refusal) {
      return { id: design.id, label: design.label, cny: null, basis: null, refusal: error.message };
    }
    throw error;
  }
}

/** Every row, in queue order, with the total that is actually buyable. */
export function tableOf(queue, rates) {
  const rows = queue.map((design) => ({ ...rowOf(design, rates), plan: design.plan ?? 'minimum' }));
  // A plan total sums the rows a plan would buy, not every row the file can price. The wider
  // population at two repetitions is an alternative to it at one, and adding both would report a
  // number nobody would ever spend -- which is the defect this file exists to stop repeating.
  const inPlan = rows.filter((row) => row.plan === 'minimum' && row.refusal === null && row.cny !== null);
  const alternatives = rows.filter((row) => row.plan === 'alternative' && row.refusal === null && row.cny !== null);
  return {
    rows,
    totalCny: inPlan.reduce((sum, row) => sum + row.cny, 0),
    freeCny: inPlan.filter((row) => row.cny === 0).reduce((sum, row) => sum + row.cny, 0),
    alternativeCny: alternatives.map((row) => ({ id: row.id, cny: row.cny })),
    refusedCount: rows.filter((row) => row.refusal !== null).length,
  };
}

function renderTable(table) {
  const lines = [];
  lines.push('| # | row | CNY | basis | verdict |');
  lines.push('| ---: | --- | ---: | --- | --- |');
  table.rows.forEach((row, index) => {
    const price = row.cny === null ? '--' : row.cny.toFixed(2);
    const verdict = row.refusal === null ? 'buyable' : `refused: ${row.refusal.slice(0, 60)}...`;
    lines.push(`| ${index + 1} | ${row.id} | ${price} | ${row.basis ?? '--'} | ${verdict} |`);
  });
  lines.push('');
  lines.push(
    `plan total: ${table.totalCny.toFixed(2)} CNY (the free probe first); refused rows: ${table.refusedCount}`,
  );
  if (table.alternativeCny.length > 0) {
    const alts = table.alternativeCny.map((row) => `${row.id} ${row.cny.toFixed(2)}`).join(', ');
    lines.push(`alternatives, not added: ${alts}`);
  }
  return lines.join('\n');
}

/**
 * The assertions. Each is a claim the header makes in prose; a failure means the prose is wrong.
 */
function selfTest() {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const rates = ratesOf(baseline);
  const problems = [];
  const check = (name, condition, detail = '') => {
    if (!condition) problems.push(`${name}${detail === '' ? '' : `: ${detail}`}`);
  };

  const mr = rates.byCapability.get('MR');
  check('MR rate is billed', mr !== undefined);
  // 5.87 / (121 x 2). The baseline states the bill and never the rounded rate, so this is the
  // repository's own arithmetic and not a re-derivation.
  check(
    'MR rate reproduces the bill',
    mr !== undefined && Math.abs(mr.rate * 121 * 2 - 5.87) < 1e-9,
    mr === undefined ? 'absent' : String(mr.rate * 121 * 2),
  );
  check('MR population is 121', rates.population.get('MR') === 121, String(rates.population.get('MR')));
  check('TR has no bill', rates.byCapability.get('TR') === undefined);

  // The three quotations, each reproduced from the two numbers the baseline states.
  const expand4 = priceOf({ capability: 'MR', questions: 431, reps: 4, population: 'external' }, rates);
  check('the 40 CNY quotation is 431 questions at four repetitions', Math.abs(expand4.cny - 41.82) < 0.01, expand4.cny.toFixed(2));
  check('four repetitions are labelled extrapolated', expand4.basis === 'extrapolated');

  const expand1 = priceOf({ capability: 'MR', questions: 431, reps: 1, population: 'external' }, rates);
  check('the cheapest wider-population row is 10.45', Math.abs(expand1.cny - 10.45) < 0.01, expand1.cny.toFixed(2));

  const memcog = priceOf({ capability: 'MR', questions: 121, reps: 1, steps: 2 }, rates);
  check('MemCog at one pass and two steps is 5.87', Math.abs(memcog.cny - 5.87) < 0.01, memcog.cny.toFixed(2));
  const memcog2 = priceOf({ capability: 'MR', questions: 121, reps: 2, steps: 2 }, rates);
  check('the 12 CNY quotation is MemCog at two passes', Math.abs(memcog2.cny - 11.74) < 0.01, memcog2.cny.toFixed(2));

  const locomo = priceOf({ capability: 'TR', proxy: 'MR', questions: 300, reps: 1, population: 'external' }, rates);
  check('LoCoMo at 300 questions is 7.28', Math.abs(locomo.cny - 7.28) < 0.01, locomo.cny.toFixed(2));
  check('LoCoMo is labelled proxy, not billed', locomo.basis === 'proxy');
  const locomoFull = priceOf({ capability: 'TR', proxy: 'MR', questions: 1986, reps: 1, population: 'external' }, rates);
  check(
    'the full LoCoMo corpus is 48.17, 6.0x the quotation',
    Math.abs(locomoFull.cny - 48.17) < 0.02,
    locomoFull.cny.toFixed(2),
  );

  // The three refusals.
  const refusals = [
    ['a capability with no bill and no proxy', () => priceOf({ capability: 'TR', questions: 10, reps: 1 }, rates)],
    ['a population larger than the corpus without saying so', () => priceOf({ capability: 'MR', questions: 431, reps: 1 }, rates)],
    ['zero repetitions', () => priceOf({ capability: 'MR', questions: 10, reps: 0 }, rates)],
    ['zero questions', () => priceOf({ capability: 'MR', questions: 0, reps: 1 }, rates)],
  ];
  for (const [name, run] of refusals) {
    let threw = false;
    try {
      run();
    } catch (error) {
      threw = error instanceof Refusal;
    }
    check(`refuses ${name}`, threw);
  }

  // The probe rule: a row at or above the threshold without a probe is refused, and the largest
  // row in the queue has a probe that costs nothing.
  check(
    'refuses a 41.82 row that names no probe',
    probeRefusal({ id: 'x' }, 41.82) !== null,
  );
  check(
    'prices a 41.82 row whose probe costs nothing',
    probeRefusal({ id: 'x', probeCny: 0 }, 41.82) === null,
  );
  check('does not demand a probe below the threshold', probeRefusal({ id: 'x' }, 5.87) === null);

  const table = tableOf(QUEUE, rates);
  check('the delivery class is refused on arithmetic', table.rows.some((row) => row.id === 'delivery-class' && row.refusal !== null));
  check(
    'every buyable row is at or under 25 CNY',
    table.rows.filter((row) => row.cny !== null).every((row) => row.cny <= 25),
    String(table.totalCny.toFixed(2)),
  );
  // The whole point: the buyable queue is one quarter of the 60 CNY the three quotations implied,
  // and the first row of it is free.
  check('the free probe exists and is first', table.rows[0]?.cny === 0, String(table.rows[0]?.cny));
  check('plan total is 23.60', Math.abs(table.totalCny - 23.6) < 0.05, table.totalCny.toFixed(2));
  check(
    'the two-pass row is an alternative and is not summed into the plan',
    table.alternativeCny.length === 1 && Math.abs(table.alternativeCny[0].cny - 20.91) < 0.01,
    JSON.stringify(table.alternativeCny),
  );
  check('the plan buys a reading for under a quarter of the 60 the quotations implied', table.totalCny < 60 / 2.5);

  if (problems.length > 0) {
    process.stderr.write(`queue-price self-test: ${problems.length} failed\n`);
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    return 1;
  }
  process.stdout.write(
    `queue-price self-test: ${QUEUE.length} rows, ${table.totalCny.toFixed(2)} CNY buyable, ` +
      `${table.refusedCount} refused, ${problems.length} failed\n`,
  );
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const flag = (name) => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? undefined : process.argv[index + 1];
  };

  if (process.argv.includes('--self-test')) {
    process.exit(selfTest());
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const rates = ratesOf(baseline);

  if (process.argv.includes('--list') || process.argv.length <= 2) {
    process.stdout.write(`${renderTable(tableOf(QUEUE, rates))}\n`);
    process.exit(0);
  }

  const id = flag('id');
  if (id !== undefined) {
    const design = QUEUE.find((entry) => entry.id === id);
    if (design === undefined) {
      process.stderr.write(`no queue row named ${id}; --list prints them\n`);
      process.exit(2);
    }
    const row = rowOf(design, rates);
    process.stdout.write(`${JSON.stringify(row, null, 2)}\n`);
    process.exit(row.refusal === null ? 0 : 1);
  }

  const questions = Number(flag('questions'));
  const capability = flag('capability');
  if (!Number.isFinite(questions) || capability === undefined) {
    process.stderr.write(
      'usage: node tools/queue-price.mjs --list | --id <row> | --questions N --capability C ' +
        '[--reps N] [--steps N] [--population external|billed] [--proxy C] | --self-test\n',
    );
    process.exit(2);
  }

  const design = {
    capability,
    questions,
    reps: Number(flag('reps') ?? 1),
    steps: Number(flag('steps') ?? 1),
    population: flag('population') ?? 'billed',
    proxy: flag('proxy'),
    probeCny: flag('probe-cny') === undefined ? undefined : Number(flag('probe-cny')),
  };
  const row = rowOf(design, rates);
  process.stdout.write(`${JSON.stringify(row, null, 2)}\n`);
  process.exit(row.refusal === null ? 0 : 1);
}
