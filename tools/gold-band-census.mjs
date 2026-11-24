#!/usr/bin/env node
/**
 * Where the gold turns went, in three bands rather than two.
 *
 * ## The defect this file exists for
 *
 * `goldOverlap.carried` counts a gold turn as delivered when its text is **one of the units the
 * arm admitted** (`goldOverlapOf`, membership on `retrieved`). `retrieved` is the unbounded
 * context -- `question-record.ts` says so at `turns[].text`, which the memory arm carries
 * unbounded -- so a gold turn the renderer then cut at `maxTurnChars` is counted as carried
 * while the reader saw only its first N characters. `types.ts` records the anecdote that made
 * this visible: `a4996e51`'s decisive turn arrived and was cut mid-sentence at
 * `…I increase my work hours`, and "the artifact's coverage count still reports the turn as
 * delivered, which is true and does not help".
 *
 * An anecdote is not a population. This tool is the population: it re-reads an archived report
 * and splits every annotated gold turn three ways by what the reader actually received.
 *
 * | band | meaning |
 * | --- | --- |
 * | `whole` | admitted, and under the cap that reaches this route -- the reader saw all of it |
 * | `cut` | admitted, and longer than that cap -- the reader saw its first `cap` characters |
 * | `absent` | not admitted at all -- the room, or the ranking, or both |
 *
 * ## What it deliberately does not claim
 *
 * The bands are conditioned on the dataset's annotation, which names a handful of turns per
 * question, and on a cap whose *reach* is a list (`maxTurnCharsRoutes`). It cannot see the other
 * two hundred turns the reader also read, and it says nothing about whether a cut gold turn was
 * the one that mattered -- that is a question about the reader, and it needs a dispatch.
 *
 * It also refuses one configuration instead of guessing at it: under `resolution: 'layered'` the
 * bound on a turn is a *form ceiling* computed from the question (`resolveCappedTurn`), not the
 * cap, so a length comparison against `maxTurnChars` would mis-band every turn. The tool exits
 * with that sentence rather than printing a table.
 *
 * ## Usage
 *
 *     node tools/gold-band-census.mjs <report.json>          # human table
 *     node tools/gold-band-census.mjs <report.json> --json   # the same numbers, machine-readable
 *     node tools/gold-band-census.mjs --self-test            # hermetic, synthetic, no artifact
 */

import { readFileSync } from 'node:fs';

/** Bands, in the order they are reported. `cut` first because it is the one that reads as whole. */
const BANDS = ['whole', 'cut', 'absent'];

/**
 * The band one gold turn is in.
 *
 * `reach` is the caller's answer to "does the cap apply to this route", resolved once per
 * question rather than once per turn, because it is a property of the route.
 */
export function bandOf(gold, delivered, cap, reach) {
  if (!delivered.has(gold)) return 'absent';
  if (cap !== undefined && reach && gold.length > cap) return 'cut';
  return 'whole';
}

/**
 * The cap's reach, as the arm resolves it.
 *
 * `undefined` routes means every route, which is `CortexMemory.#capReaches`'s first branch and
 * is why the predicate is written the same way here rather than as `routes.includes(route)`.
 */
export function capReaches(routes, route) {
  return routes === undefined || routes.includes(route);
}

/**
 * One report's gold-turn census.
 *
 * Returns `questions: 0` for a report with no annotated gold rather than an empty table that
 * reads like a measured zero -- the same rule `goldOverlapOf` follows by returning `null`.
 */
export function census(report) {
  const config = report.memoryArmConfig ?? {};
  if (config.resolution === 'layered') {
    throw new Error(
      'resolution: layered bounds a turn by its form ceiling, not by maxTurnChars: the cap ' +
        'comparison this tool makes would mis-band every gold turn. No table is printed.',
    );
  }
  const cap = config.maxTurnChars;
  const routes = config.maxTurnCharsRoutes;

  /** @type {Map<string, Record<string, number>>} */
  const byCapability = new Map();
  const all = blank();
  let questions = 0;

  const bump = (row, band, correct) => {
    row[band] += 1;
    row.total += 1;
    if (!correct) row[`wrong_${band}`] += 1;
    if (!correct) row.wrongTotal += 1;
  };

  for (const question of report.questions ?? []) {
    const gold = question.goldOverlap?.goldTurns ?? [];
    if (gold.length === 0) continue;
    questions += 1;
    const delivered = new Set((question.turns ?? []).map((turn) => turn.text));
    const reach = capReaches(routes, question.route);
    const row = byCapability.get(question.capability) ?? blank();
    byCapability.set(question.capability, row);
    const bands = gold.map((turn) => bandOf(turn, delivered, cap, reach));
    // The cross-tab this tool exists for: does a question whose gold was cut read worse than one
    // whose gold arrived whole? It is a stratification, not an experiment -- see the header.
    const stratum = bands.includes('cut')
      ? 'hasCut'
      : bands.includes('absent')
        ? 'hasAbsent'
        : 'allWhole';
    for (const key of [row, all]) {
      key[stratum] += 1;
      if (question.correct) key[`${stratum}Correct`] += 1;
    }
    for (const band of bands) {
      bump(row, band, question.correct);
      bump(all, band, question.correct);
    }
  }

  return {
    cap,
    routes: routes === undefined ? 'every route' : [...routes],
    questions,
    all,
    byCapability: [...byCapability.entries()].sort(([a], [b]) => a.localeCompare(b)),
  };
}

function blank() {
  const row = { total: 0, wrongTotal: 0 };
  for (const band of BANDS) {
    row[band] = 0;
    row[`wrong_${band}`] = 0;
  }
  for (const stratum of ['allWhole', 'hasCut', 'hasAbsent']) {
    row[stratum] = 0;
    row[`${stratum}Correct`] = 0;
  }
  return row;
}

const pct = (n, d) => (d === 0 ? '—' : `${((100 * n) / d).toFixed(2)}%`);

function table(result) {
  const lines = [];
  lines.push(
    `gold-turn census: ${result.questions} question(s), cap ${result.cap ?? 'none'} on ${result.routes}`,
  );
  lines.push('');
  lines.push('| capability | gold | whole | cut | absent | cut/delivered | wrong | wrong cut |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const [name, row] of [...result.byCapability, ['**all**', result.all]]) {
    lines.push(
      `| ${name} | ${row.total} | ${row.whole} | ${row.cut} | ${row.absent} | ` +
        `${pct(row.cut, row.whole + row.cut)} | ${row.wrongTotal} | ${row.wrong_cut} |`,
    );
  }
  lines.push('');
  lines.push('| stratum | questions | correct |');
  lines.push('| --- | ---: | ---: |');
  for (const stratum of ['allWhole', 'hasCut', 'hasAbsent']) {
    lines.push(
      `| ${stratum} | ${result.all[stratum]} | ${pct(result.all[`${stratum}Correct`], result.all[stratum])} |`,
    );
  }
  lines.push('');
  lines.push(
    'Per-capability strata are in `--json`; the aggregate row is here because a stratum whose ' +
      'size is a function of the route is not a rate.',
  );
  return lines.join('\n');
}

function selfTest() {
  const mk = (route, correct, golds, delivered) => ({
    capability: 'MR',
    route,
    correct,
    goldOverlap: { goldTurns: golds },
    turns: delivered.map((text) => ({ text })),
  });
  const long = `${'x'.repeat(500)}`;
  const short = `${'y'.repeat(100)}`;
  const result = census({
    memoryArmConfig: { maxTurnChars: 400, maxTurnCharsRoutes: ['multi-session'] },
    questions: [
      mk('multi-session', true, [short], [short]),
      mk('multi-session', false, [long], [long]),
      mk('multi-session', false, [short], []),
      mk('temporal', false, [long], [long]),
    ],
  });
  const errors = [];
  const eq = (label, got, want) => {
    if (got !== want) errors.push(`${label}: got ${got}, want ${want}`);
  };
  eq('whole', result.all.whole, 2);
  eq('cut', result.all.cut, 1);
  eq('absent', result.all.absent, 1);
  eq('wrong cut', result.all.wrong_cut, 1);
  eq('hasCut', result.all.hasCut, 1);
  eq('hasCutCorrect', result.all.hasCutCorrect, 0);
  eq('hasAbsent', result.all.hasAbsent, 1);
  // Two questions read all-whole: the short one, and the `temporal` one the cap does not reach.
  eq('allWhole', result.all.allWhole, 2);
  // A route the cap does not reach cannot band as `cut`, whatever the turn's length: the
  // `temporal` question above carries a 500-character gold turn and is counted `whole`.
  eq('uncapped route banded whole', result.all.whole, 2);
  let refused = false;
  try {
    census({ memoryArmConfig: { resolution: 'layered' }, questions: [] });
  } catch {
    refused = true;
  }
  eq('layered refused', refused, true);
  if (errors.length > 0) {
    console.error(`gold-band-census self-test FAILED\n  ${errors.join('\n  ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('gold-band-census self-test: 10 assertions, all passed');
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  selfTest();
} else {
  const path = args.find((arg) => !arg.startsWith('--'));
  if (path === undefined) {
    console.error('usage: node tools/gold-band-census.mjs <report.json> [--json] | --self-test');
    process.exitCode = 2;
  } else {
    const result = census(JSON.parse(readFileSync(path, 'utf8')));
    console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : table(result));
  }
}
