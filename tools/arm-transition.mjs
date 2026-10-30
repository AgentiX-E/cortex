#!/usr/bin/env node
/**
 * The five criteria `§13.166.6` registered, applied to a pair of artifacts.
 *
 * ## Why this is a tool and not a paragraph of instructions
 *
 * The registration was written before the dispatch, in five rows, each with a threshold and a
 * consequence. Reading it by hand means comparing two printers' output question by question and
 * holding five conditions in a reader's head at once -- and the failure mode of that is not a wrong
 * verdict, it is a *confident* one: the population that converts is exactly the population a reader
 * is looking at, so the seven questions that moved are the ones that get noticed and the hundred and
 * fourteen that must not move are the ones that do not.
 *
 * Criterion 5 is the reason this cannot be a judgement call. It is an assembly check, not an outcome:
 * `promptChars` must differ on the seven named questions and be **equal** on every other MR record.
 * A change that helps and a change that leaks differ in exactly that column, and the leak is invisible
 * in any summary that reports a total.
 *
 * ## Why a non-applicable criterion is `skipped` rather than `fail`
 *
 * The thresholds are attached to populations: "at least 4 **of the 7**", "the **ten** off-by-one
 * questions". A tool that rescaled them for a different pair would report a verdict about a criterion
 * nobody registered; a tool that failed them would report a defect where the truth is that the
 * question was not asked. So each criterion carries `applicable`, computed from the before-state, and
 * the exit code counts only the ones that apply. The count of skipped criteria is printed, because a
 * reading in which four of five were skipped is a different document from one where five passed.
 *
 * ## The classification is imported, never restated
 *
 * `classify` and `censusOf` come from `mr-failure-census.mjs`, which is the same rule `§13.166.3`
 * registered and the same one `§13.166.7` pinned against the product's own shape classifier. A second
 * copy here would let this tool disagree with the census about the population it is measuring, and the
 * disagreement would look like an effect.
 */

import { readFileSync } from 'node:fs';
import { censusOf } from './mr-failure-census.mjs';

/** The registered thresholds, named once. `§13.166.6` is the only place they may change. */
const NAMED_MIN = 4;
const NAMED_POPULATION = 7;
const OFF_BY_ONE_POPULATION = 10;
const OFF_BY_ONE_MAX_MOVES = 2;
const CAPABILITY_MAX_LOSS = 2;
const ACCURACY_MIN_GAIN_POINTS = 1.0;

/**
 * A capability's correct count, as the average over the run's repeats.
 *
 * The average and not the single-run count, because a criterion that reads one draw of four is a
 * criterion about jitter: `40989420944`'s MR band is `83..86` over its four runs, so a `-3` on the
 * chosen draw can be inside the spread the arm already has and would be reported as a loss. The band
 * exists for exactly this reason -- `ablation.featureByCapability` carries `min`/`avg`/`max` -- and
 * `§13.82`'s per-capability line is the average too, which is what makes the registered count
 * comparable to it.
 *
 * The single-draw figure is returned beside it rather than instead of it, so the detail line can show
 * what the run's headline number moved by as well as what the band did.
 */
function featureCorrect(report, capability) {
  const band = report.ablation?.featureByCapability?.[capability];
  if (band !== undefined && typeof band.avg === 'number') return band.avg;
  const per = report.feature?.metrics?.perCapability?.[capability];
  if (per !== undefined && typeof per.correct === 'number') return per.correct;
  return undefined;
}

/** The count the run's own headline is built from, which is one draw rather than the band. */
function featureCorrectRun(report, capability) {
  const per = report.feature?.metrics?.perCapability?.[capability];
  return per !== undefined && typeof per.correct === 'number' ? per.correct : undefined;
}

/** Abstention-aware accuracy in points, which is the unit `§13.166.6` states the threshold in. */
function accuracyPoints(report) {
  const value = report.feature?.metrics?.abstentionAwareAccuracy;
  return typeof value === 'number' ? value * 100 : undefined;
}

/** `promptChars` by question id, from the record list rather than from the census. */
function promptCharsById(report) {
  const map = new Map();
  for (const record of report.questions ?? []) {
    if (typeof record.promptChars === 'number') map.set(record.questionId, record.promptChars);
  }
  return map;
}

/**
 * Read one pair of artifacts against the five criteria.
 *
 * `capability` defaults to `MR` because every registered threshold is about MR: the population, the
 * off-by-one set, the seven named questions and the assembly check all live there. Passing another
 * capability produces a reading whose first four criteria are skipped, which is the honest output for
 * a pair this registration does not describe.
 */
export function transitionOf(before, after, options = {}) {
  const capability = options.capability ?? 'MR';
  const beforeCensus = censusOf(before, capability);
  const afterCensus = censusOf(after, capability);

  const afterById = new Map(afterCensus.rows.map((row) => [row.id, row]));
  const beforeById = new Map(beforeCensus.rows.map((row) => [row.id, row]));

  // Every question either census calls reference-only. The union, not the before set: a question that
  // was not reference-only and now is has crossed the other way, and that is the regression criterion 2
  // and 3 exist to catch.
  const union = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort();
  const rows = union.map((id) => {
    const from = beforeById.get(id);
    const to = afterById.get(id);
    return {
      id,
      capability: (from ?? to).capability,
      question: (from ?? to).question,
      before: from?.klass ?? null,
      after: to?.klass ?? null,
      gold: (from ?? to).gold,
      answerBefore: from?.answer ?? null,
      answerAfter: to?.answer ?? null,
      transition: `${from?.klass ?? 'answered'} -> ${to?.klass ?? 'answered'}`,
    };
  });

  // The named population is the before-state's, because the registration named it before the dispatch.
  // Reading it from the after-state would let a treatment that changed the classifier redefine the set
  // it is judged on.
  const named = beforeCensus.rows
    .filter((row) => row.shape === 'derivation')
    .map((row) => row.id)
    .sort();
  const namedSet = new Set(named);
  const namedRows = named.map((id) => {
    const from = beforeById.get(id);
    const to = afterById.get(id);
    return {
      id,
      before: from?.klass ?? null,
      after: to?.klass ?? null,
      left: to === undefined,
      question: (from ?? to)?.question,
    };
  });

  const offByOneBefore = beforeCensus.rows.filter((row) => row.klass === 'off-by-one').map((row) => row.id);
  const offByOneRows = offByOneBefore.map((id) => {
    const to = afterById.get(id);
    return {
      id,
      after: to?.klass ?? null,
      moved: (to?.klass ?? 'answered') !== 'off-by-one',
      answerAfter: to?.answer ?? null,
    };
  });

  const capabilities = Object.keys(before.ablation?.featureByCapability ?? {}).sort();
  const perCapability = capabilities.map((name) => {
    const from = featureCorrect(before, name);
    const to = featureCorrect(after, name);
    const runFrom = featureCorrectRun(before, name);
    const runTo = featureCorrectRun(after, name);
    return {
      capability: name,
      before: from ?? null,
      after: to ?? null,
      delta: from !== undefined && to !== undefined ? to - from : null,
      runBefore: runFrom ?? null,
      runAfter: runTo ?? null,
      runDelta: runFrom !== undefined && runTo !== undefined ? runTo - runFrom : null,
    };
  });

  const beforePrompt = promptCharsById(before);
  const afterPrompt = promptCharsById(after);
  const namedPrompt = [];
  const otherPrompt = [];
  for (const record of after.questions ?? []) {
    if (record.capability !== capability) continue;
    const was = beforePrompt.get(record.questionId);
    const now = typeof record.promptChars === 'number' ? record.promptChars : undefined;
    if (was === undefined || now === undefined) continue;
    const entry = { id: record.questionId, before: was, after: now, delta: now - was };
    (namedSet.has(record.questionId) ? namedPrompt : otherPrompt).push(entry);
  }

  const accuracyBefore = accuracyPoints(before);
  const accuracyAfter = accuracyPoints(after);

  const criteria = [];
  const add = (registered, label, applicable, pass, detail) => {
    criteria.push({
      registered,
      label,
      applicable,
      verdict: !applicable ? 'skipped' : pass ? 'pass' : 'fail',
      detail,
    });
  };

  const namedLeft = namedRows.filter((row) => row.left).length;
  add(
    1,
    `at least ${NAMED_MIN} of the ${NAMED_POPULATION} named questions stop being reference-only`,
    named.length === NAMED_POPULATION,
    namedLeft >= NAMED_MIN,
    named.length === NAMED_POPULATION
      ? `${namedLeft} of ${named.length} left (need ${NAMED_MIN}): ${namedRows
          .map((row) => `${row.id}${row.left ? '=left' : `=${row.after ?? 'answered'}`}`)
          .join(' ')}`
      : `the registered population is ${NAMED_POPULATION}; this pair has ${named.length}, so the ` +
        `threshold does not describe this reading`,
  );

  const moved = offByOneRows.filter((row) => row.moved);
  add(
    2,
    `the ${OFF_BY_ONE_POPULATION} off-by-one questions do not move by more than ${OFF_BY_ONE_MAX_MOVES}`,
    offByOneBefore.length === OFF_BY_ONE_POPULATION,
    moved.length <= OFF_BY_ONE_MAX_MOVES,
    offByOneBefore.length === OFF_BY_ONE_POPULATION
      ? `${moved.length} of ${offByOneBefore.length} moved: ${
          moved.map((row) => `${row.id}->${row.after ?? 'answered'}`).join(' ') || 'none'
        }`
      : `the registered set is ${OFF_BY_ONE_POPULATION}; this pair has ${offByOneBefore.length}`,
  );

  const losses = perCapability.filter((row) => row.delta !== null && row.delta < -CAPABILITY_MAX_LOSS);
  const absBefore = featureCorrect(before, 'ABS');
  const absAfter = featureCorrect(after, 'ABS');
  const absHeld = absBefore === undefined || absAfter === undefined ? undefined : absBefore === absAfter;
  add(
    3,
    `no capability loses more than ${CAPABILITY_MAX_LOSS}, and ABS is unchanged`,
    perCapability.some((row) => row.delta !== null),
    losses.length === 0 && absHeld !== false,
    `${perCapability
      .filter((row) => row.delta !== null)
      .map(
        (row) =>
          `${row.capability} ${row.before}->${row.after} (${row.delta >= 0 ? '+' : ''}${row.delta} ` +
          `avg; ${row.runBefore}->${row.runAfter} this draw)`,
      )
      .join(', ')}${absHeld === false ? ` -- ABS moved ${absBefore}->${absAfter}, which the ask cannot reach` : ''}`,
  );

  const gain = accuracyBefore === undefined || accuracyAfter === undefined ? undefined : accuracyAfter - accuracyBefore;
  add(
    4,
    `overall accuracy rises by at least ${ACCURACY_MIN_GAIN_POINTS.toFixed(1)} point`,
    gain !== undefined,
    gain !== undefined && gain >= ACCURACY_MIN_GAIN_POINTS,
    gain === undefined
      ? 'one side carries no abstention-aware accuracy'
      : `${accuracyBefore.toFixed(2)}% -> ${accuracyAfter.toFixed(2)}% (${gain >= 0 ? '+' : ''}${gain.toFixed(2)} pt)`,
  );

  // The assembly check. `promptChars` is the only per-question field that is a property of the PROMPT
  // rather than of the answer, so it is the one column in which "the mechanism reached this question"
  // is separable from "the answer changed".
  const namedChanged = namedPrompt.filter((row) => row.delta !== 0);
  const outsideChanged = otherPrompt.filter((row) => row.delta !== 0);
  add(
    5,
    `promptChars moves on the ${named.length} named questions and is equal on the other ${otherPrompt.length}`,
    named.length > 0 && otherPrompt.length > 0,
    namedChanged.length === named.length && outsideChanged.length === 0,
    `${namedChanged.length}/${named.length} named moved; ${outsideChanged.length}/${otherPrompt.length} ` +
      `outside moved${outsideChanged.length === 0 ? '' : ` (first ${outsideChanged[0].id} ${outsideChanged[0].before}->${outsideChanged[0].after})`}` +
      `${namedChanged.length === named.length ? '' : `; named still equal: ${namedPrompt
        .filter((row) => row.delta === 0)
        .map((row) => row.id)
        .join(' ') || 'none'}`}`,
  );

  return {
    capability,
    before: {
      population: beforeCensus.population,
      classes: beforeCensus.classes,
      accuracy: accuracyBefore ?? null,
      generation: before.generatedAt ?? null,
    },
    after: {
      population: afterCensus.population,
      classes: afterCensus.classes,
      accuracy: accuracyAfter ?? null,
      generation: after.generatedAt ?? null,
    },
    named,
    namedLeft,
    namedRows,
    offByOneRows,
    perCapability,
    rows,
    promptChars: { named: namedPrompt, outside: otherPrompt },
    criteria,
    applicable: criteria.filter((row) => row.applicable).length,
    skipped: criteria.filter((row) => !row.applicable).length,
    failed: criteria.filter((row) => row.verdict === 'fail').length,
  };
}

const PAD = (text, width) => String(text).padEnd(width);

/** The human reading: the five verdicts first, then the transitions that produced them. */
export function renderReading(reading) {
  const lines = [];
  lines.push(
    `registered criteria, capability ${reading.capability}: ` +
      `${reading.applicable} applicable, ${reading.skipped} skipped, ${reading.failed} failed`,
  );
  lines.push(`  before ${reading.before.generation}  population ${reading.before.population}`);
  lines.push(`  after  ${reading.after.generation}  population ${reading.after.population}`);
  lines.push('');
  lines.push('  #  verdict  criterion');
  for (const row of reading.criteria) {
    lines.push(`  ${row.registered}  ${PAD(row.verdict, 7)}  ${row.label}`);
    lines.push(`     ${' '.repeat(7)}  ${row.detail}`);
  }
  lines.push('');
  lines.push(`  transitions (${reading.rows.length} question(s) reference-only on either side)`);
  lines.push(`  ${PAD('question', 18)}${PAD('before', 14)}${PAD('after', 14)}gold`);
  for (const row of reading.rows) {
    lines.push(
      `  ${PAD(row.id, 18)}${PAD(row.before ?? 'answered', 14)}${PAD(row.after ?? 'answered', 14)}` +
        String(row.gold ?? '').slice(0, 40),
    );
  }
  return lines.join('\n');
}

function flag(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function main(argv) {
  const beforePath = flag(argv, '--before');
  const afterPath = flag(argv, '--after');
  if (beforePath === undefined || afterPath === undefined) {
    process.stderr.write(
      'usage: arm-transition.mjs --before <artifact.json> --after <artifact.json> ' +
        '[--capability MR] [--json]\n',
    );
    return 2;
  }
  const before = JSON.parse(readFileSync(beforePath, 'utf8'));
  const after = JSON.parse(readFileSync(afterPath, 'utf8'));
  const capability = flag(argv, '--capability');
  const reading = transitionOf(before, after, capability === undefined ? {} : { capability });
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(reading, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderReading(reading)}\n`);
  }
  // A skipped criterion is not a failure and not a pass. The exit code reports only the ones this
  // pair's populations actually pose, which is why the skipped count is printed beside it.
  return reading.failed > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('arm-transition.mjs')) {
  process.exitCode = main(process.argv.slice(2));
}
