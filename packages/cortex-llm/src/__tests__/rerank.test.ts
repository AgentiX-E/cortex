/**
 * Tests for the reranker adapters (roadmap measure B1).
 *
 * Two adapters, deliberately split so that neither is a single point of lock-in:
 *
 *  - `OpenAICompatibleReranker` speaks the `/rerank` convention used by Cohere,
 *    Jina, Voyage, and a self-hosted bge-reranker behind an OpenAI-shaped proxy.
 *  - `CrossEncoderReranker` runs a local transformers.js sequence-classification
 *    pipeline, so reranking still works with no provider, no API key, and no
 *    network — the same escape hatch the embedding layer already has.
 *
 * The network boundary is a fake `fetchFn` (the adapter accepts one for exactly
 * this reason); no HTTP is performed.
 */

import { describe, expect, it } from 'vitest';

import {
  CrossEncoderReranker,
  OpenAICompatibleReranker,
  buildRerankBody,
  parseRerankResponse,
  type CrossEncoderPipeline,
} from '../rerank/rerank.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('buildRerankBody', () => {
  it('emits the document list and a top_n covering every pair', () => {
    const body = buildRerankBody('q', ['a', 'b'], 'a-model') as Record<string, unknown>;

    expect(body.model).toBe('a-model');
    // `query` is the question; some gateways name it `text` instead, so the
    // adapter sends the canonical `query` form used by Cohere/Jina.
    expect(body.query).toBe('q');
    expect(body.documents).toEqual(['a', 'b']);
    expect(body.top_n).toBe(2);
  });

  it('requests no truncation so a short response is detectable as an error', () => {
    const body = buildRerankBody('q', ['a', 'b', 'c'], 'm') as Record<string, unknown>;

    expect(body.top_n).toBe(3);
  });
});

describe('parseRerankResponse', () => {
  it('scatters results back into input order by index', () => {
    // The rerank API returns results sorted best-first, with an `index` that
    // refers back to the request's document order.
    const scores = parseRerankResponse(
      {
        results: [
          { index: 2, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.1 },
          { index: 1, relevance_score: 0.5 },
        ],
      },
      3,
    );

    expect(scores).toEqual([0.1, 0.5, 0.9]);
  });

  it('returns null when a document is missing from the response', () => {
    expect(parseRerankResponse({ results: [{ index: 0, relevance_score: 0.5 }] }, 2)).toBeNull();
  });

  it('returns null when a score is not a finite number', () => {
    expect(parseRerankResponse({ results: [{ index: 0, relevance_score: 'high' }] }, 1)).toBeNull();
  });

  it('returns null when the payload has no results array', () => {
    expect(parseRerankResponse({}, 1)).toBeNull();
    expect(parseRerankResponse(null, 1)).toBeNull();
  });

  it('rejects an out-of-range index rather than writing to a wrong slot', () => {
    expect(parseRerankResponse({ results: [{ index: 5, relevance_score: 0.5 }] }, 1)).toBeNull();
  });

  it('rejects a negative index', () => {
    expect(parseRerankResponse({ results: [{ index: -1, relevance_score: 0.5 }] }, 1)).toBeNull();
  });

  it('returns an empty list for zero documents without asserting failure', () => {
    expect(parseRerankResponse({ results: [] }, 0)).toEqual([]);
  });

  it('rejects a malformed entry instead of skipping it', () => {
    expect(parseRerankResponse({ results: [null] }, 1)).toBeNull();
    expect(parseRerankResponse({ results: ['nope'] }, 1)).toBeNull();
  });

  it('rejects a duplicate index, which would leave a document unscored', () => {
    const payload = {
      results: [
        { index: 0, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.1 },
      ],
    };

    expect(parseRerankResponse(payload, 2)).toBeNull();
  });

  it('rejects a non-integer index', () => {
    expect(parseRerankResponse({ results: [{ index: 0.5, relevance_score: 0.5 }] }, 2)).toBeNull();
  });
});

describe('OpenAICompatibleReranker', () => {
  const pairs = [
    { question: 'q', candidateId: 'a', text: 'text a' },
    { question: 'q', candidateId: 'b', text: 'text b' },
  ];

  it('returns scores in the order the pairs were given', async () => {
    const seen: unknown[] = [];
    const reranker = new OpenAICompatibleReranker({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'k',
      model: 'rerank-model',
      fetchFn: async (_url, init) => {
        seen.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          results: [
            { index: 1, relevance_score: 0.8 },
            { index: 0, relevance_score: 0.2 },
          ],
        });
      },
    });

    expect(await reranker.score(pairs)).toEqual([0.2, 0.8]);
    expect(seen).toHaveLength(1);
    expect((seen[0] as Record<string, unknown>).documents).toEqual(['text a', 'text b']);
  });

  it('sends the bearer token and hits the /rerank path', async () => {
    let url = '';
    let auth = '';
    const reranker = new OpenAICompatibleReranker({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'secret',
      model: 'm',
      fetchFn: async (input, init) => {
        url = String(input);
        auth = String((init?.headers as Record<string, string>).Authorization);
        return jsonResponse({ results: [{ index: 0, relevance_score: 1 }] });
      },
    });

    await reranker.score([pairs[0]!]);
    expect(url).toBe('https://example.invalid/v1/rerank');
    expect(auth).toBe('Bearer secret');
  });

  it('avoids the network entirely for an empty pair list', async () => {
    let called = 0;
    const reranker = new OpenAICompatibleReranker({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'k',
      model: 'm',
      fetchFn: async () => {
        called += 1;
        return jsonResponse({ results: [] });
      },
    });

    expect(await reranker.score([])).toEqual([]);
    expect(called).toBe(0);
  });

  it('throws on a non-OK response so rerankHits can apply its fallback', async () => {
    // The status is permanent here, so the retry budget is spent and the error
    // surfaces. The budget is set explicitly to keep the test fast: with the
    // default it would burn five 1s backoffs before failing, which is correct
    // production behaviour and a 5s test.
    const reranker = new OpenAICompatibleReranker({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'k',
      model: 'm',
      maxRetries: 1,
      retryBaseDelayMs: 1,
      fetchFn: async () => new Response('rate limited', { status: 429 }),
    });

    await expect(reranker.score(pairs)).rejects.toThrow(/429/);
  });

  it('throws when the response omits a document, rather than scoring it zero', async () => {
    const reranker = new OpenAICompatibleReranker({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'k',
      model: 'm',
      fetchFn: async () => jsonResponse({ results: [{ index: 0, relevance_score: 0.5 }] }),
    });

    await expect(reranker.score(pairs)).rejects.toThrow(/incomplete/i);
  });

  it('uses a caller-supplied fetch default when none is injected', async () => {
    const original = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (async () =>
      jsonResponse({ results: [{ index: 0, relevance_score: 0.4 }] })) as typeof fetch;
    called += 1;
    try {
      const reranker = new OpenAICompatibleReranker({
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'k',
        model: 'm',
      });
      expect(await reranker.score([pairs[0]!])).toEqual([0.4]);
      expect(called).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('CrossEncoderReranker', () => {
  const pairs = [
    { question: 'q', candidateId: 'a', text: 'text a' },
    { question: 'q', candidateId: 'b', text: 'text b' },
  ];

  /** A pipeline stand-in that scores by the length of the joined input. */
  function lengthPipeline(): { pipeline: CrossEncoderPipeline; inputs: string[][] } {
    const inputs: string[][] = [];
    const pipeline: CrossEncoderPipeline = async (texts) => {
      inputs.push([...texts]);
      return texts.map((text) => ({ score: text.length }));
    };
    return { pipeline, inputs };
  }

  it('scores each (question, text) pair and returns them in pair order', async () => {
    const { pipeline, inputs } = lengthPipeline();
    const reranker = new CrossEncoderReranker({ pipeline });

    const scores = await reranker.score(pairs);

    // 'q' + separator + 'text a' is shorter than the same for 'text b'? Both
    // same length, so instead assert against recomputation of the join.
    expect(scores).toHaveLength(2);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toHaveLength(2);
    expect(scores[0]).toBe(inputs[0]![0]!.length);
    expect(scores[1]).toBe(inputs[0]![1]!.length);
  });

  it('joins the question and the text with the model separator token', async () => {
    const { pipeline, inputs } = lengthPipeline();
    const reranker = new CrossEncoderReranker({ pipeline });

    await reranker.score([pairs[0]!]);

    expect(inputs[0]![0]).toContain('q');
    expect(inputs[0]![0]).toContain('text a');
  });

  it('honours a custom separator', async () => {
    const { pipeline, inputs } = lengthPipeline();
    const reranker = new CrossEncoderReranker({ pipeline, separator: ' || ' });

    await reranker.score([pairs[0]!]);

    expect(inputs[0]![0]).toBe('q || text a');
  });

  it('avoids invoking the pipeline for an empty pair list', async () => {
    let called = 0;
    const reranker = new CrossEncoderReranker({
      pipeline: async () => {
        called += 1;
        return [];
      },
    });

    expect(await reranker.score([])).toEqual([]);
    expect(called).toBe(0);
  });

  it('applies the sigmoid when scores are raw logits', async () => {
    const reranker = new CrossEncoderReranker({
      pipeline: async (texts) => texts.map(() => ({ score: 0 })),
      applySigmoid: true,
    });

    // sigmoid(0) === 0.5, and the adapter must be monotonic in the logit.
    expect(await reranker.score([pairs[0]!])).toEqual([0.5]);
  });

  it('keeps logits untouched by default', async () => {
    const reranker = new CrossEncoderReranker({
      pipeline: async (texts) => texts.map(() => ({ score: 3.25 })),
    });

    expect(await reranker.score([pairs[0]!])).toEqual([3.25]);
  });

  it('rejects a response of the wrong length instead of truncating', async () => {
    const reranker = new CrossEncoderReranker({
      pipeline: async () => [{ score: 1 }],
    });

    await expect(reranker.score(pairs)).rejects.toThrow(/incomplete/i);
  });

  it('rejects non-finite logits', async () => {
    const reranker = new CrossEncoderReranker({
      pipeline: async (texts) => texts.map(() => ({ score: Number.NaN })),
    });

    await expect(reranker.score(pairs)).rejects.toThrow(/non-finite/i);
  });

  it('accepts a raw number in place of a {score} object', async () => {
    // Some pipelines resolve to a plain array of numbers.
    const reranker = new CrossEncoderReranker({
      pipeline: (async (texts: string[]) =>
        texts.map(() => 0.25)) as unknown as CrossEncoderPipeline,
    });

    expect(await reranker.score([pairs[0]!])).toEqual([0.25]);
  });

  it('treats a non-array pipeline result as an incomplete response', async () => {
    const reranker = new CrossEncoderReranker({
      pipeline: (async () => undefined) as unknown as CrossEncoderPipeline,
    });

    await expect(reranker.score(pairs)).rejects.toThrow(/incomplete/i);
  });
});

/**
 * Retry behaviour on the `/rerank` path.
 *
 * These cover a consistency gap rather than a new feature: `OpenAICompatibleLLM`
 * and `OpenAIEmbedding` both route through `retryableFetch`, and this adapter did
 * not — it called `fetchFn` directly. The consequence is not theoretical. A
 * benchmark that issues hundreds of rerank calls per run is exactly the workload
 * that meets a 429, and without retry a single throttled response aborts the run
 * and the A/B arm produces no measurement at all.
 *
 * The fetch stand-ins below are plain functions that count their calls. Nothing is
 * mocked at the module level; the adapter already accepts an injected `fetchFn`.
 */
describe('OpenAICompatibleReranker retry', () => {
  const retryPairs = [{ question: 'q', candidateId: 'a', text: 'alpha' }] as const;
  it('retries a 429 and succeeds on a later attempt', async () => {
    let calls = 0;
    const reranker = new OpenAICompatibleReranker({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'k',
      model: 'm',
      maxRetries: 2,
      retryBaseDelayMs: 1,
      fetchFn: async () => {
        calls += 1;
        return calls === 1
          ? jsonResponse({ error: 'slow down' }, 429)
          : jsonResponse({ results: [{ index: 0, relevance_score: 0.7 }] });
      },
    });

    expect(await reranker.score(retryPairs)).toEqual([0.7]);
    expect(calls).toBe(2);
  });

  it('retries a 503, which is a transient server fault and not a caller error', async () => {
    let calls = 0;
    const reranker = new OpenAICompatibleReranker({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'k',
      model: 'm',
      maxRetries: 2,
      retryBaseDelayMs: 1,
      fetchFn: async () => {
        calls += 1;
        return calls === 1
          ? jsonResponse({}, 503)
          : jsonResponse({ results: [{ index: 0, relevance_score: 0.3 }] });
      },
    });

    expect(await reranker.score(retryPairs)).toEqual([0.3]);
    expect(calls).toBe(2);
  });

  it('does not retry a 400, because a malformed request never becomes well-formed', async () => {
    let calls = 0;
    const reranker = new OpenAICompatibleReranker({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'k',
      model: 'm',
      maxRetries: 3,
      retryBaseDelayMs: 1,
      fetchFn: async () => {
        calls += 1;
        return jsonResponse({ error: 'bad request' }, 400);
      },
    });

    await expect(reranker.score(retryPairs)).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });

  it('gives up after the retry budget and surfaces the last status', async () => {
    let calls = 0;
    const reranker = new OpenAICompatibleReranker({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'k',
      model: 'm',
      maxRetries: 2,
      retryBaseDelayMs: 1,
      fetchFn: async () => {
        calls += 1;
        return jsonResponse({}, 500);
      },
    });

    await expect(reranker.score(retryPairs)).rejects.toThrow(/500/);
    // 1 initial attempt plus 2 retries.
    expect(calls).toBe(3);
  });
});
