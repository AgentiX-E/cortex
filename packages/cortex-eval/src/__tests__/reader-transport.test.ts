import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readReaderPacing,
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

  it('reads the environment at both entry points', () => {
    // Two entry points, two readers per run: a read at only one of them would pace the feature arm
    // and not the baseline, and the A/B would differ by a transport property.
    const reads = source.match(/readReaderPacing\(env\)/g) ?? [];
    expect(reads.length).toBe(2);
  });
});
