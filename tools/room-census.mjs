#!/usr/bin/env node
/**
 * What each route's room buys: capacity, gold coverage, and the accuracy that came out of it.
 *
 *     node tools/room-census.mjs <report.json> [...more] [--json]
 *     node tools/room-census.mjs --self-test
 *
 * ## Why the denominator is `effectivePromptChars` and not `maxPromptChars`
 *
 * The arm carries two width numbers and they mean different things. `maxPromptChars` is the product's
 * default for a route the table does not name; `maxPromptCharsByRoute` -- projected into the artifact as
 * `effectivePromptChars` -- is the room each route actually received, and the product reads the table
 * first (`memory.ts`: `named ?? maxPromptChars`). On the adopted arm the table names **all six** routes,
 * so the scalar is dead code for every one of them: 48,460 on `multi-session` and 24,000 on the rest.
 *
 * Dividing by the scalar instead produces a headline that is entirely an artefact of the mistake. It was
 * computed once while this file was being written -- "379 of 500 questions spend under 60% of the room" --
 * and it is false: the three routes it convicted are at 95-99% of **their own** room. The `room` column
 * below is printed for exactly that reason: a share of the wrong denominator looks like a finding.
 *
 * ## What the table is for
 *
 * The four columns are one question: *is the room the binding constraint?* A route whose delivered
 * characters sit at 99% of its room is spending everything it has, so its failures cannot be answered by
 * a better order -- only by a bigger room or by spending the same room on more, shorter turns. A route at
 * 40% has room it never used and its failures are somewhere else. And the gold column is what the room was
 * bought for: `carried / total` counts the gold turns that reached the reader, so a route that spends 99%
 * of its room and delivers half its gold is spending it on the wrong turns.
 *
 * ## Why the ordering is printed rather than asserted
 *
 * On the adopted arm the two rankings disagree: `MR` carries 98.5% of its gold and reads 89.3%, while `IE`
 * carries 58.3% and reads 94.0%. Neither number is wrong and the pair is the useful reading -- a route can
 * fail with every gold turn present (`MR`: nine of thirteen failures), and a route can succeed with half
 * of them absent (`IE`). This tool prints both orders side by side so the disagreement is visible, and it
 * does **not** assert which one is causal: that is a claim about mechanism, and a census cannot make it.
 *
 * ## What it refuses
 *
 * Three states make every number below meaningless, and each is refused with the reason rather than
 * computed around:
 *
 * - no `effectivePromptChars`, because the denominator of the `fill` column would be a guess;
 * - a route the record used but the table does not name, because the two disagree about the run;
 * - delivered characters above the room, which is not "over budget" but a pair of fields that cannot both
 *   be true, and a silent `> 100%` would be read as a measurement.
 */

import { readFileSync } from 'node:fs';

class Refusal extends Error {}

/**
 * The order routes are printed in, and it is `TURN_CAP_ROUTES`' own order rather than this file's taste.
 *
 * A copy of a constant is a claim that it still agrees, so `repo-gates.test.ts` reads both and fails when
 * they diverge -- the same gate `assemble-rooms.test.ts` is for the room table itself. Without it the
 * printed order would be a second opinion about a list the product owns, and a route added to the product
 * would appear at the end of this table under a heading that claims the product's order.
 */
const ROUTES = ['multi-session', 'temporal', 'flat', 'knowledge-update', 'abstention', 'assistant'];

function pad(value, width) {
  return String(value).padEnd(width);
}

function left(value, width) {
  return String(value).padStart(width);
}

/** Every question record across every file handed in, one population. */
function load(paths) {
  const records = [];
  let room = null;
  for (const path of paths) {
    const report = JSON.parse(readFileSync(path, 'utf8'));
    const questions = Array.isArray(report.questions) ? report.questions : null;
    if (questions === null) {
      throw new Refusal(`${path} carries no questions array`);
    }
    const table = report.memoryArmConfig?.effectivePromptChars;
    if (table === undefined || table === null) {
      // Without it the `fill` column has no denominator. `maxPromptChars` is a different number and using
      // it is the mistake this file's docblock records.
      throw new Refusal(
        `${path} carries no memoryArmConfig.effectivePromptChars: the room each route received is the ` +
          'denominator of every share below, and the scalar `maxPromptChars` is not that number',
      );
    }
    if (room !== null && JSON.stringify(room) !== JSON.stringify(table)) {
      throw new Refusal(
        `the files disagree about the room table: ${JSON.stringify(room)} against ${JSON.stringify(table)}. ` +
          'Two rooms is two experiments and one table would report an average of them',
      );
    }
    room = table;
    records.push(...questions.map((record) => ({ ...record, source: path })));
  }
  if (records.length === 0) throw new Refusal('the population is empty');
  return { records, room };
}

/** The census, grouped by the route the record actually took. */
function census(records, room) {
  const groups = new Map();
  for (const record of records) {
    const route = record.route;
    if (typeof route !== 'string' || route === '') {
      throw new Refusal(
        `question ${JSON.stringify(record.questionId)} names no route: the room it was given cannot be ` +
          'known, so its share of that room cannot be printed',
      );
    }
    if (room[route] === undefined) {
      throw new Refusal(
        `question ${JSON.stringify(record.questionId)} took route ${JSON.stringify(route)}, which the arm's ` +
          `room table does not name (${Object.keys(room).join(', ')}). The record and the configuration ` +
          'disagree about the run',
      );
    }
    const theRoom = room[route];
    const delivered = record.deliveredPromptChars;
    if (typeof delivered === 'number' && delivered > theRoom) {
      throw new Refusal(
        `question ${JSON.stringify(record.questionId)} delivered ${delivered} characters into a ` +
          `${theRoom}-character room. Both fields are in the same artifact and they cannot both be true`,
      );
    }
    const group = groups.get(route) ?? {
      route,
      room: theRoom,
      n: 0,
      correct: 0,
      turns: [],
      fill: [],
      goldCarried: 0,
      goldTotal: 0,
      failures: 0,
      failuresWithFullGold: 0,
    };
    group.n += 1;
    if (record.correct === true) group.correct += 1;
    else group.failures += 1;
    if (Array.isArray(record.turns)) group.turns.push(record.turns.length);
    if (typeof delivered === 'number') group.fill.push(delivered / theRoom);
    const gold = record.goldOverlap;
    if (gold !== null && gold !== undefined) {
      group.goldCarried += gold.carried;
      group.goldTotal += gold.total;
      if (record.correct !== true && gold.total > 0 && gold.carried === gold.total) {
        group.failuresWithFullGold += 1;
      }
    }
    groups.set(route, group);
  }
  return ROUTES.filter((route) => groups.has(route)).map((route) => groups.get(route));
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function render(groups) {
  const lines = [];
  lines.push(
    pad('route', 17) +
      left('n', 5) +
      left('room', 7) +
      left('turns', 7) +
      left('fill', 7) +
      left('gold', 11) +
      left('gold%', 7) +
      left('acc', 8) +
      left('fail', 6) +
      left('full', 6),
  );
  for (const group of groups) {
    const turns = median(group.turns);
    const fill = median(group.fill);
    const goldShare = group.goldTotal === 0 ? null : group.goldCarried / group.goldTotal;
    lines.push(
      pad(group.route, 17) +
        left(group.n, 5) +
        left(group.room, 7) +
        left(turns === null ? '-' : turns.toFixed(0), 7) +
        left(fill === null ? '-' : `${(fill * 100).toFixed(1)}%`, 7) +
        left(`${group.goldCarried}/${group.goldTotal}`, 11) +
        left(goldShare === null ? '-' : `${(goldShare * 100).toFixed(1)}%`, 7) +
        left(`${(100 * group.correct) / group.n}`.slice(0, 6), 8) +
        left(group.failures, 6) +
        left(group.failuresWithFullGold, 6),
    );
  }
  lines.push('');
  lines.push(
    "`fill` is deliveredPromptChars / the route's own room; `full` is failures whose gold arrived",
  );
  lines.push('complete, i.e. the reader had every gold turn and answered wrong anyway.');

  // The two orders, printed because they disagree and the disagreement is the reading.
  const ranked = groups.filter((group) => group.goldTotal > 0);
  const byGold = [...ranked].sort(
    (a, b) => b.goldCarried / b.goldTotal - a.goldCarried / a.goldTotal,
  );
  const byAccuracy = [...ranked].sort((a, b) => b.correct / b.n - a.correct / a.n);
  lines.push('');
  lines.push(`by gold coverage  ${byGold.map((group) => group.route).join(' > ')}`);
  lines.push(`by accuracy       ${byAccuracy.map((group) => group.route).join(' > ')}`);
  const same = byGold.every((group, index) => group.route === byAccuracy[index].route);
  lines.push(
    same
      ? 'the two orders agree: on this arm coverage predicts accuracy'
      : 'THE TWO ORDERS DISAGREE: a route can win accuracy while delivering half its gold, so coverage is ' +
          'not the mechanism and this table cannot name the one that is',
  );
  return lines;
}

function selfTest() {
  const question = (id, route, correct, delivered, turns, gold) => ({
    questionId: id,
    route,
    correct,
    deliveredPromptChars: delivered,
    turns: Array.from({ length: turns }, (_, index) => ({ index })),
    ...(gold === undefined ? {} : { goldOverlap: { carried: gold[0], total: gold[1] } }),
  });
  const room = { 'multi-session': 48460, flat: 24000 };
  const report = {
    memoryArmConfig: { effectivePromptChars: room },
    questions: [
      // A route at its ceiling with complete gold and a failure: the decision-institution shape.
      question('a', 'multi-session', false, 48000, 200, [12, 12]),
      question('b', 'multi-session', true, 48000, 210, [4, 4]),
      // A route with half its room spent and half its gold missing: the delivery-institution shape. It is
      // MORE accurate than the route above while delivering a third of its gold, which is the disagreement
      // the renderer has to print rather than smooth over.
      question('c', 'flat', true, 12000, 18, [3, 6]),
      question('d', 'flat', true, 12000, 20, [2, 6]),
      question('e', 'flat', false, 12000, 19, [0, 6]),
    ],
  };
  const groups = census(report.questions, room);
  const lines = render(groups);
  const text = lines.join('\n');
  const assert = (condition, message) => {
    if (!condition) throw new Error(`self-test: ${message}`);
  };
  assert(groups.length === 2, 'two routes, in the table order');
  assert(groups[0].route === 'multi-session', 'the order is the room-table order, not insertion');
  assert(groups[0].failuresWithFullGold === 1, 'a failure with every gold turn present is counted');
  assert(groups[1].failuresWithFullGold === 0, 'a failure with gold missing is not');
  assert(text.includes('THE TWO ORDERS DISAGREE'), 'the fixture is one where the orders differ');

  const refuse = (fn, pattern, message) => {
    let error = null;
    try {
      fn();
    } catch (thrown) {
      error = thrown;
    }
    assert(error instanceof Refusal, `${message}: refused`);
    assert(pattern.test(error.message), `${message}: and says why`);
  };
  refuse(
    () => census([{ ...question('h', 'flat', true, 100, 1), route: 'assistant' }], room),
    /does not name/,
    'a route the table does not name',
  );
  refuse(
    () => census([question('f', 'flat', true, 25000, 1)], room),
    /cannot both be true/,
    'delivered characters above the room',
  );
  refuse(
    () =>
      census(
        [{ questionId: 'g', route: '', correct: true, deliveredPromptChars: 1, turns: [] }],
        room,
      ),
    /names no route/,
    'a record with no route',
  );

  // The denominator itself: a share computed against `maxPromptChars` is a different number, and the
  // fixture is chosen so the two cannot be confused -- 12,000 is half of 24,000 and a quarter of 48,460.
  assert(Math.abs(groups[1].fill[0] - 0.5) < 1e-9, 'fill divides by the route own room');
  assert(
    groups[1].fill.every((share) => share <= 1),
    'and no route reports a share above one without being refused first',
  );

  process.stdout.write('room-census: self-test ok\n');
}

function main(argv) {
  if (argv.includes('--self-test')) {
    selfTest();
    return 0;
  }
  const json = argv.includes('--json');
  const paths = argv.filter((argument) => !argument.startsWith('--'));
  if (paths.length === 0) {
    process.stderr.write('usage: room-census.mjs <report.json> [...more] [--json]\n');
    return 1;
  }
  let groups;
  let room;
  try {
    const loaded = load(paths);
    room = loaded.room;
    groups = census(loaded.records, room);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    process.stderr.write(`refused: ${error.message}\n`);
    return 1;
  }
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          room,
          routes: groups.map((group) => ({
            ...group,
            turns: median(group.turns),
            fill: median(group.fill),
            accuracy: group.correct / group.n,
            goldShare: group.goldTotal === 0 ? null : group.goldCarried / group.goldTotal,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  process.stdout.write(`${render(groups).join('\n')}\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
