/**
 * Recording an ablation that refused to score.
 *
 * The conjunction arm is the only ablation that can legitimately decline to run:
 * its seven questions are what P2/P3 are pre-registered against, so scoring a
 * sample that lost some of them would publish a different experiment under the
 * same name. The guard that refuses is correct and must stay loud.
 *
 * What was wrong was the blast radius. `bench/run.ts` writes every other report
 * before this arm runs and persists them after, so an unrecovered throw from the
 * guard discarded the main benchmark report, its markdown, and the
 * embedding-cache write (run 35498421148 did exactly this: 11 minutes of billed
 * provider calls, zero reports persisted). The outcome a reader got was "the run
 * failed and produced nothing", when the honest outcome is "everything except
 * the conjunction arm succeeded, and the conjunction arm was declined for a
 * stated reason".
 *
 * This module keeps the reason in a machine-readable record rather than a bare
 * string, so the artifact set explains its own gap. A reader who finds no
 * `benchmark-conjunction-ablation-report.json` can find a skip record naming the
 * missing questions instead of guessing whether the arm crashed, was never
 * wired, or was silently dropped.
 */

/** The file an artifact set carries when an ablation declined to run. */
export const ABLATION_SKIP_FILENAME = 'benchmark-ablation-skipped.json';

/** One declined ablation: which arm, why, and how much of it was missing. */
export type AblationSkipRecord = {
  /** Stable identifier for the arm, matching its report filename stem. */
  readonly ablation: string;
  /** The guard's own message, unmodified. */
  readonly reason: string;
  /** Cohort members that were required and absent, when the guard names them. */
  readonly missing: readonly string[];
  /** Cohort members required in total, `0` when the arm declares no cohort. */
  readonly required: number;
};

/**
 * Extract the missing cohort member ids from a coverage-guard message.
 *
 * The guard's message is written for a human reading a log line, and it is the
 * only place the ids exist once the throw unwinds. Parsing a message is
 * normally the wrong way to move data, but the alternative here is worse: the
 * guard lives in `runner.ts` and the catcher lives in the CLI, so threading a
 * typed shortfall through would mean widening a public return type to carry
 * information the caller already has in hand but cannot deconstruct.
 *
 * The pattern is anchored on the guard's own wording — `present, missing <ids>.`
 * — rather than a bare `missing (.*)\.` search. The un-anchored form is actively
 * wrong: `"the response is missing content."` matches it and yields the cohort
 * member `content`, so a provider error would be recorded as a shortfall naming
 * a question that does not exist. Requiring the `present, ` prefix and the ids'
 * `_abs` suffix means only a real cohort report produces ids.
 *
 * Returns `[]` when the message does not match, which is the honest answer for a
 * failure that is not a coverage shortfall.
 */
export function parseMissingCohortMembers(message: string): string[] {
  const match = /\bpresent,\s*missing\s+([^.]*)\./.exec(message);
  if (match === null) {
    return [];
  }
  // The capture group is mandatory in this pattern and cannot be absent when
  // `match` is non-null, so no `?? ''` fallback is needed: an optional chain
  // here would be unreachable defensive code, and an unreachable branch in a
  // parser is worse than none because it hides a pattern change that dropped
  // the group.
  const named = match[1] as string;
  return named
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/**
 * Build the skip record for a declined ablation.
 *
 * `required` is passed in rather than counted from `missing`, because the two
 * answer different questions: a test asserting "all six controls were absent"
 * needs the denominator, and inferring it from the shortfall would make a
 * completely-missing cohort indistinguishable from a partially-missing one.
 */
export function buildAblationSkipRecord(
  ablation: string,
  error: unknown,
  required: number,
): AblationSkipRecord {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    ablation,
    reason,
    missing: parseMissingCohortMembers(reason),
    required,
  };
}

/**
 * Serialise skip records for the artifact set.
 *
 * Emits a JSON array even for the empty case so every run's artifact set has the
 * same shape: a consumer can read the key unconditionally instead of first
 * testing whether the file exists, and "no ablations were skipped" stops being
 * indistinguishable from "this run predates skip recording".
 */
export function serializeAblationSkips(skips: readonly AblationSkipRecord[]): string {
  return `${JSON.stringify(skips, null, 2)}\n`;
}
