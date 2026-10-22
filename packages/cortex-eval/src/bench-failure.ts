/**
 * A failed pass, summarised in one block.
 *
 * ## Why this is a module and not four lines in the entry point
 *
 * Run `38659495034` cost 1h49m and left `progress: died on reference-pipeline run=0
 * q=1/500 id=e47becba` and a `TimeoutError`. Run `37281155088` cost 52 minutes and left a
 * stack trace. Both are the same defect -- a failure whose durable record cannot say how
 * long it had been failing, or whether the retry ladder under it was exhausted -- and it
 * has now cost this campaign three runs.
 *
 * The repair is not "print more": it is to move the summary into a layer a test can reach.
 * An entry point that assembles a log line by hand is a log line no test can execute, which
 * is why the previous two incidents changed nothing. This function is pure, takes its inputs
 * explicitly, and is asserted against a real progress event.
 *
 * ## What it adds to what the entry point already printed
 *
 * | Fact | Before | After |
 * | --- | --- | --- |
 * | Which question was in flight | printed | printed |
 * | **How long the pass had been running** | **inferable only from the workflow's timestamps** | printed, in ms and s |
 * | **Whether the retry ladder was exhausted, and by what** | **not printed anywhere on failure** | printed when the error carries it |
 *
 * The second row is the one that matters for the next dispatch: `q=1/500` describes both a
 * hang and a slow pass, and the two want opposite repairs.
 *
 * ## Why the error is `unknown`, and the exhaustion is read structurally
 *
 * A `catch` binding is `unknown` under this repository's settings, a system under test may
 * reject with anything, and a summary that narrowed the type would either throw while
 * describing the failure or acquire a cast that hides the same assumption.
 *
 * `RetryExhaustion` is `cortex-ai`'s type and `cortex-eval` sits **below** that package,
 * so this module reads the four fields it prints by name rather than importing the shape.
 * The dependency order is not a preference here: importing it would make the harness depend
 * on one adapter, which is the arrangement every provider-agnostic layer in this repository
 * exists to prevent.
 */

import type { BenchmarkProgress } from './benchmark.js';

/**
 * The four fields `RetryExhaustion` carries that a reader needs, and no more.
 *
 * Every one is optional because the annotation is structural: a value that is absent is not
 * printed rather than printed as `undefined`. A line reading `attempts=undefined` would say
 * that a retry layer ran and reported nothing, which is a different fact from a failure that
 * never reached one.
 */
type ExhaustionSummary = {
  readonly attempts: number;
  readonly retried?: number | undefined;
  readonly rateLimited?: boolean | undefined;
  readonly elapsedMs?: number | undefined;
  readonly url?: string | undefined;
};

/** How far down a `cause` chain to look before giving up. */
const MAX_CAUSE_DEPTH = 8;

/**
 * The exhaustion annotation, if the error or one of its causes carries one.
 *
 * ## Why the chain is walked
 *
 * `retryFetch` attaches the annotation to the error it throws, and every layer above it
 * wraps -- an embedding failure reaches the benchmark as a wrapper around the transport
 * error. A reader that looked only at the top level would report the missing fact for
 * exactly the failures that are deepest and hardest to diagnose.
 *
 * ## Why `attempts` is required and the rest are not
 *
 * `attempts` is the field that distinguishes "the provider answered once with a timeout"
 * from "six attempts were made against it", and that distinction is the whole reason the
 * line exists. An annotation without it is not a summary of a retry ladder, so it is
 * ignored rather than printed with holes.
 */
function findExhaustion(error: unknown): ExhaustionSummary | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || typeof current !== 'object') return undefined;
    const annotated = (current as { retryExhausted?: unknown }).retryExhausted;
    if (annotated !== null && typeof annotated === 'object') {
      const candidate = annotated as Record<string, unknown>;
      const attempts = candidate.attempts;
      if (typeof attempts === 'number' && Number.isFinite(attempts)) {
        return {
          attempts,
          ...(typeof candidate.retried === 'number' ? { retried: candidate.retried } : {}),
          ...(typeof candidate.rateLimited === 'boolean'
            ? { rateLimited: candidate.rateLimited }
            : {}),
          ...(typeof candidate.elapsedMs === 'number' ? { elapsedMs: candidate.elapsedMs } : {}),
          ...(typeof candidate.url === 'string' ? { url: candidate.url } : {}),
        };
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The text of an error, whatever it is. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * One block describing a failed pass.
 *
 * The shape is the one the entry point already wrote -- a `progress:` line, a blank line,
 * the error -- so an existing reader of `benchmark-error.log` is not surprised by it. What
 * changed is that the first line now carries the duration and that a `retry:` line can
 * appear between the two.
 */
export function describeFailure(input: {
  readonly progress: BenchmarkProgress | undefined;
  readonly error: unknown;
}): string {
  const lines: string[] = [];

  if (input.progress === undefined) {
    lines.push('progress: no question was started before the failure');
  } else {
    const { system, run, index, total, questionId, elapsedMs } = input.progress;
    lines.push(
      `progress: died on ${system} run=${run} q=${index + 1}/${total} id=${questionId} ` +
        // Both units, because the reader wants "nearly two hours" and the log wants the
        // number that was actually measured. Seconds are derived here rather than stored.
        `at +${(elapsedMs / 1000).toFixed(1)}s (${elapsedMs}ms)`,
    );
  }

  const exhaustion = findExhaustion(input.error);
  if (exhaustion !== undefined) {
    lines.push(
      `retry: exhausted after attempts=${exhaustion.attempts}` +
        (exhaustion.retried === undefined ? '' : ` retried=${exhaustion.retried}`) +
        (exhaustion.rateLimited === undefined ? '' : ` rateLimited=${exhaustion.rateLimited}`) +
        (exhaustion.elapsedMs === undefined ? '' : ` elapsed=${exhaustion.elapsedMs}ms`) +
        (exhaustion.url === undefined ? '' : ` url=${exhaustion.url}`),
    );
  }

  lines.push('');
  lines.push(messageOf(input.error));
  return `${lines.join('\n')}\n`;
}
