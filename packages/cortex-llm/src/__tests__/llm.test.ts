import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { buildChatBody, parseJson, OpenAICompatibleLLM } from '../llm/openai-compatible.js';
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
        if (body.includes('fail')) {
          res.statusCode = 500;
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
});
