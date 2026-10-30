#!/usr/bin/env node
/**
 * Price a time-window reorder before it is dispatched, and check the two criteria a
 * dispatched run has to meet.
 *
 * ## What the mechanism is, and why it needs pricing
 *
 * §13.151 read the reference pipeline's `temp_query_search_pruning.py`: infer a date range from
 * the question, then move the items inside that range to the front of the list retrieval already
 * produced. The move is a **permutation**, so it cannot deliver a turn that was not delivered --
 * which is what makes it registrable as one increment rather than three (§13.137.2's warning).
 *
 * What it costs is an inference call per question, and §13.151.4 priced that from a **proxy**: the
 * share of questions whose text carries a period reference (70/500, +9.7%). A proxy is not a
 * measurement, and the arm has two better instruments for the same question that cost nothing:
 *
 *   - the turn's own text carries `[YYYY/MM/DD (Day) HH:MM]`, so a date is a **prefix parse**
 *     (`packages/cortex-eval/src/turn-clock.ts`) rather than the reference's index-time LLM pass;
 *   - `resolveTimeRange` already turns a stated qualifier into a concrete window, deterministically.
 *
 * So the mechanism has a front door that is free, and a model call behind it for the questions the
 * front door cannot read. This tool measures both, on a control artifact, before any dispatch.
 *
 * ## The three populations, kept apart because they price differently
 *
 * | population | definition | what it costs |
 * | --- | --- | --- |
 * | window-wanting | `classifyTemporalQuestion` returns `eventLookup` or `relative` | nothing; it is the reach |
 * | ladder-fired | the window-wanting subset `resolveTimeRange` resolves | nothing; it is the free path |
 * | model-fallback | window-wanting minus ladder-fired | **one call each**, per run |
 *
 * A question that wants two anchors (`interval`: "how many days between X and Y") or an ordering
 * (`ordering`) is **not** in the population: one window would span both events or match one of them,
 * and promoting half of a two-event question is a claim the mechanism cannot make. The classifier is
 * the package's own, not a second grammar written here -- two classifiers would be two answers.
 *
 * ## Why "fired" is not "moved"
 *
 * A window outside the delivered span moves nothing, and a run that reported "fired on 22 questions"
 * without also reporting how many of them could split their list would have published a reach it did
 * not have. `partitionByWindow`'s split is what separates the two, and the tool reports fire, inert
 * and move as three numbers.
 *
 * ## Usage
 *
 *     node tools/window-reach.mjs --control <report.json> [--json]
 *     node tools/window-reach.mjs --control <report.json> --treatment <report.json> [--json]
 *
 * Without `--treatment` this prices the mechanism. With it, the tool also checks §13.151.5's second
 * criterion (the delivered multiset is byte-identical, so the treatment is a permutation and nothing
 * else) and its fifth (no question outside the firing population moved beyond the reader's own churn).
 *
 * Exit 2 is malformed input, exit 1 is an artifact that cannot support the reading, exit 0 is a reading.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

import {
  EXTENDED_ENGINE_OPTIONS,
  classifyTemporalQuestion,
  deliveredWindow,
  partitionByWindow,
  readTurnClocks,
  readTurnStamp,
  resolveTimeRange,
} from '../packages/cortex-eval/dist/index.js';

/**
 * The capabilities whose questions want exactly one time anchor.
 *
 * Read off `TemporalKind` rather than re-derived: `eventLookup` is "which entity was it at that
 * time", `relative` is "how long ago was that one event". Both are answered from one point in time,
 * which is the only thing a single window can express.
 */
const WINDOW_WANTING_KINDS = new Set(['eventLookup', 'relative']);

/** The reader's own churn floor: two byte-identical prompts moved 19 of 379 verdicts (§13.127.2). */
const READER_FLOOR = 0.05;

/**
 * §13.151.5's registered bar, restated against the population this tool measures.
 *
 * The criterion was written as "TR moves by at least 5 of its 13 reachable questions", before the
 * window-wanting population had been counted. The measurement below separates *reachable* (a
 * window-wanting TR question that is wrong in the control **and** whose delivered list the window
 * actually splits) from *13*, and §13.141.5 set the precedent for what happens when a registered bar
 * is quoted against a population that shrank: the bar is restated, once, in the registration, and the
 * tool then reports against the restated number rather than the old one. §13.152.4 restates it as
 * **4 of the reachable set**, which is half of the 8 this control run shows and would be 62.5% of a
 * 6-question population -- well outside what the reader moves on its own.
 */
const TR_REGISTERED_CONVERSIONS = 4;

/** The MR side of the same criterion: a temporal mechanism must not be buying MR. */
const MR_MAX_CONVERSIONS = 2;

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');

/** Every value given for one `--name` option. */
function takeOption(name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name) {
      const value = argv[index + 1];
      if (value === undefined) {
        fail(`${name} needs a value`);
      }
      values.push(value);
    } else if (argv[index].startsWith(`${name}=`)) {
      values.push(argv[index].slice(name.length + 1));
    }
  }
  return values;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

/**
 * Exit 1: the input is well formed but cannot support this reading.
 *
 * Separate from {@link fail} because the two mean different things to whoever reads the log. Exit 2 is
 * a caller handing the tool something malformed, and the fix is in the invocation. Exit 1 is a valid
 * artifact that answers nothing here -- an arm whose roster carries no temporal reference at all --
 * and the fix is a different artifact, not a different command.
 */
function unsupported(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const controls = takeOption('--control');
const treatments = takeOption('--treatment');

if (controls.length !== 1 || treatments.length > 1) {
  process.stderr.write(
    'usage: node tools/window-reach.mjs --control <report.json> [--treatment <report.json>] [--json]\n' +
      '       One control; the treatment is optional and only adds the two criteria that need a pair.\n',
  );
  process.exit(2);
}

if (treatments.length === 1 && controls[0] === treatments[0]) {
  fail(
    'the control and the treatment are the same file, so every flow would be zero by construction',
  );
}

/** One artifact's per-question records, validated on the fields this reading reads. */
function loadReport(path, role) {
  let body;
  try {
    body = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${role}: ${path} is not readable JSON (${error.message})`);
  }
  const questions = body?.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    fail(`${role}: ${path} carries no questions array, so it is not a memory-arm report`);
  }
  const byId = new Map();
  for (const record of questions) {
    if (typeof record?.questionId !== 'string' || typeof record?.question !== 'string') {
      fail(`${role}: a record has no questionId or no question text`);
    }
    if (byId.has(record.questionId)) {
      fail(`${role}: question id ${record.questionId} appears twice`);
    }
    if (!Array.isArray(record.turns)) {
      fail(`${role}: question ${record.questionId} carries no turns array`);
    }
    for (const entry of record.turns) {
      // A turn this tool cannot read is refused rather than skipped: skipping it would move the
      // delivered span, and every window decision is a comparison against that span.
      if (typeof entry === 'string') continue;
      if (typeof entry?.text !== 'string') {
        fail(`${role}: question ${record.questionId} has a turn that is neither text nor {text}`);
      }
    }
    byId.set(record.questionId, record);
  }
  return { report: body, questions, byId };
}

/** A turn's rendered text, whichever of the two shapes the artifact wrote it in. */
function textOf(entry) {
  return typeof entry === 'string' ? entry : entry.text;
}

/** The turns of one record, as text. */
function turnTexts(record) {
  return record.turns.map(textOf);
}

/**
 * The date a window is resolved against.
 *
 * The question's own date when the record carries it -- §13.152.2 added it to the record for exactly
 * this reason -- and otherwise the delivered span's last turn, which is a substitution the tool
 * reports rather than makes silently. The substitution is sound for the **firing** count (a qualifier
 * either parses against a valid date or does not) and approximate for the **window** (the span's last
 * turn is not the question date), which is why the two are counted separately.
 */
function referenceDate(record, span) {
  if (
    typeof record.questionDate === 'string' &&
    /^\d{4}\/\d{2}\/\d{2}$/.test(record.questionDate)
  ) {
    return { date: record.questionDate, source: 'record' };
  }
  return span === undefined ? null : { date: span.end, source: 'delivered-span' };
}

/**
 * One question's reading: what it wants, what the ladder resolved, and whether that window splits
 * the delivered list.
 */
function readQuestion(record) {
  const texts = turnTexts(record);
  const clocks = readTurnClocks(texts);
  const span = deliveredWindow(texts);
  const kind = classifyTemporalQuestion(record.question);
  const wantsWindow = WINDOW_WANTING_KINDS.has(kind);
  const reference = referenceDate(record, span);
  // An undated delivered list cannot be reordered at all: there is no date to compare a window to.
  // Reported as `unreadable` rather than as a question that fires and moves nothing.
  const unreadable = span === undefined;
  const window =
    wantsWindow && !unreadable && reference !== null
      ? resolveTimeRange(record.question, reference.date, EXTENDED_ENGINE_OPTIONS)
      : null;
  let inWindow = 0;
  let outOfWindow = 0;
  if (window !== null) {
    const split = partitionByWindow(texts, window, (text) => readTurnStamp(text)?.date);
    inWindow = split.inWindow.length;
    outOfWindow = split.outOfWindow.length;
  }
  return {
    record,
    kind,
    wantsWindow,
    unreadable,
    undatedTurns: clocks.undatedIndices.length,
    reference,
    window,
    fired: window !== null,
    // Both sides non-empty: a permutation that leaves the list alone is not a move, and a run
    // counting it as one would claim a mechanism that had no effect by construction.
    moves: inWindow > 0 && outOfWindow > 0,
    inWindow,
    outOfWindow,
  };
}

/** Counts over a subset, keyed by capability, keeping the denominators that matter. */
function tally(rows, predicate) {
  const byCapability = new Map();
  let total = 0;
  for (const row of rows) {
    if (!predicate(row)) continue;
    total += 1;
    const entry = byCapability.get(row.record.capability) ?? { count: 0, wrong: 0 };
    entry.count += 1;
    if (row.record.correct !== true) entry.wrong += 1;
    byCapability.set(row.record.capability, entry);
  }
  return { total, byCapability };
}

/** A capability table as one line per capability, alphabetically. */
function table(rows, label) {
  const capabilities = [...new Set(rows.map((row) => row.record.capability))].sort();
  const lines = [];
  for (const capability of capabilities) {
    const mine = rows.filter((row) => row.record.capability === capability);
    const wide = mine.filter((row) => row.wantsWindow).length;
    const fired = mine.filter((row) => row.fired).length;
    const moved = mine.filter((row) => row.fired && row.moves).length;
    const wrongReach = mine.filter(
      (row) => row.record.correct !== true && row.fired && row.moves,
    ).length;
    lines.push(
      `  ${capability.padEnd(4)} n=${String(mine.length).padStart(3)}  window-wanting=${String(wide).padStart(3)}` +
        `  ladder-fired=${String(fired).padStart(3)}  moves=${String(moved).padStart(3)}` +
        `  wrong-and-reachable=${String(wrongReach).padStart(3)}`,
    );
  }
  if (label !== undefined) lines.unshift(`  ${label}`);
  return lines;
}

const control = loadReport(controls[0], 'control');
const rows = control.questions.map(readQuestion);

if (rows.length === 0) {
  unsupported('control: no question could be read');
}

const windowWanting = rows.filter((row) => row.wantsWindow);
if (windowWanting.length === 0) {
  unsupported(
    'control: no question wants a time window, so this artifact cannot price the mechanism',
  );
}

const treatment = treatments.length === 1 ? loadReport(treatments[0], 'treatment') : null;

/** Per-question movement between the two arms, paired by id. */
function movement() {
  const bought = [];
  const sold = [];
  const missing = [];
  for (const row of rows) {
    const after = treatment.byId.get(row.record.questionId);
    if (after === undefined) {
      missing.push(row.record.questionId);
      continue;
    }
    const before = row.record.correct === true;
    const now = after.correct === true;
    if (before === now) continue;
    (now ? bought : sold).push(row.record.questionId);
  }
  return { bought, sold, missing };
}

const substitutions = rows.filter((row) => row.reference?.source === 'delivered-span').length;
const undated = rows.filter((row) => row.undatedTurns > 0);
const unreadable = rows.filter((row) => row.unreadable);
const ladderFired = rows.filter((row) => row.fired);
const ladderMoved = rows.filter((row) => row.fired && row.moves);
const fallback = windowWanting.filter((row) => !row.fired);
// The paid population, priced before it is paid for. A fallback question is one the free ladder
// cannot read, so a model would have to produce a window for it; only the ones the control answers
// wrong can convert, and even those are an upper bound, because producing a window is not the same
// as moving the list. Reporting the fallback's size without this count would price the mechanism by
// what it costs and never by what it could buy.
//
// Counted here rather than with `tally`, whose `count` is the number of rows that *matched* the
// predicate and not the size of the population it was given: reusing it printed "questions=1" beside
// a fallback of two, which is the same class of error as a denominator that silently shrinks.
const fallbackWrong = { total: 0, byCapability: {} };
for (const row of fallback) {
  const entry = (fallbackWrong.byCapability[row.record.capability] ??= {
    questions: 0,
    wrong: 0,
  });
  entry.questions += 1;
  if (row.record.correct !== true) {
    entry.wrong += 1;
    fallbackWrong.total += 1;
  }
}
const reachableWrong = rows.filter((row) => row.record.correct !== true && row.fired && row.moves);
const trReachable = reachableWrong.filter((row) => row.record.capability === 'TR');
const mrReachable = reachableWrong.filter((row) => row.record.capability === 'MR');

const claims = [];
claims.push({
  id: 1,
  statement:
    'every delivered turn carries a readable stamp, or the questions that do not are named',
  measured:
    `${rows.length - undated.length}/${rows.length} questions fully dated; ` +
    `${unreadable.length} with no readable turn at all`,
  verdict: undated.length === 0 && unreadable.length === 0 ? 'met' : 'not met',
});
claims.push({
  id: 3,
  statement: 'the reorder administers 10-20% of the roster',
  measured: `${windowWanting.length}/${rows.length} = ${((100 * windowWanting.length) / rows.length).toFixed(1)}%`,
  verdict:
    windowWanting.length / rows.length >= 0.1 && windowWanting.length / rows.length <= 0.2
      ? 'met'
      : 'not met',
});
claims.push({
  id: 4,
  statement: `TR converts at least ${String(TR_REGISTERED_CONVERSIONS)}, MR at most ${String(MR_MAX_CONVERSIONS)}`,
  measured: `${String(trReachable.length)} TR and ${String(mrReachable.length)} MR questions are wrong and splittable`,
  verdict:
    trReachable.length >= TR_REGISTERED_CONVERSIONS && mrReachable.length <= MR_MAX_CONVERSIONS
      ? 'reachable'
      : 'unreachable',
});

let pairReading = null;
if (treatment !== null) {
  const flow = movement();

  // §13.151.5 criterion 2: a permutation by construction means the delivered multiset is identical.
  // The comparison is on sorted turn text, which removes order -- the only thing a permutation may
  // change -- and keeps every byte of every turn.
  const changedSet = [];
  for (const row of rows) {
    const after = treatment.byId.get(row.record.questionId);
    if (after === undefined) continue;
    const before = [...turnTexts(row.record)].sort();
    const now = [...turnTexts(after)].sort();
    if (before.length !== now.length || before.some((text, index) => text !== now[index])) {
      changedSet.push(row.record.questionId);
    }
  }

  // §13.151.5 criterion 5: questions the mechanism does not reach are the experiment's own control,
  // and their flow has to sit inside the reader's churn floor.
  const population = new Set(ladderFired.map((row) => row.record.questionId));
  const outside = rows.filter((row) => !population.has(row.record.questionId));
  const outsideMoved = outside.filter(
    (row) =>
      flow.bought.includes(row.record.questionId) || flow.sold.includes(row.record.questionId),
  );
  const outsideShare = outside.length === 0 ? 0 : outsideMoved.length / outside.length;

  const converted = (ids) => ids.filter((id) => flow.bought.includes(id)).length;
  pairReading = {
    bought: flow.bought.length,
    sold: flow.sold.length,
    missing: flow.missing,
    changedSet,
    outside: { count: outside.length, moved: outsideMoved.length, share: outsideShare },
    trConverted: converted(trReachable.map((row) => row.record.questionId)),
    mrConverted: converted(mrReachable.map((row) => row.record.questionId)),
  };

  claims.push({
    id: 2,
    statement: 'the delivered multiset is byte-identical, so the treatment is a permutation',
    measured: `${changedSet.length} of ${rows.length} questions changed their delivered set`,
    verdict: changedSet.length === 0 ? 'met' : 'not met',
  });
  claims.push({
    id: 5,
    statement: "questions the mechanism does not reach move no more than the reader's own floor",
    measured: `${outsideMoved.length}/${outside.length} = ${(100 * outsideShare).toFixed(1)}% (floor 5.0%)`,
    verdict: outsideShare <= READER_FLOOR ? 'met' : 'not met',
  });
  claims.push({
    id: 4,
    statement: `TR converts at least ${String(TR_REGISTERED_CONVERSIONS)}, MR at most ${String(MR_MAX_CONVERSIONS)}`,
    measured: `${String(pairReading.trConverted)} TR bought, ${String(pairReading.mrConverted)} MR bought`,
    verdict:
      pairReading.trConverted >= TR_REGISTERED_CONVERSIONS &&
      pairReading.mrConverted <= MR_MAX_CONVERSIONS
        ? 'met'
        : 'not met',
  });
}

if (asJson) {
  process.stdout.write(
    `${JSON.stringify(
      {
        control: controls[0],
        treatment: treatments[0] ?? null,
        questions: rows.length,
        substitutions,
        undated: undated.map((row) => row.record.questionId),
        unreadable: unreadable.map((row) => row.record.questionId),
        windowWanting: windowWanting.length,
        ladderFired: ladderFired.length,
        ladderMoved: ladderMoved.length,
        fallback: fallback.length,
        fallbackWrong: {
          total: fallbackWrong.total,
          byCapability: fallbackWrong.byCapability,
        },
        reachableWrong: reachableWrong.map((row) => row.record.questionId),
        claims,
        pair: pairReading,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

const lines = [];
lines.push(`Window reorder, priced on ${controls[0]}`);
lines.push('');
lines.push(
  `Questions: ${rows.length}. Reference date from the record: ${rows.length - substitutions}; substituted from the delivered span: ${substitutions}.`,
);
lines.push('');
lines.push('Prefix coverage (§13.151.5 criterion 1):');
lines.push(
  `  turns dated: ${rows.reduce((sum, row) => sum + (row.record.turns.length - row.undatedTurns), 0)} of ${rows.reduce((sum, row) => sum + row.record.turns.length, 0)}`,
);
lines.push(
  `  questions with an unreadable turn: ${undated.length}${undated.length === 0 ? '' : ` -> ${undated.map((row) => row.record.questionId).join(', ')}`}`,
);
lines.push(`  questions with no readable turn at all: ${unreadable.length}`);
lines.push('');
lines.push(...table(rows, 'per capability:'));
lines.push('');
lines.push('The mechanism, in three populations that price differently:');
lines.push(
  `  window-wanting (eventLookup | relative): ${windowWanting.length} = ${((100 * windowWanting.length) / rows.length).toFixed(1)}% of the roster`,
);
lines.push(`  ladder-fired (free, no model call):      ${ladderFired.length}`);
lines.push(`  ladder-fired and actually splitting:     ${ladderMoved.length}`);
lines.push(`  model fallback (one call each, per run): ${fallback.length}`);
lines.push('');
lines.push('The paid population, priced before paying:');
lines.push(
  `  fallback questions the control answers wrong: ${fallbackWrong.total} of ${fallback.length}`,
);
for (const [capability, entry] of Object.entries(fallbackWrong.byCapability).sort()) {
  lines.push(
    `    ${capability.padEnd(4)} questions=${String(entry.questions).padStart(3)}  wrong=${String(entry.wrong).padStart(3)}`,
  );
}
lines.push(
  '  ceiling, not a forecast: a fallback question has no parsed window, so the model has to produce',
);
lines.push(
  "  one and it has to split the delivered list before it can convert anything. The ladder's own",
);
lines.push(
  '  conversion rate on the questions it did read is the only measured basis for discounting this.',
);
lines.push('');
lines.push('The reach that matters -- wrong in the control and splittable by the window:');
for (const entry of reachableWrong) {
  lines.push(
    `  ${entry.record.questionId}  ${entry.record.capability}  ${entry.kind}  ` +
      `in=${String(entry.inWindow)}/out=${String(entry.outOfWindow)}  ${entry.window.start}..${entry.window.end}  ` +
      `${JSON.stringify(entry.record.question.slice(0, 62))}`,
  );
}
lines.push('');
if (pairReading !== null) {
  lines.push('Paired against the treatment:');
  lines.push(
    `  bought ${pairReading.bought}, sold ${pairReading.sold}, unchanged ${rows.length - pairReading.bought - pairReading.sold - pairReading.missing.length}${pairReading.missing.length === 0 ? '' : `, missing ${pairReading.missing.length}`}`,
  );
  lines.push(
    `  delivered set changed on ${pairReading.changedSet.length} questions${pairReading.changedSet.length === 0 ? '' : ` -> ${pairReading.changedSet.join(', ')}`}`,
  );
  lines.push(
    `  outside the population: ${pairReading.outside.moved}/${pairReading.outside.count} = ${(100 * pairReading.outside.share).toFixed(1)}% (floor 5.0%)`,
  );
  lines.push('');
}
lines.push('Registered claims, read against this artifact:');
for (const claim of claims) {
  lines.push(`  ${String(claim.id)}. ${claim.statement}`);
  lines.push(`     measured ${claim.measured} -> ${claim.verdict.toUpperCase()}`);
}
lines.push('');
lines.push(
  `This tool reads; it dispatches nothing. The model fallback is ${String(fallback.length)} calls per run ` +
    `and the ladder path is free, so the mechanism's bill is the fallback alone -- which is what ` +
    `§13.152.3 restates against §13.151.4's proxy.`,
);

process.stdout.write(`${lines.join('\n')}\n`);
