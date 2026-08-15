import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { buildChatBody, parseJson, OpenAICompatibleLLM } from '../llm/openai-compatible.js';
import { OpenAIEmbedding } from '../embedding/openai.js';
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
        if (req.url === '/embeddings') {
          res.end(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }));
        } else {
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

  it('embeds text via a real HTTP server', async () => {
    const emb = new OpenAIEmbedding({ baseUrl, apiKey: 'test', model: 'm', dimensions: 3 });
    const vectors = await emb.embed(['hello']);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]!.length).toBe(3);
    expect(vectors[0]![0]).toBeCloseTo(1, 12);
  });
});
