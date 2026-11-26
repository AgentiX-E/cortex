/**
 * Read a two-arm artifact as a **paired** measurement instead of as a difference of means.
 *
 * ## The number this replaces
 *
 * `MEASURE-BASELINE-DRIFT.md` and the MR sections of the tracking report quote `87.25` against
 * `103.75`: "16 questions behind the reference pipeline". Both are averages over four repetitions,
 * and the artifact has carried `featureCorrectByRun` and `baselineCorrectByRun` — one correctness
 * mask per repetition, one character per question — since that field was added with the stated
 * purpose of telling "one question flapping four times" apart from "four questions flapping once
 * each". Until `§13.187` nothing in this repository read them. Every head-to-head was the
 * subtraction of two means over masks nobody opened.
 *
 * ## Why the subtraction is not merely imprecise
 *
 * Four repetitions of the same 121 questions, with a byte-identical prompt in each, produced MR
 * counts of 84, 86, 87 and 92 for this arm and 105, 104, 104, 102 for the reference pipeline. The
 * difference of means mixes the questions that are decided the same way every time with the ones
 * that are not, and reports one number for both. So a treatment that moves three durable questions
 * and a treatment that moves the same three questions into and out of the noise read identically.
 *
 * The five verdicts below are the separation. `durable-miss` is the population an intervention can
 * address, because the same code decided it wrongly four times; `contested` is the population that
 * needs a repeat rather than an explanation; `agreed-wrong` is a question neither arm wins, so it
 * is a ceiling of the harness and not a gap between the arms.
 *
 * ## Why the counts are not enough either
 *
 * A verdict says what happened to a question; it says nothing about how surprising the total is. Nine
 * questions moving one way and two the other is not a finding at any population this campaign runs,
 * and it looks exactly like the eleven-question row a real treatment produces. So each repetition
 * carries its own exact McNemar p-value over its own discordant pairs, and `significantEveryRun` says
 * whether the *repetitions* agree rather than whether a lucky one cleared the bar. The counts stay
 * printed beside it: a p-value is not a magnitude, and a row that reports only `p < 0.001` has
 * stopped saying how many questions moved.
 *
 * ## What a verdict is not
 *
 * It is not a claim about *why*. A durable miss can be a retrieval miss, a reader miss or a gold
 * that two annotators would score differently, and this file deliberately cannot tell them apart —
 * `tools/mr-failure-census.mjs` classifies the run-0 failures by value shape, and the two readings
 * compose: the census says what kind of error, this says whether it is stable.
 */

import { exactMcNemar } from './stats.js';

/**
 * The two-sided alpha every paired criterion in this campaign is written at.
 *
 * One value rather than an option: a reading that chose its own alpha after seeing the p-value is a
 * reading that can certify anything, and every criterion in `PREREGISTRATION` states 0.05 before the
 * dispatch. A dispatch that wants a different bar states it in its own consequence table.
 */
const SIGNIFICANCE = 0.05;

/** How one question was decided across the repetitions of one run. */
type PairedVerdict =
  /** Baseline right in every repetition, feature wrong in every repetition. */
  | 'durable-miss'
  /** The mirror image: a question this arm wins every time. */
  | 'durable-win'
  /** Both arms right every time. The bulk of any corpus, and never a win. */
  | 'agreed-right'
  /** Both arms wrong every time: not a gap, because the other arm does not win it either. */
  | 'agreed-wrong'
  /** Each side was right at least once and wrong at least once — a question the code does not decide. */
  | 'contested';

/**
 * One question, with both arms' per-repetition correctness, in repetition order.
 *
 * The two vectors are the unit of the whole instrument, which is why they are `readonly boolean[]`
 * rather than the `'1010'` mask strings the artifact stores: a mask read into the wrong index space
 * is the defect this file cannot detect once it has happened, and the conversion is done exactly
 * once, by the caller, next to the check that the lengths agree with the question list.
 */
type PairedCase = {
  readonly index: number;
  readonly questionId: string;
  readonly capability: string;
  readonly gold: string;
  readonly answer: string;
  readonly baseline: readonly boolean[];
  readonly feature: readonly boolean[];
};

type PairedRow = PairedCase & {
  readonly verdict: PairedVerdict;
  /** Repetitions in which the baseline was right, and in which the feature was. */
  readonly baselineRuns: number;
  readonly featureRuns: number;
};

type CapabilityPaired = {
  readonly capability: string;
  readonly total: number;
  /** Correct count per repetition, one entry each, so a spread can be read back from the same row. */
  readonly baselinePerRun: readonly number[];
  readonly featurePerRun: readonly number[];
  /** `baseline - feature` per repetition. The quantity that was being averaged and never shown. */
  readonly gapPerRun: readonly number[];
  /** Discordant counts per repetition: baseline right and feature wrong, and the reverse. */
  readonly baselineOnlyPerRun: readonly number[];
  readonly featureOnlyPerRun: readonly number[];
  /**
   * The exact two-sided McNemar p-value of that repetition's discordant pairs.
   *
   * The row above says *how many* questions moved; this says whether the asymmetry could be a coin
   * flip. Both are needed because neither implies the other: `20` against `9` is `p = 0.043` and
   * `9` against `2` is `p = 0.065` — one is the campaign's floor and the other is noise, and the
   * counts alone do not order them. The gap is also not the test: a run can move 24 questions with a
   * p-value of `1e-6` and another can move 24 with a p-value of `0.3`, depending where they moved.
   */
  readonly pValuePerRun: readonly number[];
  /**
   * Whether **every** repetition rejected the null at `SIGNIFICANCE`.
   *
   * Every, not any: the repetitions are the same questions asked again, so a treatment that is real
   * shows up in each of them, and "significant in one of two" is a statement about the draw rather
   * than about the treatment. `false` on a single-repetition artifact is not a finding about the
   * mechanism — it is that artifact's one draw, which is why the reading prints the counts too.
   */
  readonly significantEveryRun: boolean;
  readonly durableMiss: readonly string[];
  readonly durableWin: readonly string[];
  readonly agreedWrong: readonly string[];
  readonly contested: number;
  /**
   * Questions whose verdict is not constant on that side, with the count of repetitions it was right.
   *
   * Keyed by question id so the same question appears once however many times it swings — the
   * distinction `featureByCapability`'s `{min, avg, max}` cannot make.
   */
  readonly flapping: {
    readonly baseline: readonly { readonly questionId: string; readonly runs: number }[];
    readonly feature: readonly { readonly questionId: string; readonly runs: number }[];
  };
};

type PairedReading = {
  readonly runs: number;
  /** Ordered by capability name, so two runs of one artifact print the same table. */
  readonly capabilities: readonly CapabilityPaired[];
  readonly rows: readonly PairedRow[];
};

/**
 * Both sides of one question, from their per-repetition correctness.
 *
 * Not exported: `summarisePaired` is the only caller and the tests reach the verdicts through it, so an
 * `export` here would be an advertisement nothing imports (`tools/export-census.mjs`). Reaching them
 * through the summary is also the stronger test — it is the path the tool takes.
 */
function classifyPaired(baseline: readonly boolean[], feature: readonly boolean[]): PairedVerdict {
  // The two guards that used to stand here -- equal lengths, and at least one repetition -- were
  // unreachable: `summarisePaired` refuses both shapes before it calls this, and it refuses them with
  // better messages, because it is the function that knows a question id. Keeping a second copy of a
  // check the caller already made is dead code that reads as protection; the contract is stated here
  // and enforced one function up.
  const baselineRuns = baseline.filter(Boolean).length;
  const featureRuns = feature.filter(Boolean).length;
  const runs = baseline.length;
  if (baselineRuns === runs && featureRuns === runs) return 'agreed-right';
  if (baselineRuns === 0 && featureRuns === 0) return 'agreed-wrong';
  if (baselineRuns === runs && featureRuns === 0) return 'durable-miss';
  if (baselineRuns === 0 && featureRuns === runs) return 'durable-win';
  return 'contested';
}

function countTrue(values: readonly boolean[]): number {
  let total = 0;
  for (const value of values) if (value) total += 1;
  return total;
}

/**
 * The whole reading, from cases that have already been paired by question.
 *
 * Refuses rather than repairs: a set of cases whose repetition counts disagree means at least one of
 * them was built from a different run, and a summary that took the first case's count would silently
 * truncate every longer vector — the failure mode `sourcesFrom` shipped once already, in a different
 * instrument (`§13.186`), where eight rows left the denominator and no line said so.
 */
export function summarisePaired(cases: readonly PairedCase[]): PairedReading {
  if (cases.length === 0) {
    throw new Error('no questions to pair');
  }
  const runs = cases[0]!.baseline.length;
  if (runs === 0) {
    throw new Error('no repetition to pair: the first case carries an empty correctness vector');
  }
  for (const entry of cases) {
    if (entry.baseline.length !== runs || entry.feature.length !== runs) {
      throw new Error(
        `question ${entry.questionId} was measured ${entry.baseline.length} and ` +
          `${entry.feature.length} times against the reading's ${runs}; a question measured a ` +
          'different number of times belongs to a different artifact',
      );
    }
  }

  const rows: PairedRow[] = cases.map((entry) => ({
    ...entry,
    verdict: classifyPaired(entry.baseline, entry.feature),
    baselineRuns: countTrue(entry.baseline),
    featureRuns: countTrue(entry.feature),
  }));

  const byCapability = new Map<string, PairedRow[]>();
  for (const row of rows) {
    const bucket = byCapability.get(row.capability);
    if (bucket === undefined) byCapability.set(row.capability, [row]);
    else bucket.push(row);
  }

  const capabilities: CapabilityPaired[] = [...byCapability.keys()]
    // Default sort, which for strings is code-unit order -- exactly what the comparator this replaces
    // computed. That comparator had three arms and the third (`a === b`, returning 0) could not run,
    // because the keys it sorts come from a map and are distinct by construction. An arm that cannot
    // run is not safety; it is a claim that two capabilities may share a name, which would be a defect
    // somewhere else entirely.
    .sort()
    .map((capability) => {
      // `?? []` stood here and could not run: the keys are iterated from this same map, so the lookup
      // always resolves. The fallback read as tolerance and was a second, quieter way to say "the code
      // I just wrote is wrong". `!` says that instead.
      const group = byCapability.get(capability)!;
      const baselinePerRun = Array.from(
        { length: runs },
        (_, run) => group.filter((row) => row.baseline[run] === true).length,
      );
      const featurePerRun = Array.from(
        { length: runs },
        (_, run) => group.filter((row) => row.feature[run] === true).length,
      );
      const baselineOnlyPerRun = Array.from(
        { length: runs },
        (_, run) =>
          group.filter((row) => row.baseline[run] === true && row.feature[run] !== true).length,
      );
      const featureOnlyPerRun = Array.from(
        { length: runs },
        (_, run) =>
          group.filter((row) => row.feature[run] === true && row.baseline[run] !== true).length,
      );
      return {
        capability,
        total: group.length,
        baselinePerRun,
        featurePerRun,
        // `featurePerRun[run] ?? 0` was the same shape as the fallback above: both arrays are built
        // with `{ length: runs }`, so the index is always present. Written as a subtraction of two
        // numbers rather than of a number and a possibility.
        gapPerRun: baselinePerRun.map((count, run) => count - featurePerRun[run]!),
        baselineOnlyPerRun,
        featureOnlyPerRun,
        pValuePerRun: baselineOnlyPerRun.map((only, run) =>
          exactMcNemar(only, featureOnlyPerRun[run]!),
        ),
        significantEveryRun: baselineOnlyPerRun.every(
          (only, run) => exactMcNemar(only, featureOnlyPerRun[run]!) < SIGNIFICANCE,
        ),
        durableMiss: group
          .filter((row) => row.verdict === 'durable-miss')
          .map((row) => row.questionId),
        durableWin: group
          .filter((row) => row.verdict === 'durable-win')
          .map((row) => row.questionId),
        agreedWrong: group
          .filter((row) => row.verdict === 'agreed-wrong')
          .map((row) => row.questionId),
        contested: group.filter((row) => row.verdict === 'contested').length,
        flapping: {
          baseline: group
            .filter((row) => row.baselineRuns > 0 && row.baselineRuns < runs)
            .map((row) => ({ questionId: row.questionId, runs: row.baselineRuns })),
          feature: group
            .filter((row) => row.featureRuns > 0 && row.featureRuns < runs)
            .map((row) => ({ questionId: row.questionId, runs: row.featureRuns })),
        },
      };
    });

  return { runs, capabilities, rows };
}
