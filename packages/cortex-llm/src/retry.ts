/**
 * Retry/backoff helpers shared by the LLM and embedding adapters. Remote
 * providers rate-limit (429) and occasionally fail transiently (5xx), so a
 * large benchmark can exhaust a per-minute quota unless requests are retried
 * with exponential backoff.
 *
 * ## Why the retry budget is a duration, not an attempt count
 *
 * The budget used to be `maxRetries`, and the total sleep it implied was
 * `base * (2 ** retries - 1) = 31 s` at the defaults. That is shorter than a
 * minute-scale throttle window, so every retry landed inside the window that had
 * just rejected the request and the run exhausted its budget without the
 * provider ever being given a chance to recover. Raising the count would have
 * appeared to fix it, but only by accident: what has to be exceeded is a
 * duration, and an attempt count implies a different duration for every
 * `baseDelayMs`. `retryBudgetMs` states the requirement directly.
 *
 * ## Why `Retry-After` is read
 *
 * The header is the provider naming its own window. Discarding it and sleeping a
 * computed backoff is the client guessing at a quantity the server already
 * published, and it guesses wrong in both directions: too short and the retry is
 * rejected again, too long and a recoverable run wastes wall-clock time. It is
 * read for every retryable status, not only 429, because 503 carries it too.
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
 * Default wall-clock ceiling on retries, in milliseconds.
 *
 * Larger than 60 s on purpose: a throttle window measured in minutes has to be
 * reachable, and a budget at or below one minute would reproduce the original
 * defect with the code nominally fixed.
 */
export const DEFAULT_RETRY_BUDGET_MS = 120_000;
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
 * Parse a `Retry-After` header value into a delay in milliseconds.
 *
 * Returns `null` when the header is absent or unparseable, which is a different
 * answer from `0`: "the server named no delay" means fall back to the computed
 * backoff, while "the server named zero delay" means retry immediately. Folding
 * the two together would make an unparseable header indistinguishable from an
 * explicit instruction to retry at once.
 *
 * Accepts both forms the RFC allows — a delta-seconds integer and an HTTP-date —
 * plus a fractional-seconds value, which some providers emit. A parser handling
 * only the integer form would silently fall back to the computed backoff against
 * a date-emitting provider, a failure indistinguishable from an absent header.
 *
 * A date in the past yields `0` rather than a negative number. Clock skew
 * between client and server can produce one, and a negative delay would let a
 * caller that subtracts it from a budget compute a larger budget than it had.
 */
export function parseRetryAfterMs(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  // delta-seconds, integer or fractional. Anchored so that `1.5.5`, `-5` and
  // `30 seconds` are rejected rather than partially matched: a partial match
  // would read `30 seconds` as 30 and hide a malformed header behind a
  // plausible number.
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    // Rounded up at millisecond precision: waiting slightly too long costs a
    // little wall-clock, waiting too little costs another rejected request.
    return Math.ceil(Number(trimmed) * 1000);
  }
  // The date branch is gated on the value LOOKING like an HTTP-date before
  // `Date.parse` is consulted, and that gate is not defensive coding.
  // `Date.parse` is far more permissive than the header syntax: it accepts
  // `-5` (read as a year), `1.5.5` (read as 2005) and every other numeric
  // fragment the delta-seconds branch already rejected, turning each into a
  // date decades in the past and therefore into `0` — "retry immediately",
  // which is the opposite of what a malformed throttle hint should mean.
  //
  // The three forms the RFC allows: `Sun, 06 Nov 1994 08:49:37 GMT`,
  // `Sunday, 06-Nov-94 08:49:37 GMT` and `Sun Nov  6 08:49:37 1994`. Requiring
  // a weekday prefix plus a 4-digit year covers all three and excludes every
  // bare-numeric fragment.
  if (!/^[A-Za-z]{3},\s|^[A-Za-z]{3,9},?\s/.test(trimmed)) {
    return null;
  }
  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) {
    return null;
  }
  return Math.max(0, asDate - Date.now());
}

/**
 * Read the delay a retryable response asks for, or `null` when it names none.
 *
 * `undefined` is accepted and means the previous attempt produced no response at
 * all — a transport failure or a timeout, both of which are retried. That case
 * has no header to read, so it must yield `null` and fall back to the computed
 * backoff; the parameter is typed for it rather than the call site guarding,
 * because every retry after a transport failure reaches this function.
 *
 * Only consulted for statuses that will actually be retried. A non-retryable
 * response is returned to the caller as-is, so its header is irrelevant — but
 * reading it anyway would mean a 404 carrying `Retry-After` could contribute a
 * sleep to a loop that is about to return.
 */
function retryAfterMs(res: Response | undefined): number | null {
  if (res === undefined || !isRetryableStatus(res.status)) {
    return null;
  }
  return parseRetryAfterMs(res.headers.get('Retry-After'));
}

/**
 * Retry tuning. Grouped in one object because these are same-typed knobs:
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
  /**
   * Wall-clock ceiling on the retry sequence, measured from the first attempt.
   *
   * A retry whose wait would land beyond it is not made; the last response is
   * returned instead. Defaults to `DEFAULT_RETRY_BUDGET_MS`.
   *
   * `0` is a legitimate value meaning "no retries", and it does not suppress the
   * first attempt: the budget bounds retries, not the initial request. Pass a
   * negative number to disable the ceiling entirely.
   */
  retryBudgetMs?: number | undefined;
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
 *
 * The wait before each retry is, in order of precedence:
 *
 *   1. the response's own `Retry-After`, when it names one;
 *   2. the exponential backoff, `baseDelayMs * 2 ** (attempt - 1)`.
 *
 * A retry whose wait would land beyond `retryBudgetMs` (measured from the first
 * attempt's start) is not attempted at all; the last response is returned. The
 * budget is checked before sleeping rather than after, so an unaffordable retry
 * costs no wall-clock time.
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
  // The default is the fix, not a convenience. See `DEFAULT_RETRY_BUDGET_MS`: the
  // defect was an implied budget shorter than the window it had to outlast, so a
  // default that reproduced it would leave every caller unfixed while the code
  // read as repaired.
  const retryBudgetMs = options.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS;
  // A negative budget disables the ceiling, which is how a caller opts out
  // without a second boolean whose interaction with the number would need its
  // own rules.
  const budgetEnforced = retryBudgetMs >= 0;
  // Captured before the first attempt so the budget is measured from the start
  // of the sequence. Measuring from the first retry would let a slow initial
  // attempt (up to `timeoutMs`) be spent outside the budget entirely.
  const sequenceStart = Date.now();
  let lastError: Error | undefined;
  // The most recent retryable response, held so it can be returned when a retry
  // is unaffordable or the budget runs out. Without it the budget path would
  // have nothing to return and would have to fabricate a status.
  let resFromLastAttempt: Response | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const waitMs = retryAfterMs(resFromLastAttempt) ?? baseDelayMs * 2 ** (attempt - 1);
      if (budgetEnforced && Date.now() - sequenceStart + waitMs > retryBudgetMs) {
        // Unaffordable. Returning `resFromLastAttempt` rather than sleeping past
        // the deadline: the caller inspects `res.ok` and raises the provider's
        // own status, which is strictly more informative than a timeout error
        // raised after the run has already been delayed.
        return resFromLastAttempt ?? new Response(null, { status: 429 });
      }
      await sleep(waitMs);
    }
    const signal = attemptSignal(init.signal, timeoutMs);
    let res: Response;
    try {
      res = await fetchFn(url, signal ? { ...init, signal } : init);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // A transport failure carries no response, so there is no header to read
      // on the next iteration and the computed backoff applies.
      resFromLastAttempt = undefined;
      continue;
    }
    if (res.ok || !isRetryableStatus(res.status) || attempt === maxRetries) {
      return res;
    }
    resFromLastAttempt = res;
  }
  throw lastError ?? new Error(`fetch failed after ${maxRetries + 1} attempts`);
}
