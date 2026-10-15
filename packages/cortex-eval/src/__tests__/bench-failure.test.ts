/**
 * What a failed pass leaves behind must be enough to say what failed and how long it had
 * been failing.
 *
 * ## The incident these tests are written against
 *
 * Run `38659495034` -- the §13.27 dispatch -- died after **1h49m** and left this:
 *
 *     progress: died on reference-pipeline run=0 q=1/500 id=e47becba
 *
 *     TimeoutError: The operation was aborted due to timeout
 *
 * Two facts are missing from that, and both matter:
 *
 *   1. **How long the pass had been running.** `q=1/500` is consistent with a pass that
 *      died immediately and with one that spent nearly two hours inside a single question,
 *      and those want opposite repairs -- a hang is retried or circuited, a slow pass is
 *      given a longer budget or a smaller sample. The reader had to infer the duration from
 *      the run's `created_at`/`completed_at`, which is a fact about the workflow rather
 *      than about the failure.
 *   2. **Whether the retry layer was exhausted and by what.** The message is the last of a
 *      ladder of attempts; a reader cannot tell whether the provider answered once with a
 *      timeout or was hammered six times, which is the difference between an endpoint that
 *      was down and one that was throttling.
 *
 * The prior incident in this suite's own header -- `37281155088`, 52 minutes and a stack
 * trace and nothing else -- is the same defect one field earlier. This is the third time
 * the same class has cost a run, which is why the summary is a function with tests rather
 * than four more lines in the entry point: an entry point that builds a log line by hand
 * is a log line no test can reach.
 *
 * ## Why this module takes the error as `unknown`
 *
 * It reads one optional property off it and must not assume a shape. A `catch` binding is
 * `unknown` under this repository's settings, a system under test may throw anything, and
 * a summary function that narrowed the type would either throw on the thing it exists to
 * describe or acquire a cast that hides the same assumption.
 */
import { describe, expect, it } from 'vitest';

import { describeFailure } from '../bench-failure.js';
import type { BenchmarkProgress } from '../benchmark.js';

const AT_QUESTION_ONE: BenchmarkProgress = {
  system: 'reference-pipeline',
  index: 0,
  total: 500,
  run: 0,
  questionId: 'e47becba',
  elapsedMs: 6_540_000,
};

describe('describeFailure', () => {
  it('says so when no question was started, rather than naming one', () => {
    const text = describeFailure({ progress: undefined, error: new Error('boom') });

    expect(text).toContain('no question was started before the failure');
    expect(text).toContain('boom');
  });

  it('names the system, the run, the question and the total', () => {
    const text = describeFailure({ progress: AT_QUESTION_ONE, error: new Error('boom') });

    expect(text).toContain('reference-pipeline');
    expect(text).toContain('run=0');
    expect(text).toContain('q=1/500');
    expect(text).toContain('e47becba');
  });

  it('reports how long the pass had been running, in seconds as well as milliseconds', () => {
    // The first of the two missing facts. Seconds because the number that matters is
    // "nearly two hours" and a reader comparing it against a run's own duration should not
    // have to do the division.
    const text = describeFailure({ progress: AT_QUESTION_ONE, error: new Error('boom') });

    expect(text).toContain('6540000');
    expect(text).toContain('6540');
  });

  it('summarises an exhausted retry when the error carries one', () => {
    // The second missing fact. The shape is `RetryExhaustion` from `cortex-llm`, attached
    // under `retryExhausted`; this module reads it structurally because `cortex-eval` sits
    // below that package in the dependency order and must not import it.
    const error = new Error('fetch failed') as Error & { retryExhausted?: unknown };
    error.retryExhausted = {
      url: 'https://api.z.ai/api/paas/v4/embeddings',
      attempts: 6,
      retried: 5,
      rateLimited: true,
      elapsedMs: 391_000,
    };

    const text = describeFailure({ progress: AT_QUESTION_ONE, error });

    expect(text).toContain('attempts=6');
    expect(text).toContain('retried=5');
    expect(text).toContain('rateLimited=true');
    expect(text).toContain('391000');
    expect(text).toContain('api.z.ai');
  });

  it('omits the retry line for an error that carries none', () => {
    // A summary that printed `attempts=undefined` would read as a retry layer that ran and
    // reported nothing, which is a different fact from a failure that never reached it.
    const text = describeFailure({ progress: AT_QUESTION_ONE, error: new Error('boom') });

    expect(text).not.toContain('attempts=');
  });

  it('finds the exhaustion under a cause as well as at the top', () => {
    // `retryFetch` attaches it to the error it throws, and callers wrap. Reading only the
    // top level would report the missing fact for every wrapped failure, which is the
    // state this function exists to end.
    const inner = new Error('fetch failed') as Error & { retryExhausted?: unknown };
    inner.retryExhausted = { url: 'https://example.test/v1', attempts: 3, retried: 2 };
    const outer = new Error('embedding failed', { cause: inner });

    const text = describeFailure({ progress: AT_QUESTION_ONE, error: outer });

    expect(text).toContain('attempts=3');
    expect(text).toContain('example.test');
  });

  it('describes an error that is not an Error at all', () => {
    // A rejection can carry anything, and a summary that threw while describing a failure
    // would replace the failure with itself.
    const text = describeFailure({ progress: undefined, error: 'just a string' });

    expect(text).toContain('just a string');
  });

  it('describes an object the retry layer did not annotate without inventing fields', () => {
    const error = new Error('boom') as Error & { retryExhausted?: unknown };
    error.retryExhausted = { url: undefined };

    const text = describeFailure({ progress: AT_QUESTION_ONE, error });

    expect(text).not.toContain('attempts=');
    expect(text).toContain('boom');
  });

  it('prints only the fields the annotation carried, and no placeholders', () => {
    // A line reading `url=undefined` would describe a retry that reached a nameless
    // endpoint, which is a different fact from one that never got that far. Each optional
    // field is therefore omitted rather than defaulted, and this is the case that exercises
    // every omission at once -- the minimum annotation a retry layer can attach.
    const error = new Error('boom') as Error & { retryExhausted?: unknown };
    error.retryExhausted = { attempts: 2 };

    const text = describeFailure({ progress: undefined, error });

    expect(text).toContain('retry: exhausted after attempts=2');
    expect(text).not.toContain('retried=');
    expect(text).not.toContain('rateLimited=');
    expect(text).not.toContain('elapsed=');
    expect(text).not.toContain('url=');
  });

  it('gives up on a self-referential cause chain instead of looping', () => {
    // A `cause` chain is caller-supplied data, so it can be a cycle -- a wrapped error whose
    // wrapper is itself the cause is easy to build by accident when two layers each attach
    // the other. The walk is bounded, and this is the test that holds the bound: an
    // unbounded walk here would hang the failure path, which is the one path that must
    // always finish.
    const first = new Error('outer') as Error & { cause?: unknown };
    const second = new Error('inner') as Error & { cause?: unknown };
    first.cause = second;
    second.cause = first;

    const text = describeFailure({ progress: undefined, error: first });

    expect(text).toContain('outer');
    expect(text).not.toContain('attempts=');
  });

  it('walks past an annotated object whose attempts is not a number', () => {
    // `attempts` is the field that makes the annotation a summary of a retry ladder rather
    // than a bag of keys, so an annotation without it is skipped and the walk continues --
    // a deeper cause may carry a complete one.
    const deep = new Error('deep') as Error & { retryExhausted?: unknown };
    deep.retryExhausted = { attempts: 4, url: 'https://deep.test/v1' };
    const shallow = new Error('shallow') as Error & {
      retryExhausted?: unknown;
      cause?: unknown;
    };
    shallow.retryExhausted = { attempts: 'four' };
    shallow.cause = deep;

    const text = describeFailure({ progress: undefined, error: shallow });

    expect(text).toContain('attempts=4');
    expect(text).toContain('deep.test');
  });
});
