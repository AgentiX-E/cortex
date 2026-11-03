import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  describeJudgeTransport,
  readReaderPacing,
  resolveJudgeTransport,
  resolveReaderTransport,
  resolveRetryBudgetMs,
  resolveTimeoutMs,
} from '../reader-transport.js';
import { DEFAULT_RETRY_BUDGET_MS, DEFAULT_RETRY_TIMEOUT_MS } from '@agentix-e/cortex-ai';

/**
 * The two transport variables, and the composition that already exists without them.
 *
 * ## Why the composition is asserted and not only the parsing
 *
 * `CORTEX_LLM_RETRY_BUDGET_MS` can be set to a value that makes the retry ladder unreachable: the
 * budget is measured from the first attempt, so a budget at or below the per-attempt deadline is
 * spent by a single slow request. Run `41393748964` is the recorded instance of exactly that pair
 * arriving by accident -- a 300 s thinking deadline against the 120 s default -- and it cost an
 * afternoon and a fabricated `429`. A knob whose invalid values are silent would reintroduce it on
 * purpose, so the pair is checked where both numbers are known.
 */
describe('readReaderPacing reads the two transport variables', () => {
  it('reports both absent when neither is set', () => {
    expect(readReaderPacing({})).toEqual({ minIntervalMs: undefined, retryBudgetMs: undefined });
  });

  it('treats a blank value as unset, like every other reader variable', () => {
    // Run `41431790794` is the reason blanks are handled rather than parsed: a workflow that
    // interpolates an unset repository variable passes `''`, and `Number('')` is 0, which would
    // have read as "no pacing" -- a configured value silently becoming the opposite of itself.
    expect(readReaderPacing({ CORTEX_LLM_MIN_INTERVAL_MS: '  ' }).minIntervalMs).toBeUndefined();
  });

  it('reads an interval', () => {
    expect(readReaderPacing({ CORTEX_LLM_MIN_INTERVAL_MS: '42000' }).minIntervalMs).toBe(42_000);
  });

  it('reads zero as zero, which is "off" rather than "unset"', () => {
    // The distinction matters at the artifact: absent means the deployment said nothing, `0` means
    // it decided there is no limit. Both behave identically and they are not the same claim.
    expect(readReaderPacing({ CORTEX_LLM_MIN_INTERVAL_MS: '0' }).minIntervalMs).toBe(0);
  });

  it('refuses a value it cannot parse, naming the variable and the value', () => {
    // A message that says "invalid configuration" sends an operator through a 400-line workflow to
    // find the one line that matters. `Number('abc')` would have been `NaN`, which reaches the
    // gate as a rejected interval -- a crash one layer away from the text that caused it.
    expect(() => readReaderPacing({ CORTEX_LLM_MIN_INTERVAL_MS: 'abc' })).toThrow(
      /CORTEX_LLM_MIN_INTERVAL_MS.*abc/,
    );
    expect(() => readReaderPacing({ CORTEX_LLM_MIN_INTERVAL_MS: '-1' })).toThrow(
      /CORTEX_LLM_MIN_INTERVAL_MS/,
    );
    expect(() => readReaderPacing({ CORTEX_LLM_MIN_INTERVAL_MS: '1.5' })).toThrow(
      /CORTEX_LLM_MIN_INTERVAL_MS/,
    );
    expect(() => readReaderPacing({ CORTEX_LLM_RETRY_BUDGET_MS: '6e5' })).toThrow(
      /CORTEX_LLM_RETRY_BUDGET_MS/,
    );
  });
});

describe('resolveReaderTransport composes the pace with the deadline it already had', () => {
  const noPacing = { minIntervalMs: undefined, retryBudgetMs: undefined };

  it('keeps the non-thinking reader on the adapter defaults', () => {
    // Nothing is passed at all. The absent-key discipline is the same one `resolveRetryBudgetMs`
    // documents: a field set to `undefined` and a field set to a number are different requests,
    // and the adapter's defaults are the single place those numbers live.
    expect(resolveReaderTransport({ type: 'disabled' }, noPacing)).toEqual({});
  });

  it('keeps the thinking reader on one attempt plus the standard budget', () => {
    expect(resolveReaderTransport({ type: 'enabled' }, noPacing)).toEqual({
      timeoutMs: 300_000,
      retryBudgetMs: 300_000 + DEFAULT_RETRY_BUDGET_MS,
    });
  });

  it('lets the deployment widen the budget without changing the deadline', () => {
    // The point of the variable: §13.226 established that the second provider wants a window
    // measured in minutes and publishes no `Retry-After`, so the client's only lever is to wait
    // longer than the default allows. The deadline is untouched because it is about one attempt.
    expect(
      resolveReaderTransport(
        { type: 'disabled' },
        { minIntervalMs: undefined, retryBudgetMs: 600_000 },
      ),
    ).toEqual({ retryBudgetMs: 600_000 });
  });

  it('leaves a budget of zero alone, because zero retries is a decision', () => {
    // The one value the inequality below must not reject: a deployment that wants no retries is
    // asking for one request per call, which is achievable and is not the unreachable ladder.
    expect(
      resolveReaderTransport({ type: 'disabled' }, { minIntervalMs: undefined, retryBudgetMs: 0 }),
    ).toEqual({ retryBudgetMs: 0 });
  });

  it('refuses a budget the per-attempt deadline would consume', () => {
    // The recorded defect of `41393748964`, now refused at configuration rather than discovered as
    // a `429` the provider never sent. The floor is named, because the operator's next move is to
    // pick a number and they need to know which one is too small.
    expect(() =>
      resolveReaderTransport(
        { type: 'disabled' },
        { minIntervalMs: undefined, retryBudgetMs: 30_000 },
      ),
    ).toThrow(new RegExp(`greater than the ${DEFAULT_RETRY_TIMEOUT_MS} ms`));
    expect(() =>
      resolveReaderTransport(
        { type: 'enabled' },
        { minIntervalMs: undefined, retryBudgetMs: 200_000 },
      ),
    ).toThrow(/greater than the 300000 ms/);
  });

  it('forwards the interval as a third independent field', () => {
    // Independent of the budget in both directions: a run may pace without widening, and widen
    // without pacing, which is exactly what the two dispatches in §13.221 need.
    expect(
      resolveReaderTransport(
        { type: 'disabled' },
        { minIntervalMs: 6_000, retryBudgetMs: undefined },
      ),
    ).toEqual({ minIntervalMs: 6_000 });
  });

  it('agrees with the two functions it replaces', () => {
    // These two exports stay because archived artifacts and their documentation quote the numbers
    // they return; the composition must not drift from them.
    expect(resolveTimeoutMs({ type: 'enabled' })).toBe(300_000);
    expect(resolveRetryBudgetMs({ type: 'enabled' })).toBe(300_000 + DEFAULT_RETRY_BUDGET_MS);
  });
});

/**
 * The wiring, read from the source.
 *
 * An option that the factory accepts but never forwards is indistinguishable, from every artifact,
 * from an option that works: this repository has that failure twice on record (`41393748964`'s
 * unwired `thinking`, and the `response_format` flag that was built, tested and never sent). The
 * unit tests above prove the decisions; this proves the decisions reach the client.
 */
describe('the factory hands the transport to the adapter', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'llm-factory.ts'), 'utf8');

  it('builds the reader from the composed transport rather than from two hand-set fields', () => {
    expect(source).toContain('...resolveReaderTransport(');
  });

  it('reads the environment once per entry point, and there are three of them now', () => {
    // Two reader entry points, because a read at only one of them would pace the feature arm and
    // not the baseline, and the A/B would differ by a transport property. The third is the judge
    // (§13.236): it reads the same variables, so a judge built from a literal would be a second
    // copy of the deployment's pace -- and the one client whose pace nobody would think to check.
    const reads = source.match(/readReaderPacing\(env\)/g) ?? [];
    expect(reads.length).toBe(3);
  });

  it('gives the judge its own pair rather than the reader spread', () => {
    expect(source).toContain('...resolveJudgeTransport(');
  });
});

/**
 * The judge's pair: the instrument's transport, which is not the reader's.
 *
 * `41585013786` is the run behind every assertion here. Its five hundred answers were in memory,
 * it had been judging for twenty-six minutes, and one call exhausted a ladder that nominally has
 * nine rungs -- because the ceiling it inherited (`120 s`) buys two attempts at the reader's
 * `60 s` deadline. A judge prompt is one question and one word, so both numbers were wrong for
 * the workload even after the run's data was made survivable (§13.236).
 */
describe('resolveJudgeTransport sizes the instrument separately from the subject', () => {
  it('gives the judge many attempts by keeping the ceiling far above the deadline', () => {
    const judge = resolveJudgeTransport({ minIntervalMs: undefined, retryBudgetMs: undefined });
    expect(judge.timeoutMs).toBe(30_000);
    expect(judge.retryBudgetMs).toBe(300_000);
    // The relationship the reader's guard enforces, asserted for the pair that bypasses it: a
    // ceiling at or below the deadline is spent by one slow attempt and the ladder cannot walk.
    expect(judge.retryBudgetMs!).toBeGreaterThan(judge.timeoutMs!);
    // Ten deadlines fit inside the ceiling, so a stalled attempt cannot be the whole story.
    expect(judge.retryBudgetMs! / judge.timeoutMs!).toBeGreaterThanOrEqual(9);
  });

  it('is shorter than the reader on the deadline and longer on the ceiling', () => {
    const judge = resolveJudgeTransport({ minIntervalMs: undefined, retryBudgetMs: undefined });
    // The reader's pair for a non-thinking arm is the adapter's own defaults -- the resolver
    // omits both fields rather than restating them, which is why the comparison is against the
    // defaults and not against the resolver's return value.
    const reader = resolveReaderTransport(
      { type: 'disabled' },
      { minIntervalMs: undefined, retryBudgetMs: undefined },
    );
    expect('timeoutMs' in reader).toBe(false);
    expect(judge.timeoutMs!).toBeLessThan(DEFAULT_RETRY_TIMEOUT_MS);
    expect(judge.retryBudgetMs!).toBeGreaterThan(DEFAULT_RETRY_BUDGET_MS);
  });

  it('inherits the pace, which belongs to the provider rather than to the workload', () => {
    const judge = resolveJudgeTransport({ minIntervalMs: 6000, retryBudgetMs: undefined });
    expect(judge.minIntervalMs).toBe(6000);
  });

  it('does not carry a pacing field when the deployment stated none', () => {
    const judge = resolveJudgeTransport({ minIntervalMs: undefined, retryBudgetMs: undefined });
    expect('minIntervalMs' in judge).toBe(false);
  });

  it('describes the pair it builds, so the log cannot drift from the client', () => {
    const judge = resolveJudgeTransport({ minIntervalMs: undefined, retryBudgetMs: undefined });
    const line = describeJudgeTransport();
    expect(line).toContain(`deadlineMs=${String(judge.timeoutMs)}`);
    expect(line).toContain(`retryBudgetMs=${String(judge.retryBudgetMs)}`);
    // The one property of a judge that is not a number and cannot be read off the transport.
    expect(line).toContain('thinking=disabled');
  });
});
