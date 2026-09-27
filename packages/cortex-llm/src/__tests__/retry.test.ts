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
    expect(DEFAULT_MAX_RETRIES).toBe(5);
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
    expect(calls).toBe(1);
    // A refused retry is a retry that never happened.
    expect(outcome.retried).toBe(0);
    expect(outcome.rateLimited).toBe(0);
    expect(outcome.attempts).toBe(1);
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
});
