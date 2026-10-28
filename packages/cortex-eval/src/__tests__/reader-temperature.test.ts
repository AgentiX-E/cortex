/**
 * The temperature input: declared, forwarded, and — until this round — never read.
 *
 * ## What the three tests below separate
 *
 * `PREREGISTRATION` §13.114 found that `TEMPERATURE` is declared in the workflow, forwarded into
 * the job's `env`, and read by exactly one runner in the repository (`cortex-eval/bench/run.ts`,
 * the reference pipeline's). The arm never sent it, so every reading in this campaign was served
 * at the provider's default — `1.0` — while every document said 0. §13.118 then measured the cost:
 * four repetitions of one configuration spread over **16 questions** on the roster, against a
 * registered effect of **3**.
 *
 * So this module exists for one purpose: make the value *reach the request*, and make the absence
 * of a value a distinct, nameable state rather than a zero. Three properties are asserted
 * separately because each one is a different way to get it wrong:
 *
 *   1. **Parsing.** `default` (and empty, and absent) mean "send nothing"; anything else must be a
 *      number in [0, 2]. A junk value that quietly became the provider default is the §7.3 side
 *      channel in its fifth form: the artifact would say `temp=default` about a run that was asked
 *      for something else entirely.
 *   2. **Injection.** The wrapper supplies the value when the call site supplies none. The call
 *      sites that matter (`cortex-memory`'s `#consult`) pass no options at all, which is the whole
 *      reason a decorator is the right shape: no future call site can forget.
 *   3. **Precedence.** An explicit temperature at the call site wins. `llm-reranker.ts` already
 *      pins 0 for its own prompt, and a default that overrode it would make the reranker's
 *      temperature a function of an unrelated environment variable.
 *
 * ## Why the wrapper is not applied when the value is absent
 *
 * Because "no temperature was sent" is the state of every run before this round, and a wrapper
 * that injected 0 by default would silently retro-fit determinism onto a campaign's worth of
 * numbers that never had it. The absent path must stay absent, which is why `readTemperature`
 * returns `null` rather than `0` and the factory only wraps on a non-null value.
 */
import { describe, expect, it } from 'vitest';

import type { CompleteOptions, JsonSchema, LLM } from '@agentix-e/cortex-core';

import { readTemperature, withTemperature } from '../reader-temperature.js';

describe('reading the temperature out of the environment', () => {
  it('reports absence as null rather than as zero', () => {
    // The distinction the whole module turns on. `0` means "pin deterministic"; absent means
    // "let the provider choose", and every run before this round was the second.
    expect(readTemperature({})).toBeNull();
    expect(readTemperature({ TEMPERATURE: '' })).toBeNull();
    expect(readTemperature({ TEMPERATURE: '   ' })).toBeNull();
  });

  it('treats the literal `default` as the way to ask for nothing', () => {
    // A workflow input cannot express "not set" -- every forwarded value becomes a string -- so
    // the registry needs a sentinel, and it is spelled the same way the artifact renders the
    // state (`temp=default`). One word, one meaning, in both places.
    expect(readTemperature({ TEMPERATURE: 'default' })).toBeNull();
    expect(readTemperature({ TEMPERATURE: 'DEFAULT' })).toBeNull();
    expect(readTemperature({ TEMPERATURE: ' default ' })).toBeNull();
  });

  it('parses the values a dispatch actually sends', () => {
    expect(readTemperature({ TEMPERATURE: '0' })).toBe(0);
    expect(readTemperature({ TEMPERATURE: '1' })).toBe(1);
    expect(readTemperature({ TEMPERATURE: '1.5' })).toBe(1.5);
    expect(readTemperature({ TEMPERATURE: '2' })).toBe(2);
    // Whitespace survives a YAML form and a copy-paste; it must not turn 0.7 into a NaN.
    expect(readTemperature({ TEMPERATURE: ' 0.7 ' })).toBe(0.7);
  });

  it('refuses a value outside the range the provider accepts', () => {
    // Loudly, and naming the value. A silent clamp would make the artifact's `temp=` line a
    // claim about the request that the request did not carry.
    expect(() => readTemperature({ TEMPERATURE: '-0.1' })).toThrow(/\[0, 2\]/);
    expect(() => readTemperature({ TEMPERATURE: '2.5' })).toThrow(/\[0, 2\]/);
    expect(() => readTemperature({ TEMPERATURE: '3' })).toThrow(/\[0, 2\]/);
  });

  it('refuses a value that is not a number, instead of reading it as absent', () => {
    // `Number('hot')` is NaN and `NaN` in a JSON body serialises as `null`, which the provider
    // would read as "unset" -- a run that believed it had pinned a temperature and had not.
    expect(() => readTemperature({ TEMPERATURE: 'hot' })).toThrow(/hot/);
    expect(() => readTemperature({ TEMPERATURE: 'Infinity' })).toThrow(/Infinity/);
    expect(() => readTemperature({ TEMPERATURE: 'NaN' })).toThrow(/NaN/);
  });

  it('names `default` in the error, because that is what the caller probably meant', () => {
    // The error is read by whoever edits a dispatch, at the moment they are editing it.
    expect(() => readTemperature({ TEMPERATURE: 'warm' })).toThrow(/default/);
  });
});

/** A reader that records what each call carried and returns a fixed reply. */
function recordingLlm(): {
  readonly llm: LLM;
  readonly calls: { readonly prompt: string; readonly opts: CompleteOptions | undefined }[];
  readonly structuredCalls: {
    readonly prompt: string;
    readonly schema: JsonSchema;
    readonly opts: CompleteOptions | undefined;
  }[];
} {
  const calls: { prompt: string; opts: CompleteOptions | undefined }[] = [];
  const structuredCalls: {
    prompt: string;
    schema: JsonSchema;
    opts: CompleteOptions | undefined;
  }[] = [];
  const llm: LLM = {
    complete: (prompt, opts) => {
      calls.push({ prompt, opts });
      return Promise.resolve('Lisbon');
    },
    completeStructured: <T>(prompt: string, schema: JsonSchema, opts?: CompleteOptions) => {
      structuredCalls.push({ prompt, schema, opts });
      return Promise.resolve({} as T);
    },
  };
  return { llm, calls, structuredCalls };
}

describe('injecting the temperature at the reader boundary', () => {
  it('adds the value when the call site passes no options at all', () => {
    // `cortex-memory`'s `#consult` calls `complete(prompt)`. That is the call this exists for.
    const { llm, calls } = recordingLlm();
    const wrapped = withTemperature(llm, 0);

    return wrapped.complete('where did I go?').then(() => {
      expect(calls).toHaveLength(1);
      expect(calls[0]!.opts).toEqual({ temperature: 0 });
    });
  });

  it('adds it when the call site passes options that do not mention temperature', () => {
    const { llm, calls } = recordingLlm();
    const wrapped = withTemperature(llm, 0.3);

    return wrapped.complete('q', { maxTokens: 64 }).then(() => {
      expect(calls[0]!.opts).toEqual({ maxTokens: 64, temperature: 0.3 });
    });
  });

  it('leaves an explicit call-site temperature alone', () => {
    // `llm-reranker.ts` pins 0 for its own prompt. A default that won here would make that
    // pin a function of an environment variable that has nothing to do with the reranker.
    const { llm, calls } = recordingLlm();
    const wrapped = withTemperature(llm, 1.2);

    return wrapped.complete('q', { temperature: 0 }).then(() => {
      expect(calls[0]!.opts).toEqual({ temperature: 0 });
    });
  });

  it('passes the prompt through byte for byte and returns the inner reply', () => {
    // A wrapper that re-encoded the prompt would change the tokens the model sees, which is a
    // different experiment wearing the same name.
    const { llm, calls } = recordingLlm();
    const wrapped = withTemperature(llm, 0);
    const prompt = '  Answer with the Step 2 number alone.\n\n[date] user: I went to Lisbon.  ';

    return wrapped.complete(prompt).then((reply) => {
      expect(reply).toBe('Lisbon');
      expect(calls[0]!.prompt).toBe(prompt);
    });
  });

  it('injects into the structured path too, because a reader has two methods', () => {
    // The arm does not use `completeStructured` today. It is wrapped anyway: a decorator that
    // covered one of two methods would send the temperature on some calls and not others, and
    // the artifact would have no way to describe that.
    const { llm, structuredCalls } = recordingLlm();
    const wrapped = withTemperature(llm, 0.7);
    const schema: JsonSchema = { type: 'object', properties: {}, required: [] };

    return wrapped.completeStructured('q', schema).then(() => {
      expect(structuredCalls[0]!.opts).toEqual({ temperature: 0.7 });
      expect(structuredCalls[0]!.schema).toBe(schema);
    });
  });

  it('keeps an explicit temperature on the structured path as well', () => {
    const { llm, structuredCalls } = recordingLlm();
    const wrapped = withTemperature(llm, 0.7);
    const schema: JsonSchema = { type: 'object', properties: {}, required: [] };

    return wrapped.completeStructured('q', schema, { temperature: 1 }).then(() => {
      expect(structuredCalls[0]!.opts).toEqual({ temperature: 1 });
    });
  });
});
