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

import {
  resolveReaderProvider,
  type EndpointCheck,
  type LlmEnv,
  type ReaderProviderId,
} from './reader-provider.js';
import { readTemperature, withTemperature } from './reader-temperature.js';
import {
  readReaderPacing,
  resolveJudgeTransport,
  resolveReaderTransport,
  type ReaderPacing,
} from './reader-transport.js';
import { ALL_TURN_CAP_ROUTES, TURN_CAP_ROUTES } from './turn-cap-routes.js';

/**
 * The environment the reader reads.
 *
 * Declared in `reader-provider.ts` rather than here because that is the module the type is about:
 * seven of these variables are the provider declaration's, one is the thinking reach's. Re-exported
 * so `LlmEnv` keeps its public name -- `index.ts` and both benchmark entry points import it from
 * this module -- while the source graph stays acyclic (`llm-factory` → `reader-provider`).
 */
export type { LlmEnv };

/** The variable `thinking` arrives in. Named once, because four messages state it. */
const THINKING_VARIABLE = 'DEEPSEEK_THINKING';

/**
 * The variable a dispatch pins the **judge** in, independently of the reader.
 *
 * ## Why this variable exists, and why it is not `DEEPSEEK_MODEL`
 *
 * §13.312. The judge took its identity from the reader, defended on the grounds that a judge on a
 * different model would make the campaign's numbers incomparable to its own history. That is right
 * about history and wrong about **arms**: when the treatment being compared *is* the reader, a judge
 * that follows the reader is a judge that moves with the treatment. M1's arms were graded by
 * `deepseek-v4-pro` and `deepseek-flash`, and on the 29 preference questions -- whose golds are
 * criteria, so the verdict is entirely the judge's opinion -- one rejected 10 answers the other
 * accepted. A capability difference of 34.5 points was reported for a round and it was an instrument
 * swap.
 *
 * A separate variable rather than a second meaning for `DEEPSEEK_MODEL`, because that one already
 * names the *reader*, and a dispatch that pinned its judge by pointing `DEEPSEEK_MODEL` at it would
 * silently change the thing under test. Two roles, two variables; the grammar they share lives in
 * `readModelSelection`.
 *
 * Unset means "follow the reader", which is the state every archived artifact was produced in and is
 * recorded as such (`source: 'reader'`), so a later reader can tell a pinned judge from a followed
 * one without knowing when the variable was introduced.
 */
const JUDGE_MODEL_VARIABLE = 'CORTEX_JUDGE_MODEL';

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
    // `Object.hasOwn`, not `in`: the table is an object literal, so `in` also accepts every
    // inherited member, and `DEEPSEEK_THINKING=constructor` would then build a map whose only
    // entry is a route the product can never ask for while the artifact printed it as reach.
    if (!Object.hasOwn(TURN_CAP_ROUTES, name)) {
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
  readonly providerId: ReaderProviderId;
  readonly model: string;
  readonly baseUrl: string;
  readonly endpoint: EndpointCheck;
  readonly thinking: 'enabled' | 'disabled';
  readonly thinkingRoutes: readonly string[] | undefined;
  readonly temperature: number | null;
  /**
   * The per-attempt deadline this run declared, or absent when the thinking mode's own applies.
   *
   * Read here rather than inside `describeReader` so that each entry point still reads the
   * environment once: the constructor needs the transport and the recorder needs the identity, and
   * a shared `describeReader` that read both would make three entry points read the variables
   * twice each. Absent stays absent, so every artifact written before the variable existed renders
   * the bytes it always rendered and the difference is visible as a missing clause rather than as a
   * number that pretends to have been declared.
   */
  readonly deadlineMs: number | undefined;
} {
  return {
    ...describeReader(env, resolveReaderProvider(env)),
    deadlineMs: readReaderPacing(env).timeoutMs,
  };
}

/**
 * The identity, given a provider the caller already resolved.
 *
 * ## Why the provider is a parameter rather than resolved again here
 *
 * `createLlmFromEnv` needs the provider too -- the credential's variable name lives on it -- and
 * a second call would be a second copy of one fact. The same argument the module docblock makes
 * for `resolveReaderIdentity` itself: the reader that answers and the reader the artifact names
 * must not be two expressions of one environment. Here it is one expression, read once.
 *
 * ## What the identity says about the backend
 *
 * The **declared** name (`providerId`) and whether the endpoint it reaches is the one that name
 * implies (`endpoint`). Before §13.212 the field was derived from the host: `'deepseek'` for one
 * domain and `'openai-compatible'` for every other, which is a vendor for one provider and a
 * protocol for the rest -- two kinds of fact in one field, comparable to nothing.
 */
function describeReader(
  env: LlmEnv,
  provider: ReturnType<typeof resolveReaderProvider>,
): {
  readonly providerId: ReaderProviderId;
  readonly model: string;
  readonly baseUrl: string;
  readonly endpoint: EndpointCheck;
  readonly thinking: 'enabled' | 'disabled';
  readonly thinkingRoutes: readonly string[] | undefined;
  readonly temperature: number | null;
} {
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
  return {
    providerId: provider.id,
    model: provider.model,
    baseUrl: provider.baseUrl,
    endpoint: provider.endpoint,
    thinking: reach.mode,
    thinkingRoutes: reach.routes,
    temperature: readTemperature(env),
  };
}

/**
 * The credential the resolved provider needs, refused once so both factories state it the same way.
 *
 * The variable is the **provider's**, not a hardcoded one. That is the repair, not a tidy-up:
 * §13.211.3 records that switching providers before §13.212 meant putting a second vendor's key
 * into a variable named after the first, so the only record of which backend answered was the
 * host string -- and the failure mode of getting it wrong was a 401 that named the wrong variable.
 */
function requireKey(env: LlmEnv, provider: ReturnType<typeof resolveReaderProvider>): string {
  const apiKey = env[provider.credentialVariable];
  if (!apiKey) {
    throw new Error(
      `${provider.credentialVariable} is required for natural-language benchmark ` +
        `(reader provider ${JSON.stringify(provider.id)})`,
    );
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
  // `describeReader`'s identity rather than `resolveReaderIdentity`'s: the latter adds the declared
  // deadline, which is a fact for the artifact, and a constructor that required it would make the
  // three entry points read the transport twice to satisfy a parameter none of them reads.
  identity: ReturnType<typeof describeReader>,
  apiKey: string,
  mode: 'enabled' | 'disabled',
  pacing: ReaderPacing,
): LLM {
  const thinking: ThinkingMode = { type: mode };
  const llm = new OpenAICompatibleLLM({
    baseUrl: identity.baseUrl,
    apiKey,
    model: identity.model,
    thinking,
    // Composed rather than assembled here: the deadline, the budget and the interval have a
    // relationship (`resolveReaderTransport` states and tests it), and three spreads at the call
    // site would put that relationship one refactor away from being nobody's job.
    ...resolveReaderTransport(thinking, pacing),
  });
  // Wrapped only when the environment asks for a temperature. The absent path stays absent on
  // purpose: §13.114 records that every reading before §13.119 was taken with no temperature in
  // the request, and a factory that injected `0` here would retro-fit determinism onto those
  // numbers in the artifact's own description of them.
  return identity.temperature === null ? llm : withTemperature(llm, identity.temperature);
}

export function createLlmFromEnv(env: LlmEnv): LLM {
  // One resolution, used for both the credential and the identity: the variable the key is read
  // from and the backend the artifact names are properties of the same declaration, so reading
  // the environment twice would be two chances to disagree about which provider was selected.
  const provider = resolveReaderProvider(env);
  const apiKey = requireKey(env, provider);
  const identity = describeReader(env, provider);
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
  return buildReader(identity, apiKey, identity.thinking, readReaderPacing(env));
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
  const provider = resolveReaderProvider(env);
  const apiKey = requireKey(env, provider);
  const identity = describeReader(env, provider);
  // Read once: both readers of a scoped pair share one transport, and two reads would be two
  // chances for one of them to be built at a different pace than the other.
  const pacing = readReaderPacing(env);
  const routes = identity.thinkingRoutes;
  if (routes === undefined) {
    return {
      llm: buildReader(identity, apiKey, identity.thinking, pacing),
      readerByRoute: undefined,
    };
  }
  // One client for every named route, not one per route: two clients would be two connection pools
  // and two usage counters for one treatment, and the artifact's usage block would be a sum of
  // parts that never existed.
  //
  // `identity.thinking` is the mode the named routes run under -- the parser only ever produces
  // `enabled` alongside a list, because the grammar has no form for the other direction.
  const scoped = buildReader(identity, apiKey, identity.thinking, pacing);
  const readerByRoute: Record<string, LLM> = {};
  for (const route of routes) readerByRoute[route] = scoped;
  return { llm: buildReader(identity, apiKey, 'disabled', pacing), readerByRoute };
}

/**
 * Which judge a process will use, and whether that was decided or inherited.
 *
 * `source: 'reader'` means no dispatch pinned one, which is the state of every archived artifact;
 * `source: 'pinned'` means `CORTEX_JUDGE_MODEL` named it. The field is not decoration: a comparison
 * across two arms is only a comparison if both say `pinned` with the same value, and a reader of two
 * artifacts can check that without reconstructing either dispatch.
 *
 * The provider travels with the identity because a judge on another vendor needs that vendor's
 * credential and endpoint, and because `providerId` is what the artifact can be held to (§13.212).
 */
export function resolveJudgeIdentity(env: LlmEnv): ReturnType<typeof describeReader> & {
  readonly provider: ReturnType<typeof resolveReaderProvider>;
  readonly source: 'reader' | 'pinned';
} {
  const pinned = (env[JUDGE_MODEL_VARIABLE] ?? '').trim();
  if (pinned === '') {
    const provider = resolveReaderProvider(env);
    return { ...describeReader(env, provider), provider, source: 'reader' };
  }
  // The pin is a selection in the same grammar as `DEEPSEEK_MODEL`, resolved through the same
  // reader so the two selections cannot disagree about what `zhipu:glm-4.6` means.
  const provider = resolveReaderProvider(env, JUDGE_MODEL_VARIABLE);
  return { ...describeReader(env, provider), provider, source: 'pinned' };
}

/**
 * The LLM the scorer's judge uses.
 *
 * ## Why this is a separate reader and not the run's `llm`
 *
 * Two reasons, and only the second one is about failures.
 *
 * The first is workload: a judge prompt is a question, a gold answer and a reply, and the answer
 * is the word `yes` or `no`. It is not a reader's turn -- it needs no thinking mode, no 60 s
 * deadline and no 120 s ceiling -- and giving it the reader's pair is how a nine-rung ladder
 * became two attempts. See `resolveJudgeTransport`.
 *
 * The second is the run that makes it a repair: `41585013786` lost a 500-question pass because
 * one judge call could not finish, and the pass it was scoring had already succeeded. An
 * instrument that can destroy the thing it measures has the wrong transport or the wrong
 * tolerance, and this is the transport half.
 *
 * ## Why the identity is the reader's unless a dispatch pins it (§13.312)
 *
 * Because the verdict is a measurement, and a judge that ran on a different model or a different
 * temperature than the archived readings would make this campaign's numbers incomparable to its
 * own history. Only the pipe changes here -- the same distinction §13.227 drew for the pacer.
 *
 * But that argument is about **one arm over time**, and it fails for **two arms at one time**: when
 * the treatment is the reader, a judge that follows the reader moves with the treatment. So the
 * identity is `resolveJudgeIdentity`'s -- the reader's unless `CORTEX_JUDGE_MODEL` names another --
 * and both the choice and its source are recorded in the artifact.
 */
export function createJudgeFromEnv(env: LlmEnv): LLM {
  const identity = resolveJudgeIdentity(env);
  // The credential follows the **judge's** provider, not the reader's: a run that pinned `zhipu:`
  // and kept reading `DEEPSEEK_API_KEY` would send one vendor's key to another and collect a 401 on
  // every question of a 500-question pass. The original environment is read for it, because a
  // credential does not depend on which model the selection names.
  const apiKey = requireKey(env, identity.provider);
  const llm = new OpenAICompatibleLLM({
    baseUrl: identity.baseUrl,
    apiKey,
    model: identity.model,
    // Never a thinking judge: the verdict is one token, and the ten-fold completion cost
    // `41546569106` measured for thinking on a reader would be paid 342 times a run for a bit.
    thinking: { type: 'disabled' },
    ...resolveJudgeTransport(readReaderPacing(env)),
  });
  return identity.temperature === null ? llm : withTemperature(llm, identity.temperature);
}
