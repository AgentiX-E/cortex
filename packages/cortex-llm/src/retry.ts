/**
 * Retry/backoff helpers shared by the LLM and embedding adapters. Remote
 * providers rate-limit (429) and occasionally fail transiently (5xx), so a
 * large benchmark can exhaust a per-minute quota unless requests are retried
 * with exponential backoff.
 */

/** Whether an HTTP status should be retried (rate limit or transient server error). */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Resolve after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default number of attempts (1 initial + `maxRetries` retries). */
export const DEFAULT_MAX_RETRIES = 5;
/** Initial backoff delay in milliseconds; doubles on each retry. */
export const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
/**
 * Default per-attempt deadline in milliseconds.
 *
 * Retrying only helps when an attempt actually SETTLES. A request that is
 * accepted and then stalls — a reset or half-open connection — leaves the loop
 * awaiting a promise that never settles, so `maxRetries` never gets to run and
 * the caller hangs forever. A full benchmark run was lost that way to
 * `TypeError: terminated`.
 */
export const DEFAULT_RETRY_TIMEOUT_MS = 60_000;

/**
 * Retry tuning. Grouped in one object because these are three same-typed knobs:
 * passing them positionally produced call sites that read
 * `retryableFetch(fn, url, init, 5, 1000, 60000)`.
 */
export type RetryOptions = {
  // `| undefined` is required by `exactOptionalPropertyTypes`: the adapters
  // forward their own optional options straight through, and without it an
  // explicitly-undefined `maxRetries` is not assignable.
  /** Retries on top of the first attempt; default `DEFAULT_MAX_RETRIES`. */
  maxRetries?: number | undefined;
  /** Initial backoff delay in milliseconds; doubles on each retry. */
  baseDelayMs?: number | undefined;
  /** Per-attempt deadline in milliseconds. `0` installs no deadline. */
  timeoutMs?: number | undefined;
};

/**
 * Build the abort signal for ONE attempt.
 *
 * The deadline has to be created per attempt rather than once before the loop.
 * An `AbortSignal` is single-use: one shared instance would already be aborted
 * by the time a retry ran, so every retry would fail instantly and the retry
 * budget would be spent without a single request reaching the server.
 *
 * A caller-supplied signal is preserved and combined with the deadline, so an
 * outer cancellation still wins and the shorter of the two applies.
 */
function attemptSignal(
  callerSignal: AbortSignal | null | undefined,
  timeoutMs: number,
): AbortSignal | undefined {
  if (timeoutMs <= 0) {
    return callerSignal ?? undefined;
  }
  const deadline = AbortSignal.timeout(timeoutMs);
  if (!callerSignal) {
    return deadline;
  }
  return AbortSignal.any([callerSignal, deadline]);
}

/**
 * Fetch with retry/backoff for transient failures. Returns the response as-is
 * once it is successful or non-retryable, or after the final attempt still
 * returns a retryable status (the caller inspects `res.ok` and throws a
 * descriptive error). Network errors and per-attempt timeouts are retried and
 * re-thrown if they persist.
 */
export async function retryableFetch(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  options: RetryOptions = {},
): Promise<Response> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RETRY_TIMEOUT_MS;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
    const signal = attemptSignal(init.signal, timeoutMs);
    let res: Response;
    try {
      res = await fetchFn(url, signal ? { ...init, signal } : init);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      continue;
    }
    if (res.ok || !isRetryableStatus(res.status) || attempt === maxRetries) {
      return res;
    }
  }
  throw lastError ?? new Error(`fetch failed after ${maxRetries + 1} attempts`);
}
