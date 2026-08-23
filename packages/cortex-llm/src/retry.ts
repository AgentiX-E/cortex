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
 * Fetch with retry/backoff for transient failures. Returns the response as-is
 * once it is successful or non-retryable, or after the final attempt still
 * returns a retryable status (the caller inspects `res.ok` and throws a
 * descriptive error). Network errors are retried and re-thrown if they persist.
 */
export async function retryableFetch(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  maxRetries: number = DEFAULT_MAX_RETRIES,
  baseDelayMs: number = DEFAULT_RETRY_BASE_DELAY_MS,
): Promise<Response> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
    let res: Response;
    try {
      res = await fetchFn(url, init);
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
