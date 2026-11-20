/**
 * The half of a call's spend that no provider reports.
 *
 * ## The reading that motivated this file
 *
 * `S17`'s feature arm billed **2,938 completion tokens per call** and delivered **513 characters per answer**.
 * The baseline arm -- same client, same provider, same `thinking: {type: 'disabled'}`, same harness -- billed
 * **82**. A thirty-six-fold gap between two sides of one experiment is either a prompt contract that makes the
 * model produce a work product nobody reads, or a provider charging for generation the caller never receives,
 * and the artifact as it stood could not say which: it recorded what was charged and had no field for what
 * arrived.
 *
 * The `usage` block is the provider's own account, and every field in it describes what was **billed**. None
 * of them describes what was **delivered**, so no amount of reading that block can close the gap. The content
 * string the caller receives is the only witness, and it lives at exactly one place -- the adapter's response
 * handler -- where the billed count is also in hand.
 *
 * ## Why it rides on the usage record instead of a counter of its own
 *
 * A second counter would be a second place for "what arrived" to be defined, and the two would agree until
 * one of them was edited. `parseUsage` cannot fill this in -- no provider puts it in the response body -- so
 * the adapter adds it after parsing and before recording, which is one hop and therefore one definition.
 *
 * ## Why `answerChars` is optional on `LlmUsage` and unconditional on `UsageSnapshot`
 *
 * Optional on the per-call type because `parseUsage` genuinely cannot produce it: a caller that constructs a
 * `LlmUsage` by hand (every test in `usage.test.ts` did, before this file) must not be forced to invent a
 * number it does not have. Unconditional on the accumulated type because an accumulation that omitted it
 * would make "no call delivered anything" and "nobody recorded delivery" the same bytes -- the ambiguity this
 * project has removed from four other fields.
 */
import { describe, expect, it } from 'vitest';

import { OpenAICompatibleLLM } from '../llm/openai-compatible.js';
import { createUsageTally, llmUsage, usageDelta } from '../usage.js';

/** A response carrying `content` and a usage block that names a completion count far above it. */
function responseWith(content: string, completionTokens: number): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: {
        prompt_tokens: 1_000,
        completion_tokens: completionTokens,
        prompt_cache_hit_tokens: 800,
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('a call records what it delivered, not only what it billed', () => {
  it('measures the content the caller receives, on the same record as the billed count', async () => {
    // The reading this field exists for, stated as a test: twelve characters out of a thousand billed tokens.
    // The ratio is the whole point -- either half alone is a number a reader would believe.
    const before = llmUsage();
    const llm = new OpenAICompatibleLLM({
      baseUrl: 'https://example.invalid',
      apiKey: 'test',
      model: 'm',
      fetchFn: (async () => responseWith('Step 1: three', 1_000)) as unknown as typeof fetch,
    });

    await llm.complete('q');

    const delta = usageDelta(before, llmUsage());
    expect(delta.answerChars).toBe('Step 1: three'.length);
    expect(delta.completionTokens).toBe(1_000);
    // The gap is then sayable as arithmetic rather than as a suspicion.
    expect(delta.completionTokens / delta.answerChars).toBeGreaterThan(70);
  });

  it('counts an empty answer as zero delivered rather than as no measurement', async () => {
    // A refusal, a truncation at `max_tokens: 1`, a proxy returning `{"choices": []}` -- all arrive as an
    // empty string, and all are facts about the run. Skipping the record would leave the ratio dividing by
    // a number that existed; recording `0` makes the ratio infinite and therefore visibly wrong, which is
    // the correct reading of a run that paid for answers and shipped none.
    const before = llmUsage();
    const llm = new OpenAICompatibleLLM({
      baseUrl: 'https://example.invalid',
      apiKey: 'test',
      model: 'm',
      fetchFn: (async () => responseWith('', 40)) as unknown as typeof fetch,
    });

    await llm.complete('q');

    const delta = usageDelta(before, llmUsage());
    expect(delta.answerChars).toBe(0);
    expect(delta.completionTokens).toBe(40);
    expect(delta.calls).toBe(1);
  });

  it('contributes nothing for a content field that is not a string', async () => {
    // `typeof` rather than `??`: a body whose `content` is a number is a proxy rewriting the response, and
    // measuring `String(content).length` would report a delivery that never happened. The same guard decides
    // what the caller receives, so the two cannot disagree.
    const before = llmUsage();
    const llm = new OpenAICompatibleLLM({
      baseUrl: 'https://example.invalid',
      apiKey: 'test',
      model: 'm',
      fetchFn: (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 42 } }],
            usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )) as unknown as typeof fetch,
    });

    const answer = await llm.complete('q');

    expect(answer).toBe('');
    expect(usageDelta(before, llmUsage()).answerChars).toBe(0);
  });

  it('leaves the field absent for an unpriced call, so a stripped block is not a zero delivery', async () => {
    // A response with no `usage` block is a call whose cost is UNKNOWN. Recording `answerChars: 0` for it
    // would be a measurement of a response nobody priced -- the same defect `unpricedCalls` exists to
    // prevent, moved one field over.
    const before = llmUsage();
    const llm = new OpenAICompatibleLLM({
      baseUrl: 'https://example.invalid',
      apiKey: 'test',
      model: 'm',
      fetchFn: (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'an answer' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch,
    });

    await llm.complete('q');

    const delta = usageDelta(before, llmUsage());
    expect(delta.unpricedCalls).toBe(1);
    expect(delta.answerChars).toBe(0);
    expect(delta.completionTokens).toBe(0);
  });
});

describe('the accumulation sums delivery the way it sums spend', () => {
  it('adds a hand-built record with no `answerChars` as zero rather than as a gap', async () => {
    // `parseUsage`'s own output has no `answerChars`, so this is the shape a caller who only read a response
    // body produces. `?? 0` rather than a guard, because there is no state in which the absence is a reading:
    // an unpriced call returns early above, so anything reaching the sum is a call that was billed.
    const tally = createUsageTally();
    tally.record({ promptTokens: 10, completionTokens: 2, cacheHitPromptTokens: 0 });
    tally.record({
      promptTokens: 10,
      completionTokens: 2,
      cacheHitPromptTokens: 0,
      answerChars: 9,
    });

    expect(tally.snapshot().answerChars).toBe(9);
  });

  it('reports `answerChars: 0` on a ledger nothing wrote to', () => {
    // Unconditional on the snapshot, so a reader never has to ask whether the field exists -- the rule
    // `calls` follows, one field over.
    expect(createUsageTally().snapshot().answerChars).toBe(0);
  });
});
