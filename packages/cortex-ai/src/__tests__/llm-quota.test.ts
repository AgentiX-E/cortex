/**
 * A chat `429` that names an empty balance is typed, and a throttle on the same status is not.
 *
 * ## Why both halves are asserted in one file
 *
 * The two events share a status code and have opposite repairs: a throttle becomes true on its own, so the
 * ladder must keep retrying it, while an empty balance needs somebody to top up, so the run must stop. A test
 * that only asserted the typed error would pass equally for an adapter that typed **every** `429`, which is the
 * inversion `retry.ts`'s whitelist exists to prevent (`S9` ran 16,166 calls against a throttling provider and
 * needed every retry it got). So the control is not decoration: it is the half that says the classifier is a
 * classifier.
 *
 * ## What the type buys
 *
 * `cortex-eval`'s `latchLlmQuota` keys on the class, not on the message. Matching wording is the failure mode
 * `ProviderContentRefusal` documents from run `42368550937`, one refactor away from a silent no-op.
 */
import { describe, expect, it } from 'vitest';

import { LlmQuotaExhaustedError } from '../llm/quota-error.js';
import { OpenAICompatibleLLM } from '../llm/openai-compatible.js';

const QUOTA_BODY = JSON.stringify({
  error: { code: '1113', message: '余额不足或无可用资源包,请充值。' },
});
const THROTTLE_BODY = JSON.stringify({
  error: { code: '1302', message: 'Rate limit reached for requests' },
});

function client(
  body: string,
  status = 429,
  maxRetries = 0,
): {
  llm: OpenAICompatibleLLM;
  seen: string[];
} {
  const seen: string[] = [];
  const fetchFn = async (url: string): Promise<Response> => {
    seen.push(url);
    return new Response(body, {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return {
    llm: new OpenAICompatibleLLM({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'k',
      model: 'deepseek-chat',
      fetchFn: fetchFn as never,
      maxRetries,
    }),
    seen,
  };
}

describe('OpenAICompatibleLLM quota refusal', () => {
  it("throws a typed error carrying the provider's own words, after one request", async () => {
    const { llm, seen } = client(QUOTA_BODY);
    const error = await llm.complete('hello').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlmQuotaExhaustedError);
    const typed = error as LlmQuotaExhaustedError;
    expect(typed.status).toBe(429);
    // The sentence a person reads to decide whether the account is empty or the key is wrong.
    expect(typed.detail).toContain('余额不足');
    expect(typed.name).toBe('LlmQuotaExhaustedError');
    // The ladder already decided not to retry a balance, so the adapter sees one response -- the property the
    // whole repair exists for, and the one `43866639154`'s 127 seconds were spent on.
    expect(seen).toHaveLength(1);
  });

  it('does not type a throttle, which must stay retryable', async () => {
    const { llm } = client(THROTTLE_BODY);
    const error = await llm.complete('hello').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(LlmQuotaExhaustedError);
    expect((error as Error).name).not.toBe('LlmQuotaExhaustedError');
  });

  it('does not type a balance marker on a status other than 429', async () => {
    // `isQuotaExhausted` checks the status first, and this is the assertion that keeps the check in place: the
    // same body on a 500 is a transport failure, and a run that stopped on it would abandon a recoverable pass.
    const { llm } = client(QUOTA_BODY, 500);
    const error = await llm.complete('hello').catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(LlmQuotaExhaustedError);
  });
});
