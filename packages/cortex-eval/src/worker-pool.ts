/**
 * How many questions a benchmark pass keeps in flight, read from the environment.
 *
 * ## Why this is a number and not a boolean
 *
 * The width is not a correctness question -- `benchmark-concurrency.test.ts` asserts that the
 * same configuration at one worker and at `c` workers produces byte-identical answers and
 * prompts -- it is a question about whether a measurement **fits**. `§14.22` of the execution
 * plan prices the second provider at **5.1x** the run budget at one request in flight (1.41
 * questions per minute), and the job is killed at 350 minutes. Eight requests in flight turn a
 * 336-minute pass into 42, which is the difference between requirement 12 being blocked by
 * arithmetic and being measurable.
 *
 * ## Why an environment variable rather than a dispatch input
 *
 * A dispatch input is part of the **registered configuration**, and the registration check
 * compares that against the artifact field for field. Concurrency is not part of what a run
 * measures: if two workers changed any answer, the mechanism is not per-question and that is a
 * finding, not a setting. So this belongs with the run's budget and its timeout -- properties of
 * the invocation -- rather than with the arm's configuration.
 *
 * ## Why the ceiling exists and why it is 64
 *
 * The provider's own concurrency ceiling is where a request gets refused rather than answered
 * (`1305` on the embedding endpoint, §11 of the technical design), and a refusal is not a
 * speed-up: it is retried inside a budget that was sized for a serial pass. 64 is the largest
 * width this campaign has any evidence for and it is well above the eight the arithmetic needs,
 * so a dispatch asking for more is refused with the number that would have worked.
 */

/** The variable a dispatch sets. Named once so the workflow, the doc and the refusal agree. */
const WORKERS_VARIABLE = 'CORTEX_MEMORY_WORKERS';

/**
 * The widest pass any dispatch may ask for. See this module's header for the argument.
 *
 * Not exported: nothing outside this module has a use for the number, and `readWorkers` is the
 * only way to act on it -- an export that only a test reads is the orphan this repository's
 * census gate reports. The test asserts the refusal's message rather than the constant, which
 * is the stronger assertion anyway: it checks what a dispatcher would actually see.
 */
const MAX_WORKERS = 64;

/**
 * The worker count this environment asks for. Absent means **one**, which is the serial pass
 * every archived artifact was produced by.
 *
 * Refused rather than clamped outside `[1, 64]`, and refused rather than rounded for anything
 * that is not an integer. Both alternatives produce a run whose log line describes a width the
 * pass did not use -- the shape §13.38 and §13.114 both paid for -- and a two-hour run is a bad
 * place to discover that the value was `8 ` with a trailing space.
 */
export function readWorkers(env: Record<string, string | undefined>): number {
  const raw = env[WORKERS_VARIABLE];
  if (raw === undefined) {
    return 1;
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return 1;
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1 || value > MAX_WORKERS) {
    throw new Error(
      `${WORKERS_VARIABLE} must be an integer in [1, ${String(MAX_WORKERS)}] or unset; got ` +
        `\`${trimmed}\`. Absent means one worker, which is the serial pass every archived ` +
        'artifact was produced by. A fractional or out-of-range value is refused rather than ' +
        'clamped, because the run would then log a width it did not use.',
    );
  }
  return value;
}
