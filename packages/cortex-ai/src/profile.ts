/**
 * Which model answers, expressed as a value instead of a branch.
 *
 * ## Why this is a module and not four lines in a script
 *
 * Two readings in this repository are already attributed to a checkpoint in prose, and one of them
 * was wrong for a whole round: docs/04 section 9.14 records a cost table that could not be
 * reproduced because the script and its corpus were never delivered. A model is the same kind of
 * input to a reading as a corpus is. If "which checkpoint, which dtype, could it reach the network"
 * lives in a `if (flag === 'local')` inside a demo, then a transcript cannot be audited and two
 * numbers produced by different configurations cannot be told apart afterwards.
 *
 * So the choice is resolved once, by a pure function, into a **record that can be printed, stored
 * next to a reading, and committed** -- and it contains no secret by construction, because the key is
 * validated here and never returned.
 *
 * ## The one rule that matters: no fallback
 *
 * Asking for `remote` without a key is an **error**, not a downgrade to `local`. A silent downgrade
 * is the worst possible behaviour for this product specifically: the reading would say "measured with
 * deepseek-chat" while a 0.5B checkpoint on the same machine produced it, and nothing in the data
 * would show the substitution. The same reasoning is why `triage-proposer` returns a failure instead
 * of an empty proposal (step 9) and why the read side throws `ScopeViolation` instead of filtering
 * (step 10): an error names the problem, a fallback hides it.
 */

/** Environment variables this resolver reads. Spelled once, so an error and a document agree. */
export const PROFILE_ENV = {
  /** `local` or `remote`, for a caller that prefers configuration to a flag. */
  backend: 'CORTEX_LLM_BACKEND',
  /** Remote model id. There is deliberately no default: a vendor name baked in as a default is a
   * lock-in that nobody chose. */
  model: 'CORTEX_LLM_MODEL',
  baseUrl: 'CORTEX_LLM_BASE_URL',
  apiKey: 'CORTEX_LLM_API_KEY',
  /** Local checkpoint id, when the caller does not pass one. */
  localModel: 'CORTEX_LOCAL_MODEL',
  /** Where transformers.js fetches weights on a cold start. Inference never uses it. */
  weightHost: 'CORTEX_HF_ENDPOINT',
  /** Quantisation of the local weights: `fp32` unless a caller names another. */
  dtype: 'CORTEX_LOCAL_DTYPE',
} as const;

/**
 * The smallest checkpoint that has produced a usable proposal on this repository's corpus.
 *
 * A default, not a recommendation: it is the one that runs on a CPU in a few seconds per card, which
 * is what made the step-9 reading possible at all. It is *not* strong enough to split a sentence
 * reliably, and docs/04 section 9.16 measures exactly that.
 */
export const DEFAULT_LOCAL_MODEL = 'onnx-community/Qwen2.5-0.5B-Instruct';

/** The mirror most of this work was downloaded through; overridden by `CORTEX_HF_ENDPOINT`. */
export const DEFAULT_WEIGHT_HOST = 'https://huggingface.co';

/**
 * Generation on this machine.
 *
 * `inferenceNetwork` is the field the product promise rests on: with the weights already cached, a
 * call to a local profile makes no HTTP request. That is asserted at runtime by
 * `packages/cortex-ai/test/profile/network.mjs`, which spies on `globalThis.fetch` across a real
 * proposal -- a claim in a whitepaper is worth what its check is worth.
 */
export type LocalProfile = {
  readonly backend: 'local';
  readonly model: string;
  /** Pinned, never defaulted downstream: 4.x changed the default from quantised to fp32. */
  readonly dtype: string;
  /** Where a cold start gets weights. Not used for inference. */
  readonly weightHost: string;
  readonly inferenceNetwork: 'none';
};

/** A provider reached over HTTP. */
export type RemoteProfile = {
  readonly backend: 'remote';
  readonly model: string;
  /** Normalised: no trailing slash, so a caller can append `/chat/completions`. */
  readonly baseUrl: string;
  readonly inferenceNetwork: 'required';
};

export type LlmProfile = LocalProfile | RemoteProfile;

/** What a caller asks for. `backend` is a string, not the union: a typo has to fail loudly. */
export type ProfileRequest = {
  readonly backend: string;
  readonly model?: string;
  readonly dtype?: string;
  readonly baseUrl?: string;
};

export type ProfileEnv = Readonly<Record<string, string | undefined>>;

export class ProfileError extends Error {
  /** Variable names that would have made this work, for a caller that wants to print them. */
  readonly missing: readonly string[];

  constructor(message: string, missing: readonly string[] = []) {
    super(message);
    this.name = 'ProfileError';
    this.missing = missing;
  }
}

/** An empty string is a value a shell hands over when a variable is exported and unset. */
function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * A key may travel over TLS, or over loopback to a sidecar. Nowhere else.
 *
 * This is a check rather than a comment because `http://api.deepseek.com` is a plausible typo, and
 * the failure it produces -- a bearer token in plaintext on the wire -- is silent, remote, and
 * permanent. Loopback is exempt because a local proxy is a normal deployment and the traffic does
 * not leave the machine.
 */
function assertUsableBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProfileError(`${PROFILE_ENV.baseUrl} is not a URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol === 'https:') return stripTrailingSlash(raw);
  const loopback = LOOPBACK.has(url.hostname) || url.hostname.endsWith('.localhost');
  if (url.protocol === 'http:' && loopback) return stripTrailingSlash(raw);
  throw new ProfileError(
    `${PROFILE_ENV.baseUrl} must be https (or http on loopback, for a local sidecar): ` +
      `an API key over ${url.protocol}// would be sent in the clear`,
  );
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/**
 * Resolve the configuration into a record, or explain what is missing.
 *
 * Pure: the environment is an argument, so a test drives every branch without touching `process.env`
 * and two calls with the same arguments return the same record.
 *
 * Every missing variable is reported in one message. Reporting them one at a time turns setup into a
 * guessing game -- fix, rerun, discover the next -- and the first version of the demo did exactly
 * that by checking three names in three `if` statements.
 */
export function resolveLlmProfile(request: ProfileRequest, env: ProfileEnv): LlmProfile {
  if (request.backend === 'local') {
    const model = request.model ?? env[PROFILE_ENV.localModel] ?? DEFAULT_LOCAL_MODEL;
    if (model.trim() === '') {
      throw new ProfileError(
        `${PROFILE_ENV.localModel} is set but empty: leave it unset to use ${DEFAULT_LOCAL_MODEL}`,
      );
    }
    const weightHost = env[PROFILE_ENV.weightHost];
    // Bound to a local so the narrowing applies: a type predicate does not narrow an index
    // expression, and `string | undefined` reaching `dtype` is the compile error that teaches it.
    const dtypeFromEnv = env[PROFILE_ENV.dtype];
    return {
      backend: 'local',
      model,
      // Not defaulted to a quantisation: 4.x changed the default from quantised to fp32 and the
      // output is prose, so nothing downstream would notice the substitution. A caller that wants
      // q4 asks for q4, and the profile records it.
      dtype: request.dtype ?? (present(dtypeFromEnv) ? dtypeFromEnv : 'fp32'),
      weightHost: present(weightHost) ? stripTrailingSlash(weightHost) : DEFAULT_WEIGHT_HOST,
      inferenceNetwork: 'none',
    };
  }

  if (request.backend === 'remote') {
    const model = request.model ?? env[PROFILE_ENV.model];
    const baseUrl = request.baseUrl ?? env[PROFILE_ENV.baseUrl];
    const apiKey = env[PROFILE_ENV.apiKey];

    const missing = [
      ...(present(model) ? [] : [PROFILE_ENV.model]),
      ...(present(baseUrl) ? [] : [PROFILE_ENV.baseUrl]),
      ...(present(apiKey) ? [] : [PROFILE_ENV.apiKey]),
    ];
    if (missing.length > 0) {
      throw new ProfileError(
        `the remote backend needs ${missing.join(', ')}: this repository never stores a key, so it ` +
          `can only come from the environment. Use backend "local" for a run that makes no API call.`,
        missing,
      );
    }

    return {
      backend: 'remote',
      model: model as string,
      baseUrl: assertUsableBaseUrl(baseUrl as string),
      inferenceNetwork: 'required',
    };
  }

  throw new ProfileError(
    `unknown backend ${JSON.stringify(request.backend)}: expected "local" (on-device, no API call) ` +
      `or "remote" (an HTTP provider)`,
  );
}

/**
 * One line for a transcript or a reading header.
 *
 * Stable and greppable on purpose: a table of readings is assembled by reading these lines, and a
 * format that drifts makes the table a transcription exercise. It cannot contain a key, because the
 * profile it describes cannot contain one.
 */
export function describeProfile(profile: LlmProfile): string {
  if (profile.backend === 'local') {
    return `local ${profile.model} dtype=${profile.dtype} weights=${profile.weightHost} inference-network=none`;
  }
  return `remote ${profile.model} base=${profile.baseUrl} inference-network=required`;
}

/**
 * The secret, kept out of the profile on purpose, fetched only where a client is built.
 *
 * A function rather than a field so that the only way to obtain the key is to ask for it by name at
 * the one call site that needs it, and so no `JSON.stringify(profile)` can ever carry it.
 */
export function readApiKey(env: ProfileEnv): string {
  const key = env[PROFILE_ENV.apiKey];
  if (!present(key)) throw new ProfileError(`${PROFILE_ENV.apiKey} is not set`);
  return key;
}
