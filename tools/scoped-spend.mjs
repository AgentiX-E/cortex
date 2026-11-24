#!/usr/bin/env node
/**
 * What a *smaller* dispatch would cost, priced from a bill rather than from a census.
 *
 * ## The defect this file is written against
 *
 * `spend-projection.mjs` prices a dispatch by scaling a billed run along two axes, question count and
 * repetition count, and it refuses the third: a run scoped to one capability. Its own header records
 * why -- §13.348's first capability-scoped dispatch was projected at **1.73 CNY** and billed
 * **5.87**, 3.4x, because the projection scaled by the census and `MR`'s per-question cost is 3.8x the
 * file's (`0.0243` against `0.0064`). The refusal is honest and it leaves the operator with one
 * instruction: "dispatch the screening configuration and read its own artifact". That instruction
 * costs money to obey, which is the wrong answer to a question about money.
 *
 * The fix is not a better model. It is a different unit: a question's prompt is its own, so the bill
 * for a subset of questions is the sum of their own rows, and `costPerCapability` already computes
 * exactly those rows off a billed artifact. Nothing is extrapolated along the population axis -- the
 * population is composed of the parts being priced.
 *
 * ## What is extrapolated, and what is not
 *
 * Three axes, three different claims:
 *
 * - **Capability** is composition, not extrapolation. The rows are the artifact's own.
 * - **Repetitions** scale linearly in tokens because each repetition is its own call. The two effects
 *   that are *not* linear are wall clock (`40722772896`: 2.87x for 4 against 1) and the prefix cache,
 *   which is why a design above the observed repetition count is priced and labelled `extrapolated`
 *   rather than refused or trusted.
 * - **Arms** are two by construction -- the A/B runs one baseline side and one feature side through
 *   one `runAblationReport` call (`PREREGISTRATION-CORTEX-MEMORY-ARM.md` §2.2). `arms: 1` exists for
 *   an ablation whose control side is already archived and is therefore a comparison across runs,
 *   which §181 measured at a 3.75-question placebo on questions the treatment could not reach.
 *
 * ## Why the judge is apportioned and not scaled by arm
 *
 * The judge makes one call per question-run, not per side: it grades the feature answer. So a scoped
 * two-arm design pays the judge once. Folding it into the arm multiplier would double it, and the
 * judge is 15.7% of the calls on the artifact this file was written against -- a 2x error on a sixth
 * of the bill is not rounding. The judge's own share is read off `llmUsage` minus the two sides,
 * which is the only place the artifact states it.
 *
 * ## Usage
 *
 *     node tools/scoped-spend.mjs --report <artifact.json> --ladder
 *     node tools/scoped-spend.mjs --report <artifact.json> --capability MR --reps 1
 *     node tools/scoped-spend.mjs --report <artifact.json> --capability MR,KU --reps 1 --arms 2 --budget 5
 *     node tools/scoped-spend.mjs --self-test
 *
 * `--ladder` prints every design this file knows how to price, which is the table a plan should be
 * chosen from rather than the single number a plan tends to be argued from.
 */
import { readFileSync } from 'node:fs';

import { costPerCapability } from '../packages/cortex-eval/dist/cost-per-capability.js';
import { DEEPSEEK_PRICES, priceUsage } from './spend-projection.mjs';

/** The capabilities the file is partitioned into, in the order the artifact lists them. */
export const KNOWN_CAPABILITIES = Object.freeze(['MR', 'TR', 'IE', 'KU', 'ABS']);

const REFUSALS = Object.freeze({
  noRows: 'the artifact carries no per-capability rows, so there is nothing to scope',
  unknownCapability: 'is not a capability this artifact carries',
  emptySelection:
    'a design with no capabilities prices nothing; that is not a saving, it is a typo',
  badReps: '--reps takes a positive integer',
  badArms: '--arms takes 1 or 2 (the A/B is two sides by construction)',
  noJudge: 'the artifact states no judge share, so the judge line cannot be apportioned',
});

/**
 * The judge's share of the bill, in CNY, and the question-run denominator it is apportioned over.
 *
 * `llmUsage` is process-wide, so subtracting the two sides is the only way the artifact states
 * "neither arm". A negative residual is refused rather than clamped: it means the sides were credited
 * more tokens than the process spent, and apportioning a negative would turn a corrupted ledger into a
 * discount.
 */
export function judgeShare(report, prices = DEEPSEEK_PRICES) {
  const total = report.llmUsage;
  const baseline = report.usageBySide?.baseline;
  const feature = report.usageBySide?.feature;
  if (total === undefined || baseline === undefined || feature === undefined) {
    throw new Error(`scoped-spend: ${REFUSALS.noJudge}`);
  }
  const residual = {
    promptTokens:
      (total.promptTokens ?? 0) - (baseline.promptTokens ?? 0) - (feature.promptTokens ?? 0),
    completionTokens:
      (total.completionTokens ?? 0) -
      (baseline.completionTokens ?? 0) -
      (feature.completionTokens ?? 0),
    cacheHitPromptTokens:
      (total.cacheHitPromptTokens ?? 0) -
      (baseline.cacheHitPromptTokens ?? 0) -
      (feature.cacheHitPromptTokens ?? 0),
  };
  for (const [key, value] of Object.entries(residual)) {
    if (value < 0) {
      throw new Error(
        `scoped-spend: the residual ${key} is ${value}: the two sides are credited more than the ` +
          'process spent, so this artifact cannot price a judge',
      );
    }
  }
  return priceUsage(residual, prices).total;
}

/**
 * The baseline side's bill as a share of the feature side's, off the same artifact.
 *
 * Why a ratio rather than a per-capability table: `costPerCapability` splits the feature side only, so
 * there are no baseline rows to scope with. The two sides answer the *same* questions, though, so their
 * ratio is measured on an identical population — which is exactly the property a census scaling lacks.
 * On the artifact this file was written against the ratio is **0.135**: the baseline is raw retrieval
 * and the feature arm carries the reasoning, so pricing both arms at the feature arm's rate overstates
 * a two-arm run by 11.6 CNY of 15.6.
 */
export function baselineShare(report, prices = DEEPSEEK_PRICES) {
  const baseline = report.usageBySide?.baseline;
  const feature = report.usageBySide?.feature;
  if (baseline === undefined || feature === undefined) {
    throw new Error(`scoped-spend: ${REFUSALS.noJudge}`);
  }
  const featureCost = priceUsage(feature, prices).total;
  if (featureCost <= 0) {
    throw new Error('scoped-spend: the feature side is billed at nothing, so no ratio exists');
  }
  return priceUsage(baseline, prices).total / featureCost;
}

/**
 * Price one design, given the artifact's own per-capability rows.
 *
 * The rows are `{ capability, questions, cny }` where `cny` is **one arm** at the observed repetition
 * count, which is the unit `costPerCapability` reports: it divides the feature side only.
 */
export function scopedSpend(reading, design) {
  const { rows, observedRuns, judgeCny, arms2 = 1, prices = DEEPSEEK_PRICES } = reading;
  const { capabilities, reps, arms } = design;
  if (!Number.isInteger(reps) || reps <= 0) throw new Error(`scoped-spend: ${REFUSALS.badReps}`);
  if (arms !== 1 && arms !== 2) throw new Error(`scoped-spend: ${REFUSALS.badArms}`);
  if (capabilities.length === 0) throw new Error(`scoped-spend: ${REFUSALS.emptySelection}`);
  if (rows.length === 0) throw new Error(`scoped-spend: ${REFUSALS.noRows}`);

  const byCapability = new Map(rows.map((row) => [row.capability, row]));
  for (const capability of capabilities) {
    if (!byCapability.has(capability)) {
      throw new Error(
        `scoped-spend: '${capability}' ${REFUSALS.unknownCapability} (${rows
          .map((row) => row.capability)
          .join(', ')})`,
      );
    }
  }

  const allQuestionRuns = rows.reduce((sum, row) => sum + row.questions, 0) * observedRuns;
  const priced = capabilities.map((capability) => {
    const row = byCapability.get(capability);
    const questionRuns = row.questions * reps;
    const featureCny = row.cny * (reps / observedRuns) * (arms === 2 ? 1 + arms2 : 1);
    // One judge call per question-run, on the feature answer: apportioned by the run's share of the
    // artifact's own question-runs, never by the arm count.
    const judge = judgeCny * (questionRuns / allQuestionRuns);
    return {
      capability,
      questions: row.questions,
      questionRuns,
      featureCny,
      baselineCny: arms === 2 ? row.cny * (reps / observedRuns) * arms2 : 0,
      judgeCny: judge,
      cny: featureCny + judge,
    };
  });

  const total = priced.reduce((sum, row) => sum + row.cny, 0);
  return {
    design: { capabilities: [...capabilities], reps, arms },
    observedRuns,
    measured: reps <= observedRuns,
    rows: priced,
    total,
    percentOf: (full) => (full > 0 ? (total / full) * 100 : Number.NaN),
    prices,
  };
}

/**
 * The ladder: every design this file can price, cheapest first.
 *
 * Cheap is not the criterion and the table says so -- a design's price is only meaningful beside the
 * population it grades, which is why the row carries both.
 */
export function ladder(reading) {
  const designs = [];
  const all = reading.rows.map((row) => row.capability);
  for (const reps of [1, reading.observedRuns]) {
    for (const arms of [1, 2]) {
      for (const capability of [...all, null]) {
        designs.push({
          capabilities: capability === null ? all : [capability],
          reps,
          arms,
          label: capability === null ? 'whole file' : capability,
        });
      }
    }
  }
  return designs
    .map((design) => ({ ...design, priced: scopedSpend(reading, design) }))
    .sort((left, right) => left.priced.total - right.priced.total);
}

export function renderLadder(reading) {
  const all = reading.rows.map((row) => row.capability);
  const full = scopedSpend(reading, {
    capabilities: all,
    reps: reading.observedRuns,
    arms: 2,
  }).total;
  const lines = [
    `scoped spend, priced from ${reading.rows.length} capability rows billed at ` +
      `${reading.observedRuns} repetition(s); one arm's feature side plus an apportioned judge`,
    '',
    'design                     qs  reps  arms      CNY   vs full',
  ];
  for (const entry of ladder(reading)) {
    const questions = entry.priced.rows.reduce((sum, row) => sum + row.questions, 0);
    const share = ((entry.priced.total / full) * 100).toFixed(1);
    const mark = entry.priced.measured ? '' : ' *';
    lines.push(
      `${entry.label.padEnd(24)}${String(questions).padStart(4)}` +
        `${String(entry.reps).padStart(6)}${String(entry.arms).padStart(6)}` +
        `${entry.priced.total.toFixed(2).padStart(9)}${`${share}%`.padStart(9)}${mark}`,
    );
  }
  lines.push(
    '',
    '* above the observed repetition count: priced linearly, cache behaviour unmeasured',
  );
  return lines.join('\n');
}

/**
 * Turn a billed artifact into the reading {@link scopedSpend} takes.
 *
 * `costPerCapability` is the arithmetic and every refusal about the artifact; this function only
 * reshapes its rows, so a figure this file prints can be checked against the figure that tool prints
 * for the same capability.
 */
export function readingOf(report, prices = DEEPSEEK_PRICES) {
  const reading = costPerCapability(report, { prices });
  // `cost` is `null` without prices and `costPerCapability` is called with them, so the null branch is
  // refused rather than coalesced: a `?? 0` here would price every capability at nothing and print it
  // as a saving.
  const unpriced = reading.rows.filter((row) => row.cost === null);
  if (unpriced.length > 0) {
    throw new Error(
      `scoped-spend: ${unpriced.map((row) => row.capability).join(', ')} carries no price`,
    );
  }
  return {
    rows: reading.rows.map((row) => ({
      capability: row.capability,
      questions: row.questions,
      cny: row.cost,
    })),
    observedRuns: reading.runs,
    judgeCny: judgeShare(report, prices),
    arms2: baselineShare(report, prices),
    prices,
  };
}

function selfTest() {
  let checks = 0;
  const assert = (condition, message) => {
    checks += 1;
    if (!condition) throw new Error(`self-test: ${message}`);
  };
  const close = (actual, expected, message) =>
    assert(Math.abs(actual - expected) < 1e-9, `${message} (${actual} vs ${expected})`);

  // Hand-built reading: MR's own row and KU's, a 2 CNY judge over 193 questions at 4 repetitions, and
  // a baseline side billed at 13.5% of the feature side.
  const reading = {
    rows: [
      { capability: 'MR', questions: 121, cny: 4.45 },
      { capability: 'KU', questions: 72, cny: 1.693 },
    ],
    observedRuns: 4,
    judgeCny: 2,
    arms2: 0.135,
  };

  // One capability, both arms, the observed repetitions: the feature row is scaled by `1 + the baseline
  // share` and the judge is apportioned by question-runs (484 of 772), not by arm.
  const mr4 = scopedSpend(reading, { capabilities: ['MR'], reps: 4, arms: 2 });
  close(mr4.rows[0].featureCny, 4.45 * 1.135, 'MR feature at 4 reps and two arms');
  close(mr4.rows[0].baselineCny, 4.45 * 0.135, 'the baseline side is its own measured share');
  close(mr4.rows[0].judgeCny, 2 * (484 / 772), 'MR judge apportioned by question-runs');
  close(mr4.total, 4.45 * 1.135 + 2 * (484 / 772), 'MR total');
  assert(mr4.measured, 'a design at the observed repetition count is measured');

  // One repetition is a quarter of everything that scales with repetitions.
  const mr1 = scopedSpend(reading, { capabilities: ['MR'], reps: 1, arms: 2 });
  close(mr1.rows[0].featureCny, 4.45 * 1.135 * 0.25, 'MR feature at 1 rep and two arms');
  close(mr1.rows[0].judgeCny, 2 * (121 / 772), 'MR judge at 1 rep');
  assert(mr1.measured, 'fewer repetitions than observed is still measured');

  // Two capabilities compose by addition: no cross term, because each question's prompt is its own.
  const both = scopedSpend(reading, { capabilities: ['MR', 'KU'], reps: 1, arms: 2 });
  close(
    both.total,
    mr1.total + scopedSpend(reading, { capabilities: ['KU'], reps: 1, arms: 2 }).total,
    'composition is additive',
  );

  // One arm is the feature row alone, and the whole judge: the judge grades one answer either way.
  const oneArm = scopedSpend(reading, { capabilities: ['MR'], reps: 4, arms: 1 });
  close(oneArm.rows[0].featureCny, 4.45, 'one arm is the artifact row unchanged');
  close(oneArm.rows[0].baselineCny, 0, 'one arm pays no baseline');
  close(oneArm.total, 4.45 + 2 * (484 / 772), 'the judge does not halve with the arm count');

  // Above the observed repetitions is priced and labelled, not refused.
  const eight = scopedSpend(reading, { capabilities: ['MR'], reps: 8, arms: 2 });
  assert(!eight.measured, 'eight repetitions against four observed is extrapolated');
  close(eight.rows[0].featureCny, 4.45 * 1.135 * 2, 'linear above the observed count');

  // The identity that makes this a pricing of a bill rather than a second opinion: the whole file at the
  // artifact's own repetitions and both arms has to reproduce the artifact's own total, because every
  // term it is built from came off that artifact.
  const reconcile = scopedSpend(reading, { capabilities: ['MR', 'KU'], reps: 4, arms: 2 });
  close(
    reconcile.total,
    (4.45 + 1.693) * 1.135 + 2,
    'the ladder closes on the artifact it was priced from',
  );

  // Every refusal fires, because a refusal that cannot be tested is a refusal that will not.
  const refuses = (fn, needle) => {
    checks += 1;
    try {
      fn();
    } catch (error) {
      if (String(error.message).includes(needle)) return;
      throw new Error(`self-test: wrong refusal: ${error.message}`);
    }
    throw new Error(`self-test: expected a refusal containing '${needle}'`);
  };
  refuses(() => scopedSpend(reading, { capabilities: [], reps: 1, arms: 2 }), 'typo');
  refuses(
    () => scopedSpend(reading, { capabilities: ['XX'], reps: 1, arms: 2 }),
    'not a capability',
  );
  refuses(
    () => scopedSpend(reading, { capabilities: ['MR'], reps: 0, arms: 2 }),
    'positive integer',
  );
  refuses(
    () => scopedSpend(reading, { capabilities: ['MR'], reps: 1.5, arms: 2 }),
    'positive integer',
  );
  refuses(() => scopedSpend(reading, { capabilities: ['MR'], reps: 1, arms: 3 }), '1 or 2');
  refuses(
    () => scopedSpend({ ...reading, rows: [] }, { capabilities: ['MR'], reps: 1, arms: 2 }),
    'no per-capability rows',
  );

  process.stdout.write(`scoped-spend self-test: ${checks} checks passed\n`);
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  selfTest();
} else {
  const flag = (name) => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };
  const reportPath =
    flag('--report') ?? args.find((arg) => !arg.startsWith('--') && arg !== undefined);
  if (reportPath === undefined) {
    process.stderr.write(
      'usage: node tools/scoped-spend.mjs --report <artifact.json> [--ladder] ' +
        '[--capability MR,KU] [--reps N] [--arms 1|2] [--budget CNY] | --self-test\n',
    );
    process.exitCode = 2;
  } else {
    const pricesPath = flag('--prices');
    const prices =
      pricesPath === undefined ? DEEPSEEK_PRICES : JSON.parse(readFileSync(pricesPath, 'utf8'));
    const reading = readingOf(JSON.parse(readFileSync(reportPath, 'utf8')), prices);
    if (args.includes('--ladder')) {
      process.stdout.write(`${renderLadder(reading)}\n`);
    } else {
      const named = (flag('--capability') ?? '').split(',').filter((value) => value !== '');
      const capabilities = named.length > 0 ? named : reading.rows.map((row) => row.capability);
      const priced = scopedSpend(reading, {
        capabilities,
        reps: Number.parseInt(flag('--reps') ?? String(reading.observedRuns), 10),
        arms: Number.parseInt(flag('--arms') ?? '2', 10),
      });
      const budget = flag('--budget');
      const lines = priced.rows.map(
        (row) =>
          `${row.capability.padEnd(4)}${String(row.questions).padStart(5)} q` +
          `${String(row.questionRuns).padStart(7)} runs` +
          `${row.cny.toFixed(3).padStart(10)} CNY`,
      );
      lines.push(
        `${'TOTAL'.padEnd(4)}${''.padStart(5)}  ${''.padStart(7)}` +
          `${priced.total.toFixed(3).padStart(10)} CNY` +
          `  at ${priced.design.reps} repetition(s) x ${priced.design.arms} arm(s)` +
          `${priced.measured ? '' : ' [extrapolated]'}`,
      );
      process.stdout.write(`${lines.join('\n')}\n`);
      if (budget !== undefined) {
        const ceiling = Number.parseFloat(budget);
        if (!Number.isFinite(ceiling)) {
          process.stderr.write('--budget needs a CNY amount\n');
          process.exitCode = 2;
        } else if (priced.total > ceiling) {
          process.stderr.write(
            `BUDGET EXCEEDED: ${priced.total.toFixed(2)} CNY projected against a ${ceiling.toFixed(2)} ` +
              'CNY budget. Narrow the capability list, drop a repetition, or name a larger budget.\n',
          );
          process.exitCode = 1;
        }
      }
    }
  }
}
