/**
 * The shape of a pass: how much of the run was concurrency, how fast it emitted, and how long a
 * call could keep trying.
 *
 * ## Why this is a block of its own and not three keys in `memoryArmConfig`
 *
 * `memoryArmConfig` is what `--registration` compares, field for field, against the registration.
 * Every key in it is a statement about *what the arm is*, and adding one is a declared departure --
 * which is the correct cost for an arm change and the wrong one for a pipe change. Run `41431790794`
 * is why the distinction is load-bearing: nine departures in the block, and a reader could not tell
 * which of them was the experiment. The three values here (§13.224's width, §13.227's pace and
 * retry allowance) are the same arm on a different pipe, so they sit beside `transportRetry` and
 * carry no departure.
 *
 * ## Why it is in the artifact rather than only on the gate line
 *
 * It was on the gate line first, and the gate line is a log: `41393748964` is the campaign's
 * standing example of a fact that existed only in a container log and could not be recovered when
 * it mattered. A run whose wall clock is nine minutes per question and whose artifact does not say
 * what pace it was under is a run whose next dispatch is a guess.
 */
import type { ReaderPacing } from './reader-transport.js';

/** What the run was configured to do about rate, recorded so a duration can be interpreted. */
export type PassShape = {
  /** Readers in flight. Not an arm property: it changes the wall clock, not what is measured. */
  readonly workers: number;
  /**
   * Minimum gap between reader request starts, in milliseconds, or `null` when none was set.
   *
   * `null` rather than `0` because the two are different decisions with identical behaviour:
   * `0` says the deployment considered a rate and decided against one, `null` says nobody said
   * anything. An artifact that folded them together would make an unconfigured run indistinguishable
   * from a deliberately unthrottled one.
   */
  readonly minIntervalMs: number | null;
  /**
   * Wall-clock ceiling on one call's retries, in milliseconds, or `null` for the adapter default.
   *
   * `null` here means "`DEFAULT_RETRY_BUDGET_MS`, or the thinking-mode composition of it" -- which
   * is why the number is not restated: the artifact should say what the deployment asked for, and
   * the default is a property of the code the artifact already names by commit.
   */
  readonly retryBudgetMs: number | null;
};

/**
 * Build the block from what the entry point resolved.
 *
 * Takes `ReaderPacing` rather than three arguments so the reader of this call site can see that the
 * pace it records is *the same object* the reader factory was given. Two independent reads of the
 * environment would be two chances to record a pace the client did not run at -- the defect
 * `41393748964` recorded for `thinking`, one layer down.
 */
export function passShapeReport(input: {
  readonly workers: number;
  readonly pacing: ReaderPacing;
}): PassShape {
  return {
    workers: input.workers,
    minIntervalMs: input.pacing.minIntervalMs ?? null,
    retryBudgetMs: input.pacing.retryBudgetMs ?? null,
  };
}

/**
 * The three lines the Markdown report shows.
 *
 * Rendered from the given shape rather than from the environment, so a re-rendered artifact
 * reproduces the numbers of the run that produced it instead of the machine that re-rendered it.
 */
export function passShapeLines(shape: PassShape): string[] {
  const rate = shape.minIntervalMs === null ? 'none' : `${String(shape.minIntervalMs)} ms`;
  const budget = shape.retryBudgetMs === null ? 'default' : `${String(shape.retryBudgetMs)} ms`;
  return [
    '## The shape of the pass',
    '',
    // The width first: it is the one of the three that changes what a duration means without
    // changing a single answer, so a reader comparing two wall clocks needs it before the other two.
    `- Workers in flight: **${String(shape.workers)}**`,
    `- Minimum gap between reader requests: **${rate}**`,
    `- Retry budget per call: **${budget}**`,
    '',
    'None of the three is part of the arm: they change how long the run takes and whether the',
    'provider refuses it, not what was measured. `memoryArmConfig` is the block `--registration`',
    'compares, and putting them there would make a pipe change read as an arm change.',
  ];
}
