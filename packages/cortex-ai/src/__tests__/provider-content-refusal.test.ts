/**
 * What the adapter does with a provider that refuses to read the prompt, and with one that refuses
 * to serve it.
 *
 * ## Why this file exists
 *
 * `ProviderContentRefusal` was introduced because a `400` from a moderation filter was being caught
 * by a per-question handler that treated every `400` as a malformed body — so a refused prompt was
 * classified as a defect in the harness, and the harness kept sending it. The class is the repair:
 * a caller can key on the *type* instead of matching prose in a message.
 *
 * The class was also, until this file, the only export in the package with no test. The gate that
 * found it is `tools/coverage-per-file.mjs`: the package mean read 98.38 / 97.55 / 96.55 / 98.48 and
 * passed, while this file read 86.27 / 84.21 / 84.62 / 85.42. A mean is an average over files.
 *
 * ## The four distinctions the tests pin
 *
 *   - **A refusal is not an `Error`.** The type is what a caller keys on. `instanceof` is asserted,
 *     along with `name`, `status` and `providerCode`.
 *   - **A `400` without a moderation marker is still an ordinary `Error`.** A malformed body is a
 *     defect that must keep crashing the pass; widening the class to every `400` would turn a
 *     harness bug into a content decision and silence it.
 *   - **A `429` quoting a marker is throttling, not refusal.** A throttling body that happened to
 *     contain the string `sensitive content` would otherwise be reported as a content refusal, and
 *     a wait would become a lost measurement. The status gate is the defence, and the negative
 *     control below is a `429` carrying the exact marker.
 *   - **The refusal reason and the remaining budget reach the message.** A call that the ladder
 *     declined to retry says so, with the attempts taken and the milliseconds left; without that,
 *     a `429` that was never chased reads exactly like one that was chased eight times.
 */

import { describe, expect, it } from 'vitest';

import { OpenAICompatibleLLM, ProviderContentRefusal } from '../llm/openai-compatible.js';

/** A transport that answers every request with one status and body. */
function answering(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): typeof fetch {
  return (async () => new Response(body, { status, headers })) as unknown as typeof fetch;
}

function build(fetchFn: typeof fetch, extra: Record<string, unknown> = {}): OpenAICompatibleLLM {
  return new OpenAICompatibleLLM({
    baseUrl: 'https://provider.invalid/v1',
    apiKey: 'test-key',
    model: 'test-model',
    fetchFn,
    maxRetries: 0,
    retryBudgetMs: 1_000,
    ...extra,
  });
}

/** Zhipu's own shape for a moderated prompt: a `contentFilter` array and code `1301`. */
const ZHIPU_REFUSAL = JSON.stringify({
  error: { code: '1301', message: 'The request was rejected by the content filter.' },
  contentFilter: [{ level: 1, role: 'user' }],
});

describe('a provider that refuses to read the prompt', () => {
  it('throws a ProviderContentRefusal rather than a bare Error', async () => {
    const llm = build(answering(400, ZHIPU_REFUSAL));
    const error = await llm.complete('a prompt the filter dislikes').then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ProviderContentRefusal);
    expect(error).toBeInstanceOf(Error);
    expect((error as ProviderContentRefusal).name).toBe('ProviderContentRefusal');
    expect((error as ProviderContentRefusal).status).toBe(400);
    expect((error as ProviderContentRefusal).providerCode).toBe('1301');
    // The provider's body is carried, because the marker that identified the refusal is the only
    // evidence a later reader has for why this question was dropped.
    expect((error as ProviderContentRefusal).message).toContain('LLM request failed: 400');
    expect((error as ProviderContentRefusal).message).toContain('content filter');
  });

  it('recognises the English wording some gateways answer 422 with, and reports no code', async () => {
    const llm = build(answering(422, 'the prompt was rejected as sensitive content'));
    const error = await llm.complete('another prompt').then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ProviderContentRefusal);
    expect((error as ProviderContentRefusal).status).toBe(422);
    // The body published no `"code"` field, so the field is null rather than the word 'null'.
    expect((error as ProviderContentRefusal).providerCode).toBeNull();
  });

  it('reads an unquoted numeric code as the provider published it', async () => {
    const llm = build(answering(400, '{"contentFilter":[{"level":2}],"code":1301}'));
    const error = await llm.complete('a third prompt').then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect((error as ProviderContentRefusal).providerCode).toBe('1301');
  });

  it('leaves a 400 without a marker as an ordinary error, so a malformed body still crashes the pass', async () => {
    const llm = build(answering(400, '{"error":{"message":"unknown field tools[0].strict"}}'));
    const error = await llm.complete('a malformed request').then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ProviderContentRefusal);
    expect((error as Error).message).toContain('400');
  });
});

describe('a provider that refuses to serve the prompt', () => {
  it('treats a 429 quoting a moderation marker as throttling, not as a content refusal', async () => {
    const llm = build(answering(429, ZHIPU_REFUSAL));
    const error = await llm.complete('a throttled prompt').then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // The marker is present and the status is not one moderation gateways use, so widening the
    // class here would convert a wait into a lost measurement.
    expect(error).not.toBeInstanceOf(ProviderContentRefusal);
    expect((error as Error).message).toContain('LLM request failed: 429');
  });

  it('names why the ladder did not retry, and how much of the budget was left', async () => {
    const llm = build(answering(503, 'upstream unavailable'));
    const error = await llm.complete('a prompt behind a broken upstream').then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    const message = (error as Error).message;
    expect(message).toContain('not retried (attempts-exhausted) after 1 attempt(s)');
    // Non-null `remainingMs`: the budget is enforced by default, so the message has to say how much
    // of it was left rather than falling through the `null` arm the other four tests exercise.
    expect(message).toMatch(/ and \d+ s was left/);
  });

  it('declines a Retry-After that exceeds what is left, and says what the provider asked for', async () => {
    const llm = build(answering(429, 'slow down', { 'retry-after': '30' }), {
      maxRetries: 2,
      retryBudgetMs: 50,
    });
    const error = await llm.complete('a prompt inside a closed window').then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    const message = (error as Error).message;
    expect(message).toContain('not retried (retry-after-beyond-budget)');
    expect(message).toContain('the provider asked for 30 s');
  });
});

describe('a ladder with no ceiling', () => {
  it('omits the remaining-budget clause, because there is no budget to report', async () => {
    // `retryBudgetMs` accepts a negative number to disable the ceiling entirely (retry.ts). In that
    // state `remainingMs` is `null` rather than a number, and the message must not claim "0 s was
    // left" — that would describe a ceiling the caller explicitly removed.
    const llm = build(answering(503, 'upstream unavailable'), { retryBudgetMs: -1 });
    const error = await llm.complete('a prompt behind an unbounded ladder').then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    const message = (error as Error).message;
    expect(message).toContain('not retried (attempts-exhausted) after 1 attempt(s)');
    expect(message).not.toContain('was left');
  });
});
