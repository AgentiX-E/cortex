/**
 * The population E6 has never been dispatched on: more than one window over one corpus.
 *
 * ## The arithmetic this file answers
 *
 * `S13`'s `onMiss` states the repair in one sentence -- *"a population with more than one window
 * over one corpus -- the same corpus asked about twice -- not a dispatch of this one"* -- and
 * `AUDIT-SEMANTIC-REACH.md` §15.2 gives the reason it is needed rather than merely wanted: an
 * update is about the record it was authorised by, `updateAppliesTo` is a substring test on that
 * record against each turn of the window, and the registered population answers every question
 * from **its own** haystack. So on 500 LongMemEval-S questions the reach is zero by construction,
 * and a `deltaQuestions` of `0` there is a fact about the population rather than about the layer.
 *
 * This module multiplies the population by windows: each corpus is asked `windows` times, in
 * ascending window order, contiguously, and every question carries the corpus it reads so the
 * harness can keep one corpus on one store (`Question.corpus`, `benchmark.ts`'s `claimRun`).
 *
 * ## Why a selector over the loaded dataset rather than a second loader
 *
 * The corpus a two-window population needs is the one `loadLongMemEval` already built: same turns,
 * same gold, same date, same gold-turn annotation. A second loader would be a second definition of
 * what a question is, and the two would agree until one of them was edited -- the failure
 * `AUDIT-EVAL-CONTRACTS.md` records for the exported protocol types. So the transform takes a
 * `BenchmarkDataset` and returns one.
 *
 * ## Where it sits among the selectors, and why there
 *
 * After `sampleInstances` and after `restrictDatasetToCapability`, for the reason
 * `capability-filter.ts` states for its own placement: `limit` asks **how many corpora** and
 * `CORTEX_CAPABILITY` asks **which**, so both must see the corpus population rather than the
 * window population. `LIMIT=78, capability=KU, windows=2` therefore means "78 KU questions, each
 * asked twice" and never "156 questions, half of them second windows". Composing them in the other
 * order would make the sample size depend on a multiplication nobody could see in the log.
 *
 * ## Why `1` returns its argument rather than a copy
 *
 * An unfiltered run must be byte-identical to the run before this file existed, and every archived
 * artifact was produced under it. Returning a shallow copy with the same contents would still be a
 * second code path through the dataset -- and a copy also drops a `toBe` assertion a caller could
 * have written. So `withWindows(dataset, 1)` **is** `dataset`, the same object, and the harness's
 * log line is the only trace that the selector ran at all.
 */

import type { BenchmarkDataset, Question } from './types.js';

/**
 * The variable a dispatch sets. Module-local for the reason `capability-filter.ts` gives for its
 * own: the harness spells the name at its one call site, and a second exported spelling is a
 * second statement of one name with nothing checking that they agree.
 */
const WINDOWS_VARIABLE = 'CORTEX_WINDOWS';

/**
 * What a window's identifier carries, and therefore what a reader of an artifact splits on.
 *
 * Exported because the harness prints it on the run's configuration line: a run whose artifact
 * carries `gpt4_2f8be40d#w2` and whose log does not say what `#w2` means leaves the reader to infer
 * the format from the data. Suffix rather than prefix on purpose -- every id predicate in this
 * package is a suffix test (`endsWith('_abs')` in the loader, the judge and the recall curve), and a
 * prefix would have to be stripped before any of them ran again.
 */
export const WINDOW_MARKER = '#w';

/**
 * The widest multiplication a dispatch may ask for.
 *
 * Not a cost guard but a typo guard: the answers double with every window, and `CORTEX_WINDOWS=20`
 * is far more likely to be a keypressed zero than an intent. Eight is above the largest population
 * this campaign has any use for (the two-window one `S13` names) and far below a run that would
 * silently outrun its budget.
 */
const MAX_WINDOWS = 8;

/**
 * The window count this environment asks for. Absent, blank and `1` all mean **one**, which is the
 * population every archived artifact was produced on.
 *
 * Refused rather than clamped outside `[1, 8]`, and refused rather than rounded for anything that
 * is not a positive integer -- the same rule `readWorkers` applies, for the same reason: a clamped
 * value produces a run whose log line describes a population the pass did not grade, and a
 * two-hour dispatch is a bad place to discover that the value was `2 ` with a trailing space or
 * `two` in words.
 */
export function readWindowCount(raw: string | undefined): number {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return 1;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `${WINDOWS_VARIABLE} must be a positive whole number of windows per corpus: got ` +
        `${JSON.stringify(trimmed)}. Blank means one, which is the population every archived ` +
        'artifact was produced on; two is the population `S13` names.',
    );
  }
  const windows = Number(trimmed);
  if (windows < 1) {
    throw new Error(
      `${WINDOWS_VARIABLE}=${trimmed} would grade no window at all, so the run would report an ` +
        'accuracy of `null` over an empty denominator -- which reads as a failed arm rather than ' +
        'as a failed dispatch. One means the registered population; omit the variable for it.',
    );
  }
  if (windows > MAX_WINDOWS) {
    throw new Error(
      `${WINDOWS_VARIABLE}=${windows} multiplies the population by ${windows}, and ${MAX_WINDOWS} ` +
        'is the widest this campaign has a use for. The value is far more likely to be a mistyped ' +
        'digit than an intent, and the cost of honouring it is a run that outruns its own budget.',
    );
  }
  return windows;
}

/**
 * The dataset asked `windows` times per corpus, in corpus-major order.
 *
 * Each question keeps its turns, gold, date and gold-turn annotation, gains `corpus` set to the id
 * it was loaded under, and takes a new id: `<id>#w1`, `<id>#w2`, ... The questions of one corpus
 * are adjacent, which is the contract `Question.corpus` states and the one `claimRun` relies on.
 *
 * ## Why the first window is materialised rather than skipped
 *
 * The first window is not a warm-up to be hidden: it is the window that **absorbs**, and the second
 * is the one that can be **read**. Both are graded, and that is deliberate -- the first window's row
 * is the control for window position itself. A mechanism that moved accuracy on the second window is
 * only readable beside a first window that did not, otherwise "asking again" and "carrying an update"
 * are one number.
 *
 * ## What it refuses
 *
 * A dataset that already carries `corpus` values, because applying the transform twice would put two
 * meanings in one field and grade `#w1#w1`. An empty dataset, because the multiplication of nothing
 * is nothing and the harness would fail later with a message about the arm rather than about the
 * selector.
 */
export function withWindows(dataset: BenchmarkDataset, windows: number): BenchmarkDataset {
  if (!Number.isInteger(windows) || windows < 1) {
    throw new Error(
      `withWindows received windows=${String(windows)}, which is not a positive integer. The ` +
        'harness reads this value through `readWindowCount`, which refuses the same range; a ' +
        'caller reaching this line with it is a caller that bypassed the reader.',
    );
  }
  // The identity, not a copy. See this module's header.
  if (windows === 1) return dataset;
  if (dataset.questions.length === 0) {
    throw new Error(
      `the dataset is empty, so asking it ${windows} times per corpus grades nothing. The ` +
        'selectors compose as `limit` then `capability` then `windows`, so an empty sample is ' +
        'upstream of this call: `LIMIT=0` means the whole file and any other value must admit at ' +
        'least one question.',
    );
  }
  const alreadyWindowed = dataset.questions.find((question) => question.corpus !== undefined);
  if (alreadyWindowed !== undefined) {
    throw new Error(
      `the dataset already carries corpus ${JSON.stringify(alreadyWindowed.corpus)} on question ` +
        `${JSON.stringify(alreadyWindowed.id)}, so it is a population this transform has already ` +
        'been applied to. Applying it twice would grade `#w1#w1` and give one field two meanings.',
    );
  }
  const questions: Question[] = [];
  for (const question of dataset.questions) {
    for (let window = 1; window <= windows; window += 1) {
      questions.push({
        ...question,
        id: `${question.id}${WINDOW_MARKER}${window}`,
        corpus: question.id,
      });
    }
  }
  return { name: dataset.name, questions };
}
