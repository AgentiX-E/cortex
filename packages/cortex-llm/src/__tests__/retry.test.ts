import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  retryableFetch,
  isRetryableStatus,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BASE_DELAY_MS,
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
});
