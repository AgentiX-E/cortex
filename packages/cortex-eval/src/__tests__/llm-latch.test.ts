/**
 * The chat latch: one refusal closes the process, and every later call is refused without a request.
 *
 * ## What has to be true, and what each assertion is worth
 *
 * | claim | how it is asserted | what a broken version looks like |
 * | --- | --- | --- |
 * | the first balance refusal closes the latch | `closure.atCall` is the ordinal of that call | a latch that never closes: `closure === null` |
 * | later calls cost nothing | the inner client's call count does not move | the defect `R2` paid 666 s for: 33 refusals |
 * | the refusal keeps the type | the thrown value is `LlmQuotaExhaustedError` with the first status and detail | a plain `Error`, which every classifier above would have to match by wording |
 * | a non-quota failure does not close | inner throws `TypeError`, latch stays open, the error passes through | a latch that closes on any failure, which would abandon a run over a malformed prompt |
 * | both methods are guarded | `completeStructured` after closure refuses locally too | a latch that guards only `complete`, leaving the aggregated routes paying |
 *
 * ## Why the module is imported afresh for each case
 *
 * The counters are process-wide by design (`llm-latch.ts` argues why a reader and a judge must share one
 * closure), so there is no reset function -- one would be an export with no production caller, which
 * `tools/export-census.mjs` reports as an orphan. `vi.resetModules()` gives each case its own process, which is
 * exactly the isolation a benchmark process has.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import type * as LatchModule from '../llm-latch.js';
import type * as AiModule from '@agentix-e/cortex-ai';

let latch: typeof LatchModule;
let ai: typeof AiModule;

beforeEach(async () => {
  vi.resetModules();
  latch = await import('../llm-latch.js');
  ai = await import('@agentix-e/cortex-ai');
});

/** A client that fails with the given error on every call, counting the calls that reached it. */
function stub(error: unknown): { llm: LLM; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    llm: {
      complete: async () => {
        calls += 1;
        throw error;
      },
      completeStructured: async () => {
        calls += 1;
        throw error;
      },
    } as unknown as LLM,
  };
}

function refusal(detail = '余额不足或无可用资源包,请充值。'): Error {
  return new ai.LlmQuotaExhaustedError(`LLM request failed: 429 — ${detail}`, 429, detail);
}

describe('latchLlmQuota', () => {
  it('closes on the first refusal and reports the ordinal, the status and the words', async () => {
    const inner = stub(refusal());
    const llm = latch.latchLlmQuota(inner.llm);
    const error = await llm.complete('q').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ai.LlmQuotaExhaustedError);
    expect(latch.llmQuotaLatchReading()).toEqual({
      calls: 1,
      refusedByProvider: 1,
      refusedAfterLatch: 0,
      closure: { atCall: 1, status: 429, detail: '余额不足或无可用资源包,请充值。' },
    });
  });

  it('refuses every later call without reaching the provider', async () => {
    const inner = stub(refusal());
    const llm = latch.latchLlmQuota(inner.llm);
    await llm.complete('q1').catch(() => undefined);
    for (const question of ['q2', 'q3', 'q4']) {
      const error = await llm.complete(question).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ai.LlmQuotaExhaustedError);
      // The message names the call that closed it and how many were refused since -- the two numbers an
      // operator needs to tell "one question hit a wall" from "the run kept paying into it".
      expect((error as Error).message).toContain('no quota left');
    }
    // **The number the mechanism exists for.** One request, not four.
    expect(inner.calls()).toBe(1);
    expect(latch.llmQuotaLatchReading()).toMatchObject({
      calls: 1,
      refusedByProvider: 1,
      refusedAfterLatch: 3,
    });
    // The closure does not move: the ordinal is the call that closed it, not the last one refused.
    expect(latch.llmQuotaLatchReading().closure?.atCall).toBe(1);
  });

  it('guards the structured call too', async () => {
    // The aggregated routes ask through `completeStructured`. A latch that wrapped only `complete` would look
    // healthy on every single-block route and pay in full on the one family of prompts that asks for a plan.
    const inner = stub(refusal());
    const llm = latch.latchLlmQuota(inner.llm);
    const schema = { type: 'object' as const, properties: {}, required: [] };
    await llm.completeStructured('q1', schema).catch(() => undefined);
    await llm.completeStructured('q2', schema).catch(() => undefined);
    expect(inner.calls()).toBe(1);
    expect(latch.llmQuotaLatchReading().refusedAfterLatch).toBe(1);
  });

  it('rethrows a failure that is not a quota refusal, and stays open', async () => {
    const inner = stub(new TypeError('malformed prompt'));
    const llm = latch.latchLlmQuota(inner.llm);
    const error = await llm.complete('q').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TypeError);
    expect(latch.llmQuotaLatchReading()).toEqual({
      calls: 1,
      refusedByProvider: 0,
      refusedAfterLatch: 0,
      closure: null,
    });
  });

  it('recognises the refusal by name when the class is resolved twice', async () => {
    // A workspace can resolve one package twice (a nested dependency, a rebuilt `dist`), and `instanceof`
    // across two copies is false. The fallback is the `name` the producer sets, which is why the class sets it.
    const alien = Object.assign(new Error('LLM request failed: 429'), {
      name: 'LlmQuotaExhaustedError',
      status: 429,
      detail: 'insufficient_quota',
    });
    const inner = stub(alien);
    const llm = latch.latchLlmQuota(inner.llm);
    await llm.complete('q').catch(() => undefined);
    expect(latch.llmQuotaLatchReading().closure).toMatchObject({
      status: 429,
      detail: 'insufficient_quota',
    });
  });

  it('counts calls that succeed, so the reading has a denominator', async () => {
    // A run with 4,000 calls and one refusal is a different story from a run with two, and only the counter
    // says which one happened.
    let calls = 0;
    const llm = latch.latchLlmQuota({
      complete: async () => {
        calls += 1;
        return calls === 2 ? await Promise.reject(refusal()) : 'ok';
      },
      completeStructured: async () => 'unused',
    } as unknown as LLM);
    expect(await llm.complete('q1')).toBe('ok');
    await llm.complete('q2').catch(() => undefined);
    expect(latch.llmQuotaLatchReading()).toMatchObject({
      calls: 2,
      refusedByProvider: 1,
      closure: { atCall: 2 },
    });
  });
});
