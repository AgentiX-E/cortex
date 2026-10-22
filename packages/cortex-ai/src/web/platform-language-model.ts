/**
 * The platform's own language model: Chrome's built-in Prompt API (`globalThis.LanguageModel`),
 * and whatever else implements the same shape.
 *
 * ## Why this entry exists at all
 *
 * It is the only way to get generation on a device with **no network, no key and no download of our
 * own**: the model is already in the browser. That is the difference between "Cortex can run
 * offline" and "Cortex can run offline if you ship it 90 MB of weights". The trade is that the model
 * belongs to the browser, so its availability is a property of the user's installation, not of this
 * package -- which is why the probe below is part of the public surface rather than an internal
 * detail.
 *
 * ## Three behaviours worth reading before changing anything
 *
 * 1. **A download is never started implicitly.** `availability()` distinguishes `downloadable` (the
 *    model exists but is not on this device) from `available`. `complete()` refuses in the
 *    downloadable case unless the caller passed `allowDownload`. Starting a multi-gigabyte download
 *    because somebody asked a question is not a decision this layer gets to make on their behalf.
 *
 * 2. **Sessions are reused, and rebuilt when the sampling changes.** The platform fixes
 *    temperature and token limits when a session is created, so a call that asks for different
 *    values gets a new session rather than silently keeping the old ones. The key is the resolved
 *    options, not the call count.
 *
 * 3. **A failed prompt discards the session.** A session that threw may still hold partial state;
 *    the next call gets a fresh one. Reusing it would turn one transient error into every
 *    subsequent call returning the same thing.
 *
 * ## What has not been measured
 *
 * No run of this adapter against a real on-device model exists in this repository: the model needs a
 * multi-gigabyte download and a browser flag, and the host that builds this package has neither.
 * What *is* measured is the refusal path -- `availability()` in an environment without the platform
 * object -- because that is the path a user hits on every browser that does not have one, and a
 * wrong answer there is worse than a feature that is simply absent.
 */
import type { CompleteOptions, JsonSchema, LLM } from '@agentix-e/cortex-core';
import { parseJson } from '../llm/openai-compatible.js';

/** The states Chrome's Prompt API reports. `downloadable` means "not on this device yet". */
export type PlatformStatus = 'available' | 'downloadable' | 'downloading' | 'unavailable';

/** The session object the platform hands back. Only `prompt` is used. */
export type PlatformSession = {
  prompt(text: string): Promise<string>;
  destroy?(): void;
};

/** The platform entry point, structurally. */
export type PlatformLanguageModel = {
  availability?: () => Promise<PlatformStatus>;
  create?: (options?: Record<string, unknown>) => Promise<PlatformSession>;
};

export type AvailabilityReport = {
  available: boolean;
  /** `absent` is not a platform state: it means the API is not present in this environment. */
  status: PlatformStatus | 'absent';
  reason: string;
};

export type PlatformLanguageModelOptions = {
  /** Injected platform object; defaults to `globalThis.LanguageModel`. */
  platform?: PlatformLanguageModel;
  /** System prompt for every session. */
  systemPrompt?: string;
  /** Sampling temperature, fixed per session. */
  temperature?: number;
  /** Top-k sampling, fixed per session. */
  topK?: number;
  /** Output token cap, fixed per session. */
  maxOutputTokens?: number;
  /** Allow `create()` to start a model download. Default false; see the module comment. */
  allowDownload?: boolean;
};

/** Read the platform object without assuming it exists. */
export function readPlatform(explicit?: PlatformLanguageModel): PlatformLanguageModel | undefined {
  if (explicit !== undefined) return explicit;
  return (globalThis as { LanguageModel?: PlatformLanguageModel }).LanguageModel;
}

/**
 * Report what this device can do.
 *
 * A platform object without `availability` is reported as `unavailable` rather than assumed usable:
 * guessing `available` would move the failure to the first prompt, where the error is a generic
 * exception instead of a sentence the product can show.
 */
export async function checkAvailability(
  platform: PlatformLanguageModel | undefined = readPlatform(),
): Promise<AvailabilityReport> {
  if (platform === undefined) {
    return {
      available: false,
      status: 'absent',
      reason:
        'this environment has no built-in language model (globalThis.LanguageModel is undefined)',
    };
  }
  if (typeof platform.availability !== 'function') {
    return {
      available: false,
      status: 'unavailable',
      reason: 'the platform object has no availability() probe, so its state cannot be reported',
    };
  }

  let status: PlatformStatus;
  try {
    status = await platform.availability();
  } catch (error) {
    return {
      available: false,
      status: 'unavailable',
      reason: `availability() failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  switch (status) {
    case 'available':
      return { available: true, status, reason: 'the model is on this device' };
    case 'downloadable':
      return {
        available: false,
        status,
        reason: 'the model is not on this device; create() would start a download',
      };
    case 'downloading':
      return { available: false, status, reason: 'the model is being downloaded' };
    default:
      return { available: false, status: 'unavailable', reason: 'the platform reports no model' };
  }
}

export class PlatformLanguageModelAdapter implements LLM {
  readonly #options: PlatformLanguageModelOptions;
  #session: PlatformSession | null = null;
  #sessionKey = '';

  constructor(options: PlatformLanguageModelOptions = {}) {
    this.#options = options;
  }

  /** What this device can do, before any prompt is attempted. */
  async availability(): Promise<AvailabilityReport> {
    return checkAvailability(readPlatform(this.#options.platform));
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    const session = await this.#acquire(opts);
    try {
      return await session.prompt(prompt);
    } catch (error) {
      // A session that threw may hold partial state; the next call starts clean rather than
      // inheriting whatever it was left in.
      this.#discard();
      throw error;
    }
  }

  async completeStructured<T>(
    prompt: string,
    schema: JsonSchema,
    opts: CompleteOptions = {},
  ): Promise<T> {
    // There is no JSON mode on the platform API, so the schema goes into the prompt and the parse
    // is the check. Stating that plainly matters: a caller who assumes a grammar constraint would
    // believe the output is valid JSON because it was asked to be.
    const guided = `${prompt}\n\nRespond with JSON matching this schema:\n${JSON.stringify(schema)}`;
    return parseJson<T>(await this.complete(guided, opts));
  }

  /** Release the platform session. Safe to call twice. */
  destroy(): void {
    this.#discard();
  }

  #discard(): void {
    this.#session?.destroy?.();
    this.#session = null;
    this.#sessionKey = '';
  }

  async #acquire(opts: CompleteOptions): Promise<PlatformSession> {
    const report = await this.availability();
    const status = report.status;
    const mayDownload = this.#options.allowDownload === true;

    if (status === 'downloadable' && !mayDownload) {
      throw new Error(
        `the built-in model is not on this device: ${report.reason}. Pass allowDownload: true to ` +
          `start the download, or use a different provider.`,
      );
    }
    if (status !== 'available' && !(status === 'downloadable' && mayDownload)) {
      throw new Error(`the built-in model is not usable here: ${report.reason}`);
    }

    const platform = readPlatform(this.#options.platform);
    if (platform === undefined || typeof platform.create !== 'function') {
      throw new Error('the platform object has no create(), so no session can be started');
    }

    const temperature = opts.temperature ?? this.#options.temperature;
    const maxOutputTokens = this.#options.maxOutputTokens;
    const key = JSON.stringify([
      temperature,
      this.#options.topK,
      maxOutputTokens,
      this.#options.systemPrompt,
    ]);

    if (this.#session !== null && key === this.#sessionKey) return this.#session;

    this.#discard();
    const initialPrompts =
      this.#options.systemPrompt === undefined
        ? undefined
        : [{ role: 'system', content: this.#options.systemPrompt }];
    this.#session = await platform.create({
      ...(initialPrompts === undefined ? {} : { initialPrompts }),
      ...(temperature === undefined ? {} : { temperature }),
      ...(this.#options.topK === undefined ? {} : { topK: this.#options.topK }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    });
    this.#sessionKey = key;
    return this.#session;
  }
}
