#!/usr/bin/env node
/**
 * What a room-filling selection could recover, computed from an artifact and from nothing else.
 *
 * ## Why this exists before the dispatch rather than after it
 *
 * `MEASURE-UNSPENT-ROOM.md` prices a change whose cost is **zero tokens**: `selectByRelevance` returns
 * the largest fitting prefix, so a turn that does not fit ends the pass and the room behind it is
 * returned to nobody. Spending it costs nothing because the room was already bought. The only open
 * question is whether anything is there to spend it on, and that question is arithmetic over an
 * artifact -- the gold ranks, the gold lengths and the room each question was given. Answering it with
 * a dispatch would be buying a reading that was already on disk.
 *
 * ## What the number is, and what it is not
 *
 * **An upper bound, and it is labelled one everywhere it is printed.** The walk below spends the whole
 * unspent room on gold, in rank order, as if no other turn competed for it. On a real fill the turns
 * between two gold segments are bought first and consume the room, so the true recovery is somewhere
 * between zero and this. A tool that printed the two ends as one number would be inventing the answer
 * to the question it exists to size.
 *
 * ## The three things it refuses
 *
 * An artifact with no `goldRanks` cannot say which gold was reachable; one with no
 * `deliveredPromptChars` cannot say how much room went unspent; one with no per-route room cannot say
 * what the room was. Each refusal names the field, because the alternative -- defaulting any of them to
 * zero -- produces the one number this file exists to stop being produced by hand.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export class Refusal extends Error {}

const NEEDED = ['goldRanks', 'goldDelivered'];

/**
 * The room each route was given, refusing a report that does not say.
 *
 * `effectivePromptChars` is preferred when present, because it is the pinned value the run actually
 * used; the route map is the fallback for the older artifacts that carry only that.
 */
function roomsOf(config) {
  const byRoute = config?.effectivePromptChars ?? config?.maxPromptCharsByRoute;
  if (byRoute === undefined || typeof byRoute !== 'object') {
    throw new Refusal(
      'no per-route room: the report carries neither `effectivePromptChars` nor `maxPromptCharsByRoute`, ' +
        'so there is no budget to compare a delivered prompt against',
    );
  }
  return byRoute;
}

/**
 * One question's arithmetic.
 *
 * `gap` is the honest way to say "how far out of reach this was": the best missing gold's rank minus
 * the number of turns the window held. Zero means the gold was the **very next turn** -- one more turn
 * of room would have delivered it -- and it is the sharpest single number this tool produces, because
 * it separates "the room was almost enough" from "the ranking put it 200 places away".
 */
function questionOf(question, room) {
  const overlap = question.goldOverlap;
  if (!overlap || !Array.isArray(overlap.goldTurns) || overlap.goldTurns.length === 0) return null;
  for (const field of NEEDED) {
    if (overlap[field] === undefined) {
      throw new Refusal(
        `question ${question.questionId} has no \`goldOverlap.${field}\`: this artifact predates the field, ` +
          'and a missing rank is not rank zero',
      );
    }
  }
  if (typeof question.deliveredPromptChars !== 'number') {
    throw new Refusal(
      `question ${question.questionId} has no \`deliveredPromptChars\`: the unspent room is a ' +
        'subtraction and this report holds only one of its two terms`,
    );
  }

  const missing = overlap.goldTurns
    .map((text, index) => ({ text, index }))
    .filter(({ index }) => overlap.goldDelivered[index] !== true);
  if (missing.length === 0) return null;

  // Rank order, and a rank the ranking never produced sorts last: `-1` is "not surfaced", which is a
  // different fact from "surfaced late" and must not be read as rank minus one.
  const ordered = [...missing].sort((a, b) => {
    const left = overlap.goldRanks[a.index];
    const right = overlap.goldRanks[b.index];
    return (left < 0 ? Number.MAX_SAFE_INTEGER : left) - (right < 0 ? Number.MAX_SAFE_INTEGER : right);
  });

  const slack = room - question.deliveredPromptChars;
  let left = Math.max(0, slack);
  let recoverable = 0;
  let recoverableChars = 0;
  for (const { index } of ordered) {
    const length = overlap.goldTurns[index].length;
    if (length <= left) {
      left -= length;
      recoverable += 1;
      recoverableChars += length;
    }
  }

  const held = Array.isArray(question.turns) ? question.turns.length : 0;
  const ranks = ordered.map(({ index }) => overlap.goldRanks[index]).filter((rank) => rank >= 0);

  return {
    questionId: question.questionId,
    route: question.route,
    capability: question.capability,
    correct: question.correct === true,
    room,
    held,
    slack,
    missing: missing.length,
    recoverable,
    recoverableChars,
    // Null rather than a number when the ranking never surfaced a missing segment: the gap is then
    // unbounded by the room and a number would imply it could be closed by buying one.
    gap: ranks.length === 0 ? null : Math.min(...ranks) - held,
    wholeGap: ranks.length === 0 ? null : Math.max(...ranks) - held,
  };
}

/**
 * The whole census: per question, per route, and the two totals that matter.
 *
 * The totals are kept apart on purpose. `questionsGainingGold` counts every question the fill could
 * move; `wrongGainingGold` counts the ones that would gain gold **and are wrong**, which is the only
 * population that can move an accuracy number, and the difference between the two is the size of the
 * confounding this campaign has already been bitten by -- on the published artifact a question with an
 * absent gold reads *higher* than one whose gold arrived whole.
 */
export function census(report) {
  const rooms = roomsOf(report.memoryArmConfig ?? {});
  const rows = [];
  for (const question of report.questions ?? []) {
    const room = rooms[question.route];
    if (typeof room !== 'number') {
      throw new Refusal(
        `route \`${question.route}\` has no room: the map names ${Object.keys(rooms).join(', ')}, and a ` +
          'question measured against a room it was not given would be arithmetic about nothing',
      );
    }
    const row = questionOf(question, room);
    if (row !== null) rows.push(row);
  }

  const byRoute = new Map();
  const blank = () => ({
    questions: 0,
    wrong: 0,
    questionsGainingGold: 0,
    wrongGainingGold: 0,
    fullyRecovered: 0,
    wrongFullyRecovered: 0,
    slackTotal: 0,
    recoverableChars: 0,
  });
  const all = blank();
  for (const row of rows) {
    for (const key of [byRoute.get(row.route) ?? blank(), all]) {
      key.questions += 1;
      if (!row.correct) key.wrong += 1;
      key.slackTotal += row.slack;
      if (row.recoverable > 0) {
        key.questionsGainingGold += 1;
        key.recoverableChars += row.recoverableChars;
        if (!row.correct) key.wrongGainingGold += 1;
      }
      if (row.recoverable === row.missing) {
        key.fullyRecovered += 1;
        if (!row.correct) key.wrongFullyRecovered += 1;
      }
    }
    byRoute.set(row.route, byRoute.get(row.route) ?? blank());
  }
  return { rows, byRoute: [...byRoute.entries()].sort(([a], [b]) => a.localeCompare(b)), all };
}

const pct = (part, whole) => (whole === 0 ? 'n/a' : `${((100 * part) / whole).toFixed(1)}%`);

export function table(result) {
  const lines = [];
  lines.push(
    `unspent room: ${result.rows.length} question(s) with a missing gold, ` +
      `${result.all.slackTotal.toLocaleString('en-US')} characters standing unspent`,
  );
  lines.push('');
  lines.push('| route | questions | wrong | slack mean | gain gold | of them wrong | fully | of them wrong |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const [name, row] of [...result.byRoute, ['**all**', result.all]]) {
    lines.push(
      `| ${name} | ${row.questions} | ${row.wrong} | ${Math.round(row.slackTotal / Math.max(1, row.questions))} | ` +
        `${row.questionsGainingGold} | ${row.wrongGainingGold} | ${row.fullyRecovered} | ${row.wrongFullyRecovered} |`,
    );
  }
  lines.push('');
  lines.push('`gain gold` = the fill could deliver at least one more gold segment, spending the room it');
  lines.push('already had. `fully` = every missing segment of that question fits. Both are **upper bounds**:');
  lines.push('the walk spends the whole slack on gold and no other turn competes for it.');
  lines.push('');
  lines.push('| question | route | correct | held | slack | missing | recoverable | gap |');
  lines.push('| --- | --- | :---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of [...result.rows].sort((a, b) => (a.gap ?? 1e9) - (b.gap ?? 1e9))) {
    lines.push(
      `| ${row.questionId} | ${row.route} | ${row.correct ? 'yes' : 'no'} | ${row.held} | ${row.slack} | ` +
        `${row.missing} | ${row.recoverable} | ${row.gap ?? 'unranked'} |`,
    );
  }
  lines.push('');
  lines.push("`gap` = the best missing gold's rank minus the turns the window held. Zero means one more");
  lines.push('turn of room would have delivered it; a positive number is what buying room has to close.');
  lines.push('');
  lines.push(
    `wrong questions that gain gold: **${result.all.wrongGainingGold}**, of which fully recovered: ` +
      `**${result.all.wrongFullyRecovered}**. Both are upper bounds, and neither is a rate: the ` +
      'denominator is the run\'s question count rather than this table\'s population, which holds only ' +
      'the questions that are missing something.',
  );
  return lines.join('\n');
}

function selfTest() {
  const errors = [];
  const eq = (label, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      errors.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };

  const q = (id, route, correct, gold, delivered, ranks, deliveredChars, held = 10) => ({
    questionId: id,
    route,
    capability: 'MR',
    correct,
    deliveredPromptChars: deliveredChars,
    turns: Array.from({ length: held }, () => ({ text: 'x' })),
    goldOverlap: { goldTurns: gold, goldDelivered: delivered, goldRanks: ranks },
  });
  // Lengths are the fixture's, not the artifact's: a gold segment is a paragraph and the arithmetic is
  // about how many paragraphs the unspent room holds, so a two-character marker would make every
  // fixture fit and every assertion vacuous.
  const seg = (tag, length) => `${tag}${'x'.repeat(length - tag.length)}`;
  const report = {
    memoryArmConfig: { maxPromptCharsByRoute: { flat: 10_000, temporal: 10_000 } },
    questions: [
      // Slack 5,000 and two segments of 1,000 and 4,000 in rank order: both fit, one at a time.
      q('a', 'flat', false, [seg('g1', 120), seg('g2', 1_000), seg('g3', 4_000)], [true, false, false], [0, 11, 12], 5_000, 10),
      // Slack 500 and a 900-character segment: nothing fits, and this is the population no amount of
      // careful filling can move.
      q('b', 'flat', false, [seg('h1', 900)], [false], [40], 9_500, 10),
      // Already whole: not in the population at all, and a row for it would inflate every denominator.
      q('c', 'flat', true, [seg('i1', 40)], [true], [0], 9_000, 10),
      // A missing gold the ranking never surfaced: gap is null rather than minus one.
      q('d', 'temporal', true, [seg('j1', 90)], [false], [-1], 9_900, 10),
    ],
  };
  const result = census(report);
  eq('population', result.rows.length, 3);
  eq('a recovers both', result.rows.find((r) => r.questionId === 'a').recoverable, 2);
  eq('a gap is one past the window', result.rows.find((r) => r.questionId === 'a').gap, 1);
  eq('b recovers nothing', result.rows.find((r) => r.questionId === 'b').recoverable, 0);
  eq('d gap is null when unranked', result.rows.find((r) => r.questionId === 'd').gap, null);
  eq('only a and b count as wrong', result.all.wrong, 2);
  eq('only a gains gold', result.all.wrongGainingGold, 1);
  eq('only a is fully recovered', result.all.wrongFullyRecovered, 1);
  eq('slack is summed', result.all.slackTotal, 5_000 + 500 + 100);

  const refused = (label, mutate) => {
    const copy = JSON.parse(JSON.stringify(report));
    mutate(copy);
    let hit = false;
    try {
      census(copy);
    } catch (error) {
      hit = error instanceof Refusal;
    }
    eq(label, hit, true);
  };
  refused('no room map at all', (copy) => {
    delete copy.memoryArmConfig.maxPromptCharsByRoute;
  });
  refused('a route with no room', (copy) => {
    copy.questions[0].route = 'nowhere';
  });
  refused('no delivered prompt', (copy) => {
    delete copy.questions[0].deliveredPromptChars;
  });
  refused('no ranks', (copy) => {
    delete copy.questions[0].goldOverlap.goldRanks;
  });

  if (errors.length > 0) {
    console.error(`turn-fill-ceiling self-test FAILED\n  ${errors.join('\n  ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('turn-fill-ceiling self-test: 12 assertions, all passed');
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    selfTest();
  } else {
    const path = args.find((arg) => !arg.startsWith('--'));
    if (path === undefined) {
      console.error('usage: node tools/turn-fill-ceiling.mjs <report.json> [--json] | --self-test');
      process.exitCode = 2;
    } else {
      const result = census(JSON.parse(readFileSync(path, 'utf8')));
      console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : table(result));
    }
  }
}
