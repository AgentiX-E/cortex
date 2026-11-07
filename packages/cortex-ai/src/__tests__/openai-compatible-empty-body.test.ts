/**
 * What `OpenAICompatibleLLM.complete` does when the provider answers `200` and no completion.
 *
 * ## Why this file exists
 *
 * Run `42347151147` -- the dispatch that would have measured `verbatim-acts` with its character
 * room paid back -- died 135 seconds in, at question 88 of 500, on this:
 *
 * ```
 * TypeError: Cannot read properties of null (reading 'usage')
 *     at OpenAICompatibleLLM.complete (openai-compatible.ts:83:33)
 * ```
 *
 * The provider had answered with the four-character body `null`. `res.json()` returns `null` for
 * that input, and the next line read `json.usage`. The cost was not one wrong answer; it was the
 * whole dispatch, because the failure propagates out of `runWorker` and `runBenchmark` has nothing
 * that turns one question's exception into one question's miss.
 *
 * ## The four traps the tests below close
 *
 *   - **`null` is not "absent".** A response body that parses to `null` is a successful HTTP call
 *     whose JSON is the literal `null`. Optional chaining on the *property* (`json.usage`) does not
 *     help; the chain has to start at the root.
 *   - **an empty body does not return `null`, it throws.** `res.json()` on a zero-length body
 *     raises a `SyntaxError`, so a guard written as `if (json === null)` handles the `null` case and
 *     still dies on the empty one. Both have to land in the same place.
 *   - **a non-string `content` is not an answer.** `??` accepts a number, and `parseAnswer` would
 *     then be handed a value it never expects. `typeof` is the check that matches the type.
 *   - **the retry ladder cannot catch this.** `retryableFetchWithStats` retries on status, network
 *     errors and per-attempt deadlines; a `200` is a success to it, so the response is returned and
 *     the ladder has already finished. That is why the repair belongs here rather than in `retry.ts`
 *     -- and the last test pins it, so a future change that moves the guard up a layer fails here
 *     instead of silently reintroducing a dispatch-killing path.
 *
 * ## Why an empty answer is returned rather than thrown
 *
 * The accounting already makes it visible, which is the condition for tolerating it.
 * `parseUsage(undefined)` returns `undefined`, `recordUsage` counts that as an **unpriced** call, and
 * `report.ts` prints `PARTIAL: N of M calls reported no usage` whenever any call went unpriced. So a
 * provider returning empty bodies cannot be read as a free run, and one such answer costs one
 * question instead of one dispatch. Throwing would trade a measurable single miss for an
 * unmeasurable total loss.
 */

import { describe, expect, it } from 'vitest';

import { OpenAICompatibleLLM } from '../llm/openai-compatible.js';
import { llmUsage, usageDelta } from '../usage.js';

/** A transport that answers every request with the given status and body. */
function answering(status: number, body: string, seen?: { calls: number }): typeof fetch {
  return (async () => {
    if (seen !== undefined) seen.calls += 1;
    return new Response(body, { status });
  }) as unknown as typeof fetch;
}

function build(fetchFn: typeof fetch): OpenAICompatibleLLM {
  return new OpenAICompatibleLLM({
    baseUrl: 'https://provider.invalid/v1',
    apiKey: 'test-key-not-a-secret',
    model: 'test-model',
    fetchFn,
  });
}

describe('a 200 response that carries no completion', () => {
  it('returns an empty string when the body is the JSON literal null', async () => {
    // The exact shape of `42347151147`: `null` parses cleanly, so a `catch` on `res.json()` alone
    // would not save this case -- the chain has to start with `json?.`.
    const answer = await build(answering(200, 'null')).complete('prompt');
    expect(answer).toBe('');
  });

  it('returns an empty string when the body is empty, which throws instead of returning null', async () => {
    // `res.json()` on a zero-length body raises `SyntaxError: Unexpected end of JSON input`. A guard
    // written as `json === null` would pass the test above and die here.
    const answer = await build(answering(200, '')).complete('prompt');
    expect(answer).toBe('');
  });

  it('returns an empty string when the body is an object with no choices', async () => {
    const answer = await build(
      answering(200, '{"usage":{"prompt_tokens":9,"completion_tokens":1}}'),
    ).complete('prompt');
    expect(answer).toBe('');
  });

  it('refuses a content field that is not a string', async () => {
    // `??` would return the number. A proxy that rewrites `content` is a real failure mode, and
    // handing `parseAnswer` a number is a second failure on top of it.
    const answer = await build(answering(200, '{"choices":[{"message":{"content":42}}]}')).complete(
      'prompt',
    );
    expect(answer).toBe('');
  });

  it('still returns the content of a normal completion', async () => {
    // The control. Without it the four tests above are satisfied by a function that always returns
    // the empty string.
    const answer = await build(
      answering(
        200,
        '{"choices":[{"message":{"content":"Alice"}}],"usage":{"prompt_tokens":7,"completion_tokens":2}}',
      ),
    ).complete('prompt');
    expect(answer).toBe('Alice');
  });
});

describe('the accounting, which is the condition for tolerating the empty answer', () => {
  it('books an empty completion as an unpriced call rather than as a free one', async () => {
    // This is what keeps the tolerance honest: `report.ts` prints `PARTIAL: N of M calls reported no
    // usage` when any call is unpriced, so a provider answering `null` to everything produces an
    // artifact that says so instead of an artifact that reads like a zero-cost run.
    const before = llmUsage();
    await build(answering(200, 'null')).complete('prompt');
    const delta = usageDelta(before, llmUsage());

    expect(delta.calls).toBe(1);
    expect(delta.unpricedCalls).toBe(1);
    expect(delta.promptTokens).toBe(0);
  });

  it('books a priced completion with its tokens', async () => {
    const before = llmUsage();
    await build(
      answering(
        200,
        '{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":11,"completion_tokens":3}}',
      ),
    ).complete('prompt');
    const delta = usageDelta(before, llmUsage());

    expect(delta.calls).toBe(1);
    expect(delta.unpricedCalls).toBe(0);
    expect(delta.promptTokens).toBe(11);
  });
});

describe('why the guard sits in complete() and not in the retry ladder', () => {
  it('does not retry a 200, so the ladder has already finished when the body is read', async () => {
    // `retryableFetchWithStats` retries on status, network errors and per-attempt deadlines. A 200 is
    // a success to it, so the body is read after the ladder returned -- with no attempts left and no
    // knowledge that the body was unusable. If a future change moved this guard up into the ladder,
    // this count would rise and the test would say so.
    const seen = { calls: 0 };
    await build(answering(200, 'null', seen)).complete('prompt');
    expect(seen.calls).toBe(1);
  });
});
