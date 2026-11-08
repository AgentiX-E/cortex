/**
 * OpenAI-compatible embedding adapter. Normalizes remote float32 outputs to
 * Float64Array so downstream Cortex math retains full precision.
 */
import type { EmbeddingModel } from '@agentix-e/cortex-core';
import { retryableFetch } from '../retry.js';

export type OpenAIEmbeddingOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
  fetchFn?: typeof fetch;
  /** Retries for transient (429/5xx) failures; default `DEFAULT_MAX_RETRIES` (8). */
  maxRetries?: number;
  /** Initial backoff in milliseconds; doubles each retry. */
  retryBaseDelayMs?: number;
  /** Per-attempt request deadline in milliseconds; default 60000. */
  timeoutMs?: number;
};

export class OpenAIEmbedding implements EmbeddingModel {
  private readonly options: OpenAIEmbeddingOptions;

  constructor(options: OpenAIEmbeddingOptions) {
    this.options = options;
  }

  dimension(): number {
    return this.options.dimensions;
  }

  async embed(texts: string[]): Promise<Float64Array[]> {
    const fetchFn = this.options.fetchFn ?? fetch;
    const body: Record<string, unknown> = { model: this.options.model, input: texts };
    // Variable-dimension models (e.g. Zhipu embedding-3) require an explicit
    // `dimensions` parameter; omitting it yields 400 Bad Request.
    if (this.options.dimensions > 0) {
      body['dimensions'] = this.options.dimensions;
    }
    const res = await retryableFetch(
      fetchFn,
      `${this.options.baseUrl}/embeddings`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      {
        maxRetries: this.options.maxRetries,
        baseDelayMs: this.options.retryBaseDelayMs,
        timeoutMs: this.options.timeoutMs,
      },
    );
    if (!res.ok) {
      // `withBufferedBody` in `retry.ts` reads every body to completion inside the attempt, so a
      // body that dies mid-read is a transport failure the ladder retries and then rethrows with
      // its exhaustion record. What still reaches this line is a response with a null body whose
      // `text()` the injector overrode, which is the seam `llm.test.ts` uses because the network
      // path cannot produce it — and the arm exists so that a read failure is downgraded to "no
      // detail" instead of masking the status the provider did publish.
      const bodyText = await res.text().catch(() => '');
      const detail = bodyText ? ` — ${bodyText.slice(0, 400)}` : '';
      throw new Error(`Embedding request failed: ${res.status} ${res.statusText}${detail}`);
    }
    const json = (await res.json()) as { data?: { embedding?: number[] }[] };
    const data = json.data ?? [];
    return data.map((d) => new Float64Array(d.embedding ?? []));
  }
}
