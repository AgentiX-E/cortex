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
import { fileURLToPath } from 'node:url';

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
  // `cut` needs the cap; `absent` does not. `bandOf` decides delivery **before** it looks at the cap,
  // so under `layered` -- where a turn's bound is a form ceiling computed from the question
  // (`resolveCappedTurn`) rather than `maxTurnChars` -- the width columns are unmeasurable and the
  // delivery column is exact. Refusing the table refused a column that was never in question, and
  // every published artifact is written in exactly this configuration.
  const bandsResolvable = config.resolution !== 'layered';
  const cap = bandsResolvable ? config.maxTurnChars : undefined;
  const routes = config.maxTurnCharsRoutes;

  /** @type {Map<string, Record<string, number>>} */
  const byCapability = new Map();
  /** @type {Map<string, Record<string, number>>} */
  const byRoute = new Map();
  const all = blank();
  let questions = 0;

  const bump = (row, band, correct) => {
    row[band] += 1;
    row.total += 1;
    // A `whole` or a `cut` segment was delivered; `absent` was not. This is the denominator the
    // route table prints, so it has to be the same predicate `bandOf` uses and not a second one.
    if (band !== 'absent') row.deliveredSegments += 1;
    if (!correct) row[`wrong_${band}`] += 1;
    if (!correct) row.wrongTotal += 1;
  };

  for (const question of report.questions ?? []) {
    const gold = question.goldOverlap?.goldTurns ?? [];
    if (gold.length === 0) continue;
    questions += 1;
    const overlap = question.goldOverlap;
    const delivered = new Set((question.turns ?? []).map((turn) => turn.text));
    const reach = capReaches(routes, question.route);
    const row = byCapability.get(question.capability) ?? blank();
    byCapability.set(question.capability, row);
    const routeRow = byRoute.get(question.route) ?? blank();
    byRoute.set(question.route, routeRow);
    // `opaque` is a delivered segment whose width this configuration cannot band. It is not a band:
    // it never enters `whole` or `cut`, and it is counted so that the two columns plus `absent` still
    // account for every gold segment in the artifact.
    const bands = gold.map((turn) => {
      if (!delivered.has(turn)) return 'absent';
      if (!bandsResolvable) return 'opaque';
      if (cap !== undefined && reach && turn.length > cap) return 'cut';
      return 'whole';
    });
    // The split this round added. A gold turn is missing either because the ranking never surfaced it
    // (a retrieval repair) or because it surfaced and the window's ranked prefix ran out (a selection
    // repair). On the 500-question artifact those numbers are **0 and 2,256**, so the institution the
    // queue called *delivery* is a ranking distance and no window sizing reaches it. A report with no
    // `goldRanks` is counted apart rather than assigned to either branch: the field arrived with the
    // ranking, and defaulting it would invent the one number the split exists to produce.
    bands.forEach((band, index) => {
      if (band !== 'absent') return;
      const rank = overlap?.goldRanks?.[index];
      for (const key of [row, routeRow, all]) {
        if (rank === undefined) key.absentUnattributable += 1;
        else if (rank < 0) key.absentNeverRanked += 1;
        else key.absentBeyondCut += 1;
      }
    });
    // The cross-tab this tool exists for: does a question whose gold was cut read worse than one
    // whose gold arrived whole? It is a stratification, not an experiment -- see the header.
    const stratum = bands.includes('cut')
      ? 'hasCut'
      : bands.includes('absent')
        ? 'hasAbsent'
        : 'allWhole';
    for (const key of [row, routeRow, all]) {
      key[stratum] += 1;
      if (question.correct) key[`${stratum}Correct`] += 1;
    }
    for (const band of bands) {
      if (band === 'opaque') {
        for (const key of [row, routeRow, all]) {
          key.deliveredSegments += 1;
          key.total += 1;
          if (!question.correct) key.wrongTotal += 1;
        }
        continue;
      }
      bump(row, band, question.correct);
      bump(routeRow, band, question.correct);
      bump(all, band, question.correct);
    }
  }

  const finalize = (row) => {
    // `null` and not `0` for a column this configuration cannot take: zero is a measurement, and the
    // whole point of the refusal's narrower form is that it must not print one here.
    if (bandsResolvable) return row;
    return { ...row, whole: null, cut: null, wrong_whole: null, wrong_cut: null, hasCut: 0, hasCutCorrect: 0 };
  };

  return {
    cap,
    routes: routes === undefined ? 'every route' : [...routes],
    bandsResolvable,
    questions,
    all: finalize(all),
    byCapability: [...byCapability.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, row]) => [name, finalize(row)]),
    byRoute: [...byRoute.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, row]) => [name, finalize(row)]),
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
  // Every gold segment accounted for: `deliveredSegments` + `absent` === `total`.
  row.deliveredSegments = 0;
  // The three causes of `absent`, which sum to it. See `census` for why they are not one number.
  row.absentBeyondCut = 0;
  row.absentNeverRanked = 0;
  row.absentUnattributable = 0;
  return row;
}

const pct = (n, d) => (d === 0 ? '—' : `${((100 * n) / d).toFixed(2)}%`);

const width = (row) => (row.whole === null ? 'n/a' : `${row.whole} / ${row.cut}`);

function table(result) {
  const lines = [];
  lines.push(
    `gold-turn census: ${result.questions} question(s), cap ${result.cap ?? 'none'} on ${result.routes}`,
  );
  if (!result.bandsResolvable) {
    lines.push(
      'width columns are n/a: under `resolution: layered` a turn is bounded by its form ceiling, ' +
        'not by `maxTurnChars`. The delivery column does not consult the cap and is exact.',
    );
  }
  lines.push('');
  lines.push('| route | gold | delivered | absent | beyond-cut | never-ranked | unexplained | delivered% |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const [name, row] of [...result.byRoute, ['**all**', result.all]]) {
    lines.push(
      `| ${name} | ${row.total} | ${row.deliveredSegments} | ${row.absent} | ${row.absentBeyondCut} | ` +
        `${row.absentNeverRanked} | ${row.absentUnattributable} | ` +
        `${pct(row.deliveredSegments, row.total)} |`,
    );
  }
  lines.push('');
  lines.push("`beyond-cut` = the ranking surfaced it and the window's ranked prefix ran out.");
  lines.push('`never-ranked` = the ranking never surfaced it. Different repair, different institution.');
  lines.push('');
  lines.push('| capability | gold | width whole/cut | absent | beyond-cut | never-ranked | wrong | wrong absent |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const [name, row] of [...result.byCapability, ['**all**', result.all]]) {
    lines.push(
      `| ${name} | ${row.total} | ${width(row)} | ${row.absent} | ${row.absentBeyondCut} | ` +
        `${row.absentNeverRanked} | ${row.wrongTotal} | ${row.wrong_absent} |`,
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
  // `layered` was refused outright until this round, and every published artifact is written in it.
  // The width columns are unmeasurable there; the delivery column never was.
  const layered = census({
    memoryArmConfig: { resolution: 'layered' },
    questions: [mk('temporal', false, [short], [])],
  });
  eq('layered is read rather than refused', layered.bandsResolvable, false);
  eq('layered still counts an absent gold', layered.all.absent, 1);
  eq('layered width is null rather than zero', layered.all.whole, null);
  eq('layered cut is null rather than zero', layered.all.cut, null);
  eq('a delivered gold is still counted under layered', layered.all.deliveredSegments, 0);

  // The three causes of `absent`, kept apart because they name three different repairs.
  const withRanks = (route, golds, delivered, ranks) => ({
    capability: 'MR',
    route,
    correct: false,
    goldOverlap: {
      goldTurns: golds,
      ...(ranks === undefined ? {} : { goldRanks: ranks, goldDelivered: golds.map((g) => delivered.includes(g)) }),
    },
    turns: delivered.map((text) => ({ text })),
  });
  const why = census({
    memoryArmConfig: { maxTurnChars: 400 },
    questions: [
      withRanks('temporal', ['g1', 'g2', 'g3'], ['g1'], [0, 141, -1]),
      withRanks('flat', ['h1'], []),
    ],
  });
  eq('beyond-cut', why.all.absentBeyondCut, 1);
  eq('never-ranked', why.all.absentNeverRanked, 1);
  eq('unattributable', why.all.absentUnattributable, 1);
  eq('absent is the sum of its causes', why.all.absent, 3);
  eq(
    'the buckets account for every absent segment',
    why.all.absentBeyondCut + why.all.absentNeverRanked + why.all.absentUnattributable,
    why.all.absent,
  );
  const byRoute = Object.fromEntries(why.byRoute);
  eq('beyond-cut lives on its own route', byRoute.temporal.absentBeyondCut, 1);
  eq('a report with no ranks is unattributable on its route', byRoute.flat.absentUnattributable, 1);
  eq('delivered segments are counted apart from absent', byRoute.temporal.deliveredSegments, 1);

  if (errors.length > 0) {
    console.error(`gold-band-census self-test FAILED\n  ${errors.join('\n  ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('gold-band-census self-test: 20 assertions, all passed');
}

// Guarded, because the tests import `census` and an unguarded tail would print a usage line into
// every one of those imports and set a non-zero exit code on a successful import.
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
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
}
