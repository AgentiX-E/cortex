import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  retryableFetch,
  isRetryableStatus,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BASE_DELAY_MS,
} from '../retry.js';

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
    const res = await retryableFetch(fetch, baseUrl, { method: 'POST' }, 5, 1);
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
      2,
      1,
    );
    expect(res.status).toBe(429);
    await new Promise<void>((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve())));
  });

  it('re-throws a persistent network error after retries', async () => {
    await expect(
      retryableFetch(fetch, 'http://127.0.0.1:1', { method: 'POST' }, 1, 1),
    ).rejects.toThrow();
  });

  it('wraps a non-Error thrown by fetch into an Error', async () => {
    const throwingFetch = (async () => {
      throw 'boom';
    }) as unknown as typeof fetch;
    await expect(retryableFetch(throwingFetch, 'http://x', {}, 1, 1)).rejects.toThrow('boom');
  });

  it('throws a generic error when the retry budget is negative', async () => {
    const fetchFn = (async () => new Response('{}')) as unknown as typeof fetch;
    await expect(retryableFetch(fetchFn, 'http://x', {}, -1, 1)).rejects.toThrow(/fetch failed/);
  });
});

describe('defaults', () => {
  it('exposes sane retry defaults', () => {
    expect(DEFAULT_MAX_RETRIES).toBe(5);
    expect(DEFAULT_RETRY_BASE_DELAY_MS).toBe(1000);
  });
});
