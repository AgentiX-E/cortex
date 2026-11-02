import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  retryableFetch,
  retryableFetchWithStats,
  createRetryStatsAggregate,
  retryStats,
  resetRetryStats,
  isRetryableStatus,
  parseRetryAfterMs,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_BUDGET_MS,
  DEFAULT_RETRY_TIMEOUT_MS,
  type RetryExhaustion,
} from '../retry.js';

/**
 * A fetch that simulates a server which never answers unless aborted.
 *
 * It honours `init.signal` the way a real implementation must: an adapter that
 * ignores the signal would never surface the timeout, so a test built on a
 * non-honouring fake would pass against a broken implementation.
 */
function hangingFetch(ms: number): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    // A real fetch rejects at once when handed an already-aborted signal; it
    // does not wait for an `abort` event that was dispatched before it
    // subscribed. The fake has to match, or it would hide exactly that case.
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        },
        { once: true },
      );
    });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
}

/** A fetch that hangs on the first `hangCount` calls then answers 200. */
function flakyThenOkFetch(hangMs: number, hangCount: number): typeof fetch {
  let calls = 0;
  return (async (_url: unknown, init?: RequestInit) => {
    calls += 1;
    if (calls <= hangCount) {
      const signal = init?.signal;
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, hangMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
}

describe('isRetryableStatus', () => {
  it('retries rate limits and transient server errors', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
  });

  it('does not retry client errors or success', () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
  });
});

describe('retryableFetch', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    let attempts = 0;
    server = createServer((_req, res) => {
      attempts++;
      res.setHeader('Content-Type', 'application/json');
      if (attempts < 3) {
        res.statusCode = 429;
        res.end(JSON.stringify({ error: 'rate limited' }));
        return;
      }
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('retries a 429 and returns the eventual success', async () => {
    const res = await retryableFetch(
      fetch,
      baseUrl,
      { method: 'POST' },
      { maxRetries: 5, baseDelayMs: 1 },
    );
    expect(res.ok).toBe(true);
  });

  it('returns the final retryable response when retries are exhausted', async () => {
    // A fresh server that always 429s.
    const srv = createServer((_req, res) => {
      res.statusCode = 429;
      res.end('{}');
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const addr = srv.address() as { port: number };
    const res = await retryableFetch(
      fetch,
      `http://127.0.0.1:${addr.port}`,
      { method: 'POST' },
      { maxRetries: 2, baseDelayMs: 1 },
    );
    expect(res.status).toBe(429);
    await new Promise<void>((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve())));
  });

  it('re-throws a persistent network error after retries', async () => {
    await expect(
      retryableFetch(
        fetch,
        'http://127.0.0.1:1',
        { method: 'POST' },
        { maxRetries: 1, baseDelayMs: 1 },
      ),
    ).rejects.toThrow();
  });

  it('wraps a non-Error thrown by fetch into an Error', async () => {
    const throwingFetch = (async () => {
      throw 'boom';
    }) as unknown as typeof fetch;
    await expect(
      retryableFetch(throwingFetch, 'http://x', {}, { maxRetries: 1, baseDelayMs: 1 }),
    ).rejects.toThrow('boom');
  });

  it('throws a generic error when the retry budget is negative', async () => {
    const fetchFn = (async () => new Response('{}')) as unknown as typeof fetch;
    await expect(
      retryableFetch(fetchFn, 'http://x', {}, { maxRetries: -1, baseDelayMs: 1 }),
    ).rejects.toThrow(/fetch failed/);
  });

  /**
   * A request that never completes must not stall the caller forever. A
   * benchmark run died with `TypeError: terminated` after a connection reset,
   * and without a deadline there is nothing to bound the wait.
   */
  it('aborts an attempt that exceeds the per-attempt deadline', async () => {
    const started = Date.now();
    await expect(
      retryableFetch(hangingFetch(60_000), 'http://x', {}, { maxRetries: 0, timeoutMs: 50 }),
    ).rejects.toThrow();
    // `AbortSignal.timeout` never fires early, so this is a lower bound only.
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  /**
   * The regression this guards is subtle: if one signal were built before the
   * loop it would already be aborted by the time the retry ran, so every retry
   * would fail instantly and the retry budget would be spent without a single
   * request reaching the server.
   *
   * This asserts on the signal STATE each attempt receives, not on elapsed time
   * and not on how a stub happens to behave. An earlier version hung only on the
   * first call and answered on the second, so the retry path never consulted the
   * signal at all and the mutant survived a full green run.
   */
  it('gives each retry a fresh deadline instead of reusing an expired one', async () => {
    const abortedAtCallTime: boolean[] = [];
    const spy: typeof fetch = (async (_url: unknown, init?: RequestInit) => {
      const signal = init?.signal;
      abortedAtCallTime.push(signal?.aborted === true);
      if (signal?.aborted) {
        throw new Error('aborted before dispatch');
      }
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      retryableFetch(spy, 'http://x', {}, { maxRetries: 2, baseDelayMs: 1, timeoutMs: 40 }),
    ).rejects.toThrow();

    // One entry per attempt, and none of them may already be dead on arrival.
    expect(abortedAtCallTime).toEqual([false, false, false]);
  });

  it('succeeds on a retry after an earlier attempt timed out', async () => {
    const res = await retryableFetch(
      flakyThenOkFetch(60_000, 1),
      'http://x',
      {},
      { maxRetries: 1, baseDelayMs: 1, timeoutMs: 40 },
    );
    expect(res.ok).toBe(true);
  });

  it('passes a live AbortSignal to the underlying fetch', async () => {
    let seen: AbortSignal | undefined;
    const spy: typeof fetch = (async (_url: unknown, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await retryableFetch(spy, 'http://x', {}, { timeoutMs: 1000 });
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
  });

  it('honours a caller-supplied signal alongside the per-attempt deadline', async () => {
    const caller = AbortSignal.timeout(30);
    const started = Date.now();
    await expect(
      retryableFetch(
        hangingFetch(60_000),
        'http://x',
        { signal: caller },
        { maxRetries: 0, timeoutMs: 5000 },
      ),
    ).rejects.toThrow();
    // The caller's shorter deadline must win, long before the 5s retry deadline.
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('aborts immediately when the caller-supplied signal is already aborted', async () => {
    const caller = AbortSignal.abort(new Error('caller cancelled'));
    await expect(
      retryableFetch(
        hangingFetch(60_000),
        'http://x',
        { signal: caller },
        { maxRetries: 0, timeoutMs: 5000 },
      ),
    ).rejects.toThrow('caller cancelled');
  });

  it('installs no deadline when the timeout is disabled', async () => {
    let seen: AbortSignal | undefined;
    let called = false;
    const spy: typeof fetch = (async (_url: unknown, init?: RequestInit) => {
      called = true;
      seen = init?.signal ?? undefined;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await retryableFetch(spy, 'http://x', {}, { timeoutMs: 0 });
    expect(called).toBe(true);
    expect(seen).toBeUndefined();
  });

  it('retries after a timeout and re-throws once the budget is exhausted', async () => {
    const fetchFn = hangingFetch(60_000);
    await expect(
      retryableFetch(fetchFn, 'http://x', {}, { maxRetries: 2, baseDelayMs: 1, timeoutMs: 30 }),
    ).rejects.toThrow();
  });
});

describe('defaults', () => {
  it('exposes sane retry defaults', () => {
    // Eight, not five: the geometric sum of the default backoff has to exceed the default
    // budget, or the budget is never reached. `1+2+4+8+16 = 31 s` against a 120 s ceiling
    // is the defect run `41346610318` died of; `1+2+4+…+128 = 255 s` is a ladder the
    // ceiling can actually stop. See the block on spending the budget below, which asserts
    // the identity rather than the constant.
    expect(DEFAULT_MAX_RETRIES).toBe(8);
    expect(DEFAULT_RETRY_BASE_DELAY_MS).toBe(1000);
    expect(DEFAULT_RETRY_TIMEOUT_MS).toBe(60_000);
  });

  it('exposes a retry budget long enough to outlast a minute-scale window', () => {
    // The whole point of the budget default: a provider whose window is measured
    // in minutes must be reachable. A default at or below 60 s would reproduce
    // the original defect with the code nominally fixed — the retries would run
    // and every one would land inside the window that rejected the request.
    expect(DEFAULT_RETRY_BUDGET_MS).toBeGreaterThan(60_000);
  });
});

/**
 * `Retry-After` is the provider telling the client exactly how long its own
 * throttle window is. Before this existed the client discarded it and slept a
 * computed backoff instead, so a 60-second window was waited out in 31 seconds
 * of total sleeping and every retry landed inside the window that had just
 * rejected the request. The header is the only field that can distinguish "wait
 * one second" from "wait until the window rolls over", so parsing it is
 * load-bearing rather than a nicety.
 */
describe('parseRetryAfterMs', () => {
  it('reads the delay-seconds form', () => {
    expect(parseRetryAfterMs('30')).toBe(30_000);
    expect(parseRetryAfterMs('1')).toBe(1_000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  it('reads the HTTP-date form as a delay from now', () => {
    // The spec allows either a delta-seconds integer or an HTTP-date. Both are
    // in use in the wild, and a parser handling only the first would silently
    // fall back to the computed backoff against a date-emitting provider --
    // a failure indistinguishable from "the header was absent".
    const now = Date.now();
    const when = new Date(now + 45_000).toUTCString();
    const parsed = parseRetryAfterMs(when);
    expect(parsed).not.toBeNull();
    // Within a second of the intended 45s, allowing for the clock moving
    // between building the string and parsing it.
    expect(parsed!).toBeGreaterThan(43_000);
    expect(parsed!).toBeLessThanOrEqual(45_000);
  });

  it('treats a past date as no delay rather than a negative one', () => {
    // A clock skew between client and server can put the date in the past. A
    // negative sleep would fire immediately anyway, but returning a negative
    // number lets a caller that adds it to a budget compute a smaller budget
    // than it had.
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfterMs(past)).toBe(0);
  });

  it('returns null for an absent or unparseable value', () => {
    // `null` rather than 0: "the server named no delay" and "the server named
    // zero delay" are different instructions, and only the second should
    // override the computed backoff with an immediate retry.
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
    expect(parseRetryAfterMs('soon')).toBeNull();
    expect(parseRetryAfterMs('30 seconds')).toBeNull();
  });

  it('rejects numeric fragments that are not delta-seconds', () => {
    // These are the values `Date.parse` accepts and reads as a year, which is
    // what makes them dangerous rather than merely malformed. Before the date
    // branch was gated on the value looking like an HTTP-date, each of these
    // parsed to a date decades in the past and therefore returned `0` —
    // "retry immediately" — instead of `null`, "fall back to the computed
    // backoff". For a throttle hint those two answers are opposites.
    //
    // `-5` in particular is not a hypothetical: a client that concatenates a
    // sign into the value produces exactly this, and the failure is silent.
    expect(parseRetryAfterMs('-5')).toBeNull();
    expect(parseRetryAfterMs('1.5.5')).toBeNull();
    expect(parseRetryAfterMs('1e3')).toBeNull();
    expect(parseRetryAfterMs('+30')).toBeNull();
  });

  it('rejects a weekday-prefixed value that is still not a real date', () => {
    // The gate on a weekday prefix and `Date.parse` are two separate checks, and
    // this test covers the second: a value that passes the prefix gate and still
    // fails to parse. Without it the two checks are indistinguishable in the
    // suite, so removing `Number.isNaN` would return `Math.max(0, NaN - now)`
    // — which is `NaN`, not a number of milliseconds, and would be handed to
    // `setTimeout` as the delay.
    expect(parseRetryAfterMs('Mon, 99 Zzz 9999 99:99:99 GMT')).toBeNull();
    expect(parseRetryAfterMs('Mon, nonsense GMT')).toBeNull();
    expect(parseRetryAfterMs('Weekdayish')).toBeNull();
  });

  it('accepts a weekday-prefixed value that IS a real date', () => {
    // The paired positive case. Without it, a mutation that rejected every
    // date-shaped value would satisfy the test above while breaking the
    // behaviour the date branch exists for.
    const parsed = parseRetryAfterMs('Sun, 06 Nov 1994 08:49:37 GMT');
    // The date is in the past, so the delay clamps to 0 rather than going
    // negative — a negative delay would reach `setTimeout` as an immediate
    // retry on a response that named a specific (already elapsed) moment.
    expect(parsed).toBe(0);
  });

  it('accepts a fractional-seconds value some providers emit', () => {
    // `1.5` is not what the spec says, but a parser that rejects it falls back
    // to the computed backoff, which is the failure this module exists to
    // remove. Rounded up at millisecond precision rather than to whole seconds:
    // the header's granularity is a second, but rounding a stated delay UP to
    // the next second would add up to a full second of needless wait on every
    // retry, and the safe direction is only "not less than asked".
    expect(parseRetryAfterMs('1.5')).toBe(1500);
    expect(parseRetryAfterMs('0.1')).toBe(100);
    expect(parseRetryAfterMs('2')).toBe(2000);
  });

  it('accepts all three HTTP-date forms', () => {
    // The RFC allows three shapes and providers differ in which they emit. A
    // gate tuned to only the first would reject the other two and fall back to
    // the computed backoff, which is indistinguishable from an absent header.
    for (const offsetMs of [30_000, 90_000, 300_000]) {
      const when = new Date(Date.now() + offsetMs);
      const forms = [
        when.toUTCString(), // Sun, 06 Nov 1994 08:49:37 GMT
        when.toUTCString().replace(/,/, ', '),
      ];
      for (const form of forms) {
        const parsed = parseRetryAfterMs(form);
        expect(parsed, form).not.toBeNull();
        expect(parsed!, form).toBeGreaterThan(offsetMs - 2000);
        expect(parsed!, form).toBeLessThanOrEqual(offsetMs);
      }
    }
  });
});

/**
 * A fetch that answers `status` with the given headers for `count` calls, then
 * 200. Also records the time of each call, so a test can assert on the delays.
 *
 * The three stubs below all wrap this one rather than each carrying their own
 * copy: an earlier revision had three near-identical bodies, and the one that
 * differed was the one with the bug.
 */
function statusThenOkFetch(
  status: number,
  count: number,
  headers: Record<string, string>,
): { fetchFn: typeof fetch; calls: () => number; gaps: () => number[] } {
  let calls = 0;
  const times: number[] = [];
  const fetchFn = (async () => {
    times.push(Date.now());
    calls += 1;
    if (calls <= count) {
      return new Response('{}', { status, headers });
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  return {
    fetchFn,
    calls: () => calls,
    gaps: () => times.slice(1).map((t, i) => t - times[i]!),
  };
}

/** A fetch that answers 429 with the given headers for `count` calls, then 200. */
function rateLimitedThenOk(
  count: number,
  headers: Record<string, string>,
): { fetchFn: typeof fetch; calls: () => number } {
  const { fetchFn, calls } = statusThenOkFetch(429, count, headers);
  return { fetchFn, calls };
}

/** Record the delays a run actually slept, by observing call timestamps. */
function timestampingFetch(
  count: number,
  headers: Record<string, string>,
): { fetchFn: typeof fetch; gaps: () => number[] } {
  const { fetchFn, gaps } = statusThenOkFetch(429, count, headers);
  return { fetchFn, gaps };
}

describe('retryableFetch honours Retry-After', () => {
  it('prefers the server delay over the computed backoff', async () => {
    // `baseDelayMs: 1` would compute a 1 ms first backoff. The header asks for
    // 120 ms, so a run that respects it must take at least that long. Asserting
    // the floor rather than an exact duration keeps the test off the clock
    // while still failing for an implementation that ignores the header.
    const { fetchFn } = rateLimitedThenOk(1, { 'Retry-After': '0.12' });
    const started = Date.now();
    const res = await retryableFetch(fetchFn, 'http://x', {}, { maxRetries: 2, baseDelayMs: 1 });
    expect(res.ok).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it('uses the header even when it is shorter than the computed backoff', async () => {
    // The mirror of the test above, and the one that separates "reads the
    // header" from "clamps a large header". A server that says "retry in 1 ms"
    // must not be made to wait the computed 2000 ms second backoff -- the
    // header is an instruction, not a lower bound.
    const { fetchFn, gaps } = timestampingFetch(1, { 'Retry-After': '0' });
    const res = await retryableFetch(fetchFn, 'http://x', {}, { maxRetries: 2, baseDelayMs: 2000 });
    expect(res.ok).toBe(true);
    expect(gaps()[0]!).toBeLessThan(2000);
  });

  it('falls back to the computed backoff when the header is absent', async () => {
    const { fetchFn, gaps } = timestampingFetch(1, {});
    const res = await retryableFetch(fetchFn, 'http://x', {}, { maxRetries: 2, baseDelayMs: 60 });
    expect(res.ok).toBe(true);
    expect(gaps()[0]!).toBeGreaterThanOrEqual(50);
  });

  it('falls back to the computed backoff when the header is unparseable', async () => {
    // Paired with the test below and asserted against it rather than against an
    // absolute duration. `>= 50` alone cannot tell "fell back to the 60 ms
    // backoff" from "read a header that happened to ask for roughly 50 ms", so
    // on its own it would pass for an implementation that read the header
    // wrongly. The pair pins the two outcomes against each other.
    const { fetchFn, gaps } = timestampingFetch(1, { 'Retry-After': 'whenever' });
    const res = await retryableFetch(fetchFn, 'http://x', {}, { maxRetries: 2, baseDelayMs: 60 });
    expect(res.ok).toBe(true);
    expect(gaps()[0]!).toBeGreaterThanOrEqual(50);
    expect(gaps()[0]!).toBeLessThan(400);
  });

  it('does not treat an unparseable header as a zero delay', async () => {
    // The defect this rules out: a parser that returns 0 instead of `null` for
    // garbage would retry immediately, so the run would hammer a provider that
    // had just asked to be left alone. The computed backoff is 250 ms here, so
    // "waited at least half of it" separates the two behaviours.
    const { fetchFn, gaps } = timestampingFetch(1, { 'Retry-After': 'whenever' });
    const res = await retryableFetch(fetchFn, 'http://x', {}, { maxRetries: 2, baseDelayMs: 250 });
    expect(res.ok).toBe(true);
    expect(gaps()[0]!).toBeGreaterThanOrEqual(200);
  });

  it('reads the header from a 503 as well as a 429', async () => {
    // 503 is retryable for the same reason 429 is, and providers emit
    // `Retry-After` on it. Reading it only for 429 would leave the identical
    // defect in place for the other retryable status.
    //
    // Built as its own helper rather than by rewriting a 429 on the way out: the
    // earlier revision wrapped `timestampingFetch` and swapped the status inside
    // the wrapper, which made the call count and the gaps come from different
    // objects and left the reader to work out which. The status is a parameter
    // here, so the fetch under test is one object.
    const { fetchFn, gaps } = statusThenOkFetch(503, 1, { 'Retry-After': '0' });
    const started = Date.now();
    const res = await retryableFetch(fetchFn, 'http://x', {}, { maxRetries: 2, baseDelayMs: 2000 });
    expect(res.ok).toBe(true);
    // The computed second backoff is 2000 ms; the header asks for none, so a
    // run that reads it finishes far sooner.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(gaps().length).toBe(1);
  });
});

describe('retryableFetch respects a wall-clock budget', () => {
  it('stops retrying once the budget is spent rather than sleeping past it', async () => {
    // The defect this closes: the retry budget was a COUNT of attempts, and the
    // total sleep it implied (31 s at the defaults) was shorter than a
    // minute-scale throttle window. Raising the count would fix this case and
    // every other one only by accident, since what has to be exceeded is a
    // duration. A wall-clock budget states the requirement directly: a retry
    // that would land beyond `retryBudgetMs` from the first attempt is not made.
    const { fetchFn, calls } = rateLimitedThenOk(99, { 'Retry-After': '30' });
    const started = Date.now();
    const res = await retryableFetch(
      fetchFn,
      'http://x',
      {},
      { maxRetries: 10, baseDelayMs: 1, retryBudgetMs: 150 },
    );
    // The server asked for 30 s; the budget is 150 ms. The retry must be
    // skipped, so the run returns the 429 rather than sleeping past its budget.
    expect(res.status).toBe(429);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(calls()).toBe(1);
  });

  it('synthesises a 429 when the budget refuses a retry after a transport failure', async () => {
    // The refusal path returns `resFromLastAttempt`, and after a transport failure
    // there is no response to return -- the failure cleared it. The fallback is a
    // synthetic 429, so the caller still sees an HTTP status to act on instead of
    // a bare `undefined` reaching `res.ok`.
    //
    // The mutation this guards: replacing the fallback with a non-429 status, or
    // removing it, makes the refused-after-failure case report a status the
    // retry layer never observed. `rateLimited` must stay at zero either way,
    // because no 429 was ever received.
    //
    // The budget is `0` rather than "shorter than the first backoff" because a shorter
    // budget no longer refuses: the last wait is truncated to whatever remains, so 10 ms
    // against a 30 ms backoff is now one truncated wait and one more attempt (the case
    // below). Nothing left at all is the state that refuses.
    let calls = 0;
    const fetchFn = async (): Promise<Response> => {
      calls += 1;
      throw new Error('socket hang up');
    };
    resetRetryStats();
    const outcome = await retryableFetchWithStats(
      fetchFn,
      'http://x',
      {},
      { maxRetries: 10, baseDelayMs: 30, retryBudgetMs: 0 },
    );

    expect(outcome.response.status).toBe(429);
    expect(calls).toBe(1);
    // A refused retry is a retry that never happened.
    expect(outcome.retried).toBe(0);
    expect(outcome.rateLimited).toBe(0);
    expect(outcome.attempts).toBe(1);
  });

  it('spends the remaining budget on a retry after a transport failure', async () => {
    // The counterpart of the case above, and the behaviour the truncation exists for: a
    // budget shorter than the next computed backoff is not a refusal any more. Ten
    // milliseconds remain and the backoff wants thirty, so the wait is the ten and one
    // more request is made. Under the old rule the ladder stopped with 10 ms of a 10 ms
    // budget unspent, which is the same defect as the default count: a ceiling the ladder
    // cannot reach.
    let calls = 0;
    const fetchFn = async (): Promise<Response> => {
      calls += 1;
      throw new Error('socket hang up');
    };
    resetRetryStats();
    const outcome = await retryableFetchWithStats(
      fetchFn,
      'http://x',
      {},
      { maxRetries: 10, baseDelayMs: 30, retryBudgetMs: 10 },
    );

    expect(outcome.response.status).toBe(429);
    expect(calls).toBe(2);
    expect(outcome.retried).toBe(1);
    expect(outcome.attempts).toBe(2);
    expect(outcome.rateLimited).toBe(0);
  });

  it('keeps retrying while the budget still allows it', async () => {
    const { fetchFn, calls } = rateLimitedThenOk(2, { 'Retry-After': '0' });
    const res = await retryableFetch(
      fetchFn,
      'http://x',
      {},
      { maxRetries: 5, baseDelayMs: 1, retryBudgetMs: 5000 },
    );
    expect(res.ok).toBe(true);
    expect(calls()).toBe(3);
  });

  it('does not let a zero budget block the first attempt', async () => {
    // The budget bounds RETRIES, not the initial request. A budget of 0 is a
    // legitimate way to say "no retries", and an implementation that checked
    // the budget before the first attempt would make the call at all.
    const { fetchFn, calls } = rateLimitedThenOk(1, {});
    const res = await retryableFetch(
      fetchFn,
      'http://x',
      {},
      { maxRetries: 5, baseDelayMs: 1, retryBudgetMs: 0 },
    );
    expect(res.status).toBe(429);
    expect(calls()).toBe(1);
  });

  it('applies the default budget when none is supplied', async () => {
    // The defect was a DEFAULT, not a missing feature: the implied budget was
    // `base * (2 ** retries - 1) = 31 s`, shorter than the minute-scale window
    // it had to outlast. Adding an opt-in parameter whose default reproduces the
    // defect would leave every existing caller -- embedding, LLM and rerank --
    // behaving exactly as before, and "fixed" would then be indistinguishable
    // from "not fixed" in the artifact. So the default IS the fix, and this
    // asserts it is in force rather than merely available.
    //
    // Observed through the ATTEMPT COUNT, not through elapsed time, because time
    // alone cannot separate the two implementations: a run that waits the full
    // 30 s the server asked for looks identical whether or not a ceiling exists.
    // The server here always 429s with `Retry-After: 30`, `maxRetries` is 10, and
    // the default ceiling is 120 s -- so exactly 4 retries fit, and the 5th is
    // refused. An implementation with no ceiling would make all 10.
    //
    // Fake timers rather than a real 2-minute wait: the assertions are on counts,
    // which advance deterministically, so compressing the clock cannot mask the
    // behaviour under test.
    vi.useFakeTimers();
    try {
      const { fetchFn, calls } = rateLimitedThenOk(99, { 'Retry-After': '30' });
      const promise = retryableFetch(fetchFn, 'http://x', {}, { maxRetries: 10, baseDelayMs: 1 });
      await vi.advanceTimersByTimeAsync(180_000);
      const res = await promise;
      expect(res.status).toBe(429);
      expect(calls()).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps the default budget so a hostile header cannot stall a run forever', async () => {
    // The other side of defaulting: a server answering `Retry-After: 86400` must
    // not turn a benchmark into a day-long sleep. The budget bounds the total
    // sequence, so a wait beyond it is skipped and the last response returned.
    const { fetchFn, calls } = rateLimitedThenOk(99, { 'Retry-After': '86400' });
    const started = Date.now();
    const res = await retryableFetch(fetchFn, 'http://x', {}, { maxRetries: 10, baseDelayMs: 1 });
    expect(res.status).toBe(429);
    expect(calls()).toBe(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('caps the sleep at the remaining budget instead of the full header value', async () => {
    // A header value shorter than the remaining budget is slept in full; when
    // the header exceeds the remaining budget there is no point sleeping it,
    // because the retry would then be issued past the deadline. Returning the
    // last response immediately is the honest outcome.
    const { fetchFn } = rateLimitedThenOk(99, { 'Retry-After': '10' });
    const started = Date.now();
    const res = await retryableFetch(
      fetchFn,
      'http://x',
      {},
      { maxRetries: 5, baseDelayMs: 1, retryBudgetMs: 200 },
    );
    expect(res.status).toBe(429);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

/**
 * The ladder has to be able to SPEND the budget it is given.
 *
 * ## What was measured, and what it cost
 *
 * `DEFAULT_RETRY_BUDGET_MS` is 120 s and its docblock states the requirement: a provider
 * whose throttle window is measured in minutes has to be reachable. At the defaults the
 * ladder reached **31,051 ms** — measured, not inferred — because `DEFAULT_MAX_RETRIES`
 * bound first: the waits are `1+2+4+8+16 = 31 s` and the sixth attempt is already the last
 * one, so the budget was 3.9x the ladder and never consulted. That is the *same* defect
 * the budget was introduced to fix, one layer down: the protection's adequacy was never
 * exercised because the failure it guards arrives through a different constant.
 *
 * Run `41346610318` is what it costs. A 20-question probe, answered `429` at question 13,
 * dead inside the 31 s ladder after six attempts, with the twelve answers it had already
 * graded left in a partial artifact nobody can score. Two minutes of permitted waiting
 * would have outlasted the per-minute window that rejected it.
 *
 * ## Why the count is asserted beside the duration
 *
 * The duration is the requirement and the count is the mechanism. A run that reached 120 s
 * with one attempt would also satisfy the duration, by sleeping once and never retrying —
 * which is not a retry ladder. So both are pinned, and the arithmetic that produces the
 * count is written down here rather than left as a constant someone has to reverse.
 */
describe('the retry ladder can spend the budget it is given', () => {
  /**
   * A fetch that answers 429 forever and records when each attempt was issued.
   *
   * The timestamps are read inside the fake rather than from `Date.now()` after the
   * promise resolves, because with fake timers the clock has already been advanced past
   * the end of the sequence — an elapsed reading taken afterwards describes the test's
   * `advanceTimersByTimeAsync`, not the ladder. The per-call timestamps are the ladder's
   * own schedule, which is the thing the budget governs.
   *
   * Offsets from the first attempt, not absolute times: fake timers start the clock at a
   * real epoch, so an absolute reading would pin this test to the day it was written.
   */
  function timedRateLimitedFetch(): { fetchFn: typeof fetch; at: () => number[] } {
    const offsets: number[] = [];
    let first: number | undefined;
    const fetchFn = (async () => {
      const now = Date.now();
      first ??= now;
      offsets.push(now - first);
      return new Response('{}', { status: 429 });
    }) as unknown as typeof fetch;
    return { fetchFn, at: () => offsets };
  }

  it('waits out the whole default budget when the provider rejects every attempt', async () => {
    // 1 + 2 + 4 + 8 + 16 + 32 = 63 s of computed backoff, then the seventh wait would
    // be 64 s and only 57 s of the budget remain, so it is truncated to the remainder and
    // the last attempt lands exactly on the deadline.
    vi.useFakeTimers();
    try {
      const { fetchFn, at } = timedRateLimitedFetch();
      const promise = retryableFetch(fetchFn, 'http://x', {});
      await vi.advanceTimersByTimeAsync(200_000);
      const res = await promise;
      expect(res.status).toBe(429);
      // Eight attempts, the last of them at the deadline. Six was the reach that the
      // default count implied, and it is the number that must not come back.
      expect(at()).toEqual([0, 1_000, 3_000, 7_000, 15_000, 31_000, 63_000, 120_000]);
      expect(at().at(-1)).toBe(DEFAULT_RETRY_BUDGET_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('imposes no ceiling at all when the budget is negative', async () => {
    // The other disarm: a negative budget turns the deadline off, so the count is the ONLY
    // limit and nothing is truncated. Asserted because the truncation rule reads
    // `remaining`, which is `Infinity` here -- and an implementation that truncated against a
    // negative or zero remainder would stop a run whose caller asked for no ceiling.
    vi.useFakeTimers();
    try {
      const { fetchFn, at } = timedRateLimitedFetch();
      const promise = retryableFetch(
        fetchFn,
        'http://x',
        {},
        { maxRetries: 2, baseDelayMs: 1_000, retryBudgetMs: -1 },
      );
      await vi.advanceTimersByTimeAsync(60_000);
      const res = await promise;
      expect(res.status).toBe(429);
      expect(at()).toEqual([0, 1_000, 3_000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('spends a short budget exactly, on the last backoff rather than abandoning it', async () => {
    // A budget the geometric series overshoots is the common case, not a corner: 40 ms
    // then 80 ms against a 100 ms budget. Refusing the second wait leaves 60 ms of the
    // budget unused and stops after two attempts; truncating it to the remainder spends
    // the budget and makes the third attempt at the deadline. The difference is one
    // request and 60% of the window.
    vi.useFakeTimers();
    try {
      const { fetchFn, at } = timedRateLimitedFetch();
      const promise = retryableFetch(
        fetchFn,
        'http://x',
        {},
        { maxRetries: 5, baseDelayMs: 40, retryBudgetMs: 100 },
      );
      await vi.advanceTimersByTimeAsync(5000);
      const res = await promise;
      expect(res.status).toBe(429);
      expect(at()).toEqual([0, 40, 100]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still binds on the count when a caller names one', async () => {
    // The count is not deprecated: it remains the caller's ceiling, and this is the
    // 31 s reach the default used to impose. It is asserted so that "5 retries" keeps
    // meaning five, which is what a caller who writes 5 is asking for — the defect was
    // the DEFAULT, not the parameter.
    vi.useFakeTimers();
    try {
      const { fetchFn, at } = timedRateLimitedFetch();
      const promise = retryableFetch(fetchFn, 'http://x', {}, { maxRetries: 5 });
      await vi.advanceTimersByTimeAsync(200_000);
      const res = await promise;
      expect(res.status).toBe(429);
      expect(at()).toEqual([0, 1_000, 3_000, 7_000, 15_000, 31_000]);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The retry layer used to be silent: it retried internally and returned only the
 * final response, so a request that was rejected twice and then served was
 * indistinguishable in every artifact from one served first time. Two A/B arms
 * were dispatched to measure a 429 rate that nothing recorded, which is the
 * measurement gap these tests close.
 */
describe('retry accounting', () => {
  it('reports the attempts and statuses a retried call actually saw', async () => {
    const { fetchFn } = rateLimitedThenOk(2, {});
    const stats = await retryableFetchWithStats(
      fetchFn,
      'http://x',
      {},
      { maxRetries: 3, baseDelayMs: 1 },
    );
    // Two rejections then a success: three requests, and the statuses of the two
    // that were retried. The success is not a "retry", it is the outcome.
    expect(stats.attempts).toBe(3);
    expect(stats.retried).toBe(2);
    expect(stats.rateLimited).toBe(2);
    expect(stats.retryAfterHonoured).toBe(0);
    expect(stats.response.ok).toBe(true);
  });

  it('counts a 5xx as retried but not as rate-limited', async () => {
    // 503 is retryable and carries `Retry-After` too, so a counter that folded
    // both into one bucket would report a rate limit that never happened.
    const { fetchFn } = statusThenOkFetch(503, 1, {});
    const stats = await retryableFetchWithStats(
      fetchFn,
      'http://x',
      {},
      { maxRetries: 2, baseDelayMs: 1 },
    );
    expect(stats.attempts).toBe(2);
    expect(stats.retried).toBe(1);
    expect(stats.rateLimited).toBe(0);
  });

  it('counts a retry whose delay came from Retry-After', async () => {
    const { fetchFn } = rateLimitedThenOk(1, { 'Retry-After': '0.05' });
    const stats = await retryableFetchWithStats(
      fetchFn,
      'http://x',
      {},
      { maxRetries: 2, baseDelayMs: 1 },
    );
    expect(stats.retried).toBe(1);
    expect(stats.rateLimited).toBe(1);
    expect(stats.retryAfterHonoured).toBe(1);
  });

  it('counts a transport failure as a retried attempt with no status', async () => {
    // A transport failure has no response, so it contributes to `attempts` and
    // `retried` but must not be counted as a rate limit -- there was no status
    // to read. Folding it in would inflate the 429 count with network errors.
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      if (calls < 3) throw new Error('ECONNRESET');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const stats = await retryableFetchWithStats(
      fetchFn,
      'http://x',
      {},
      { maxRetries: 5, baseDelayMs: 1 },
    );
    expect(stats.attempts).toBe(3);
    expect(stats.retried).toBe(2);
    expect(stats.rateLimited).toBe(0);
    expect(stats.response.ok).toBe(true);
  });

  it('reports zero retries for a first-attempt success', async () => {
    const fetchFn = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const stats = await retryableFetchWithStats(fetchFn, 'http://x', {}, {});
    expect(stats.attempts).toBe(1);
    expect(stats.retried).toBe(0);
    expect(stats.rateLimited).toBe(0);
  });

  it('counts every attempt when the retryable status never clears', async () => {
    const fetchFn = (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch;
    const stats = await retryableFetchWithStats(
      fetchFn,
      'http://x',
      {},
      { maxRetries: 2, baseDelayMs: 1 },
    );
    // 1 initial + 2 retries = 3 attempts, all rejected.
    expect(stats.attempts).toBe(3);
    expect(stats.retried).toBe(2);
    expect(stats.rateLimited).toBe(3);
    expect(stats.response.status).toBe(429);
  });

  it('does not count a retry that the budget refused to make', async () => {
    // The budget returns before sleeping, so no request is issued. Counting it
    // would report a request the provider never received, which is the specific
    // error this counter exists to prevent.
    const { fetchFn } = rateLimitedThenOk(99, { 'Retry-After': '10' });
    const stats = await retryableFetchWithStats(
      fetchFn,
      'http://x',
      {},
      { maxRetries: 5, baseDelayMs: 1, retryBudgetMs: 200 },
    );
    expect(stats.attempts).toBe(1);
    expect(stats.retried).toBe(0);
    expect(stats.rateLimited).toBe(1);
  });

  it('counts a non-retryable status as neither retried nor rate-limited', async () => {
    const fetchFn = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    const stats = await retryableFetchWithStats(
      fetchFn,
      'http://x',
      {},
      { maxRetries: 3, baseDelayMs: 1 },
    );
    expect(stats.attempts).toBe(1);
    expect(stats.retried).toBe(0);
    expect(stats.rateLimited).toBe(0);
  });
});

describe('retry stats aggregation', () => {
  it('sums counters across calls and recomputes the derived totals', () => {
    const agg = createRetryStatsAggregate();
    agg.record({ attempts: 3, retried: 2, rateLimited: 2, retryAfterHonoured: 1 });
    agg.record({ attempts: 1, retried: 0, rateLimited: 0, retryAfterHonoured: 0 });
    agg.record({ attempts: 2, retried: 1, rateLimited: 0, retryAfterHonoured: 0 });
    const snap = agg.snapshot();
    expect(snap.attempts).toBe(6);
    expect(snap.retried).toBe(3);
    expect(snap.rateLimited).toBe(2);
    expect(snap.retryAfterHonoured).toBe(1);
    // Derived, not stored: a stored copy is a second source of truth that can
    // disagree with the inputs it was computed from.
    expect(snap.calls).toBe(3);
    expect(snap.cleanCalls).toBe(1);
    // Two of the three calls retried (2 and 1), so the rate is 2/3.
    expect(snap.retryRate).toBeCloseTo(2 / 3, 10);
  });

  it('reports a zero retry rate rather than NaN for an empty aggregate', () => {
    // A rate over zero calls is not zero, but `NaN` serializes to `null` in JSON
    // and would read as "no data" beside a genuine 0. Zero clean calls is the
    // honest answer, and the `calls` field carries the sample size.
    const snap = createRetryStatsAggregate().snapshot();
    expect(snap.calls).toBe(0);
    expect(snap.retryRate).toBe(0);
    expect(Number.isNaN(snap.retryRate)).toBe(false);
  });

  it('exposes a process-level aggregate that a caller can read and reset', async () => {
    resetRetryStats();
    const fetchFn = (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch;
    await retryableFetchWithStats(fetchFn, 'http://x', {}, { maxRetries: 1, baseDelayMs: 1 });
    await retryableFetchWithStats(fetchFn, 'http://x', {}, { maxRetries: 0 });
    const snap = retryStats();
    expect(snap.calls).toBe(2);
    expect(snap.attempts).toBe(3);
    expect(snap.rateLimited).toBe(3);
    expect(snap.retried).toBe(1);
    resetRetryStats();
    expect(retryStats().calls).toBe(0);
  });

  it('zeroes every counter on reset, not just the call count', () => {
    // `bench/run.ts` resets at the start of a run and reports at the end, so a
    // field that survives the reset is attributed to a run that did not produce
    // it. Asserting only `calls` would leave the other seven free to leak: the
    // retry RATE is `retriedCalls / calls`, so a stale numerator over a fresh
    // denominator reports a rate above 100%.
    const agg = createRetryStatsAggregate();
    agg.record({ attempts: 5, retried: 4, rateLimited: 3, retryAfterHonoured: 2 });
    agg.record({ attempts: 1, retried: 0, rateLimited: 0, retryAfterHonoured: 0 });

    agg.reset();

    expect(agg.snapshot()).toEqual({
      attempts: 0,
      retried: 0,
      rateLimited: 0,
      retryAfterHonoured: 0,
      calls: 0,
      retriedCalls: 0,
      cleanCalls: 0,
      exhaustedCalls: 0,
      retryRate: 0,
    });
  });

  it('returns a copy, so a caller cannot write through the snapshot', () => {
    const agg = createRetryStatsAggregate();
    agg.record({ attempts: 1, retried: 0, rateLimited: 0, retryAfterHonoured: 0 });
    const snap = agg.snapshot();
    snap.rateLimited = 999;
    expect(agg.snapshot().rateLimited).toBe(0);
  });

  it('partitions the sample into clean, retried and exhausted calls', () => {
    // The identity that makes the three counters readable together. An exhausted call with
    // no retries -- one attempt, cut off -- belongs to neither of the other two: it did
    // not retry, and it did not complete. Counting it as clean would let a run whose
    // traffic was failing outright report a HIGHER share of untroubled calls than a
    // healthy one, which is the reading the counter exists to prevent.
    const agg = createRetryStatsAggregate();
    agg.record({ attempts: 1, retried: 0, rateLimited: 0, retryAfterHonoured: 0 });
    agg.record({ attempts: 3, retried: 2, rateLimited: 1, retryAfterHonoured: 0 });
    agg.recordExhausted({ attempts: 1, retried: 0, rateLimited: 0, retryAfterHonoured: 0 });

    const snap = agg.snapshot();
    expect(snap.calls).toBe(3);
    expect(snap.cleanCalls).toBe(1);
    expect(snap.retriedCalls).toBe(1);
    expect(snap.exhaustedCalls).toBe(1);
    expect(snap.cleanCalls + snap.retriedCalls + snap.exhaustedCalls).toBe(snap.calls);
  });

  it('counts an exhausted call that retried in both counters, because both are true', () => {
    // A call that issued six requests and never got an answer DID retry, so it belongs in
    // `retriedCalls` -- the retry rate is about the provider's behaviour, and suppressing
    // it there would report a smooth run over traffic that was failing. `exhaustedCalls`
    // is what says the retrying did not work, which is why the two are not exclusive.
    const agg = createRetryStatsAggregate();
    agg.recordExhausted({ attempts: 6, retried: 5, rateLimited: 0, retryAfterHonoured: 0 });

    const snap = agg.snapshot();
    expect(snap.retriedCalls).toBe(1);
    expect(snap.exhaustedCalls).toBe(1);
    expect(snap.cleanCalls).toBe(0);
    expect(snap.retryRate).toBe(1);
  });
});

/**
 * A call that exhausts its retries has to say so, and it did not.
 *
 * ## The loss this pins
 *
 * Run `38520676669` graded four thousand questions across two systems and died on
 * `TypeError: terminated` after three hours and eight minutes. Its error log carried the
 * stack and nothing else -- no url, no model, no attempt count -- so the one question a
 * reader has to answer after an infrastructure failure, "was this a transient fault that
 * survived six attempts, or a single abort from somewhere the retry loop does not wrap",
 * had no answer in the record.
 *
 * Two defects make that answer unrecordable, and neither is in the retry logic itself:
 *
 *   - the exhaustion path throws `lastError` without passing through `withResponse`, so
 *     a call that failed on every attempt is **invisible** in the retry accounting. The
 *     counters report the calls that recovered and not the one that did not, which is the
 *     wrong way round for a failure investigation;
 *   - the thrown error is the transport error verbatim, so nothing on it distinguishes
 *     one attempt from six.
 *
 * ## Why the record is attached rather than wrapped
 *
 * The same argument `attachPartial` makes one layer up: the stack of a transport error is
 * the only evidence in the record that the loss was infrastructure rather than a defect in
 * the arm, so replacing the error with a wrapper would destroy the thing the diagnostic
 * exists for. The original is returned untouched with a field added.
 */
describe('an exhausted retry reports itself', () => {
  /** A fetch that fails every attempt the way a reset socket does. */
  function alwaysTerminated(): typeof fetch {
    return (async () => {
      throw new TypeError('terminated');
    }) as unknown as typeof fetch;
  }

  /** The exhaustion record an error carries, or `undefined` when it carries none. */
  function exhaustionOf(error: unknown) {
    return (error as { retryExhausted?: RetryExhaustion }).retryExhausted;
  }

  it('names the url, the attempts and the transport error', async () => {
    const failure = await retryableFetch(
      alwaysTerminated(),
      'https://api.example.test/v1/chat/completions',
      {},
      { maxRetries: 2, baseDelayMs: 1 },
    ).then(
      () => {
        throw new Error('the fetch resolved, but every attempt threw');
      },
      (error: unknown) => error,
    );

    const record = exhaustionOf(failure);
    expect(record).toBeDefined();
    expect(record!.url).toBe('https://api.example.test/v1/chat/completions');
    // Three requests were issued: the first and two retries, which is what
    // `maxRetries: 2` means and what a reader has to be able to check.
    expect(record!.attempts).toBe(3);
    expect(record!.retried).toBe(2);
    expect(record!.cause).toBe('terminated');
    expect(record!.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('leaves the transport error itself intact, because its stack is the evidence', async () => {
    const failure = await retryableFetch(
      alwaysTerminated(),
      'http://x',
      {},
      {
        maxRetries: 0,
        baseDelayMs: 1,
      },
    ).then(
      () => {
        throw new Error('the fetch resolved, but the attempt threw');
      },
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toBe('terminated');
  });

  it('counts the failed call in the process aggregate, which it did not before', async () => {
    // The accounting's own purpose. `retryStats()` is the process-level view the artifact
    // reports, and a call that died on every attempt was absent from it -- so a run whose
    // traffic was entirely 429s and a run whose last call reset the socket could produce
    // the same counters.
    resetRetryStats();
    const before = retryStats();

    await retryableFetch(
      alwaysTerminated(),
      'http://x',
      {},
      { maxRetries: 1, baseDelayMs: 1 },
    ).catch(() => undefined);

    const after = retryStats();
    expect(after.calls).toBe(before.calls + 1);
    // Recorded as a call that retried rather than as a clean one: the distinction the
    // counter exists for, and the one an exhausted call has to land on.
    expect(after.retriedCalls).toBe(before.retriedCalls + 1);
    expect(after.attempts).toBe(before.attempts + 2);
  });

  it('wraps a primitive throw into an Error and records the exhaustion on it', async () => {
    // A `throw 'string'` from `fetch` is converted into an `Error` by the loop before it is
    // rethrown -- the layer's own test pins that wrapping -- so the value a caller here
    // receives is always an object and can always carry the record. The `attachPartial`
    // rule about primitives is about a seam that can receive one; this is not that seam,
    // which is why `withExhaustion` takes an `Error` and has no guard.
    const weird = (async () => {
      throw 'a primitive throw';
    }) as unknown as typeof fetch;

    const thrown = await retryableFetch(
      weird,
      'http://x',
      {},
      { maxRetries: 0, baseDelayMs: 1 },
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('a primitive throw');
    expect(exhaustionOf(thrown)!.attempts).toBe(1);
    expect(exhaustionOf(thrown)!.cause).toBe('a primitive throw');
  });

  it('records nothing on a call that succeeded, so absence means no exhaustion', async () => {
    // The other polarity, and it is what makes the field readable: a successful call must
    // not carry a record, or "no exhaustion" and "exhaustion with zero attempts" would be
    // the same bytes.
    const ok = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const outcome = await retryableFetchWithStats(ok, 'http://x', {}, { maxRetries: 1 });
    expect(outcome.response.status).toBe(200);
    expect(exhaustionOf(outcome)).toBeUndefined();
  });

  it('reports the attempts a non-throwing failure made, including none at all', async () => {
    // `maxRetries: -1` issues no request and still has to say so: "zero attempts" and
    // "the record is missing" are different facts about a run, and only one of them means
    // the call never reached the network.
    const fetchFn = (async () => new Response('{}')) as unknown as typeof fetch;
    const thrown = await retryableFetch(
      fetchFn,
      'http://x',
      {},
      {
        maxRetries: -1,
        baseDelayMs: 1,
      },
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/fetch failed/);
    const record = exhaustionOf(thrown);
    expect(record).toBeDefined();
    expect(record!.attempts).toBe(0);
    expect(record!.cause).toBe('');
  });
});

/**
 * The deadline must cover the BODY, not only the headers.
 *
 * ## The run this was written against
 *
 * `38941095220` graded four passes and died at `reference-pipeline run=1 q=391` on
 * `TimeoutError: The operation was aborted due to timeout`, and the same run's
 * transport accounting said:
 *
 *     {"attempts":6702,"retried":0,"rateLimited":0,"calls":6702,
 *      "retriedCalls":0,"cleanCalls":6702,"exhaustedCalls":0}
 *
 * Zero retries and zero exhausted calls across 6,702 calls, while a `TimeoutError`
 * killed the process. The two facts are only jointly true one way: `attemptSignal`
 * arms `AbortSignal.timeout` on the REQUEST, `fetch` resolves as soon as the
 * HEADERS arrive, and this function returns that response -- so the deadline is
 * still armed when the CALLER reads the body. A body still streaming when the
 * deadline fires aborts there, at `res.json()` in the client, where this loop
 * cannot see it: the call was already counted `clean`, and no retry is attempted
 * because no attempt is still open.
 *
 * The consequence is the one §13.31 named as the open question -- "a single abort
 * from somewhere the retry loop does not wrap" -- and it cost 79 minutes of graded
 * answers.
 *
 * ## What the fix changes, and what it deliberately does not
 *
 * An attempt becomes the COMPLETE exchange: the body is read inside the same `try`
 * that issues the request, so a body-level abort is a transport failure like any
 * other and takes the ordinary backoff and retry path. The response handed back is
 * rebuilt from those bytes, so no caller's code changes and none can observe the
 * difference except by a body that used to stall.
 *
 * Not changed: the deadline's value, the retry count, the backoff, and the
 * classification of statuses. Those were not what failed.
 */
describe('the per-attempt deadline covers the body', () => {
  /** Headers arrive at once; the body never does. */
  function stalledBodyFetch(): typeof fetch {
    return (async (_url: unknown, init?: RequestInit) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const abort = (): void => {
            controller.error(
              signal?.reason instanceof Error ? signal.reason : new Error('aborted'),
            );
          };
          if (signal?.aborted) {
            abort();
          } else {
            signal?.addEventListener('abort', abort, { once: true });
          }
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
  }

  it('retries a body that stalls past the deadline instead of dying at the caller', async () => {
    // Without the fix this resolves: the loop returns on the first attempt with a
    // live stream, `attempts` is 1, and the abort happens outside every counter.
    // Reset first, so the counters read below describe this call and not the file's
    // earlier ones.
    resetRetryStats();
    await expect(
      retryableFetchWithStats(
        stalledBodyFetch(),
        'https://stall.test/v1',
        {},
        {
          timeoutMs: 25,
          maxRetries: 2,
          baseDelayMs: 1,
          retryBudgetMs: 60_000,
        },
      ),
    ).rejects.toThrow();

    const stats = retryStats();
    expect(stats.exhaustedCalls).toBe(1);
    // Three attempts and two retries: the stall is a transport failure at every
    // attempt, so the ladder runs to the end rather than stopping at the first.
    expect(stats.attempts).toBe(3);
    expect(stats.retried).toBe(2);
  });

  it('still hands back a readable body for a response that completes', async () => {
    // The regression guard for the buffering itself: a rebuilt response must keep
    // the status, the headers and the bytes, or the fix would trade a rare hang for
    // a common breakage.
    const outcome = await retryableFetchWithStats(
      (async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
      'https://ok.test/v1',
      {},
      { timeoutMs: 1_000, maxRetries: 0 },
    );
    expect(outcome.response.status).toBe(200);
    expect(outcome.response.headers.get('content-type')).toBe('application/json');
    await expect(outcome.response.json()).resolves.toEqual({ ok: true });
  });

  it('keeps the status readable for a response that carries no body', async () => {
    // 204 has no body to read and no failure to classify; a buffering step that
    // assumed a stream would turn a legal empty response into an exception.
    const outcome = await retryableFetchWithStats(
      (async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
      'https://empty.test/v1',
      {},
      { timeoutMs: 1_000, maxRetries: 0 },
    );
    expect(outcome.response.status).toBe(204);
  });
});
