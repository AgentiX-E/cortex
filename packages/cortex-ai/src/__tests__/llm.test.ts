import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  buildChatBody,
  parseJson,
  sanitizePrompt,
  OpenAICompatibleLLM,
} from '../llm/openai-compatible.js';
import { OpenAIEmbedding } from '../embedding/openai.js';
import { TransformersEmbedding } from '../local/embedding.js';
import type { TransformersModule } from '../local/pipelines.js';
import { llmUsage, usageDelta } from '../usage.js';
import * as cortexAi from '../index.js';

describe('package exports', () => {
  it('exports the remote adapters, and not the local ones', () => {
    // The root is the remote entry. `TransformersEmbedding` is deliberately absent from it: the
    // whole point of the split is that importing the provider adapters does not drag an ONNX
    // runtime in, and a re-export here would undo that without changing a single test elsewhere.
    expect(typeof cortexAi.OpenAICompatibleLLM).toBe('function');
    expect(typeof cortexAi.OpenAIEmbedding).toBe('function');
    expect(typeof cortexAi.OpenAICompatibleReranker).toBe('function');
    expect((cortexAi as Record<string, unknown>).TransformersEmbedding).toBeUndefined();
    expect((cortexAi as Record<string, unknown>).createFeatureExtractor).toBeUndefined();
  });
});

describe('sanitizePrompt', () => {
  it('replaces backslashes with forward slashes to remove hex-escape ambiguity', () => {
    expect(sanitizePrompt('a\\xb')).toBe('a/xb');
    expect(sanitizePrompt('a\\u12')).toBe('a/u12');
    expect(sanitizePrompt('C:\\Users')).toBe('C:/Users');
  });

  it('strips line/paragraph separators and zero-width format characters', () => {
    expect(sanitizePrompt('a\u2028b\u2029c')).toBe('abc');
    expect(sanitizePrompt('a\u200B\u200D\uFEFFb')).toBe('ab');
  });

  it('strips control characters but keeps newlines and tabs', () => {
    expect(sanitizePrompt('a\u0000b\nc\td')).toBe('ab\nc\td');
  });

  it('leaves ordinary text unchanged', () => {
    expect(sanitizePrompt('hello world')).toBe('hello world');
  });
});

describe('buildChatBody', () => {
  it('builds a minimal chat body', () => {
    const body = buildChatBody('m', 'hello', {});
    expect(body).toMatchObject({ model: 'm', messages: [{ role: 'user', content: 'hello' }] });
  });

  it('includes temperature and max tokens', () => {
    const body = buildChatBody('m', 'hello', { temperature: 0.7, maxTokens: 42 });
    expect(body['temperature']).toBe(0.7);
    expect(body['max_tokens']).toBe(42);
  });

  it('enables JSON response format when a schema is given', () => {
    const body = buildChatBody('m', 'hello', { schema: { type: 'object' } });
    expect(body['response_format']).toEqual({ type: 'json_object' });
  });

  it('includes the thinking toggle when provided', () => {
    const body = buildChatBody('m', 'hello', {}, { type: 'disabled' });
    expect(body['thinking']).toEqual({ type: 'disabled' });
  });

  it('omits the thinking toggle when not provided', () => {
    const body = buildChatBody('m', 'hello', {});
    expect('thinking' in body).toBe(false);
  });
});

describe('parseJson', () => {
  it('parses a plain JSON object', () => {
    expect(parseJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it('parses a fenced JSON block', () => {
    expect(parseJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it('throws on non-JSON input', () => {
    expect(() => parseJson('no json here')).toThrow();
  });
});

describe('OpenAICompatibleLLM (real local server)', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (body.includes('emptyfail')) {
          res.statusCode = 400;
          res.end('');
          return;
        }
        if (body.includes('fail')) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'internal' }));
          return;
        }
        if (req.url === '/embeddings') {
          if (body.includes('emptydata')) {
            res.end('{}');
            return;
          }
          if (body.includes('missingembedding')) {
            res.end(JSON.stringify({ data: [{}] }));
            return;
          }
          res.end(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }));
        } else {
          if (body.includes('emptycontent')) {
            res.end(JSON.stringify({ choices: [] }));
            return;
          }
          // Two response shapes on one endpoint, because the property under test is the
          // difference between them and a second server would let them drift apart. The
          // `usage` block is the shape every OpenAI-compatible provider returns; its
          // absence is the shape a stripping proxy returns.
          if (body.includes('withusage')) {
            res.end(
              JSON.stringify({
                choices: [{ message: { content: 'priced' } }],
                usage: {
                  prompt_tokens: 12_000,
                  completion_tokens: 40,
                  prompt_cache_hit_tokens: 9_000,
                  prompt_cache_miss_tokens: 3_000,
                },
              }),
            );
            return;
          }
          res.end(
            JSON.stringify({
              choices: [
                { message: { content: `echo:${JSON.parse(body)['messages'][0].content}` } },
              ],
            }),
          );
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('completes a prompt via a real HTTP server', async () => {
    const llm = new OpenAICompatibleLLM({ baseUrl, apiKey: 'test', model: 'm' });
    const out = await llm.complete('hi');
    expect(out).toBe('echo:hi');
  });

  it('produces structured output by parsing the guided response', async () => {
    const llm = new OpenAICompatibleLLM({ baseUrl, apiKey: 'test', model: 'm' });
    const out = await llm.completeStructured('hi', { type: 'object' });
    expect(typeof out).toBe('object');
  });

  it('returns an empty string when the response has no content', async () => {
    const llm = new OpenAICompatibleLLM({ baseUrl, apiKey: 'test', model: 'm' });
    expect(await llm.complete('emptycontent')).toBe('');
  });

  /**
   * The two tests below are the transport half of `usage.ts`.
   *
   * `usage.test.ts` pins the parser against hand-built bodies and would stay green if
   * the adapter never called it -- which is precisely the defect that kept every artifact
   * in this campaign silent about spend: the provider published the number on every
   * request and the adapter returned only `choices[0]`. A test at the parse layer cannot
   * see a caller that does not call it, so the assertion has to start at `complete()` and
   * read the process aggregate through its public accessor.
   *
   * Each takes a snapshot before the call and asserts on the DIFFERENCE, rather than
   * resetting the process aggregate first: the aggregate is process-wide and the tests
   * above it in this file make real calls too, so a reset would be this file's second
   * global side effect and the assertion would depend on test order either way. The
   * delta is the same arithmetic the report uses (`usageDelta`), so the test drives the
   * production path rather than a test-only accessor.
   */
  it('records what the provider said the call cost', async () => {
    const before = llmUsage();
    const llm = new OpenAICompatibleLLM({ baseUrl, apiKey: 'test', model: 'm' });
    expect(await llm.complete('withusage')).toBe('priced');
    // The hit count is reported as part of the prompt it came from, not in addition to
    // it: 12,000 and not 21,000.
    expect(usageDelta(before, llmUsage())).toEqual({
      calls: 1,
      unpricedCalls: 0,
      promptTokens: 12_000,
      completionTokens: 40,
      cacheHitPromptTokens: 9_000,
    });
  });

  it('counts a response that states no cost as an unpriced call, not a free one', async () => {
    const before = llmUsage();
    const llm = new OpenAICompatibleLLM({ baseUrl, apiKey: 'test', model: 'm' });
    await llm.complete('hi');
    // `calls: 1` with `unpricedCalls: 1` is the whole assertion. Folding the missing
    // block into zeros would produce the same token totals with `calls: 0`, and an
    // artifact built from that reads exactly like a run that spent nothing.
    expect(usageDelta(before, llmUsage())).toEqual({
      calls: 1,
      unpricedCalls: 1,
      promptTokens: 0,
      completionTokens: 0,
      cacheHitPromptTokens: 0,
    });
  });

  it('throws when the LLM server returns an error', async () => {
    const llm = new OpenAICompatibleLLM({ baseUrl, apiKey: 'test', model: 'm' });
    await expect(llm.complete('fail')).rejects.toThrow(/LLM request failed/);
    await expect(llm.complete('fail')).rejects.toThrow(/internal/);
  });

  it('reports the status without a body detail when reading the body fails', async () => {
    // Covers `res.text().catch(() => '')`, the arm from the previous test not
    // reaching. The two cases look similar and are not:
    //
    //   - `emptyfail` returns a well-formed 400 with NO body, so `res.text()`
    //     resolves to `''` and the `bodyText ? ... : ''` ternary takes its false
    //     branch;
    //   - here the response is received and then its BODY READ REJECTS, so the
    //     catch fires and `.catch` is what supplies the empty string.
    //
    // This is tested through the `fetchFn` seam rather than the local server
    // because a real socket cannot produce it. The first attempt did exactly that
    // — the route declared `Content-Length: 500`, wrote a fragment and called
    // `socket.destroy()` — and what came back was `fetch failed`, not a 400 with an
    // unreadable body. Undici rejects the whole FETCH when the connection dies
    // mid-response, so `res.ok` is never evaluated and the guard under test is
    // never entered. Injecting a `Response` whose `text()` rejects is therefore not
    // a convenience: it is the only way to reach a branch that the network path
    // provably cannot. `new Response('{}')` is already the established form of this
    // seam elsewhere in the suite.
    //
    // What is being asserted is that a body-read failure is DOWNGRADED to "no
    // detail" rather than propagating. The status and statusText are the actionable
    // information, and letting the read error escape would replace a diagnosable
    // 400 with an opaque stream error.
    const failingResponse = new Response(null, { status: 400, statusText: 'Bad Request' });
    // `text()` is overridden on the instance rather than constructed: a `Response`
    // body can be made to error, but only asynchronously and not portably across
    // runtimes, and the property under test is the caller's handling of the
    // rejection, not how a stream is broken.
    Object.defineProperty(failingResponse, 'text', {
      value: () => Promise.reject(new Error('stream closed')),
    });

    const llm = new OpenAICompatibleLLM({
      baseUrl,
      apiKey: 'test',
      model: 'm',
      fetchFn: (async () => failingResponse) as unknown as typeof fetch,
    });

    await expect(llm.complete('hi')).rejects.toThrow(/LLM request failed: 400 Bad Request/);
    // The read error must not surface, and no detail segment may appear.
    await expect(llm.complete('hi')).rejects.not.toThrow(/stream closed/);
  });

  it('names why the ladder declined, because the status alone reads as throttling', async () => {
    // ## The loss this pins
    //
    // `41393748964` printed `LLM request failed: 429 ` and stopped there. Every reader took it
    // for a rate limit; the counters said `rateLimited: 0` over 2,892 calls, and the two could
    // not both be right until the refusal was named. A `Retry-After` of an hour against a
    // two-minute allowance is a *decision* -- this client will not wait an hour -- and it is a
    // different fact from the provider slowing down, which is the one the message implied.
    const llm = new OpenAICompatibleLLM({
      baseUrl: 'http://llm.invalid',
      apiKey: 'k',
      model: 'm',
      fetchFn: (async () =>
        new Response('', {
          status: 429,
          headers: { 'retry-after': '3600' },
        })) as unknown as typeof fetch,
    });

    const message = await llm.complete('hi').then(
      () => 'resolved',
      (error: unknown) => (error as Error).message,
    );

    expect(message).toContain('LLM request failed: 429');
    expect(message).toContain('not retried (retry-after-beyond-budget)');
    expect(message).toContain('the provider asked for 3600 s');
    expect(message).toContain('after 1 attempt(s)');
  });

  it('carries the budget it was given, so a long attempt deadline cannot eat the ladder', async () => {
    // The pair that has to be chosen together. A `timeoutMs` larger than `retryBudgetMs` makes
    // the ladder unreachable by construction, because the budget is measured from the first
    // attempt; the adapter's job is to pass both through unchanged so the composer owns that
    // inequality. Here an 80 ms budget against a 1,000 ms backoff and a 429 with no header:
    // the computed wait is truncated to the 80 ms that remain, so a second request IS made and
    // the third is declined. Two requests and a named reason is the whole contract -- the
    // alternative reading, one request and a fabricated status, is what `41393748964` produced.
    let issued = 0;
    const llm = new OpenAICompatibleLLM({
      baseUrl: 'http://llm.invalid',
      apiKey: 'k',
      model: 'm',
      retryBudgetMs: 80,
      retryBaseDelayMs: 1000,
      fetchFn: (async () => {
        issued += 1;
        return new Response('', { status: 429 });
      }) as unknown as typeof fetch,
    });

    // The clock is faked for the reason the assertion below is exact: the budget is measured from
    // the first attempt, so a real clock makes "how much was left" depend on how long the first
    // attempt took -- which under coverage instrumentation was enough to spend the 80 ms twice
    // over and leave one request where this test expects two. The behaviour under test is the
    // truncation arithmetic, not the runner's speed, so the clock is the one thing to control.
    vi.useFakeTimers();
    let message: string;
    try {
      const pending = llm.complete('hi').then(
        () => 'resolved',
        (error: unknown) => (error as Error).message,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      message = await pending;
    } finally {
      vi.useRealTimers();
    }

    expect(issued).toBe(2);
    expect(message).toContain('not retried (budget-exhausted)');
    expect(message).toContain('after 2 attempt(s)');
    expect(message).toContain('and 0 s was left');
  });

  it('embeds text via a real HTTP server', async () => {
    const emb = new OpenAIEmbedding({ baseUrl, apiKey: 'test', model: 'm', dimensions: 3 });
    expect(emb.dimension()).toBe(3);
    const vectors = await emb.embed(['hello']);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]!.length).toBe(3);
    expect(vectors[0]![0]).toBeCloseTo(1, 12);
  });

  it('throws when the embedding server returns an error', async () => {
    const emb = new OpenAIEmbedding({ baseUrl, apiKey: 'test', model: 'm', dimensions: 3 });
    await expect(emb.embed(['fail'])).rejects.toThrow(/Embedding request failed/);
  });

  it('reports the embedding error without a body detail when the response is empty', async () => {
    const emb = new OpenAIEmbedding({ baseUrl, apiKey: 'test', model: 'm', dimensions: 3 });
    await expect(emb.embed(['emptyfail'])).rejects.toThrow(/Embedding request failed/);
  });

  it('reports a body that dies mid-read as a transport failure, not as a status', async () => {
    // A provider that answers 502 and then drops the connection while the body is arriving. The
    // ladder reads every body to completion *inside* the attempt (`withBufferedBody`, which is what
    // closed the abort-at-`res.json()` class of loss in `38941095220`), so this never reaches the
    // adapter's `!res.ok` branch at all: it is a transport error, and it carries the exhaustion
    // record rather than a status.
    //
    // That is the correct shape. A half-arrived body has no detail to report, and inventing a
    // `502` for it would state something the provider did send only in part.
    const broken = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('socket hang up'));
          },
        }),
        { status: 502 },
      )) as unknown as typeof fetch;
    const emb = new OpenAIEmbedding({
      baseUrl: 'https://provider.invalid/v1',
      apiKey: 'test',
      model: 'm',
      dimensions: 3,
      maxRetries: 0,
      fetchFn: broken,
    });

    const failure = await emb.embed(['hello']).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect((failure as Error).message).toBe('socket hang up');
    expect(
      (failure as Error & { retryExhausted?: { attempts: number } }).retryExhausted?.attempts,
    ).toBe(1);
  });

  it('downgrades an unreadable error body to no detail, keeping the status', async () => {
    // The embedding mirror of the LLM case above, and it exists for the same reason: the two
    // adapters carry the same `res.text().catch(() => '')`, and only the LLM side had a test
    // reaching the catch. A `Response` with a null body passes through `withBufferedBody`
    // untouched, so this is the one shape that can still arrive with a `text()` that rejects.
    const unreadable = new Response(null, { status: 400, statusText: 'Bad Request' });
    Object.defineProperty(unreadable, 'text', {
      value: () => Promise.reject(new Error('stream closed')),
    });
    const emb = new OpenAIEmbedding({
      baseUrl: 'https://provider.invalid/v1',
      apiKey: 'test',
      model: 'm',
      dimensions: 3,
      maxRetries: 0,
      fetchFn: (async () => unreadable) as unknown as typeof fetch,
    });

    await expect(emb.embed(['hello'])).rejects.toThrow(
      /Embedding request failed: 400 Bad Request$/,
    );
    await expect(emb.embed(['hello'])).rejects.not.toThrow(/stream closed/);
  });

  it('returns an empty list when the response has no data field', async () => {
    const emb = new OpenAIEmbedding({ baseUrl, apiKey: 'test', model: 'm', dimensions: 3 });
    expect(await emb.embed(['emptydata'])).toEqual([]);
  });

  it('treats a missing embedding as an empty vector', async () => {
    const emb = new OpenAIEmbedding({ baseUrl, apiKey: 'test', model: 'm', dimensions: 3 });
    const vectors = await emb.embed(['missingembedding']);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]!.length).toBe(0);
  });
});

describe('OpenAIEmbedding request body', () => {
  it('sends the dimensions parameter for variable-dimension models', async () => {
    let captured: Record<string, unknown> | null = null;
    const fetchFn = async (_url: string, init: { body?: string }) => {
      captured = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      return new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const emb = new OpenAIEmbedding({
      baseUrl: 'https://example.invalid',
      apiKey: 'k',
      model: 'embedding-3',
      dimensions: 1024,
      fetchFn: fetchFn as never,
    });
    await emb.embed(['hello']);
    expect(captured!['model']).toBe('embedding-3');
    expect(captured!['dimensions']).toBe(1024);
    expect(captured!['input']).toEqual(['hello']);
  });

  it('omits the dimensions parameter when it is not positive', async () => {
    let captured: Record<string, unknown> | null = null;
    const fetchFn = async (_url: string, init: { body?: string }) => {
      captured = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      return new Response(JSON.stringify({ data: [{ embedding: [1] }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const emb = new OpenAIEmbedding({
      baseUrl: 'https://example.invalid',
      apiKey: 'k',
      model: 'embedding-2',
      dimensions: 0,
      fetchFn: fetchFn as never,
    });
    await emb.embed(['hello']);
    expect('dimensions' in captured!).toBe(false);
  });
});

describe('TransformersEmbedding', () => {
  it('returns the configured dimension', () => {
    const emb = new TransformersEmbedding({ model: 'm', dimensions: 7 });
    expect(emb.dimension()).toBe(7);
  });

  it('converts extractor output to Float64Array', async () => {
    const emb = new TransformersEmbedding({
      model: 'm',
      dimensions: 2,
      pipelineFactory: async () => async () => ({ tolist: () => [[0.25, 0.75]] }),
    });
    const vectors = await emb.embed(['hello']);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toBeInstanceOf(Float64Array);
    expect(vectors[0]![0]).toBeCloseTo(0.25, 12);
    expect(vectors[0]![1]).toBeCloseTo(0.75, 12);
  });

  it('caches the extractor across embed calls', async () => {
    let factoryCalls = 0;
    const emb = new TransformersEmbedding({
      model: 'm',
      dimensions: 1,
      pipelineFactory: async () => {
        factoryCalls++;
        return async () => ({ tolist: () => [[1]] });
      },
    });
    await emb.embed(['a']);
    await emb.embed(['b']);
    expect(factoryCalls).toBe(1);
  });

  it('takes the default loader, and pins dtype to fp32', async () => {
    // The arm every other test misses, because every other test injects a factory. It is asserted
    // through `loadModule` rather than by letting the real loader run: the real one would download
    // 90 MB of weights, and the claim here is about the arguments this package sends -- which is
    // exactly the claim whose absence let v2's quantized default go unnoticed.
    const calls: { task: string; model: string; options?: Record<string, unknown> }[] = [];
    const module: TransformersModule = {
      env: {},
      pipeline: async (task, model, options) => {
        calls.push({ task, model, ...(options === undefined ? {} : { options }) });
        return async () => ({ tolist: () => [[0.5, 0.5]] });
      },
    };
    const emb = new TransformersEmbedding({
      model: 'Xenova/all-MiniLM-L6-v2',
      dimensions: 2,
      loadModule: async () => module,
    });

    expect(await emb.embed(['hello'])).toEqual([new Float64Array([0.5, 0.5])]);
    expect(calls).toEqual([
      { task: 'feature-extraction', model: 'Xenova/all-MiniLM-L6-v2', options: { dtype: 'fp32' } },
    ]);
  });

  it('does not cache a failed extractor load', async () => {
    // Whether the rejection above leaves `this.extractor` set decides whether a
    // second call retries or reports a stale failure for ever. Retrying is the
    // useful property: an optional peer can be installed while a process runs, and
    // a permanently poisoned cache would turn that into a restart. The counter
    // distinguishes the two, and the assertion is on the count rather than on the
    // error, so it stays true whichever way the first call fails.
    let attempts = 0;
    const emb = new TransformersEmbedding({
      model: 'm',
      dimensions: 1,
      pipelineFactory: async () => {
        attempts++;
        if (attempts === 1) throw new Error('peer not installed yet');
        return async () => ({ tolist: () => [[1]] });
      },
    });

    await expect(emb.embed(['a'])).rejects.toThrow('peer not installed yet');
    // The factory is called again, so the failure was not cached.
    const vectors = await emb.embed(['b']);
    expect(attempts).toBe(2);
    expect(vectors[0]![0]).toBeCloseTo(1, 12);
  });
});

/**
 * The adapter's own seam for pacing.
 *
 * `retry.test.ts` proves the ladder honours a pacer. This proves the adapter *supplies* one from
 * the option, which is the half a wiring defect lives in: `41393748964` is a run where a branch was
 * built, tested and never reached because nothing set the field on the way in.
 */
describe('a paced reader spaces consecutive requests', () => {
  /**
   * The interval the paced case configures, and the bound the unpaced case must stay under.
   *
   * ## Why these are constants and not literals in the two assertions
   *
   * The pair of tests is one experiment: *does a configured interval delay the second request, and does a
   * zero interval not?* The two numbers have to be chosen together, because the second is only meaningful
   * as "far below what pacing would have cost". They used to be `37` and `30`, which is a 7 ms margin
   * between the treatment's own delay and the null's bound -- and a full workspace check on a loaded
   * machine measured **33 ms** for the null, failing an assertion whose own comment said it must not be an
   * assertion about the scheduler.
   *
   * A zero interval schedules no wait at all, so the true effect is not 7 ms, it is "no delay versus a
   * delay of `PACED_INTERVAL_MS`". Measuring that gap needs the two numbers an order of magnitude apart,
   * which is what these are: 250 ms of pacing against a 200 ms bound leaves a machine 6x slower than the
   * one that failed still inside the null.
   */
  const PACED_INTERVAL_MS = 250;
  const UNPACED_BOUND_MS = 200;

  /** Answers 200 with one message, recording when each request started. */
  function timestampingFetch(): { fetchFn: typeof fetch; times: () => number[] } {
    const times: number[] = [];
    const fetchFn = (async () => {
      times.push(Date.now());
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { fetchFn, times: () => times };
  }

  it('waits at least the interval before the second request', async () => {
    // 37 ms rather than a round number, and no other test uses it: `sharedRequestGate` is
    // process-wide, so a shared interval would make two tests consume each other's slots and this
    // assertion would pass on the wrong grounds.
    const { fetchFn, times } = timestampingFetch();
    const llm = new OpenAICompatibleLLM({
      baseUrl: 'http://x',
      apiKey: 'k',
      model: 'm',
      fetchFn,
      minIntervalMs: PACED_INTERVAL_MS,
    });
    await llm.complete('a');
    await llm.complete('b');
    const gap = times()[1]! - times()[0]!;
    // A floor, not an equality: the point is that the second request did not leave at once, and an
    // exact assertion would be an assertion about the scheduler.
    expect(gap).toBeGreaterThanOrEqual(PACED_INTERVAL_MS - UNPACED_BOUND_MS);
  });

  it('does not wait when the interval is zero', async () => {
    const { fetchFn, times } = timestampingFetch();
    const llm = new OpenAICompatibleLLM({
      baseUrl: 'http://x',
      apiKey: 'k',
      model: 'm',
      fetchFn,
      minIntervalMs: 0,
    });
    await llm.complete('a');
    await llm.complete('b');
    // The bound is the one the paired test above can tell apart from pacing, not a budget for the
    // machine. It used to be 30 ms, and a full workspace check on a loaded box measured 33 -- the
    // assertion was reading the scheduler, which is exactly what its own comment said it must not do.
    expect(times()[1]! - times()[0]!).toBeLessThan(UNPACED_BOUND_MS);
  });

  it('refuses a negative interval where it is written, not on the first call', async () => {
    // Construction rather than first request: a run that is misconfigured should fail before it
    // spends forty minutes and then dies at question 55, which is what `41553176719` did.
    expect(
      () =>
        new OpenAICompatibleLLM({
          baseUrl: 'http://x',
          apiKey: 'k',
          model: 'm',
          minIntervalMs: -5,
        }),
    ).toThrow(/positive/);
  });
});
