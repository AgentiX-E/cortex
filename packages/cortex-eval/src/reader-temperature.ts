/**
 * The temperature, at the one boundary every reader call crosses.
 *
 * ## The defect this closes
 *
 * `PREREGISTRATION` §13.114: the workflow declares a `temperature` input defaulting to `'0'`, the
 * dispatch script sends it, the job forwards it into `env`, and **nothing on the arm's path reads
 * it**. `createLlmFromEnv` builds the reader without it, `cortex-memory` calls
 * `complete(prompt)` with no options, and the adapter omits the field — so every reading this
 * campaign has taken was served at the provider's default (`1.0`), while every document said 0.
 * §13.118 then measured what that cost: four repetitions of one configuration, one job, one
 * dataset, spread over **16 questions** on the roster and **7 on MR**, against a registered effect
 * of **3**. A ±3-question prediction is not testable at that dispersion.
 *
 * ## Why a wrapper rather than a parameter
 *
 * The call sites are the problem: `#consult` passes no options, and any future call site would
 * have to remember. A wrapper at the boundary cannot be forgotten, and it makes the property
 * testable in one place ("every call carries the temperature") instead of once per caller.
 *
 * ## Why `null` and not a zero default
 *
 * Because "no temperature was sent" is the honest description of every run before this round, and
 * a factory that injected `0` by default would retro-fit determinism onto a campaign's worth of
 * numbers that never had it. Absence stays absent; the registry spells it `default`, the artifact
 * renders it `temp=default`, and `withTemperature` is only applied to a value that exists.
 */
import type { CompleteOptions, JsonSchema, LLM } from '@agentix-e/cortex-core';

/**
 * The values that mean "send no temperature".
 *
 * `default` is the sentinel for one structural reason: a `workflow_dispatch` input is a string,
 * so "not set" cannot be forwarded as an absent variable — it arrives as `''`, which the workflow
 * expression substitutes, leaving no way to express it. The sentinel is spelled the same way the
 * artifact renders the state, so the dispatch and the report use one word for one fact.
 */
const ABSENT_TEMPERATURES: readonly string[] = ['default'];

/** The provider's accepted range. Outside it the request is refused, not clamped. */
const MIN_TEMPERATURE = 0;
const MAX_TEMPERATURE = 2;

/**
 * The temperature this environment asks for, or `null` when it asks for none.
 *
 * Throws on anything that is neither a sentinel nor a number in range. The alternative — falling
 * back to the provider default — would produce a run whose artifact says `temp=default` about a
 * dispatch that asked for something else, which is the failure mode this whole file is about.
 */
export function readTemperature(env: Record<string, string | undefined>): number | null {
  const raw = env['TEMPERATURE'];
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === '' || ABSENT_TEMPERATURES.includes(trimmed.toLowerCase())) {
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    throw new Error(
      `TEMPERATURE must be a number in [${String(MIN_TEMPERATURE)}, ${String(MAX_TEMPERATURE)}], ` +
        `or the word \`default\` to send no temperature at all; got \`${trimmed}\`. ` +
        'A value that is neither is refused rather than ignored, because a run that asked for ' +
        'one thing and sent another has an artifact that describes the request it did not make.',
    );
  }
  if (value < MIN_TEMPERATURE || value > MAX_TEMPERATURE) {
    throw new Error(
      `TEMPERATURE must be in [${String(MIN_TEMPERATURE)}, ${String(MAX_TEMPERATURE)}], got ` +
        `\`${trimmed}\`. The provider refuses the request outside that range, so accepting it ` +
        'here would only move the failure to the far side of a two-hour run.',
    );
  }
  return value;
}

/**
 * The same reader, with a temperature supplied whenever the call site does not.
 *
 * An explicit call-site value always wins: `llm-reranker.ts` pins `0` for its own prompt, and a
 * default that overrode it would make the reranker's temperature a function of an unrelated
 * environment variable. Both methods are wrapped — a decorator covering one of two would send the
 * temperature on some calls and not others, with nothing in the artifact able to describe that.
 */
export function withTemperature(llm: LLM, temperature: number): LLM {
  const withDefault = (opts: CompleteOptions | undefined): CompleteOptions => ({
    ...(opts ?? {}),
    temperature: opts?.temperature ?? temperature,
  });
  return {
    complete: (prompt: string, opts?: CompleteOptions): Promise<string> =>
      llm.complete(prompt, withDefault(opts)),
    completeStructured: <T>(
      prompt: string,
      schema: JsonSchema,
      opts?: CompleteOptions,
    ): Promise<T> => llm.completeStructured<T>(prompt, schema, withDefault(opts)),
  };
}
