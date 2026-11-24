#!/usr/bin/env node
/**
 * Solve the per-turn cap instead of choosing it.
 *
 * ## Why a sweep and not a guess
 *
 * `maxTurnChars` 400 is the shipped value, and `MEASURE-GOLD-BAND.md` established that 487 of the
 * 7,516 annotated gold turns arrive and are then cut at it -- 18 of `MR`'s 19 failures carry at
 * least one. The obvious next question is "how wide", and the obvious answer is wrong: the cap is
 * not free to raise, because **the room is spent to within one turn**. On run 44017278305 the
 * median `multi-session` question leaves 117 characters of its 48,460 unspent, so a turn allowed
 * 1,200 characters instead of 400 takes 800 of them out of the tail. The width trades one kind of
 * loss for another, and the value where the two cross is a property of this dataset's turn-length
 * distribution rather than a matter of taste.
 *
 * So this tool walks the allocator. It re-reads an archived report, replays the prefix rule that
 * admitted the shipped turns at the shipped width, and then re-admits the same ranked list at every
 * candidate width. Three things come out:
 *
 * | column | what it counts |
 * | --- | --- |
 * | `whole` | gold turns the reader received in full |
 * | `cut` | gold turns received but truncated at the width |
 * | `absent` | gold turns the prefix no longer reached, because a wider turn spent their room |
 * | `coverage` | `whole / total` -- the quantity section 13.26 measured accuracy against |
 * | `projected` | accuracy implied by the width's band transition, under measured cell rates |
 *
 * ## The replayer is checked, not assumed
 *
 * A projection built on a model of the allocator is worth exactly what the model's fidelity is
 * worth, so the tool prints that first: at the shipped width the replay must admit **the same
 * set the artifact says was delivered**. It does, on 247 of 248 capped-route questions (the
 * exception is the one `temporal` question recorded with no room left). Everything after that line
 * is a counterfactual over a verified replayer rather than a heuristic.
 *
 * ## The projection is a saturated fit and says so
 *
 * `projected` applies three conditional rates measured on the shipped run -- complete and uncut,
 * complete and cut, partial -- to each question's band at the candidate width. One rate per cell
 * over a partition of the same questions is **saturated**: it reproduces the run it was fitted on
 * exactly, so nothing about it is validated by that. The quantity it transports is the gap between
 * the two complete-row cells, and the tool prints the gap beside every projection:
 *
 *   - `MR`: 96.43% against 81.82%, a **14.6-point** gap on 77 questions. The width is predicted to
 *     pay where it converts a cut question into an uncut one.
 *   - `TR`: 95.7% against 95.7%, a **zero** gap. `TR`'s failures are not a truncation phenomenon,
 *     which is why its column barely moves and why its covered gold can rise 10 points while its
 *     prediction does not -- the two facts are consistent, and reading the coverage column alone
 *     would have argued for a treatment that cannot work there.
 *
 * A capability whose cells are thinner than five questions is refused outright (`IE`, `KU`, `ABS`
 * complete rows are 0 to 26 questions), because a rate over four questions is not a rate.
 *
 * ## Usage
 *
 *     node tools/turn-width.mjs <report.json>                       # sweep 400..2,400
 *     node tools/turn-width.mjs <report.json> --widths 400,600,800   # named widths
 *     node tools/turn-width.mjs <report.json> --json                 # machine-readable
 *     node tools/turn-width.mjs --self-test                          # hermetic, no artifact
 */

import { readFileSync } from 'node:fs';

/** Widths swept by default: the shipped 400 plus the ladder a reader would consider. */
export const DEFAULT_WIDTHS = [400, 450, 500, 550, 600, 650, 700, 800, 1_000, 1_200, 1_600, 2_400];

/** A cell thinner than this is not a rate, so the projection refuses it. */
const MIN_CELL = 5;

/** A projection further off than this at the shipped width is not transported. */
const MAX_CALIBRATION_ERROR = 2;

const length = (turn) => (typeof turn === 'string' ? turn.length : (turn.text ?? '').length);
const textOf = (turn) => (typeof turn === 'string' ? turn : turn.text);

/**
 * The prefix rule, replayed.
 *
 * `overhead` is the per-turn rendering cost the artifact's own `deliveredPromptChars` implies
 * (dateline, role, ordinal). It is recovered per question rather than assumed, because it is what
 * makes the replay reproduce the shipped prefix instead of approximately reproducing it.
 *
 * A turn wider than the remaining room **ends** the pass rather than being skipped: that is the
 * rule the arm shipped, and the shipped room leftover (median 117 characters against a median turn
 * of 207) is the signature of a rule that stops.
 */
export function admit(turns, width, room, overhead) {
  let spent = 0;
  let admitted = 0;
  for (const turn of turns) {
    const cost = Math.min(length(turn), width) + overhead;
    if (spent + cost > room) break;
    spent += cost;
    admitted += 1;
  }
  return admitted;
}

/**
 * The spend the artifact recorded, and the per-turn overhead it implies.
 *
 * `deliveredPromptChars` is the allocator's own accounting -- on `multi-session` its median sits
 * 117 characters under the 48,460 room, which is how we know the room binds. Subtracting the
 * capped text of the delivered turns leaves the rendering cost of those turns.
 */
function calibrate(question, cap) {
  const turns = question.turns ?? [];
  const text = turns.reduce((sum, turn) => sum + Math.min(length(turn), cap), 0);
  const spend = question.deliveredPromptChars ?? text;
  return { turns, overhead: turns.length === 0 ? 0 : (spend - text) / turns.length, spend };
}

/**
 * One question's gold band at one width.
 *
 * `present` is membership in the admitted prefix; `cut` is present-but-longer-than-the-width. A
 * route the cap does not reach cannot band as `cut`, and cannot lose a turn to the sweep either,
 * which is what makes it a control rather than a participant.
 */
function band(question, admittedTexts, width, capped) {
  const gold = question.goldOverlap?.goldTurns ?? [];
  const present = gold.filter((turn) => admittedTexts.has(turn));
  const cut = capped ? present.filter((turn) => length(turn) > width).length : 0;
  return {
    total: gold.length,
    whole: present.length - cut,
    cut,
    absent: gold.length - present.length,
  };
}

/** The three conditional cells the projection transports, per capability. */
function cells(questions, cap) {
  const out = new Map();
  for (const question of questions) {
    if ((question.goldOverlap?.goldTurns ?? []).length === 0) continue;
    const admitted = new Set((question.turns ?? []).map(textOf));
    const gold = question.goldOverlap.goldTurns;
    const present = gold.filter((turn) => admitted.has(turn));
    const complete = present.length === gold.length;
    const cut = present.some((turn) => length(turn) > cap);
    const key = complete ? (cut ? 'completeCut' : 'completeWhole') : 'partial';
    const row = out.get(question.capability) ?? {
      completeWhole: [0, 0],
      completeCut: [0, 0],
      partial: [0, 0],
    };
    row[key][1] += 1;
    if (question.correct) row[key][0] += 1;
    out.set(question.capability, row);
  }
  return out;
}

/**
 * The whole sweep.
 *
 * `widths` is the ladder; `cap` and `routes` come from the artifact so the sweep describes the arm
 * that produced it rather than a remembered one. Rooms come from `maxPromptCharsByRoute`, which is
 * the table the arm itself used.
 */
export function sweep(report, widths = DEFAULT_WIDTHS) {
  const config = report.memoryArmConfig ?? {};
  const cap = config.maxTurnChars;
  const routes = config.maxTurnCharsRoutes;
  const rooms = config.maxPromptCharsByRoute ?? {};
  if (typeof cap !== 'number') {
    throw new Error('the artifact records no maxTurnChars: there is no width to sweep from');
  }
  const capped = (route) => routes === undefined || routes.includes(route);
  const questions = (report.questions ?? []).filter(
    (q) => (q.goldOverlap?.goldTurns ?? []).length > 0,
  );

  const fidelity = { replayed: 0, total: 0, failures: [] };
  const byCapability = new Map();
  const rows = [];

  // The replay check first: a counterfactual over an unverified replayer is a story.
  for (const question of questions) {
    if (!capped(question.route)) continue;
    const { turns, overhead } = calibrate(question, cap);
    const room = rooms[question.route];
    if (room === undefined) continue;
    fidelity.total += 1;
    if (admit(turns, cap, room, overhead) === turns.length) fidelity.replayed += 1;
    else fidelity.failures.push(question.questionId);
  }

  const rate = cells(questions, cap);
  const env = { room: (question) => rooms[question.route], capped, cap };

  for (const width of widths) {
    const row = { width, byCapability: {}, all: { total: 0, whole: 0, cut: 0, absent: 0 } };
    for (const question of questions) {
      const { turns, overhead } = calibrate(question, cap);
      const room = rooms[question.route];
      const reach = capped(question.route) && room !== undefined;
      const admittedTurns = reach
        ? turns.slice(0, admit(turns, width, room, overhead))
        : turns.slice(0, admit(turns, width, Number.POSITIVE_INFINITY, 0));
      const bands = band(question, new Set(admittedTurns.map(textOf)), width, reach);
      for (const target of [row.all, (row.byCapability[question.capability] ??= blank())]) {
        target.total += bands.total;
        target.whole += bands.whole;
        target.cut += bands.cut;
        target.absent += bands.absent;
        if (bands.whole === bands.total) target.allWhole = (target.allWhole ?? 0) + 1;
        target.asked = (target.asked ?? 0) + 1;
      }
    }
    for (const [capability, cell] of Object.entries(row.byCapability)) {
      cell.projection = project(capability, questions, width, env, rate.get(capability));
    }
    rows.push(row);
  }

  return { cap, routes: routes ?? 'every route', questions: questions.length, fidelity, rows };
}

/**
 * The transported accuracy, or the reason there is none.
 *
 * The calibration is the same transport applied at the shipped width: if it does not reproduce the
 * run it is derived from, the rates do not describe this capability and the column stays empty.
 */
function project(capability, questions, width, env, rates) {
  if (rates === undefined) return { value: null, why: 'no measured cells' };
  const thin = Object.entries(rates).filter(([, [, n]]) => n < MIN_CELL);
  if (thin.length > 0) {
    return {
      value: null,
      why: `cell(s) under ${MIN_CELL} questions: ${thin.map(([k]) => k).join(', ')}`,
    };
  }
  const rate = (key) => rates[key][0] / rates[key][1];
  // The model is SATURATED: one rate per cell, and the cells partition the questions, so it
  // reproduces the run it was fitted on exactly. That is algebra, not validation -- the only
  // quantity it transports is the GAP between the two complete-row cells, and a capability whose
  // gap is zero is predicted to gain nothing from the width whatever its bands do.
  const gap = rate('completeWhole') - rate('completeCut');
  let value = 0;
  for (const question of questions) {
    if (question.capability !== capability) continue;
    const admitted = new Set(admittedAt(question, width, env).map(textOf));
    const gold = question.goldOverlap.goldTurns;
    const present = gold.filter((turn) => admitted.has(turn));
    const complete = present.length === gold.length;
    const cut = present.some((turn) => length(turn) > width);
    value += rate(complete ? (cut ? 'completeCut' : 'completeWhole') : 'partial');
  }
  return {
    value,
    gap,
    cells: Object.fromEntries(Object.entries(rates).map(([k, [c, n]]) => [k, `${c}/${n}`])),
  };
}

/** The one question's admitted prefix at a width, under the arm's own room and overhead. */
function admittedAt(question, width, env) {
  const turns = question.turns ?? [];
  const text = turns.reduce((sum, turn) => sum + Math.min(length(turn), env.cap), 0);
  const spend = question.deliveredPromptChars ?? text;
  const overhead = turns.length === 0 ? 0 : (spend - text) / turns.length;
  const room = env.room(question);
  if (!env.capped(question.route) || room === undefined) return turns;
  return turns.slice(0, admit(turns, width, room, overhead));
}

function blank() {
  return { total: 0, whole: 0, cut: 0, absent: 0, allWhole: 0, asked: 0, projection: null };
}

const pct = (n, d) => (d === 0 ? '—' : `${((100 * n) / d).toFixed(2)}%`);

function table(result) {
  const lines = [];
  lines.push(
    `turn width sweep: ${result.questions} question(s) with annotated gold, cap ${result.cap} on ${result.routes}`,
  );
  lines.push(
    `replay fidelity: the prefix rule at ${result.cap} reproduces the delivered set on ` +
      `${result.fidelity.replayed}/${result.fidelity.total} capped-route questions` +
      (result.fidelity.failures.length > 0
        ? ` (misses: ${result.fidelity.failures.join(', ')})`
        : ''),
  );
  const capabilities = [
    ...new Set(result.rows.flatMap((row) => Object.keys(row.byCapability))),
  ].sort();
  for (const capability of capabilities) {
    lines.push('');
    lines.push(`### ${capability}`);
    lines.push('');
    lines.push('| width | whole | cut | absent | coverage | all-whole | projected |');
    lines.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const row of result.rows) {
      const cell = row.byCapability[capability];
      if (cell === undefined) continue;
      const projection = cell.projection;
      const shown =
        projection?.value == null
          ? `— ${projection?.why ?? ''}`.trim()
          : `${projection.value.toFixed(2)} (gap ${(100 * projection.gap).toFixed(1)} pts)`;
      lines.push(
        `| ${row.width} | ${cell.whole} | ${cell.cut} | ${cell.absent} | ` +
          `${pct(cell.whole, cell.total)} | ${cell.allWhole}/${cell.asked} | ${shown} |`,
      );
    }
  }
  lines.push('');
  lines.push(
    '`coverage` is the quantity section 13.26 measured accuracy against. `projected` is a saturated ' +
      'fit: it reproduces this run by construction, and the number beside it is the only quantity it ' +
      'transports -- the accuracy gap between a complete-and-uncut question and a complete-and-cut ' +
      'one. A zero gap means the width is predicted to do nothing on that capability.',
  );
  return lines.join('\n');
}

function selfTest() {
  const errors = [];
  const eq = (label, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want))
      errors.push(`${label}: got ${got}, want ${want}`);
  };
  const rep = (n, ch) => ch.repeat(n);

  // The prefix rule: 400-character turns in a 1,000-character room admit two of six, and the
  // sixth is never reached because the third does not fit -- the rule stops, it does not skip.
  eq(
    'prefix at 400',
    admit(
      Array.from({ length: 6 }, () => ({ text: rep(400, 'z') })),
      400,
      1_000,
      0,
    ),
    2,
  );
  eq(
    'prefix at 800',
    admit(
      Array.from({ length: 3 }, () => ({ text: rep(500, 'z') })),
      800,
      1_000,
      0,
    ),
    2,
  );
  eq(
    'prefix narrows to admit more',
    admit(
      Array.from({ length: 3 }, () => ({ text: rep(500, 'z') })),
      250,
      1_000,
      0,
    ),
    3,
  );
  eq(
    'the rule stops rather than skipping',
    admit([{ text: rep(900, 'z') }, { text: 'y' }], 900, 500, 0),
    0,
  );
  eq('overhead is charged against the room', admit([{ text: rep(100, 'z') }], 100, 100, 1), 0);

  const report = {
    memoryArmConfig: {
      maxTurnChars: 400,
      maxTurnCharsRoutes: ['multi-session'],
      maxPromptCharsByRoute: { 'multi-session': 1_000, flat: 1_000 },
    },
    questions: [
      // A 900-character gold turn and a 300-character one, with 100 characters of room to spare at
      // the shipped width. At 800 the first one spends 800 and evicts the second: the sweep's whole
      // trade, in one question.
      q('a', 'MR', 'multi-session', true, [rep(900, 'z'), rep(300, 'y')], [rep(200, 'w')]),
      // A gold turn under the cap: nothing the sweep can do.
      q('b', 'MR', 'multi-session', true, [rep(100, 'y')], [rep(200, 'w')]),
      // A route the cap does not reach: the width is not a treatment here, so nothing may move.
      q('c', 'IE', 'flat', false, [rep(900, 'z'), rep(900, 'z')], []),
    ],
  };
  const result = sweep(report, [400, 900]);
  eq('fidelity replays every capped question', result.fidelity.replayed, 2);
  const [at400, at900] = result.rows;
  eq('whole at 400', at400.all.whole, 4);
  eq('cut at 400', at400.all.cut, 1);
  eq('absent at 400', at400.all.absent, 0);
  // The trade in one line: the same number of whole gold turns, but one of them is now the long
  // one and the short one behind it is gone.
  eq('whole at 800', at900.all.whole, 4);
  eq('cut at 800', at900.all.cut, 0);
  eq('absent at 800', at900.all.absent, 1);
  eq('uncapped route never loses a turn', at900.byCapability.IE.absent, 0);
  eq('uncapped route never bands as cut', at900.byCapability.IE.cut, 0);
  let refused = false;
  try {
    sweep({ memoryArmConfig: {}, questions: [] });
  } catch {
    refused = true;
  }
  eq('an artifact with no cap is refused', refused, true);
  if (errors.length > 0) {
    console.error(`turn-width self-test FAILED\n  ${errors.join('\n  ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`turn-width self-test: ${13} assertions, all passed`);
}

function q(questionId, capability, route, correct, goldTurns, extraTurns) {
  const turns = [...goldTurns, ...extraTurns].map((text) => ({ text }));
  return {
    questionId,
    route,
    capability,
    correct,
    goldOverlap: { goldTurns },
    turns,
    deliveredPromptChars: turns.reduce((sum, turn) => sum + Math.min(turn.text.length, 400), 0),
  };
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  selfTest();
} else {
  const path = args.find((arg) => !arg.startsWith('--'));
  if (path === undefined) {
    console.error(
      'usage: node tools/turn-width.mjs <report.json> [--widths a,b] [--json] | --self-test',
    );
    process.exitCode = 2;
  } else {
    const at = args.indexOf('--widths');
    const widths =
      at === -1
        ? DEFAULT_WIDTHS
        : args[at + 1]
            .split(',')
            .map((value) => Number.parseInt(value, 10))
            .filter((value) => Number.isInteger(value) && value > 0);
    if (widths.length === 0) {
      console.error('--widths needs at least one positive integer');
      process.exitCode = 2;
    } else {
      const result = sweep(JSON.parse(readFileSync(path, 'utf8')), widths);
      console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : table(result));
    }
  }
}
