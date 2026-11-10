#!/usr/bin/env node
/**
 * Which failures are real, and what a mechanism can actually convert.
 *
 * `packages/cortex-eval/src/failure-stability.ts` owns the partition and the ceiling arithmetic;
 * this file is the caller. It exists because the queue's every ceiling was priced against **one
 * repetition's failure list**, and the artifact has carried the data that corrects it since
 * §13.118.5: `ablation.featureCorrectByRun` is one `'0'`/`'1'` mask per repetition, in dataset order.
 *
 *     node tools/failure-stability.mjs --report path/to/ablation-report.json
 *     node tools/failure-stability.mjs --report ... --capability MR
 *     node tools/failure-stability.mjs --report ... --capability MR --targets queue.json
 *     node tools/failure-stability.mjs --report ... --json
 *
 * `--targets` is a JSON object of `mechanism name -> question ids`, and it is the form the reading
 * is meant to be consumed in: a mechanism whose target set is named is a mechanism whose ceiling can
 * be computed before it is dispatched, which is the whole point. A target with an id the artifact
 * does not carry is a refusal from the library rather than a silently smaller set.
 */
import { readFileSync } from 'node:fs';

import {
  conversionCeiling,
  renderCeilings,
  renderStability,
  repetitionNull,
  stabilityOf,
} from '../packages/cortex-eval/dist/failure-stability.js';

function fail(message) {
  process.stderr.write(`failure-stability: ${message}\n`);
  process.exit(2);
}

function parse(argv) {
  const options = { report: null, capability: undefined, targets: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--report') {
      options.report = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (argument === '--capability') {
      options.capability = argv[index + 1] ?? undefined;
      index += 1;
      continue;
    }
    if (argument === '--targets') {
      const path = argv[index + 1];
      if (path === undefined) fail('--targets needs a path');
      try {
        options.targets = JSON.parse(readFileSync(path, 'utf8'));
      } catch (error) {
        fail(
          `--targets could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      index += 1;
      continue;
    }
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    fail(`unrecognised argument ${argument}`);
  }
  if (options.report === null) fail('--report <path> is required');
  return options;
}

const options = parse(process.argv.slice(2));

let report;
try {
  report = JSON.parse(readFileSync(options.report, 'utf8'));
} catch (error) {
  fail(
    `could not read ${options.report}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

const selection = options.capability === undefined ? {} : { capability: options.capability };

let reading;
let nullReading;
try {
  reading = stabilityOf(report, selection);
  nullReading = repetitionNull(report, selection);
} catch (error) {
  // The library's refusals already name their reason; quoting them back verbatim is the difference
  // between an operator who knows what to change and one who is told the artifact is bad.
  fail(error instanceof Error ? error.message.replace(/^failure-stability: /, '') : String(error));
}

const ceilings = [];
if (options.targets !== null) {
  const byId = new Map();
  for (const question of reading.questions) {
    if (question.questionId !== undefined) byId.set(question.questionId, question.index);
  }
  for (const [label, ids] of Object.entries(options.targets)) {
    if (!Array.isArray(ids)) fail(`target ${label} must be an array of question ids`);
    const indices = ids.map((id) => {
      const index = byId.get(id);
      if (index === undefined) {
        fail(
          `target ${label} names ${id}, which is not in the ${reading.population}-question population`,
        );
      }
      return index;
    });
    ceilings.push(conversionCeiling(reading, label, indices, nullReading.twoSd));
  }
}

if (options.json) {
  process.stdout.write(
    `${JSON.stringify(
      {
        population: selection.capability ?? 'all',
        repetitions: reading.repetitions,
        questions: reading.population,
        meanAccuracy: reading.meanAccuracy,
        recoverable: reading.recoverable,
        stableFailures: reading.stableFailures.length,
        flaky: reading.flaky.length,
        stablePasses: reading.stablePasses.length,
        perRepetition: nullReading.perRepetition,
        nullSd: nullReading.sd,
        nullTwoSd: nullReading.twoSd,
        ceilings,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

process.stdout.write(`${renderStability(reading)}\n`);
process.stdout.write(
  `repetition spread ${nullReading.perRepetition.join(' / ')} -> sd ${nullReading.sd.toFixed(2)}, ` +
    `2 sd ${nullReading.twoSd.toFixed(2)} questions\n`,
);
if (ceilings.length > 0) {
  process.stdout.write(`\n${renderCeilings(ceilings)}\n`);
}
