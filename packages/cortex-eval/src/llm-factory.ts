/**
 * LLM factory: resolves a DeepSeek LLM from environment variables. DeepSeek is
 * OpenAI-compatible, so the cortex-ai adapter is reused directly.
 

 *
 * ## Module-private exports
 *
 * Some declarations below are deliberately not exported. They are used only inside
 * this file, appear in no package barrel, and are referenced by no test or tool —
 * so `export` would advertise a consumer that does not exist. The `export-census`
 * tool reports them as `referenced-locally`, and
 * `packages/cortex-eval/src/__tests__/export-surface.test.ts` pins the set from both
 * sides. Restoring an `export` is a deliberate act: add it when a real caller
 * appears, not in advance of one.
*/
import type { LLM } from '@agentix-e/cortex-core';
import { OpenAICompatibleLLM, type ThinkingMode } from '@agentix-e/cortex-ai';

import { readTemperature, withTemperature } from './reader-temperature.js';
import { ALL_TURN_CAP_ROUTES, TURN_CAP_ROUTES } from './turn-cap-routes.js';

export type LlmEnv = Record<string, string | undefined>;

export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';
/** Per-attempt deadline for thinking-mode calls; reasoning takes far longer. */
const THINKING_TIMEOUT_MS = 300_000;

/** The variable `thinking` arrives in. Named once, because four messages state it. */
const THINKING_VARIABLE = 'DEEPSEEK_THINKING';

/** The spellings that mean "no thinking anywhere". */
const DISABLED_SPELLINGS: ReadonlySet<string> = new Set(['disabled', 'off', 'false']);
/** The spellings that mean "thinking everywhere". */
const ENABLED_SPELLINGS: ReadonlySet<string> = new Set(['enabled', 'on', 'true']);

/**
 * Which routes a `thinking` value applies to, and under which mode.
 *
 * `routes: undefined` means "every route", which is what the two shipped values and every archived
 * artifact say. A list means **`mode` applies to those routes and the shipped `disabled` applies to
 * the rest** -- so a list can only ever spell `enabled`, and the grammar has no form for "disabled
 * on these, enabled elsewhere". That asymmetry is deliberate: the state was chosen because it is the
 * one §13.197 measured a reason for, and a knob that could be pointed at an unmeasured combination
 * would be a way to dispatch a treatment no registration names.
 */
export interface ThinkingReach {
  readonly mode: 'enabled' | 'disabled';
  readonly routes: readonly string[] | undefined;
}

/**
 * Read `DEEPSEEK_THINKING` as a mode plus an optional reach.
 *
 * ## Why the value, and not a new input
 *
 * `PREREGISTRATION` §13.197.4: the workflow declares 24 dispatch inputs against GitHub's ceiling of
 * 25, so the state has to live inside the value that already exists -- the repair §13.188 applied to
 * the turn-cap width. The grammar is what keeps that from being a free-text field: the words `all`
 * and a comma-separated list are both rejected with messages that name the right spelling, because
 * both are what the **neighbouring** reach inputs accept and an operator will reach for them.
 *
 * ## Why an empty value is `disabled` rather than an error
 *
 * An unfilled `workflow_dispatch` input reaches the process as `''`, not as an absent variable, and
 * `disabled` is the shipped state every archived artifact was produced under. Rejecting `''` would
 * turn "the operator left the input alone" into a failed run.
 *
 * ## Why an unrecognised route throws
 *
 * The same reason `readRouteReach` throws: a value that named five of six routes, with the sixth
 * misspelled, would produce a run whose numbers are consistent with having applied the treatment to
 * all six. A dispatch is not repeatable for free, so the mistake has to be caught before the run.
 */
export function readThinkingReach(raw: string | undefined): ThinkingReach {
  const trimmed = (raw ?? '').trim();
  const folded = trimmed.toLowerCase();
  if (trimmed === '' || DISABLED_SPELLINGS.has(folded)) {
    return { mode: 'disabled', routes: undefined };
  }
  if (ENABLED_SPELLINGS.has(folded)) return { mode: 'enabled', routes: undefined };
  // `all` gets its own message rather than falling through to "unrecognised route": it is the word
  // the two sibling reach inputs use for "every route", so naming the right spelling is the whole
  // repair, and an "unrecognised route \"all\"" message would send the operator looking for a route
  // called `all`.
  if (folded === 'all') {
    throw new Error(
      `${THINKING_VARIABLE} does not accept "all": every route is spelled "enabled". A reach ` +
        `without a mode is ambiguous -- "all" cannot say whether thinking is on or off -- so this ` +
        `value always carries the mode it applies. Got ${JSON.stringify(raw)}.`,
    );
  }
  if (trimmed.includes(',')) {
    throw new Error(
      `${THINKING_VARIABLE} separates routes with "+", not ",": got ${JSON.stringify(raw)}. The ` +
        'sibling reach inputs (`cortex_memory_max_turn_chars_routes`, ' +
        '`cortex_memory_evidence_roles_routes`) are comma-separated, which makes a comma the ' +
        'likeliest transcription -- and a value silently read as one route would run a treatment ' +
        'on a sixth of the questions it was dispatched for.',
    );
  }
  const named = trimmed.split('+').map((part) => part.trim());
  const seen = new Set<string>();
  for (const name of named) {
    if (name === '') {
      throw new Error(
        `${THINKING_VARIABLE} has an empty route in its list: got ${JSON.stringify(raw)}. An ` +
          'empty segment is rejected rather than dropped, because dropping it would run the ' +
          'treatment on fewer routes than the value names and report the value that was typed.',
      );
    }
    if (!(name in TURN_CAP_ROUTES)) {
      throw new Error(
        `${THINKING_VARIABLE} must be "disabled", "enabled", or a "+"-separated list of routes ` +
          `(${ALL_TURN_CAP_ROUTES.map((route) => JSON.stringify(route)).join(', ')}); ` +
          `got ${JSON.stringify(raw)}, which names ${JSON.stringify(name)}. An unrecognised route ` +
          'is rejected rather than ignored: a run that enabled thinking on some of the routes and ' +
          'misspelled another would report every number consistent with having enabled it.',
      );
    }
    if (seen.has(name)) {
      throw new Error(
        `${THINKING_VARIABLE} names ${JSON.stringify(name)} twice: got ${JSON.stringify(raw)}. ` +
          'The artifact prints this reach back as the treatment it administered, so a repeated ' +
          'route would make that line claim a route list the run did not have.',
      );
    }
    seen.add(name);
  }
  return { mode: 'enabled', routes: named };
}

/**
 * Per-attempt request deadline for the given thinking mode. Thinking mode
 * reasons before answering, so a single call over a large retrieved context can
 * take 30-120s and blows past the adapter's 60s non-thinking default; give it a
 * 5-minute deadline instead. Non-thinking keeps the adapter default (undefined).
 */
export function resolveTimeoutMs(thinking: ThinkingMode): number | undefined {
  return thinking.type === 'enabled' ? THINKING_TIMEOUT_MS : undefined;
}

/**
 * Which reader a run will use, resolved from the same environment the constructor reads.
 *
 * ## Why this exists as a separate function rather than as fields on the LLM
 *
 * Because the artifact has to state the identity, and the only way to state it without a
 * second copy of the defaults is for both the constructor and the recorder to call **this**
 * function. `PREREGISTRATION` §13.110 is the run that made the requirement concrete: two
 * artifacts differing by 7.20 points carried identical `memoryArmConfig` blocks, so the
 * model could only be recovered from a line in a job log that expires.
 *
 * ## Why `temperature` is `number | null`
 *
 * Because the two states are different facts and every reading before §13.119 was the second.
 * `null` means the request carried no temperature and the provider's default applied -- which is
 * what every run in this campaign did until the input was finally read, and what `default` still
 * means. A number means the request carried it. The value is parsed by `readTemperature` so this
 * function and the constructor cannot disagree about what the environment asked for, which is the
 * same reason both call this function rather than reading the variables themselves.
 */
export function resolveReaderIdentity(env: LlmEnv): {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly thinking: 'enabled' | 'disabled';
  readonly thinkingRoutes: readonly string[] | undefined;
  readonly temperature: number | null;
} {
  const baseUrl = env['DEEPSEEK_BASE_URL'] ?? DEFAULT_DEEPSEEK_BASE_URL;
  const model = env['DEEPSEEK_MODEL'] ?? DEFAULT_DEEPSEEK_MODEL;
  // DeepSeek V4-Pro enables thinking by default with effort=high, which makes
  // even a one-line QA answer reason for tens of seconds (minutes on a large
  // retrieved context) and blows past the 60s request deadline. This benchmark
  // asks shallow extract/answer questions, so disable thinking by default and
  // let DEEPSEEK_THINKING=enabled opt back in for reasoning-heavy experiments.
  //
  // §13.197.4: the value can also name routes (`multi-session+temporal`), which is the state
  // §13.197 bought with a 220-question pair and could not express as an input. `thinking` states
  // the mode those routes run under and `thinkingRoutes` states which they are; the routes not
  // named keep the shipped `disabled`, which is what the base reader below is built with.
  const reach = readThinkingReach(env[THINKING_VARIABLE]);
  // Named by the service rather than by the vendor that happens to be the default: a run
  // pointed at an OpenAI-compatible proxy is not a DeepSeek run, and an artifact that called
  // it one would attribute its numbers to a provider that never served them.
  const provider = /(^|\.)deepseek\.com$/i.test(hostOf(baseUrl)) ? 'deepseek' : 'openai-compatible';
  return {
    provider,
    model,
    baseUrl,
    thinking: reach.mode,
    thinkingRoutes: reach.routes,
    temperature: readTemperature(env),
  };
}

/** The host of a base URL, or the string itself when it does not parse. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** The credential every reader needs, refused once so both factories state it the same way. */
function requireKey(env: LlmEnv): string {
  const apiKey = env['DEEPSEEK_API_KEY'];
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is required for natural-language benchmark');
  }
  return apiKey;
}

/**
 * One reader at a named thinking mode, wrapped in the temperature the environment asked for.
 *
 * Extracted so the pair and the single reader are built by the same code: a second construction
 * site is where the temperature wrapper would be forgotten on one of two clients, and the two sides
 * of a run would then differ by two request fields instead of the one the registration names.
 */
function buildReader(
  identity: ReturnType<typeof resolveReaderIdentity>,
  apiKey: string,
  mode: 'enabled' | 'disabled',
): LLM {
  const thinking: ThinkingMode = { type: mode };
  const timeoutMs = resolveTimeoutMs(thinking);
  const llm = new OpenAICompatibleLLM({
    baseUrl: identity.baseUrl,
    apiKey,
    model: identity.model,
    thinking,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  // Wrapped only when the environment asks for a temperature. The absent path stays absent on
  // purpose: §13.114 records that every reading before §13.119 was taken with no temperature in
  // the request, and a factory that injected `0` here would retro-fit determinism onto those
  // numbers in the artifact's own description of them.
  return identity.temperature === null ? llm : withTemperature(llm, identity.temperature);
}

export function createLlmFromEnv(env: LlmEnv): LLM {
  const apiKey = requireKey(env);
  // The identity is resolved rather than re-derived, so the model that answers and the model
  // the artifact names cannot be two different expressions of the same environment.
  const identity = resolveReaderIdentity(env);
  // A route list has no meaning here: this function's contract is one reader for every route, and
  // the only way to honour a list would be to pick the mode for the caller. `createReadersFromEnv`
  // is the function that can express it, so a run that needs one is a run that has to name it --
  // and a silent `disabled` here would let the artifact state a treatment this reader never
  // administered, which is the `40698883428` failure on a new axis.
  if (identity.thinkingRoutes !== undefined) {
    throw new Error(
      `${THINKING_VARIABLE}=${JSON.stringify(identity.thinkingRoutes.join('+'))} cannot be ` +
        'administered by a single reader: this factory builds one reader for every route. Use ' +
        '`createReadersFromEnv`, which builds the base reader and maps the named routes to a ' +
        'second one -- the shape `CortexMemoryOptions.readerByRoute` accepts.',
    );
  }
  return buildReader(identity, apiKey, identity.thinking);
}

/**
 * The reader pair a route-scoped `thinking` value asks for: one base reader, plus a map.
 *
 * ## Why the base is `disabled` whenever the value names routes
 *
 * Because the four routes the value does not name are the ones that lost nothing under `enabled`
 * and, in `IE`'s case, lost sixteen questions. Building the base at `enabled` and then mapping two
 * routes to `enabled` would administer the treatment to all six while the artifact reported two,
 * and the run would be the `thinking: enabled` arm again under a new name.
 *
 * ## Why the map is absent rather than empty when no routes are named
 *
 * An empty object and an absent field are different claims: absent means "this run has one reader",
 * which is every archived artifact, and `{}` would say the run scoped something and scoped nothing.
 * `CortexMemory`'s `#readerFor` treats both as one reader, but the artifact does not.
 */
export function createReadersFromEnv(env: LlmEnv): {
  readonly llm: LLM;
  readonly readerByRoute: Readonly<Record<string, LLM>> | undefined;
} {
  const apiKey = requireKey(env);
  const identity = resolveReaderIdentity(env);
  const routes = identity.thinkingRoutes;
  if (routes === undefined) {
    return { llm: buildReader(identity, apiKey, identity.thinking), readerByRoute: undefined };
  }
  // One client for every named route, not one per route: two clients would be two connection pools
  // and two usage counters for one treatment, and the artifact's usage block would be a sum of
  // parts that never existed.
  //
  // `identity.thinking` is the mode the named routes run under -- the parser only ever produces
  // `enabled` alongside a list, because the grammar has no form for the other direction.
  const scoped = buildReader(identity, apiKey, identity.thinking);
  const readerByRoute: Record<string, LLM> = {};
  for (const route of routes) readerByRoute[route] = scoped;
  return { llm: buildReader(identity, apiKey, 'disabled'), readerByRoute };
}
