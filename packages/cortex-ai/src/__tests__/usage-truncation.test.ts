/**
 * Whether a call's generation was cut off by the provider's output limit.
 *
 * ## The reading that motivated this file
 *
 * `S17` billed **2,938 completion tokens per call** on the feature arm and delivered **513 characters** of
 * answer. The `answerChars` instrument says how much of the bill never reached the caller; it cannot say
 * *why*. Two mechanisms produce that gap and they call for opposite repairs:
 *
 * | mechanism | what a repair costs |
 * | --- | --- |
 * | the reply contract makes the model write a work product nobody reads | a prompt change, which needs a pre-registered A/B |
 * | the generation is cut off before the answer is written | a defect: the answer was never produced, and every truncated call is a question graded as wrong for a reason no prompt can fix |
 *
 * `choices[0].finish_reason` is the provider's own statement about which of the two happened, and it is
 * read at the same hop that already measures delivery -- the adapter's response handler -- because that is
 * the one place holding the whole response.
 *
 * ## Why `'length'` and not "not `'stop'`"
 *
 * Because the field is optional in the wire format and providers differ on what they emit. A response with no
 * `finish_reason` at all is a provider that did not say, which is not the same fact as a provider that said
 * "cut off" -- recording it as truncation would put a guess into a count whose only use is to decide whether a
 * defect exists. `'length'` is a positive statement and is the only value that increments the counter.
 *
 * ## Why the counter lives on `UsageSnapshot` rather than on `LlmUsage`
 *
 * `LlmUsage` is the provider's `usage` block read whole (`parseUsage` owns that decision). `finish_reason` is
 * a different block of the same body, so putting it on `LlmUsage` would make one type describe two blocks and
 * would leave the truncated-without-usage response with nowhere to be recorded -- a call can be cut off *and*
 * unpriced, and both facts have to survive it. The recording therefore takes the truncation as its own
 * argument, next to the usage it is not part of.
 */
import { describe, expect, it } from 'vitest';

import { OpenAICompatibleLLM } from '../llm/openai-compatible.js';
import { createUsageTally, llmUsage, recordUsage, usageDelta } from '../usage.js';

/** A chat body whose single choice carries `content`, a `usage` block, and whatever `finish_reason` is given. */
function responseWith(
  content: string,
  usage: Record<string, number> | undefined,
  finishReason?: string,
): Response {
  const choice: Record<string, unknown> = { message: { role: 'assistant', content } };
  if (finishReason !== undefined) {
    choice['finish_reason'] = finishReason;
  }
  const body: Record<string, unknown> = { choices: [choice] };
  if (usage !== undefined) {
    body['usage'] = usage;
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A client whose every request answers with `response`. */
function clientReturning(response: Response): OpenAICompatibleLLM {
  return new OpenAICompatibleLLM({
    apiKey: 'test-key',
    model: 'test-model',
    baseUrl: 'http://provider.invalid',
    fetchFn: async () => response.clone(),
  });
}

describe('a cut-off generation', () => {
  it('counts a call the provider reported as `length`, and still prices it', async () => {
    const before = llmUsage();
    const client = clientReturning(
      responseWith('Step 1: partial', { prompt_tokens: 900, completion_tokens: 4096 }, 'length'),
    );

    await client.complete('question');

    const delta = usageDelta(before, llmUsage());
    // The counter is the fact this file exists for.
    expect(delta.truncatedCalls).toBe(1);
    // And the bill is not lost to it: a truncated call costs what it generated, which is exactly the
    // reason a truncated run reads as expensive *and* wrong rather than as one or the other.
    expect(delta.completionTokens).toBe(4096);
    expect(delta.calls).toBe(1);
    expect(delta.unpricedCalls).toBe(0);
  });

  it('does not count `stop`, which is a finished generation', async () => {
    const before = llmUsage();
    const client = clientReturning(
      responseWith('answer', { prompt_tokens: 10, completion_tokens: 3 }, 'stop'),
    );

    await client.complete('question');

    expect(usageDelta(before, llmUsage()).truncatedCalls).toBe(0);
  });

  it('does not count a response that named no reason at all', async () => {
    // "The provider did not say" is not "the provider said cut off". A counter that treated the absence as
    // truncation would put a guess into the one number used to decide whether a defect exists.
    const before = llmUsage();
    const client = clientReturning(
      responseWith('answer', { prompt_tokens: 10, completion_tokens: 3 }),
    );

    await client.complete('question');

    expect(usageDelta(before, llmUsage()).truncatedCalls).toBe(0);
  });

  it('counts a cut-off call that carried no usage block, which is both facts at once', async () => {
    // This is why the truncation is a second argument rather than a field on `LlmUsage`: a response can be
    // cut off and unpriced, and a design that could only record the first when the second was present would
    // report the cheapest possible reading of the worst possible response.
    const before = llmUsage();
    const client = clientReturning(responseWith('', undefined, 'length'));

    await client.complete('question');

    const delta = usageDelta(before, llmUsage());
    expect(delta.truncatedCalls).toBe(1);
    expect(delta.unpricedCalls).toBe(1);
    expect(delta.promptTokens).toBe(0);
  });

  it('sums across calls, so a mixed run reports the truncated subset', async () => {
    const before = llmUsage();
    const responses = [
      responseWith('a', { prompt_tokens: 1, completion_tokens: 2 }, 'length'),
      responseWith('b', { prompt_tokens: 1, completion_tokens: 2 }, 'stop'),
      responseWith('c', { prompt_tokens: 1, completion_tokens: 2 }, 'length'),
    ];
    let index = 0;
    const client = new OpenAICompatibleLLM({
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'http://provider.invalid',
      fetchFn: async () => {
        const next = responses[index] ?? responses[responses.length - 1];
        index += 1;
        // `clone()` per call: a `Response` body can only be read once, and the second call would otherwise
        // read an already-disturbed stream and report a transport failure instead of a truncation.
        return next!.clone();
      },
    });

    await client.complete('one');
    await client.complete('two');
    await client.complete('three');

    const delta = usageDelta(before, llmUsage());
    expect(delta.calls).toBe(3);
    expect(delta.truncatedCalls).toBe(2);
  });

  it('starts at zero on a ledger nothing wrote to', () => {
    // Unconditional on the snapshot for the reason every other counter here is: a run that never recorded a
    // truncation and a run whose recording was never wired must not read as the same bytes.
    expect(createUsageTally().snapshot().truncatedCalls).toBe(0);
  });

  it('is subtracted like every other counter, so a side owns only its own truncations', () => {
    // `llmUsage()` and not a fresh tally: the process ledger is what `usageDelta` is defined over, and a
    // zero-valued snapshot here would be a different ledger the subtraction never happens against.
    const before = llmUsage();
    recordUsage({ promptTokens: 1, completionTokens: 2, cacheHitPromptTokens: 0 }, true);
    const delta = usageDelta(before, llmUsage());
    expect(delta.truncatedCalls).toBe(1);
    // The two halves close the same way `answerChars` does: nothing is recorded outside a delta.
    expect(delta.calls).toBe(1);
  });
});
