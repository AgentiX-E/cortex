import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  buildChatBody,
  parseJson,
  sanitizePrompt,
  OpenAICompatibleLLM,
} from '../llm/openai-compatible.js';
import { OpenAIEmbedding } from '../embedding/openai.js';
import { TransformersEmbedding } from '../embedding/transformers.js';
import * as cortexLlm from '../index.js';

describe('package exports', () => {
  it('exports LLM and embedding adapters', () => {
    expect(typeof cortexLlm.OpenAICompatibleLLM).toBe('function');
    expect(typeof cortexLlm.OpenAIEmbedding).toBe('function');
    expect(typeof cortexLlm.TransformersEmbedding).toBe('function');
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

  it('falls back to the default pipeline factory when none is injected', async () => {
    // Covers the `?? makeDefaultPipelineFactory(...)` arm in `getExtractor`, which
    // every other test misses because every other test injects a factory.
    //
    // The assertion is a REJECTION, and the reason is worth stating precisely
    // because the first version of this test got it wrong. It asserted a message
    // matching /xenova|transformers/, on the assumption that the peer is absent so
    // the dynamic import would fail with a module-resolution error. That is true in
    // CI and false here: `@xenova/transformers` is installed in this environment,
    // so the import succeeds and the failure comes from further in — `sharp`, its
    // transitive native dependency, whose prebuilt binary does not load. The
    // regex therefore passed locally for a reason unrelated to what it claimed and
    // would have been pinned to one machine's node_modules layout.
    //
    // What is stable across both environments is that taking the fallback arm
    // cannot SUCCEED, because the optional peer path is not guaranteed to be
    // usable, and that the failure is an Error rather than a TypeError. A TypeError
    // would mean the injection point was mis-wired and `embed` called something
    // that is not a function; an Error from the loader means the branch ran and the
    // loader reported its own problem. Distinguishing those two is the assertion's
    // whole job, so it does not reach for a message it cannot own.
    const emb = new TransformersEmbedding({ model: 'm', dimensions: 1 });
    await expect(emb.embed(['hello'])).rejects.toBeInstanceOf(Error);
    await expect(emb.embed(['hello'])).rejects.not.toBeInstanceOf(TypeError);
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
