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
 * ## What a verdict is not
 *
 * It is not a claim about *why*. A durable miss can be a retrieval miss, a reader miss or a gold
 * that two annotators would score differently, and this file deliberately cannot tell them apart —
 * `tools/mr-failure-census.mjs` classifies the run-0 failures by value shape, and the two readings
 * compose: the census says what kind of error, this says whether it is stable.
 */

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
  if (baseline.length !== feature.length) {
    throw new Error(
      `the two sides were measured a different number of times (${baseline.length} and ` +
        `${feature.length}), and a paired verdict needs the same repetition on both sides`,
    );
  }
  if (baseline.length === 0) {
    throw new Error(
      'no repetition at all is not a repetition that agreed: a verdict needs at least one',
    );
  }
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
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((capability) => {
      const group = byCapability.get(capability) ?? [];
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
        gapPerRun: baselinePerRun.map((count, run) => count - (featurePerRun[run] ?? 0)),
        baselineOnlyPerRun,
        featureOnlyPerRun,
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
