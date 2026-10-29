/**
 * What a provider said it charged us, and what happens when it says nothing.
 *
 * ## Why this file is mostly about ABSENCE
 *
 * Every assertion below that returns `undefined` rather than `0` is the reason the
 * module exists. Before it, `OpenAICompatibleLLM.complete` parsed the response body
 * for `choices` and dropped `usage` on the floor -- so a campaign that has spent
 * weeks of provider time had no artifact anywhere stating a single token count.
 * A ledger that folded a missing `usage` block into `0` would have reproduced the
 * same blindness while looking like instrumentation: it would have reported a
 * free run.
 *
 * The distinction is the same one `resolveReaderIdentity` draws between
 * `temperature: null` and a number, and the same one `staleness_refusal` draws
 * between `None` and "stale": "the provider told us nothing" and "the provider
 * told us nothing was spent" are different facts about the run.
 */
import { describe, expect, it } from 'vitest';
import { llmUsage, parseUsage, recordUsage, usageDelta } from '../usage.js';

describe('parseUsage', () => {
  it('reads the OpenAI-compatible shape', () => {
    expect(parseUsage({ prompt_tokens: 12_000, completion_tokens: 40 })).toEqual({
      promptTokens: 12_000,
      completionTokens: 40,
      cacheHitPromptTokens: 0,
    });
  });

  it("reads DeepSeek's cache-hit counter, which is a SUBSET of the prompt", () => {
    // Not an addition: `prompt_cache_hit_tokens` is the part of `prompt_tokens` the
    // provider served from its prefix cache, and the cheaper part. Summing it into
    // the prompt would report a bill up to twice the real one.
    const usage = parseUsage({
      prompt_tokens: 12_000,
      completion_tokens: 40,
      prompt_cache_hit_tokens: 9_000,
      prompt_cache_miss_tokens: 3_000,
    });
    expect(usage).toEqual({
      promptTokens: 12_000,
      completionTokens: 40,
      cacheHitPromptTokens: 9_000,
    });
  });

  it('reports ABSENCE as undefined, never as zeros', () => {
    expect(parseUsage(undefined)).toBeUndefined();
    expect(parseUsage(null)).toBeUndefined();
  });

  it('rejects a payload that is not an object', () => {
    expect(parseUsage('usage')).toBeUndefined();
    expect(parseUsage(7)).toBeUndefined();
    expect(parseUsage([1, 2])).toBeUndefined();
  });

  it('rejects a payload missing either count', () => {
    expect(parseUsage({ prompt_tokens: 10 })).toBeUndefined();
    expect(parseUsage({ completion_tokens: 10 })).toBeUndefined();
  });

  it('rejects a count that is not a finite number', () => {
    expect(parseUsage({ prompt_tokens: 'ten', completion_tokens: 1 })).toBeUndefined();
    expect(parseUsage({ prompt_tokens: 1, completion_tokens: Number.NaN })).toBeUndefined();
    expect(
      parseUsage({ prompt_tokens: 1, completion_tokens: Number.POSITIVE_INFINITY }),
    ).toBeUndefined();
  });

  it('rejects a negative count', () => {
    expect(parseUsage({ prompt_tokens: -1, completion_tokens: 1 })).toBeUndefined();
  });

  it('drops a cache hit larger than the prompt rather than claiming the saving', () => {
    // Impossible from a correct provider. Reading it would make the subset claim in
    // `LlmUsage` false and would report a saving larger than the bill, so the field
    // is dropped: the run's claimed cache credit is then understated by at most one
    // request, which is the safe direction for a number that decides whether a
    // prompt-ordering change is worth registering.
    expect(
      parseUsage({ prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 500 }),
    ).toEqual({ promptTokens: 100, completionTokens: 1, cacheHitPromptTokens: 0 });
  });

  it('drops a cache hit that is not a number', () => {
    expect(
      parseUsage({ prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 'most' }),
    ).toEqual({ promptTokens: 100, completionTokens: 1, cacheHitPromptTokens: 0 });
  });

  it('accepts a zero-length completion, which a refusal really is', () => {
    expect(parseUsage({ prompt_tokens: 10, completion_tokens: 0 })).toEqual({
      promptTokens: 10,
      completionTokens: 0,
      cacheHitPromptTokens: 0,
    });
  });
});

describe('the process ledger', () => {
  /**
   * Every assertion here is a DIFFERENCE between two readings of the process ledger,
   * never an absolute. The ledger is process-wide on purpose (the adapter records into it
   * from ten call sites that could not thread a counter down), so an absolute assertion
   * would depend on what else in this file, or in a worker this file does not own, had
   * already spent. The delta is also the production arithmetic: `usageDelta` is what the
   * arm runner calls to turn two readings into one run's bill.
   */
  function spend(records: readonly Parameters<typeof recordUsage>[0][]) {
    const before = llmUsage();
    for (const record of records) {
      recordUsage(record);
    }
    return usageDelta(before, llmUsage());
  }

  it('sums what was priced and counts what was not', () => {
    expect(
      spend([
        { promptTokens: 100, completionTokens: 10, cacheHitPromptTokens: 40 },
        { promptTokens: 200, completionTokens: 20, cacheHitPromptTokens: 0 },
        // A response that carried no usage block. It still cost money; the ledger has to
        // say "one call, unpriced" rather than drop the call or count it as free.
        undefined,
      ]),
    ).toEqual({
      calls: 3,
      unpricedCalls: 1,
      promptTokens: 300,
      completionTokens: 30,
      cacheHitPromptTokens: 40,
    });
  });

  it('reads zero calls for a ledger nothing wrote to', () => {
    // The empty case is what a run that made no call reports, and `calls: 0` is what lets
    // a reader tell it apart from a run whose calls were all unpriced.
    expect(spend([])).toEqual({
      calls: 0,
      unpricedCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheHitPromptTokens: 0,
    });
  });

  it('returns a copy, so a reader cannot move the counters it already read', () => {
    const first = llmUsage();
    const before = first.promptTokens;
    recordUsage({ promptTokens: 1, completionTokens: 1, cacheHitPromptTokens: 0 });
    const second = llmUsage();
    // The snapshot handed out is a fresh object; writing to it cannot reach the ledger.
    (first as { promptTokens: number }).promptTokens = 999;
    expect(second.promptTokens).toBe(before + 1);
    expect(second.calls).toBe(first.calls + 1);
    // ... and the corruption did not travel: a third reading still sees the ledger.
    expect(llmUsage().promptTokens).toBe(before + 1);
  });
});

describe('usageDelta', () => {
  it('subtracts one snapshot from another, field by field', () => {
    const before = {
      calls: 3,
      unpricedCalls: 1,
      promptTokens: 100,
      completionTokens: 10,
      cacheHitPromptTokens: 5,
    };
    const after = {
      calls: 9,
      unpricedCalls: 3,
      promptTokens: 700,
      completionTokens: 70,
      cacheHitPromptTokens: 65,
    };
    expect(usageDelta(before, after)).toEqual({
      calls: 6,
      unpricedCalls: 2,
      promptTokens: 600,
      completionTokens: 60,
      cacheHitPromptTokens: 60,
    });
  });

  it('is all zeros for a run that recorded nothing', () => {
    const snapshot = {
      calls: 4,
      unpricedCalls: 0,
      promptTokens: 8,
      completionTokens: 2,
      cacheHitPromptTokens: 1,
    };
    expect(usageDelta(snapshot, snapshot)).toEqual({
      calls: 0,
      unpricedCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheHitPromptTokens: 0,
    });
  });
});
