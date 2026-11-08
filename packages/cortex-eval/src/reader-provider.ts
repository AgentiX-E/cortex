/**
 * Which reader backend a run selected, as a name the artifact can print.
 *
 * ## The defect this file repairs
 *
 * `PREREGISTRATION` §13.110 recorded that two artifacts differing by **7.20 points** carried
 * identical configuration blocks, so the model could only be recovered from a job log that
 * expires. The repair was `resolveReaderIdentity`, and it worked for the model. It did not work
 * for the **backend**, because there was only ever one: the credential was read from
 * `DEEPSEEK_API_KEY` by name, the endpoint from `DEEPSEEK_BASE_URL`, and the artifact's provider
 * field was a *guess* derived from the host -- `'deepseek'` when the host ended in
 * `deepseek.com`, `'openai-compatible'` otherwise.
 *
 * That guess conflates two different facts. `'openai-compatible'` is a **protocol family**;
 * `'deepseek'` is a **vendor**. A field that means one for one endpoint and the other for the
 * rest of the world cannot be compared to anything, and it cannot be dispatched: pointing the
 * arm at a second vendor meant substituting a credential into a variable named after the first,
 * which is visible in no artifact.
 *
 * So the vendor becomes a **declaration** and the protocol stops being recorded (every reader
 * this factory builds speaks `openai-compatible`; a constant is not worth a field). The host
 * stays in the rendered line, which is where the reached fact belongs.
 *
 * ## Why the name travels inside `DEEPSEEK_MODEL` rather than as its own input
 *
 * `benchmark-cortex-memory.yml` declares 24 `workflow_dispatch` inputs against GitHub's ceiling
 * of 25 -- the ceiling §13.17 and §13.197.4 both ran into. A 25th input would fit and would leave
 * the arm with nowhere to put the axis after it, so the provider rides the value that already
 * exists, exactly as the turn-cap width (§13.188) and the thinking reach (§13.197.4) do:
 *
 * | `model` value | provider | model |
 * |---|---|---|
 * | `deepseek-chat` | `deepseek` (the default) | `deepseek-chat` |
 * | `deepseek:deepseek-v4-pro` | `deepseek` | `deepseek-v4-pro` |
 * | `zhipu:glm-4.6` | `zhipu` | `glm-4.6` |
 * | `zhipu:` | `zhipu` | the provider's default model |
 * | `custom:qwen2.5:7b` | `custom` | `qwen2.5:7b` |
 *
 * The split is on the **first** colon, which is what makes the last row work: a model id that
 * itself contains a colon is unambiguous once the provider is named. An unprefixed id keeps
 * meaning the default provider, so every archived dispatch (`deepseek-chat`) resolves exactly as
 * it always did and no artifact's rendering moves.
 *
 * ## Why an unrecognised prefix throws instead of falling through
 *
 * Same reason `rerank-factory.resolveProvider` throws: the run is not repeatable for free, and a
 * typo that silently became a different backend would produce numbers the artifact attributes to
 * the provider the operator meant. `qwen2.5:7b` is the case that makes the message worth writing:
 * it looks like a provider prefix, it is really a tag separator, and the fix is `custom:` in
 * front of it -- so the error says that.
 *
 * ## Why `custom` has no defaults
 *
 * `EmbeddingProvenance` records the same rule for the hash fallback: naming a provider the
 * process never contacted is worse than naming none. A `custom` declaration with no endpoint and
 * no model cannot describe a run, so it refuses rather than borrowing DeepSeek's defaults -- and
 * a borrowed default would also make an unconfigured dispatch look like a working one.
 */
/**
 * The environment a reader is resolved from.
 *
 * Here rather than in `llm-factory` because this module is the one that resolves it: seven of these
 * variables belong to the provider declaration and one to the thinking reach. The type used to live
 * in `llm-factory`, which would have made the source graph a cycle -- this module is a runtime
 * dependency of that one, so it cannot be its type dependency too.
 */
export type LlmEnv = Record<string, string | undefined>;

/**
 * The providers this factory can build a reader for.
 *
 * Module-private: the only callers are the grammar check and its error message, both in this file.
 * A test iterating the set declares its own exhaustive `Record<ReaderProviderId, true>` instead,
 * which is the stronger guard -- a provider added to the union breaks that record at compile time,
 * whereas a loop over an exported array would silently keep covering the providers it already knew.
 */
const READER_PROVIDERS = ['deepseek', 'zhipu', 'custom'] as const;

/**
 * The shipped endpoint and model, kept as named exports because two other modules and the
 * artifact's documentation quote them. They live here rather than in `llm-factory` because the
 * declaration table is what reads them, and a second home is how two defaults start to differ.
 */
export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';

export type ReaderProviderId = (typeof READER_PROVIDERS)[number];

/**
 * What the endpoint check found.
 *
 * Three states, and the third is the one that stops the field from lying:
 *
 * - `matches` -- the resolved host is one this provider name implies;
 * - `overridden` -- the provider was declared and the endpoint is somewhere else, which is what
 *   a proxy is, and what an undeclared `DEEPSEEK_BASE_URL` produces;
 * - `none` -- the provider makes no claim about its endpoint (`custom`), so there is nothing to
 *   check and nothing to report. Rendering this as `overridden` would put a warning on every
 *   correctly configured custom run.
 */
export type EndpointCheck = 'matches' | 'overridden' | 'none';

/**
 * The resolved backend: a declared name, the endpoint it reaches, and the credential's home.
 *
 * **Not exported.** No file outside this one names the type: `resolveReaderProvider`'s signature
 * is reached through `ReturnType<...>` at both of its call sites, so an `export` would advertise a
 * consumer that does not exist -- the rule this package's export census enforces and the one
 * `llm-factory`'s module docblock states for the same reason. It stays a named interface rather
 * than an inline return type because four call sites read fields off it and the name is what the
 * docblocks refer to.
 */
interface ReaderProvider {
  readonly id: ReaderProviderId;
  readonly model: string;
  readonly baseUrl: string;
  /**
   * Where the credential would be read from. **Named even when the variable is absent**, so the
   * caller's refusal can say which variable to set instead of describing the absence.
   */
  readonly credentialVariable: string;
  readonly endpoint: EndpointCheck;
}

/**
 * A variable list that is guaranteed to name at least one variable.
 *
 * The tuple type is load-bearing rather than decorative: `firstNonEmptyName` falls back to the
 * first element when none is set (so the refusal can name a variable to set), and with a plain
 * array that fallback would need `?? '<literal>'` -- a branch no test can reach and every coverage
 * report would then have to explain. Stating the invariant in the type removes the dead arm.
 */
type NonEmptyNames = readonly [string, ...string[]];

/**
 * One provider's declarations, in precedence order.
 *
 * Arrays rather than single names because every provider has two: the generic override
 * (`CORTEX_READER_*`, which is how a user extends the factory without a code change) and the
 * provider's own. Precedence is first-present-wins, and the *first* name is also what an error
 * message reports when none is present -- the most specific one to reach for.
 *
 * `credentialVariables` for `zhipu` carries both `ZHIPU_LLM_API_KEY` and `ZHIPU_API_KEY` because
 * the org secret is named the second way and the embedding factory already reads it. A separate
 * name for the chat credential exists so that pointing a *reader* at a different Zhipu key does
 * not silently re-point the **embeddings**, which is the collision `ZHIPU_BASE_URL` would have
 * caused had the reader reused it.
 */
interface ProviderDeclaration {
  readonly defaultBaseUrl: string | undefined;
  readonly defaultModel: string | undefined;
  readonly baseUrlVariables: NonEmptyNames;
  readonly modelVariables: NonEmptyNames;
  readonly credentialVariables: NonEmptyNames;
  /** Domains this provider name implies. Empty means "makes no claim". */
  readonly impliedDomains: readonly string[];
}

const DECLARATIONS: Readonly<Record<ReaderProviderId, ProviderDeclaration>> = {
  deepseek: {
    defaultBaseUrl: DEFAULT_DEEPSEEK_BASE_URL,
    defaultModel: DEFAULT_DEEPSEEK_MODEL,
    baseUrlVariables: ['CORTEX_READER_BASE_URL', 'DEEPSEEK_BASE_URL'],
    // `DEEPSEEK_MODEL` is deliberately absent: its value is consumed by `readModelSelection`,
    // which strips the provider prefix. Listing it again would re-read the unstripped string and
    // send `zhipu:glm-4.6` as a model id.
    modelVariables: ['CORTEX_READER_MODEL'],
    // No generic `CORTEX_READER_API_KEY` here on purpose: this provider's own variable is the
    // one the error message has to name, and a generic name *first* would be the one it named
    // when neither was set -- sending an operator to look for a variable that appears in no
    // workflow. The generic override exists for the provider that has no name of its own.
    credentialVariables: ['DEEPSEEK_API_KEY'],
    impliedDomains: ['deepseek.com'],
  },
  zhipu: {
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.6',
    baseUrlVariables: ['CORTEX_READER_BASE_URL', 'ZHIPU_LLM_BASE_URL'],
    modelVariables: ['CORTEX_READER_MODEL', 'ZHIPU_LLM_MODEL'],
    credentialVariables: ['ZHIPU_LLM_API_KEY', 'ZHIPU_API_KEY'],
    // Both hosts Zhipu serves: the mainland platform and the international one. Either is this
    // provider's own endpoint, so neither is an override.
    impliedDomains: ['bigmodel.cn', 'z.ai'],
  },
  custom: {
    defaultBaseUrl: undefined,
    defaultModel: undefined,
    baseUrlVariables: ['CORTEX_READER_BASE_URL'],
    modelVariables: ['CORTEX_READER_MODEL'],
    credentialVariables: ['CORTEX_READER_API_KEY'],
    impliedDomains: [],
  },
};

/** The variable the model selection is read from. Named because three messages state it. */
const MODEL_SELECTION_VARIABLE = 'DEEPSEEK_MODEL';

/** A value that is present and not blank, mirroring `embedding-factory`'s rule for unset secrets. */
function firstNonEmpty(env: LlmEnv, names: readonly string[]): string | undefined {
  for (const name of names) {
    const raw = env[name];
    if (raw !== undefined && raw.trim() !== '') return raw.trim();
  }
  return undefined;
}

/**
 * Which of `names` holds the credential: the first that does, or the first when none does.
 *
 * Falling back to `names[0]` rather than returning `undefined` is the whole point -- the caller
 * refuses on a missing credential, and the refusal has to name the variable to set. "No credential
 * was found" sends an operator looking through the whole environment; `ZHIPU_API_KEY is required`
 * does not.
 */
function firstNonEmptyName(env: LlmEnv, names: NonEmptyNames): string {
  for (const name of names) {
    if (firstNonEmpty(env, [name]) !== undefined) return name;
  }
  // Every declaration lists at least one variable, and the tuple type below is what makes that a
  // fact rather than a hope: the first element cannot be absent, so this branch needs no fallback
  // literal and the function has no unreachable arm for a coverage report to explain away.
  return names[0];
}

/**
 * The provider a `model` value names, before any endpoint is known.
 *
 * Exported because the *selection* and the *resolution* fail differently: a caller that only
 * wants to know which provider a dispatch asked for has no reason to require a credential or an
 * endpoint, and `resolveReaderIdentity` needs the selection in order to look the right
 * declaration up.
 */
export function readModelSelection(
  env: LlmEnv,
  /**
   * The variable the selection is read from.
   *
   * A parameter since §13.312 because there are now two selections in one process: the reader's and
   * the judge's, which a dispatch can pin independently of the arm it is measuring. Reading the
   * judge's from a second copy of the grammar would be a second answer to "what is `zhipu:x`", and
   * feeding the pin through `DEEPSEEK_MODEL` would make an invalid pin's error name a variable the
   * operator never set -- which is the class of silent substitution this whole section is about.
   */
  variable: string = MODEL_SELECTION_VARIABLE,
): {
  readonly id: ReaderProviderId;
  readonly model: string | undefined;
} {
  const raw = (env[variable] ?? '').trim();
  if (raw === '') return { id: 'deepseek', model: undefined };
  const colon = raw.indexOf(':');
  // No colon: the id is a model, and the provider is the default. This is the branch every
  // archived dispatch takes, which is what keeps their rendering byte-identical.
  if (colon < 0) return { id: 'deepseek', model: raw };
  const prefix = raw.slice(0, colon).trim().toLowerCase();
  const remainder = raw.slice(colon + 1).trim();
  const known = READER_PROVIDERS.find((candidate) => candidate === prefix);
  if (known === undefined) {
    throw new Error(
      `${variable}=${JSON.stringify(raw)} names ${JSON.stringify(prefix)} before ` +
        `its first colon, which is not a provider. Expected one of ` +
        `${READER_PROVIDERS.map((id) => JSON.stringify(id)).join(', ')}, or a plain model id ` +
        `(${JSON.stringify('deepseek-chat')}). A model id that itself contains a colon -- an ` +
        `Ollama tag such as ${JSON.stringify('qwen2.5:7b')} -- takes a provider in front of it: ` +
        `${JSON.stringify('custom:qwen2.5:7b')}.`,
    );
  }
  // An empty remainder is `zhipu:` -- a complete request for the provider's default model, not
  // a truncation. Returning `undefined` lets the declaration supply it.
  return { id: known, model: remainder === '' ? undefined : remainder };
}

/** The host of a base URL, or the string itself when it does not parse. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * Whether a host is one the provider name implies.
 *
 * Suffix matching on the domain, which is the rule the host-derived provider field used before
 * this file existed: `api.deepseek.com` is a DeepSeek endpoint, and so would be
 * `beta.deepseek.com`. The dot boundary is what keeps `notdeepseek.com` out.
 */
function isImplied(host: string, domains: readonly string[]): boolean {
  const folded = host.toLowerCase();
  return domains.some((domain) => folded === domain || folded.endsWith(`.${domain}`));
}

/**
 * The backend a run will use, resolved from the same environment both the constructor and the
 * artifact recorder read.
 *
 * ## Why it does not require a credential
 *
 * `createLlmFromEnv` refuses a missing key; this function must not, because the artifact's
 * identity is also resolved on paths that are running *because* the credential is wrong --
 * the same argument `resolveEmbeddingProvenance` makes for taking no credential. So the variable
 * is **named** and its value is the caller's to read.
 *
 * ## What it does refuse
 *
 * A `custom` declaration with no endpoint or no model. That is not validating a value the
 * environment supplied; it is refusing to describe a run that cannot start. Every other provider
 * has defaults, so the refusal can only fire on the one provider that has none.
 */
export function resolveReaderProvider(
  env: LlmEnv,
  selectionVariable: string = MODEL_SELECTION_VARIABLE,
): ReaderProvider {
  const selection = readModelSelection(env, selectionVariable);
  const declaration = DECLARATIONS[selection.id];
  const baseUrl = firstNonEmpty(env, declaration.baseUrlVariables) ?? declaration.defaultBaseUrl;
  if (baseUrl === undefined) {
    throw new Error(
      `Reader provider ${JSON.stringify(selection.id)} has no default endpoint: set ` +
        `${declaration.baseUrlVariables[0]} to the /chat/completions base of the service you ` +
        'mean. A custom provider borrows no default on purpose -- an endpoint nobody configured ' +
        'would put a run against a service the artifact could not name.',
    );
  }
  const model =
    selection.model ?? firstNonEmpty(env, declaration.modelVariables) ?? declaration.defaultModel;
  if (model === undefined) {
    throw new Error(
      `Reader provider ${JSON.stringify(selection.id)} has no default model: set ` +
        `${declaration.modelVariables[0]}, or name it in the selection ` +
        `(${JSON.stringify(`${selection.id}:<model>`)}) so the artifact records it with the ` +
        'provider it belongs to.',
    );
  }
  const host = hostOf(baseUrl);
  return {
    id: selection.id,
    model,
    baseUrl,
    credentialVariable: firstNonEmptyName(env, declaration.credentialVariables),
    endpoint:
      declaration.impliedDomains.length === 0
        ? 'none'
        : isImplied(host, declaration.impliedDomains)
          ? 'matches'
          : 'overridden',
  };
}
