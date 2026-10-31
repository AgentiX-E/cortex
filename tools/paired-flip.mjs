#!/usr/bin/env node
/**
 * Read a two-arm artifact the way its own correctness masks allow: paired, per question.
 *
 * ## Why this exists
 *
 * The campaign has quoted `87.25` against `103.75` as "16 questions behind" for several iterations.
 * Both numbers are averages over four repetitions, and the subtraction hides the only structure an
 * intervention can act on. The artifact has stored `featureCorrectByRun` and `baselineCorrectByRun` —
 * one mask per repetition — since that field was added for exactly this purpose, and `§13.187` is the
 * first reading of them.
 *
 * ## What it prints, and the order it prints it in
 *
 * 1. **The headline check.** `report.feature.metrics` is repetition 0 only, while `runs: 4` sits in
 *    the same object. Nothing says so, and a reader who divides `correct` by `total` reads one
 *    repetition of four as the run. This tool says which it is before any other number.
 * 2. **Per capability**: every repetition's count on each side, the gap per repetition, and the
 *    discordant counts those gaps are the difference of.
 * 3. **The durable populations**, by question id, because a count without ids cannot be dispatched at.
 *
 * ## Why the census is imported rather than restated
 *
 * `mr-failure-census.mjs` already classifies a failure from its gold and its answer — decline,
 * off-by-one, aggregation, other — and a second implementation of "is this one member away" would be
 * the defect that file was written to avoid (`MEASURE-MR-UNITS.md` §2: a second implementation of
 * "which part of a reply is a decline" is how two layers come to disagree about one artifact). The
 * two readings compose: the census says what kind of error, this says whether it is stable.
 *
 * ## Exit codes
 *
 * `0` reading taken; `2` usage; `3` the artifact cannot be paired (no masks, or mask lengths that do
 * not match the question list); `1` the durable partition does not sum to the population, which is an
 * instrument failure rather than a result.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { summarisePaired } from '../packages/cortex-eval/dist/paired-flip.js';
import { classify } from './mr-failure-census.mjs';

function flag(args, name) {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

/** `'1010'` → `[true, false, true, false]`. One conversion, in one place. */
function maskToBooleans(mask) {
  return [...mask].map((character) => character === '1');
}

/**
 * The pairing inputs, or a reason the artifact cannot supply them.
 *
 * A single-repetition artifact omits the masks by design — one repetition's mask would be a second
 * copy of `featureCorrect` — so its absence is not a defect of the artifact and must not be reported
 * as one. What it means is that this reading needs a repeated run.
 */
export function pairingInputs(report) {
  const ablation = report.ablation;
  if (ablation === undefined || ablation === null) {
    return { error: 'the artifact has no `ablation` object, so there are no two arms to pair' };
  }
  const baseline = ablation.baselineCorrectByRun;
  const feature = ablation.featureCorrectByRun;
  if (!Array.isArray(baseline) || !Array.isArray(feature)) {
    return {
      error:
        'the artifact has no per-repetition masks; a single-repetition artifact omits them by ' +
        'design, and `discordantQuestions` is its id-level equivalent',
    };
  }
  const questions = report.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    return {
      error: 'the artifact has no per-question records, so a mask cannot be attached to a gold',
    };
  }
  if (baseline.length !== feature.length) {
    return {
      error: `the two sides ran ${baseline.length} and ${feature.length} times; a paired reading needs the same`,
    };
  }
  for (const [side, masks] of [
    ['baseline', baseline],
    ['feature', feature],
  ]) {
    masks.forEach((mask, run) => {
      if (typeof mask !== 'string' || mask.length !== questions.length) {
        throw new Error(
          `${side} repetition ${run} has ${typeof mask === 'string' ? mask.length : 'no'} characters ` +
            `against ${questions.length} questions; a mask read into the wrong index space attributes ` +
            'one question of accuracy to another',
        );
      }
    });
  }
  return { baseline, feature, questions };
}

export function casesFrom(report) {
  const inputs = pairingInputs(report);
  if ('error' in inputs) return inputs;
  const { baseline, feature, questions } = inputs;
  return {
    cases: questions.map((question, index) => ({
      index,
      questionId: question.questionId,
      capability: typeof question.capability === 'string' ? question.capability : 'unknown',
      gold: typeof question.groundTruth === 'string' ? question.groundTruth : '',
      answer: typeof question.answer === 'string' ? question.answer : '',
      baseline: baseline.map((mask) => maskToBooleans(mask)[index] === true),
      feature: feature.map((mask) => maskToBooleans(mask)[index] === true),
    })),
  };
}

/**
 * Whether the report's headline numbers are one repetition or all of them.
 *
 * `feature.metrics.correct` equals repetition 0's total in every artifact this campaign produced
 * (`419` against masks summing `419, 417, 425, 427`), and `runs: 4` is in the same object. Saying so
 * in the reading is cheaper than a schema change and impossible to forget while reading the number.
 */
export function headlineIsOneRepetition(report, reading) {
  const metrics = report.feature?.metrics;
  if (metrics === undefined || typeof metrics.correct !== 'number') return { known: false };
  const perRun = reading.capabilities.reduce(
    (total, entry) => total + (entry.featurePerRun[0] ?? 0),
    0,
  );
  const means = Array.from({ length: reading.runs }, (_, run) =>
    reading.capabilities.reduce((total, entry) => total + (entry.featurePerRun[run] ?? 0), 0),
  );
  return {
    known: true,
    metricsCorrect: metrics.correct,
    firstRepetition: perRun,
    isFirstRepetition: metrics.correct === perRun,
    perRepetition: means,
    meanOfRepetitions: means.reduce((a, b) => a + b, 0) / means.length,
    baselineMetricsCorrect: report.baseline?.metrics?.correct ?? null,
  };
}

const pct = (value) => `${(value * 100).toFixed(1)}%`;

function render(reading, report, options) {
  const lines = [];
  const headline = headlineIsOneRepetition(report, reading);
  lines.push(`artifact          ${options.path}`);
  lines.push(`repetitions       ${reading.runs}`);
  if (headline.known === true) {
    lines.push(
      `headline metrics  feature.metrics.correct ${headline.metricsCorrect} = repetition 0 ` +
        `(${headline.isFirstRepetition ? 'yes' : 'NO'}), per repetition ` +
        `[${headline.perRepetition.join(', ')}] mean ${headline.meanOfRepetitions.toFixed(2)}; ` +
        `baseline.metrics.correct ${headline.baselineMetricsCorrect}`,
    );
  }

  const scope = (entry) =>
    options.capability === undefined || entry.capability === options.capability;
  const capabilities = reading.capabilities.filter(scope);
  if (capabilities.length === 0) {
    lines.push(`no capability matched ${options.capability}`);
    return { text: `${lines.join('\n')}\n`, capabilities };
  }

  lines.push('');
  lines.push(
    'capability            n   baseline per repetition        feature per repetition         gap per repetition',
  );
  for (const entry of capabilities) {
    lines.push(
      `${entry.capability.padEnd(18)}${String(entry.total).padStart(4)}   ` +
        `${entry.baselinePerRun.map((n) => String(n).padStart(3)).join(' ')}`.padEnd(31) +
        `${entry.featurePerRun.map((n) => String(n).padStart(3)).join(' ')}`.padEnd(30) +
        `${entry.gapPerRun.map((n) => String(n).padStart(3)).join(' ')}`,
    );
  }

  lines.push('');
  lines.push(
    'capability            n   durable-miss  durable-win  agreed-wrong  contested  flapping (b/f)',
  );
  for (const entry of capabilities) {
    lines.push(
      `${entry.capability.padEnd(18)}${String(entry.total).padStart(4)}   ` +
        `${String(entry.durableMiss.length).padStart(12)}  ` +
        `${String(entry.durableWin.length).padStart(11)}  ` +
        `${String(entry.agreedWrong.length).padStart(12)}  ` +
        `${String(entry.contested).padStart(9)}  ` +
        `${String(entry.flapping.baseline.length).padStart(6)}/${entry.flapping.feature.length}`,
    );
  }

  // The identity a reader can check by eye: mean gap == mean(baseline) - mean(feature), and the
  // discordant difference equals the gap in every repetition.
  lines.push('');
  for (const entry of capabilities) {
    const meanGap = entry.gapPerRun.reduce((a, b) => a + b, 0) / entry.gapPerRun.length;
    const meanDiscordant =
      entry.baselineOnlyPerRun.reduce((a, b) => a + b, 0) / entry.baselineOnlyPerRun.length -
      entry.featureOnlyPerRun.reduce((a, b) => a + b, 0) / entry.featureOnlyPerRun.length;
    lines.push(
      `${entry.capability}: mean gap ${meanGap.toFixed(2)} questions = ` +
        `durable ${entry.durableMiss.length} - ${entry.durableWin.length} ` +
        `= ${entry.durableMiss.length - entry.durableWin.length}, discordant mean ${meanDiscordant.toFixed(2)}`,
    );
  }

  if (options.census === true) {
    const byId = new Map(reading.rows.map((row) => [row.questionId, row]));
    for (const entry of capabilities) {
      if (entry.durableMiss.length === 0) continue;
      lines.push('');
      lines.push(`${entry.capability} durable misses, classified from gold and answer`);
      const classes = {};
      for (const id of entry.durableMiss) {
        const row = byId.get(id);
        const verdict = classify(row.gold, row.answer);
        classes[verdict.klass] = (classes[verdict.klass] ?? 0) + 1;
        if (options.list === true) {
          lines.push(`  ${id}  [${verdict.klass}] ${verdict.detail}`);
          lines.push(`    gold   ${row.gold.replace(/\s+/g, ' ').slice(0, 120)}`);
          lines.push(`    answer ${row.answer.replace(/\s+/g, ' ').slice(0, 160)}`);
        }
      }
      lines.push(
        `  ${entry.durableMiss.length} in total: ` +
          Object.entries(classes)
            .map(([name, count]) => `${name} ${count}`)
            .join(', '),
      );
    }
  }

  return { text: `${lines.join('\n')}\n`, capabilities };
}

function main(argv) {
  const args = argv;
  const path = flag(args, '--artifact');
  const capability = flag(args, '--capability');
  const out = flag(args, '--out');
  if (path === undefined) {
    process.stderr.write(
      'usage: paired-flip.mjs --artifact <report.json> [--capability MR] [--census] [--list] [--out <file>]\n',
    );
    return 2;
  }
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const built = casesFrom(report);
  if ('error' in built) {
    process.stderr.write(`${built.error}\n`);
    return 3;
  }
  const reading = summarisePaired(built.cases);

  // A partition that does not add up is an instrument failure, so it is checked before anything is
  // printed rather than left to a reader to notice.
  for (const entry of reading.capabilities) {
    const classified =
      entry.durableMiss.length + entry.durableWin.length + entry.agreedWrong.length;
    const agreedRight = entry.total - classified - entry.contested;
    if (agreedRight < 0) {
      process.stderr.write(
        `${entry.capability}: the verdicts sum to more than the population ` +
          `(${classified} + ${entry.contested} > ${entry.total})\n`,
      );
      return 1;
    }
  }

  const { text, capabilities } = render(reading, report, {
    path,
    capability,
    census: args.includes('--census'),
    list: args.includes('--list'),
  });
  process.stdout.write(text);

  if (out !== undefined) {
    const byId = new Map(reading.rows.map((row) => [row.questionId, row]));
    const payload = {
      artifact: path,
      runs: reading.runs,
      headline: headlineIsOneRepetition(report, reading),
      reading: Object.fromEntries(
        capabilities.map((entry) => [
          entry.capability,
          {
            total: entry.total,
            baselinePerRun: entry.baselinePerRun,
            featurePerRun: entry.featurePerRun,
            gapPerRun: entry.gapPerRun,
            baselineOnlyPerRun: entry.baselineOnlyPerRun,
            featureOnlyPerRun: entry.featureOnlyPerRun,
            durableMiss: entry.durableMiss.map((id) => {
              const row = byId.get(id);
              const verdict = classify(row.gold, row.answer);
              return {
                questionId: id,
                class: verdict.klass,
                detail: verdict.detail,
                gold: row.gold,
                answer: row.answer,
              };
            }),
            durableWin: entry.durableWin.map((id) => {
              const row = byId.get(id);
              return { questionId: id, gold: row.gold, answer: row.answer };
            }),
            agreedWrong: entry.agreedWrong,
            contested: entry.contested,
            flapping: entry.flapping,
          },
        ]),
      ),
    };
    writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
  }
  return 0;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('paired-flip.mjs')) {
  process.exitCode = main(process.argv.slice(2));
}
