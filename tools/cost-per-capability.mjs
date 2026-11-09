#!/usr/bin/env node
/**
 * The bill, split by capability, off one artifact.
 *
 * `packages/cortex-eval/src/cost-per-capability.ts` owns the arithmetic and every refusal; this file
 * is the caller. The split matters because the two reasoning routes are allocated a window twice the
 * size of the other four, so a per-file token reading is wrong for every row — and because the
 * decision the reading feeds ("where does the next thousand tokens go") is a per-capability question
 * that no artifact answered before.
 *
 *     node tools/cost-per-capability.mjs --report path/to/ablation-report.json
 *     node tools/cost-per-capability.mjs --report ... --json
 *     node tools/cost-per-capability.mjs --report ... --no-prices
 *
 * ## Why the prices are imported rather than restated
 *
 * `DEEPSEEK_PRICES` in `spend-projection.mjs` carries its own `asOf` and `source` for the reason that
 * file states: a price is a fact with a date, and two copies of it drift. `--prices <path>` reads a
 * JSON object with the same three fields, for the day the provider's page changes or for a run that
 * was billed in another currency; `--no-prices` prints the token columns only, which is the reading
 * that survives a price change.
 */
import { readFileSync } from 'node:fs';

import { costPerCapability, renderCostByCapability } from '../packages/cortex-eval/dist/cost-per-capability.js';
import { DEEPSEEK_PRICES } from './spend-projection.mjs';

function fail(message) {
  process.stderr.write(`cost-per-capability: ${message}\n`);
  process.exit(2);
}

function parse(argv) {
  const options = { report: null, json: false, prices: DEEPSEEK_PRICES };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--report') {
      options.report = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (argument === '--no-prices') {
      options.prices = undefined;
      continue;
    }
    if (argument === '--prices') {
      const path = argv[index + 1];
      if (path === undefined) fail('--prices needs a path');
      try {
        options.prices = JSON.parse(readFileSync(path, 'utf8'));
      } catch (error) {
        fail(`--prices could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
      index += 1;
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

let reading;
try {
  reading = costPerCapability(report, { prices: options.prices });
} catch (error) {
  // The library's refusals already name their reason; quoting them back verbatim is the difference
  // between an operator who knows what to change and one who is told the artifact is bad.
  fail(error instanceof Error ? error.message.replace(/^cost-per-capability: /, '') : String(error));
}

if (options.json) {
  process.stdout.write(`${JSON.stringify(reading, null, 2)}\n`);
} else {
  process.stdout.write(`${renderCostByCapability(reading)}\n`);
  if (options.prices !== undefined) {
    const total = reading.rows.reduce((sum, row) => sum + (row.cost ?? 0), 0);
    const priced = `${options.prices.model ?? 'the reader'} at ${options.prices.asOf ?? 'undated prices'}`;
    process.stdout.write(`feature-side bill reconstructed from the rows: ${total.toFixed(3)} (${priced})\n`);
  }
}
