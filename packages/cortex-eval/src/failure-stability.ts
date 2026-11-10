/**
 * Which failures are real, and which are one draw's.
 *
 * ## The arithmetic this file exists to make possible
 *
 * Every mechanism arm in this campaign has been designed against a **failure list taken from one
 * repetition**. `MEASURE-MR-CEILING.md` §3 partitions "the twenty" failures of run `42533236864`
 * into over-counts, under-counts, a verb filter, declines and operation errors, and §5.2 prices a
 * deterministic-summation mechanism at "the two operation failures it would get". Those are real
 * observations about one repetition, and they are not a population.
 *
 * The artifact already carries the data that settles it. `ablation.featureCorrectByRun` is one
 * `'0'`/`'1'` mask **per repetition**, in dataset order, and every archived four-repetition run has
 * carried it since §13.118.5 argued for repetitions. Nothing read it per question. So the property
 * "does this question fail every time" was measurable for months and was not measured, and the
 * census that the queue is built on was a sample reported as a census.
 *
 * | | one repetition | four repetitions |
 * | --- | --- | --- |
 * | `MR` failures of `42355323615` | 20 | **13 never correct, 13 correct at least once** |
 * | `KU` failures of the same run | 10 | **7 never correct, 3 correct at least once** |
 *
 * The consequence is not cosmetic. A mechanism that converts a question which is already right in
 * three repetitions of four buys `0.25` of a question, not one, and a mechanism whose target set is
 * chosen from a single draw is partly fitted to the draw. `conversionCeiling` therefore reports the
 * ceiling as a **sum of `1 - passRate`** over the mechanism's target set — the expected number of
 * questions the mechanism converts, not the number of rows it names — and compares it against the
 * repetition spread of the same population, because a ceiling below the noise is not a result.
 *
 * ## Why the spread is computed from the same four numbers
 *
 * The obvious null is an external one, and §13.118.5's 6.54-question floor is the campaign's
 * standing figure. It was measured on a 127-question column. A 121-question column has a wider
 * per-question variance for the same rate, and quoting the 127-question figure against an `MR`
 * subset is the unit error `§13.340.3` already refused once. So the null here is derived from the
 * repetition accuracies of the population being asked about, which is the same four numbers on the
 * same questions, and `twoSd` is reported in **questions** rather than points so that it can be
 * compared to a ceiling without a second conversion.
 *
 * ## Refusals
 *
 * Six, by name. Each has a default that would produce a confident reading: a flat `featureCorrect`
 * list where a mask is missing (a one-repetition reading presented as stability), a single
 * repetition (a spread of zero, which makes every ceiling "resolvable"), a mask of the wrong length
 * (two populations added elementwise), a mask containing `'2'` (a truthy character silently counted
 * as a pass), an empty selection (a partition whose every row is zero), and a named question that is
 * not in the artifact (a ceiling over a population that does not exist).
 */

/** The refusal texts, exported so a CLI can print the reason without inventing one. */
export const STABILITY_REFUSALS = Object.freeze({
  unstated:
    'the artifact carries no per-repetition correctness mask, so stability cannot be measured',
  single: 'the artifact carries one repetition, and one repetition has no stability to measure',
  width: 'the masks and the question list describe different populations',
  alphabet: 'a correctness mask carries a character other than `0` or `1`',
  empty: 'the selected population is empty',
  unknown: 'a named question is not in the mask',
});

/** One question, read across every repetition. */
export interface StabilityQuestion {
  /** Position in dataset order, which is the mask's position. */
  readonly index: number;
  /** The artifact's question id, when it carries the per-question records. */
  readonly questionId: string | undefined;
  /** The capability the artifact assigned, when it carries the records. */
  readonly capability: string | undefined;
  /** Repetitions this question was answered correctly. */
  readonly passed: number;
  /** Repetitions in the artifact. */
  readonly repetitions: number;
  /** `passed / repetitions`. */
  readonly passRate: number;
}

/** A population's stability, partitioned three ways. */
export interface StabilityReading {
  /** Repetitions read. Always at least two, because `single` is refused. */
  readonly repetitions: number;
  /** Questions in the selection. */
  readonly population: number;
  /** Every question, in dataset order. */
  readonly questions: readonly StabilityQuestion[];
  /** Correct in no repetition. A mechanism can own these. */
  readonly stableFailures: readonly StabilityQuestion[];
  /** Correct at least once and wrong at least once. A mechanism owns a fraction of each. */
  readonly flaky: readonly StabilityQuestion[];
  /** Correct in every repetition. Nothing left to win. */
  readonly stablePasses: readonly StabilityQuestion[];
  /**
   * `sum(1 - passRate)` over the selection, in question-equivalents.
   *
   * This is the entire recoverable mass of the population: no mechanism, however good, can convert
   * more than this, and `stableFailures.length` of it is the part that every repetition agrees on.
   */
  readonly recoverable: number;
  /** Mean accuracy over repetitions, `mean(passed) / repetitions`. */
  readonly meanAccuracy: number;
}

/** The repetition spread of a population, in questions. */
export interface NullReading {
  /** Correct questions per repetition, in repetition order. */
  readonly perRepetition: readonly number[];
  /** Population size. */
  readonly population: number;
  /** Standard deviation of `perRepetition`, in questions. */
  readonly sd: number;
  /** `2 * sd`: the movement this population produces with nothing changed. */
  readonly twoSd: number;
}

/** A mechanism's expected conversion, against a population's own noise. */
export interface CeilingReading {
  /** What the mechanism is called in the reading. */
  readonly label: string;
  /** Questions named as the mechanism's target set. */
  readonly questions: number;
  /** Population the ceiling is expressed against. */
  readonly population: number;
  /** `sum(1 - passRate)` over the target set, in question-equivalents. */
  readonly ceiling: number;
  /** Questions in the target set that are wrong in every repetition. */
  readonly stable: number;
  /** `ceiling / population * 100`. */
  readonly points: number;
  /** The population's `twoSd`, in questions. */
  readonly noise: number;
  /** `ceiling > noise`: the movement is larger than the population's own spread. */
  readonly resolvable: boolean;
}

/** The structural subset of an ablation report `stabilityOf` reads. */
export interface StabilityArtifactShape {
  readonly runs?: number | undefined;
  readonly questions?: readonly StabilityQuestionShape[] | undefined;
  readonly ablation?:
    | {
        readonly featureCorrectByRun?: readonly string[] | undefined;
        readonly featureCorrect?: readonly boolean[] | undefined;
        readonly runs?: number | undefined;
      }
    | undefined;
}

/** One per-question record, of which only the identity fields are read. */
export interface StabilityQuestionShape {
  readonly questionId?: string | undefined;
  readonly capability?: string | undefined;
}

/** Which questions a reading covers. */
export interface StabilitySelection {
  /** Restrict to one capability. */
  readonly capability?: string | undefined;
  /** Restrict to these question ids, in the artifact's order. */
  readonly questionIds?: readonly string[] | undefined;
}

function prefix(message: string): string {
  return `failure-stability: ${message}`;
}

/**
 * The per-repetition masks, refusing every shape that would produce a reading from the wrong data.
 *
 * The one-repetition refusal is the important one. `featureCorrect` is always present and is
 * repetition zero of the mask, so a fallback to it would silently answer "every failure is stable"
 * for a one-repetition artifact — which is exactly the reading this module exists to stop being
 * quoted.
 */
function readMasks(report: StabilityArtifactShape): readonly string[] {
  const masks = report.ablation?.featureCorrectByRun;
  if (masks === undefined || masks.length === 0) {
    throw new Error(prefix(STABILITY_REFUSALS.unstated));
  }
  if (masks.length < 2) {
    throw new Error(prefix(STABILITY_REFUSALS.single));
  }
  const width = masks[0]?.length ?? 0;
  if (width === 0) {
    throw new Error(prefix(STABILITY_REFUSALS.empty));
  }
  for (const mask of masks) {
    if (mask.length !== width) {
      throw new Error(prefix(STABILITY_REFUSALS.width));
    }
    // `'2'` and `' '` are the two characters a mask acquires from a writer that joined booleans
    // rather than masking them; both are truthy-adjacent and both would read as a pass below.
    for (const character of mask) {
      if (character !== '0' && character !== '1') {
        throw new Error(prefix(STABILITY_REFUSALS.alphabet));
      }
    }
  }
  const records = report.questions;
  if (records !== undefined && records.length !== width) {
    throw new Error(prefix(STABILITY_REFUSALS.width));
  }
  return masks;
}

/**
 * Read one population's stability.
 *
 * `featureCorrectByRun` is indexed by dataset position and the per-question records carry the same
 * order, which is the alignment every other reader of this field already relies on. The two are
 * checked for length so that a mismatched artifact is a refusal rather than a partition over two
 * different populations.
 */
export function stabilityOf(
  report: StabilityArtifactShape,
  selection: StabilitySelection = {},
): StabilityReading {
  const masks = readMasks(report);
  const repetitions = masks.length;
  const width = masks[0]?.length ?? 0;
  const records = report.questions;

  let indices: readonly number[];
  const wanted = selection.questionIds;
  if (wanted !== undefined) {
    const byId = new Map<string, number>();
    records?.forEach((record, index) => {
      const id = record.questionId;
      if (id !== undefined && !byId.has(id)) byId.set(id, index);
    });
    indices = wanted.map((id) => {
      const index = byId.get(id);
      if (index === undefined) throw new Error(prefix(`${STABILITY_REFUSALS.unknown}: ${id}`));
      return index;
    });
  } else {
    indices = Array.from({ length: width }, (_, index) => index);
  }

  const capability = selection.capability;
  if (capability !== undefined) {
    indices = indices.filter((index) => records?.[index]?.capability === capability);
  }
  if (indices.length === 0) {
    throw new Error(prefix(STABILITY_REFUSALS.empty));
  }

  const questions: StabilityQuestion[] = indices.map((index) => {
    let passed = 0;
    for (const mask of masks) {
      // The alphabet was checked above, so a character here is `'0'` or `'1'` and the comparison is
      // the whole test; `=== '1'` rather than a truthiness test keeps the reading independent of
      // which character a future writer chooses for "wrong".
      if (mask[index] === '1') passed += 1;
    }
    return {
      index,
      questionId: records?.[index]?.questionId,
      capability: records?.[index]?.capability,
      passed,
      repetitions,
      passRate: passed / repetitions,
    };
  });

  const stableFailures = questions.filter((question) => question.passed === 0);
  const stablePasses = questions.filter((question) => question.passed === repetitions);
  const flaky = questions.filter(
    (question) => question.passed > 0 && question.passed < repetitions,
  );
  const recoverable = questions.reduce((sum, question) => sum + (1 - question.passRate), 0);
  const totalPassed = questions.reduce((sum, question) => sum + question.passed, 0);

  return {
    repetitions,
    population: questions.length,
    questions,
    stableFailures,
    flaky,
    stablePasses,
    recoverable,
    meanAccuracy: totalPassed / (repetitions * questions.length),
  };
}

/**
 * The movement a population produces when nothing changed, in questions.
 *
 * Four repetitions give four accuracies, and their spread is the only estimate this repository has
 * of what "the same configuration twice" looks like on this population. `2 * sd` is reported
 * because the campaign's own convention is a two-standard-deviation null (§13.199's `--null`).
 */
export function repetitionNull(
  report: StabilityArtifactShape,
  selection: StabilitySelection = {},
): NullReading {
  const masks = readMasks(report);
  const reading = stabilityOf(report, selection);
  const perRepetition = masks.map(
    (mask) => reading.questions.filter((question) => mask[question.index] === '1').length,
  );
  const mean = perRepetition.reduce((sum, value) => sum + value, 0) / perRepetition.length;
  // The sample standard deviation, because four repetitions are a sample of the process and not the
  // process. With `n - 1` in the denominator a four-repetition spread of one question reads 0.58
  // rather than 0.50, and the null this campaign quotes is the conservative one.
  const variance =
    perRepetition.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    Math.max(1, perRepetition.length - 1);
  const sd = Math.sqrt(variance);
  return { perRepetition, population: reading.population, sd, twoSd: 2 * sd };
}

/**
 * What a mechanism can convert, given its target set.
 *
 * The reading is `sum(1 - passRate)` and not the size of the set: a question that four repetitions
 * answered correctly three times is worth a quarter of a question to a mechanism that would make it
 * deterministic, and the difference between the two figures is the difference between a ceiling and
 * a wish. `resolvable` compares that ceiling against `2 sd` of the population's own repetition
 * spread — a comparison the campaign has never made explicitly, and the reason several arms with a
 * defensible mechanism measured nothing.
 */
export function conversionCeiling(
  reading: StabilityReading,
  label: string,
  indices: readonly number[],
  noise: number,
): CeilingReading {
  if (indices.length === 0) {
    throw new Error(prefix(STABILITY_REFUSALS.empty));
  }
  const position = new Map<number, StabilityQuestion>();
  for (const question of reading.questions) position.set(question.index, question);
  let ceiling = 0;
  let stable = 0;
  for (const index of indices) {
    const question = position.get(index);
    if (question === undefined) {
      throw new Error(prefix(`${STABILITY_REFUSALS.unknown}: index ${index}`));
    }
    ceiling += 1 - question.passRate;
    if (question.passed === 0) stable += 1;
  }
  return {
    label,
    questions: indices.length,
    population: reading.population,
    ceiling,
    stable,
    points: (ceiling / reading.population) * 100,
    noise,
    resolvable: ceiling > noise,
  };
}

/** The partition, as a table. */
export function renderStability(reading: StabilityReading): string {
  const lines: string[] = [];
  const share = (count: number): string => `${((count / reading.population) * 100).toFixed(1)}%`;
  lines.push(
    `population ${reading.population} questions x ${reading.repetitions} repetitions = ` +
      `${reading.population * reading.repetitions} question-runs`,
  );
  lines.push(
    `mean accuracy ${(reading.meanAccuracy * 100).toFixed(2)}%   ` +
      `recoverable ${reading.recoverable.toFixed(2)} question-equivalents`,
  );
  lines.push('');
  lines.push('| repetitions correct | questions | share |');
  lines.push('| ------------------: | --------: | ----: |');
  const byCount = new Map<number, number>();
  for (const question of reading.questions) {
    byCount.set(question.passed, (byCount.get(question.passed) ?? 0) + 1);
  }
  for (let passed = 0; passed <= reading.repetitions; passed += 1) {
    const count = byCount.get(passed) ?? 0;
    lines.push(`| ${passed} of ${reading.repetitions} | ${count} | ${share(count)} |`);
  }
  lines.push('');
  lines.push(
    `stable failures ${reading.stableFailures.length}   ` +
      `flaky ${reading.flaky.length}   ` +
      `stable passes ${reading.stablePasses.length}`,
  );
  return lines.join('\n');
}

/** The ceiling reading, as one line per mechanism. */
export function renderCeilings(readings: readonly CeilingReading[]): string {
  const lines: string[] = [];
  lines.push('| mechanism | target set | stable | ceiling | points | noise (2 sd) | resolvable |');
  lines.push('| --------- | ---------: | -----: | ------: | -----: | -----------: | :--------: |');
  for (const reading of readings) {
    lines.push(
      `| ${reading.label} | ${reading.questions} | ${reading.stable} | ` +
        `${reading.ceiling.toFixed(2)} | ${reading.points.toFixed(2)} | ` +
        `${reading.noise.toFixed(2)} | ${reading.resolvable ? 'yes' : 'no'} |`,
    );
  }
  return lines.join('\n');
}
