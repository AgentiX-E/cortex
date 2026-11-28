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
 *    discordant counts those gaps are the difference of — plus the exact McNemar p-value of each
 *    repetition's discordant pairs. The counts say how much moved; the p-value says whether that
 *    asymmetry could be a coin flip, and neither implies the other.
 * 3. **Per window**, when the artifact multiplied the population (`CORTEX_WINDOWS = 2`). A pooled
 *    reading of a two-window artifact adds a window that may have moved nothing to one that moved
 *    twice as much, and `two-window.ts` grades both so that the second can be read beside the first.
 *    `--window N` narrows the whole reading to one of them.
 * 4. **The durable populations**, by question id, because a count without ids cannot be dispatched at.
 * 5. **The headroom table** — answered / unstable / never, per capability, with the `never` column tagged by
 *    whether the control answers the question at least once. This is the reading the campaign did not have
 *    and the reason every dispatch before `§203` aimed at the wrong questions: `durable-miss` is a
 *    **relative** population (it needs the other arm to be right every time) while the score is absolute, so
 *    the questions a mechanism can convert are "never right", not "worse than the control". On the shipped
 *    arm those are 26 questions, 20 of which the control never answers either, and the largest reachable
 *    block inside them is the fourteen contested rather than the four `MR` durable misses.
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

/**
 * How many contested questions on one side were right in some repetitions but not all.
 *
 * A projection of `contested` rather than a field of its own: the two were separate lists until `§203`, and
 * two lists that must agree about the same population are two lists that can disagree. The predicate is the
 * one the removed fields used — strictly between zero and the repetition count — read from the counts the
 * list already carries, on the arm the printed column belongs to.
 */
function bySide(entry, side, runs) {
  return entry.contested.filter((row) => {
    const count = side === 'baseline' ? row.baselineRuns : row.featureRuns;
    return count > 0 && count < runs;
  }).length;
}

/**
 * A p-value at the precision a reader needs, never as `0`.
 *
 * `0.0000001` printed as `0.000` is the one formatting choice that turns a measurement into a
 * verdict; the exponent says the same thing and says how far below the bar it is.
 */
const formatP = (value) => (value < 1e-4 ? value.toExponential(1) : value.toFixed(4));

/**
 * The window an artifact's ids carry, or `null` when the population is one window per corpus.
 *
 * Read from the artifact rather than assumed: `population` is absent on a single-window artifact by
 * design (`two-window.ts` states why), and a tool that defaulted to two windows would silently drop
 * half of every archived artifact.
 */
function windowCount(report) {
  const windows = report.population?.windows;
  return typeof windows === 'number' && windows > 1 ? windows : null;
}

/** The marker the artifact's own ids carry, with `withWindows`'s spelling as the fallback. */
function windowMarker(report) {
  const marker = report.population?.marker;
  return typeof marker === 'string' && marker.length > 0 ? marker : '#w';
}

/**
 * The cases of one window, or a refusal.
 *
 * A filtered population that is empty is not a reading of zero: it means the ids do not carry the
 * marker this tool was told to split on, and a summary of nothing would print as a null result.
 */
function casesForWindow(cases, marker, window) {
  const suffix = `${marker}${window}`;
  const kept = cases.filter((entry) => entry.questionId.endsWith(suffix));
  if (kept.length === 0) {
    throw new Error(
      `no question id ends in ${JSON.stringify(suffix)}: the artifact's ids do not carry the ` +
        'marker this reading splits on, so the window selection would summarise an empty population',
    );
  }
  return kept;
}

function render(reading, report, options) {
  const lines = [];
  const headline = headlineIsOneRepetition(report, reading);
  lines.push(`artifact          ${options.path}`);
  lines.push(`repetitions       ${reading.runs}`);
  if (options.windows !== null && options.windows !== undefined) {
    lines.push(
      `population        ${options.windows} windows per corpus` +
        (options.window === undefined
          ? ' (this reading pools them; the per-window split follows)'
          : `, reading window ${options.window} only`),
    );
  }
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
        `${String(entry.contested.length).padStart(9)}  ` +
        `${String(bySide(entry, 'baseline', reading.runs)).padStart(6)}/${bySide(entry, 'feature', reading.runs)}`,
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
        `= ${entry.durableMiss.length - entry.durableWin.length}, discordant mean ${meanDiscordant.toFixed(2)}, ` +
        `exact p [${entry.pValuePerRun.map(formatP).join(', ')}]` +
        `${entry.significantEveryRun ? '' : ' -- NOT below 0.05 in every repetition'}`,
    );
  }

  // The population a fix can act on, per capability, which is not the same question as the gap.
  //
  // Every earlier round chose its target by the column that looked worst, and `§203` priced that choice:
  // on `45760081761` the arm is short by 26 questions that nothing decides, and 20 of those the control
  // never answers either -- so the ceiling either arm demonstrates is 96.00, the largest reachable block
  // inside it is the 14 contested (1.40 points), and the durable misses every mechanism was aimed at are
  // worth 1.00. A capability whose column is worst can have almost nothing under it.
  lines.push('');
  lines.push('headroom: what the score is short by, and what the control demonstrated about it');
  lines.push('capability            n   answered  unstable   never  demonstrated   ceiling');
  let suite = { n: 0, answered: 0, unstable: 0, never: 0, demonstrated: 0 };
  for (const entry of capabilities) {
    const rows = reading.rows.filter((row) => row.capability === entry.capability);
    const answered = rows.filter((row) => row.featureRuns === reading.runs).length;
    const never = rows.filter((row) => row.featureRuns === 0).length;
    const demonstrated = entry.neverRight.filter((row) => row.control !== 'none').length;
    const unstable = rows.length - answered - never;
    // The ceiling is what a fix could reach **if it only did what the control already demonstrates**: every
    // question the control answers at least once is one a mechanism can be shown to convert, and the rest is
    // a ceiling of the harness rather than a gap. Printed as a percentage of the capability, so the five rows
    // are comparable without a second conversion.
    const unreachable = never - demonstrated;
    lines.push(
      `${entry.capability.padEnd(18)}${String(rows.length).padStart(4)}   ` +
        `${String(answered).padStart(8)}  ${String(unstable).padStart(8)}  ` +
        `${String(never).padStart(6)}  ${String(demonstrated).padStart(12)}   ` +
        `${(100 * (1 - unreachable / rows.length)).toFixed(2).padStart(6)}`,
    );
    suite = {
      n: suite.n + rows.length,
      answered: suite.answered + answered,
      unstable: suite.unstable + unstable,
      never: suite.never + never,
      demonstrated: suite.demonstrated + demonstrated,
    };
  }
  const suiteUnreachable = suite.never - suite.demonstrated;
  lines.push(
    `${'suite'.padEnd(18)}${String(suite.n).padStart(4)}   ` +
      `${String(suite.answered).padStart(8)}  ${String(suite.unstable).padStart(8)}  ` +
      `${String(suite.never).padStart(6)}  ${String(suite.demonstrated).padStart(12)}   ` +
      `${(100 * (1 - suiteUnreachable / suite.n)).toFixed(2).padStart(6)}`,
  );
  lines.push(
    `  answered: right in every repetition. never: wrong in every repetition, so a mechanism can reach it. ` +
      `demonstrated: the number of those the control answers at least once, so the ceiling is ` +
      `what a fix that only did what the control already does could reach.`,
  );

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

/**
 * The same reading, per window of a multiplied population.
 *
 * `two-window.ts` grades both windows on purpose, so that a mechanism which moved the second window
 * is readable beside a first window that did not. A pooled reading cannot show that: it is the sum of
 * a first window that may have moved nothing and a second that moved twice as much. The split is
 * printed by default rather than behind a flag for the reason the artifact records the population
 * rather than the harness printing it once -- a reader who has to remember to ask will not.
 */
function renderWindows(cases, marker, windows, capability) {
  const lines = ['', `per window (ids carry ${JSON.stringify(marker)}N)`];
  lines.push(
    'window  capability            n   baseline per repetition        feature per repetition         gap mean  exact p',
  );
  for (let window = 1; window <= windows; window += 1) {
    let reading;
    try {
      reading = summarisePaired(casesForWindow(cases, marker, window));
    } catch (error) {
      // One line rather than a thrown reading: a window whose ids are absent is a fact about the
      // artifact's ids, and the other windows are still readable.
      lines.push(
        `  ${window}     (no question id carries this marker: ${error.message.slice(0, 60)}...)`,
      );
      continue;
    }
    for (const entry of reading.capabilities) {
      if (capability !== undefined && entry.capability !== capability) continue;
      const meanGap = entry.gapPerRun.reduce((a, b) => a + b, 0) / entry.gapPerRun.length;
      lines.push(
        `  ${String(window).padEnd(6)}${entry.capability.padEnd(18)}${String(entry.total).padStart(4)}   ` +
          `${entry.baselinePerRun.map((n) => String(n).padStart(3)).join(' ')}`.padEnd(31) +
          `${entry.featurePerRun.map((n) => String(n).padStart(3)).join(' ')}`.padEnd(30) +
          `${meanGap.toFixed(2).padStart(8)}  [${entry.pValuePerRun.map(formatP).join(', ')}]`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  const args = argv;
  const path = flag(args, '--artifact');
  const capabilitySeen = args.includes('--capability');
  const capabilityArgument = flag(args, '--capability');
  const out = flag(args, '--out');
  const windowFlag = flag(args, '--window');
  // A flag with no NAME, or one followed by another flag, must be refused. `flag` returns
  // `undefined` both when the flag is absent and when it trails with no value, so check presence:
  // a trailing `--capability` widened the paired read to every capability, and `--capability
  // --list` swallowed `--list` as the NAME.
  if (
    capabilitySeen &&
    (capabilityArgument === undefined ||
      capabilityArgument.startsWith('--') ||
      capabilityArgument === '')
  ) {
    process.stderr.write(`--capability requires a NAME, got ${capabilityArgument}\n`);
    return 2;
  }
  const capability = capabilityArgument;
  if (path === undefined) {
    process.stderr.write(
      'usage: paired-flip.mjs --artifact <report.json> [--capability MR] [--window N] [--census] [--list] [--out <file>]\n',
    );
    return 2;
  }
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const built = casesFrom(report);
  if ('error' in built) {
    process.stderr.write(`${built.error}\n`);
    return 3;
  }

  const windows = windowCount(report);
  const marker = windowMarker(report);
  // `--window` narrows the reading to one window of a multiplied population. It is refused on a
  // single-window artifact rather than ignored: a reader who asked for a window and got the whole
  // population would read one number thinking it was another.
  let window;
  let cases = built.cases;
  if (windowFlag !== undefined) {
    if (windows === null) {
      process.stderr.write(
        `--window ${windowFlag} was asked for, but this artifact's population is one window per ` +
          'corpus: there is no window to select and the whole population is that window\n',
      );
      return 2;
    }
    window = Number(windowFlag);
    if (!Number.isInteger(window) || window < 1 || window > windows) {
      process.stderr.write(
        `--window ${windowFlag} is not one of this artifact's windows (1..${windows})\n`,
      );
      return 2;
    }
    try {
      cases = casesForWindow(built.cases, marker, window);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      return 3;
    }
  }
  const reading = summarisePaired(cases);

  // A partition that does not add up is an instrument failure, so it is checked before anything is
  // printed rather than left to a reader to notice.
  for (const entry of reading.capabilities) {
    const classified =
      entry.durableMiss.length + entry.durableWin.length + entry.agreedWrong.length;
    const agreedRight = entry.total - classified - entry.contested.length;
    if (agreedRight < 0) {
      process.stderr.write(
        `${entry.capability}: the verdicts sum to more than the population ` +
          `(${classified} + ${entry.contested.length} > ${entry.total})\n`,
      );
      return 1;
    }
  }

  const { text, capabilities } = render(reading, report, {
    path,
    capability,
    census: args.includes('--census'),
    list: args.includes('--list'),
    windows,
    window,
  });
  process.stdout.write(text);
  if (windows !== null && window === undefined) {
    process.stdout.write(renderWindows(built.cases, marker, windows, capability));
  }

  if (out !== undefined) {
    const byId = new Map(reading.rows.map((row) => [row.questionId, row]));
    const payload = {
      artifact: path,
      runs: reading.runs,
      windows: windows ?? 1,
      window: window ?? null,
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
            pValuePerRun: entry.pValuePerRun,
            significantEveryRun: entry.significantEveryRun,
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
            neverRight: entry.neverRight,
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
