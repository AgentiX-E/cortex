/**
 * OpenAI-compatible LLM adapter. Talks to any OpenAI-compatible /chat/completions
 * endpoint via fetch. Structured output uses JSON mode + schema-guided prompt.
 */
import type { CompleteOptions, JsonSchema, LLM } from '@agentix-e/cortex-core';
import { parseJson } from '../json.js';
import { sharedRequestGate, type RequestPacer } from '../pacing.js';
import { retryableFetchWithStats, withExhaustion, type RetryRefusal } from '../retry.js';
import { parseUsage, recordUsage } from '../usage.js';

/** DeepSeek thinking-mode toggle (also honoured by compatible providers). */
export type ThinkingMode = { type: 'enabled' | 'disabled' };

export type OpenAICompatibleLLMOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Injectable fetch for testability and environments without global fetch. */
  fetchFn?: typeof fetch;
  /** Retries for transient (429/5xx) failures; default `DEFAULT_MAX_RETRIES` (8). */
  maxRetries?: number;
  /** Initial backoff in milliseconds; doubles each retry. */
  retryBaseDelayMs?: number;
  /**
   * Wall-clock allowance for the retry sequence; default `DEFAULT_RETRY_BUDGET_MS` (120 s).
   *
   * Exposed because the budget and `timeoutMs` have to be chosen together: the budget is
   * measured from the first attempt, so a per-attempt deadline **longer than the budget**
   * makes the ladder unreachable. Thinking mode sets a 300 s deadline and therefore passes
   * a budget above it; see `resolveTimeoutMs` in `cortex-eval`'s `llm-factory`.
   */
  retryBudgetMs?: number;
  /** Per-attempt request deadline in milliseconds; default 60000. */
  timeoutMs?: number;
  /**
   * Minimum wall-clock gap between two request starts, in milliseconds.
   *
   * Absent means no pacing, which is what every reading before §13.227 was taken at and is why the
   * default is absent rather than a number. `0` also means off, because that is what an environment
   * variable says when the operator has decided there is no limit to respect; a negative value is
   * refused at construction.
   *
   * Resolved in the constructor rather than at each request so a misconfiguration fails where it
   * was written instead of on the first call of a forty-minute run, and so the gate is looked up
   * exactly once: `sharedRequestGate` is what makes two adapters built by two factories share one
   * schedule, and a per-request lookup would be a per-request chance to build a second one.
   */
  minIntervalMs?: number;
  /**
   * DeepSeek thinking-mode toggle. `deepseek-v4-pro` enables thinking by
   * default with effort=high, which makes even short answers reason for tens of
   * seconds (or minutes on a large retrieved context) and can blow past
   * `timeoutMs`. Omitted means the provider default applies.
   */
  thinking?: ThinkingMode | undefined;
};

export class OpenAICompatibleLLM implements LLM {
  private readonly options: OpenAICompatibleLLMOptions;
  private readonly pacer: RequestPacer | undefined;

  constructor(options: OpenAICompatibleLLMOptions) {
    this.options = options;
    // `sharedRequestGate` and not `new RequestGate`: the process-wide registry is what keeps the
    // baseline arm, the feature arm and every worker on one schedule. See `pacing.ts`.
    this.pacer =
      options.minIntervalMs === undefined ? undefined : sharedRequestGate(options.minIntervalMs);
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    const body = buildChatBody(this.options.model, prompt, opts, this.options.thinking);
    const res = await this.post('/chat/completions', body);
    // A `null` or unparsable body is a legal outcome here, and run `42347151147` is why this
    // signature admits it: the provider answered `200` with the four-character body `null`, so
    // `res.json()` returned `null` and the `json.usage` read below threw a `TypeError` at
    // question 88 of 500, 135 seconds in. One empty answer discarded a whole dispatch.
    //
    // An empty completion is deliberately NOT an exception, and the reason is the accounting
    // rather than the tolerance: `parseUsage(undefined)` returns `undefined`, `recordUsage`
    // counts that as an UNPRICED call, and `report.ts` prints `PARTIAL: N of M calls reported no
    // usage` whenever any call went unpriced. A provider answering with empty bodies is therefore
    // visible in the artifact and cannot be read as a free run, while a single such answer costs
    // one question instead of one dispatch.
    const json = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: string } }[];
      usage?: unknown;
    } | null;
    // Recorded HERE rather than at the call sites, and that placement is the repair
    // rather than a convenience: this is the one hop every provider request in the
    // repository passes through, and the ten call sites above it are ten places a
    // counter could be forgotten. The block is passed on unparsed so `parseUsage`
    // owns every decision about what counts as a usable one -- including the decision
    // that a response without a block is an UNPRICED call rather than a free one.
    recordUsage(parseUsage(json?.usage));
    const content = json?.choices?.[0]?.message?.content;
    // `typeof` rather than `??`: a body whose `content` is a number is a proxy rewriting the
    // response, and returning it would hand `parseAnswer` a value it never expects.
    return typeof content === 'string' ? content : '';
  }

  async completeStructured<T>(
    prompt: string,
    schema: JsonSchema,
    opts: CompleteOptions = {},
  ): Promise<T> {
    const guided = `${prompt}\n\nRespond with JSON matching this schema:\n${JSON.stringify(schema)}`;
    // The schema is forwarded, not only pasted into the prompt. Without this the body never carries
    // `response_format: json_object` -- `buildChatBody` had the branch, and a unit test asserted the
    // branch, but nothing set `opts.schema` on the way in, so the flag was built, tested and never
    // sent. A transport test that reads the request body is what found it.
    const raw = await this.complete(guided, { ...opts, schema });
    return parseJson<T>(raw);
  }

  private async post(path: string, body: unknown): Promise<Response> {
    const fetchFn = this.options.fetchFn ?? fetch;
    const outcome = await retryableFetchWithStats(
      fetchFn,
      `${this.options.baseUrl}${path}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      {
        maxRetries: this.options.maxRetries,
        baseDelayMs: this.options.retryBaseDelayMs,
        timeoutMs: this.options.timeoutMs,
        retryBudgetMs: this.options.retryBudgetMs,
        pacer: this.pacer,
      },
    );
    const res = outcome.response;
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      const detail = bodyText ? ` — ${bodyText.slice(0, 400)}` : '';
      const message = `LLM request failed: ${res.status} ${res.statusText}${detail}${describeRefusal(outcome.refusal)}`;
      if (isContentRefusal(res.status, bodyText)) {
        // Thrown before the generic branch so that the type, and not the wording, is what the
        // caller keys on. See `ProviderContentRefusal` for the pass this cost.
        throw new ProviderContentRefusal(message, res.status, providerErrorCode(bodyText));
      }
      // A call whose retry ladder ran out returns its last response rather than throwing, so the
      // measurements the ladder took -- attempts, attempt durations, the per-attempt deadline --
      // reach here on `outcome.exhausted` and would otherwise be dropped with `outcome`. Attached
      // rather than folded into the message because the benchmark classifies on the object, and a
      // message is not something a caller can key on without matching prose.
      throw outcome.exhausted === undefined
        ? new Error(message)
        : withExhaustion(new Error(message), outcome.exhausted);
    }
    return res;
  }
}

/**
 * Name why the retry ladder did not chase this status, when it did not.
 *
 * ## Why the reason belongs in the message
 *
 * `41393748964` printed `LLM request failed: 429 ` and nothing else -- no reason, no attempt
 * count, no window. Every operator who read it concluded the provider had throttled, and the
 * record supported that conclusion until the counters were read against it: 2,892 calls, zero
 * rate-limited, one call whose only attempt had outlived the budget. The status alone cannot
 * distinguish "the provider is throttling me" from "I am not waiting long enough to find out",
 * and those two call for opposite next steps.
 *
 * Absent when the call was served, so a message for a refused request reads identically to what
 * it read before this function existed.
 */
/**
 * The provider declined the **prompt**, not the request.
 *
 * ## Why this is a named class and not a message a caller greps
 *
 * Run `42368550937` is the reason. A 500-question pass had been running for 1,003 seconds and had
 * answered 83 questions when Zhipu returned
 *
 * ```text
 * 400 Bad Request — {"contentFilter":[{"level":1,"role":"user"}],
 *                   "error":{"code":"1301","message":"... sensitive content ..."}}
 * ```
 *
 * on `gpt4_2f8be40d`. The transport did the right thing -- a 400 is not retryable, so it did not
 * retry -- and then rethrew, `runWorker`'s promise rejected, `Promise.all` rejected, and the pass
 * ended. Two hours of a four-worker pass were discarded, no report was written, and the run
 * reported `failure` with `reached 83`. **One question's prompt contained text the provider
 * refuses to read, and that destroyed 499 other questions' measurements.**
 *
 * The class exists so that the caller can distinguish this from every other `!res.ok` with a type
 * rather than with a substring search over a message that this file is free to reword. The one
 * thing a caller may do with it is *decide the question*, never retry it: the same prompt asks the
 * same question of the same filter and gets the same answer, so an attempt is certain waste.
 *
 * ## Why the detection is narrow
 *
 * A bare `400` is a defect in the request body and must keep crashing the pass -- a malformed body
 * fails on every question and repairing it is not something a per-question catch can do. So the
 * class is thrown only when the body carries a **provider-side moderation marker**: Zhipu's
 * `contentFilter` array or its `1301` code, or the wording the endpoint returns for the same
 * condition in English. Anything else stays an ordinary `Error`.
 */
export class ProviderContentRefusal extends Error {
  /** HTTP status the provider answered with (400 on Zhipu, 422 on some compatible gateways). */
  readonly status: number;
  /** The provider's own code for the refusal, when it published one (`'1301'` on Zhipu). */
  readonly providerCode: string | null;

  constructor(message: string, status: number, providerCode: string | null) {
    super(message);
    this.name = 'ProviderContentRefusal';
    this.status = status;
    this.providerCode = providerCode;
  }
}

/**
 * Markers a provider uses to say "I will not read this prompt".
 *
 * Kept as data rather than as a regular expression so that a reviewer can add a provider by adding
 * a row, and so that the `1301` code is matched as a *quoted* token: `1301` is a plausible number
 * to find in an unrelated error body (a byte offset, an id), and a bare substring test would refuse
 * a genuine transport failure.
 */
const CONTENT_FILTER_MARKERS: readonly string[] = [
  'contentFilter',
  '"code":"1301"',
  '"code": "1301"',
  'sensitive content',
];

/** Extract the provider's own error code, when the body publishes one. */
function providerErrorCode(body: string): string | null {
  const match = /"code"\s*:\s*"?([A-Za-z0-9_.-]+)"?/.exec(body);
  return match === null ? null : (match[1] ?? null);
}

/**
 * True when a refused response is a moderation decision rather than a malformed request.
 *
 * `status` is constrained to the two codes moderation gateways use, because a `429` body that
 * happened to quote a marker would be a throttling event and treating it as a refusal would turn a
 * wait into a lost measurement.
 */
function isContentRefusal(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) {
    return false;
  }
  return CONTENT_FILTER_MARKERS.some((marker) => body.includes(marker));
}

function describeRefusal(refusal: RetryRefusal | undefined): string {
  if (refusal === undefined) {
    return '';
  }
  const window =
    refusal.retryAfterMs === null
      ? ''
      : `; the provider asked for ${Math.round(refusal.retryAfterMs / 1000)} s`;
  const left =
    refusal.remainingMs === null ? '' : ` and ${Math.round(refusal.remainingMs / 1000)} s was left`;
  return ` — not retried (${refusal.reason}) after ${refusal.attempts} attempt(s)${window}${left}`;
}

export function buildChatBody(
  model: string,
  prompt: string,
  opts: CompleteOptions,
  thinking?: ThinkingMode,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: sanitizePrompt(prompt) }],
  };
  if (opts.temperature != null) {
    body['temperature'] = opts.temperature;
  }
  if (opts.maxTokens != null) {
    body['max_tokens'] = opts.maxTokens;
  }
  if (opts.schema != null) {
    body['response_format'] = { type: 'json_object' };
  }
  if (thinking) {
    body['thinking'] = thinking;
  }
  return body;
}

/**
 * Sanitize a prompt before it becomes the user message. A literal backslash can
 * be misread as a hex escape by a lenient provider parser and reject the body as
 * invalid JSON: DeepSeek reports "unexpected end of hex escape" for a `\u`
 * sequence whose following characters are not four hex digits. Replacing every
 * backslash with a forward slash removes that escape character, but JSON
 * serialization can still emit `\u2028`/`\u2029` for line/paragraph separators,
 * which the same lenient parser may also reject. Strip line/paragraph separators
 * and zero-width format characters, and drop raw control characters (other than
 * newline/tab/carriage-return), so the serialized body contains no escape that
 * the provider can misparse.
 */
export function sanitizePrompt(prompt: string): string {
  return prompt
    .replace(/\\/g, '/')
    .replace(/[\u2028\u2029]/g, '')
    .replace(/(?![\n\r\t])[\p{Cc}]/gu, '')
    .replace(/\p{Cf}/gu, '');
}

/**
 * Re-exported, not defined here: the two offline entries need this function and must not import this
 * module (see `src/json.ts`). Keeping the name on this entry's surface means the move is invisible to
 * callers.
 */
export { parseJson } from '../json.js';
